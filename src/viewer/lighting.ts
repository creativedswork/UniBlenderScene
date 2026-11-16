import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";

export type Lightmap = { objectName: string; uri: string; uvChannel: number; scale: number };
const normalized = (name: string) => name.replace(/\s/g, "_").replace(/[\[\].:/]/g, "");

export function captureEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, position: number[], far: number) {
  const cube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const camera = new THREE.CubeCamera(0.1, far, cube);
  camera.position.set(position[0]!, position[2]!, -position[1]!);
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    camera.update(renderer, scene);
    return pmrem.fromCubemap(cube.texture);
  } finally { cube.dispose(); pmrem.dispose(); }
}

/** Static captures retain the full rig; bound the per-pixel cost of the interactive passes. */
export function limitRasterLights(scene: THREE.Scene, camera: THREE.Camera, count = 12) {
  const lights: { light: THREE.Light; score: number }[] = [];
  const eye = camera.getWorldPosition(new THREE.Vector3());
  scene.traverse(object => {
    if (!(object instanceof THREE.PointLight || object instanceof THREE.SpotLight || object instanceof THREE.RectAreaLight)) return;
    const distance = object.getWorldPosition(new THREE.Vector3()).distanceToSquared(eye);
    const luminance = object.color.r * 0.2126 + object.color.g * 0.7152 + object.color.b * 0.0722;
    lights.push({ light: object, score: object.power * luminance / Math.max(1, distance) });
  });
  lights.sort((a, b) => b.score - a.score).slice(count).forEach(({ light }) => { light.visible = false; });
}

function belongsTo(mesh: THREE.Object3D, name: string): boolean {
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    if (normalized(node.name) === normalized(name)) return true;
  }
  return false;
}

export async function applyLightmaps(root: THREE.Object3D, maps: Lightmap[], asset: (name: string) => Promise<string>) {
  const textures: THREE.Texture[] = [];
  for (const map of maps) {
    const texture = await new THREE.TextureLoader().loadAsync(await asset(map.uri));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.channel = map.uvChannel;
    textures.push(texture);
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !belongsTo(object, map.objectName)) return;
      if (!object.geometry.getAttribute(map.uvChannel ? `uv${map.uvChannel}` : "uv")) {
        throw new Error(`Lightmap UV channel is missing on ${object.name}.`);
      }
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
        if (!(source instanceof THREE.MeshStandardMaterial)) return source;
        const material = source.clone();
        material.lightMap = texture;
        // Cycles' diffuse bake contains radiance per unit albedo; Three expects irradiance.
        material.lightMapIntensity = Math.PI * map.scale;
        material.aoMapIntensity = 0;
        material.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <lights_fragment_maps>", "#include <lights_fragment_maps>\nirradiance = lightMapTexel.rgb * lightMapIntensity;")
            .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse = vec3(0.0);");
        };
        material.customProgramCacheKey = () => "static-diffuse-lightmap";
        return material;
      });
      object.material = Array.isArray(object.material) ? materials : materials[0]!;
      object.receiveShadow = false;
    });
  }
  return textures;
}

/** One horizontal receiver: a second raster pass supplies view-dependent reflections. */
export function addPlanarReflection(scene: THREE.Scene, root: THREE.Object3D, name: string) {
  const receivers: THREE.Mesh[] = [];
  root.traverse(object => { if (object instanceof THREE.Mesh && belongsTo(object, name)) receivers.push(object); });
  if (!receivers.length) throw new Error(`Reflection mesh is missing: ${name}`);
  const bounds = new THREE.Box3();
  for (const object of receivers) bounds.union(new THREE.Box3().setFromObject(object));
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  if (Math.min(size.x, size.z) <= 0 || size.y > Math.min(size.x, size.z) * 0.05) {
    throw new Error("The reflection receiver must be a horizontal surface.");
  }
  const reflection = new Reflector(new THREE.PlaneGeometry(size.x, size.z), {
    textureWidth: 1024, textureHeight: 1024, multisample: 0, clipBias: 0.001,
  });
  reflection.name = "__PreviewReflection";
  reflection.rotation.x = -Math.PI / 2;
  reflection.position.set(center.x, bounds.max.y + 0.001, center.z);
  const reflectionMaterial = reflection.material as THREE.ShaderMaterial;
  reflectionMaterial.colorWrite = false;
  reflectionMaterial.depthWrite = false;
  reflection.updateMatrixWorld(true);
  const inverse = reflection.matrixWorld.clone().invert();
  const uniforms = {
    planarTexture: { value: reflection.getRenderTarget().texture as THREE.Texture | null },
    planarMatrix: reflectionMaterial.uniforms.textureMatrix!,
    planarInverse: { value: inverse },
  };
  for (const object of receivers) {
    const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
      if (!(source instanceof THREE.MeshStandardMaterial)) return source;
      const material = source.clone();
      const previous = source.onBeforeCompile.bind(source);
      const previousKey = source.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = "uniform mat4 planarMatrix, planarInverse; varying vec4 vPlanar;\n" + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>",
          "#include <project_vertex>\nvPlanar = planarMatrix * planarInverse * modelMatrix * vec4(transformed, 1.0);");
        shader.fragmentShader = "uniform sampler2D planarTexture; varying vec4 vPlanar;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", `
          #include <lights_fragment_end>
          vec2 planarUv = vPlanar.xy / vPlanar.w;
          vec2 blur = vec2(0.001, 0.003) * roughnessFactor;
          vec3 planarColor = (texture2D(planarTexture, planarUv + blur).rgb
            + texture2D(planarTexture, planarUv - blur).rgb
            + texture2D(planarTexture, planarUv + vec2(blur.x, -blur.y)).rgb
            + texture2D(planarTexture, planarUv + vec2(-blur.x, blur.y)).rgb) * 0.25;
          float planarFresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0);
          reflectedLight.indirectSpecular = planarColor * planarFresnel;
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect = planarColor * planarFresnel;
          #endif
        `);
      };
      material.customProgramCacheKey = () => `${previousKey}:planar-reflection`;
      return material;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0]!;
  }
  const capture = reflection.onBeforeRender.bind(reflection);
  reflection.onBeforeRender = (...args) => {
    if (scene.overrideMaterial) return;
    // Do not sample the render target while it is being written by the reflected camera.
    uniforms.planarTexture.value = null;
    try { capture(...args); } finally { uniforms.planarTexture.value = reflection.getRenderTarget().texture; }
  };
  scene.add(reflection);
  return reflection;
}
