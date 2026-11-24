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

export function setPreviewLightEnergy(light: THREE.Light, energy: number) {
  // Use the same source-energy conversion as the native preview. Three's
  // SpotLight.power setter uses π, while the adapter uses 4π for local lamps.
  if (light instanceof THREE.SpotLight) light.intensity = energy / (4 * Math.PI);
  else if (light instanceof THREE.PointLight || light instanceof THREE.RectAreaLight) light.power = energy;
  else light.intensity = energy;
}

/** Budget fragment samplers before the first WebGL draw, including offscreen captures. */
export function limitPreviewShadows(scene: THREE.Scene, camera: THREE.Camera, maxSamplers: number, planarReflection: boolean) {
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const position = new THREE.Vector3();
  const shadows: { light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight; score: number }[] = [];
  const materials = new Set<THREE.MeshStandardMaterial>();
  let areaLights = false, spotTextures = 0;
  scene.traverseVisible(object => {
    if (object instanceof THREE.Mesh && object.receiveShadow) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof THREE.MeshStandardMaterial && material.visible) materials.add(material);
      }
    }
    if (object instanceof THREE.RectAreaLight) areaLights = true;
    if (object instanceof THREE.SpotLight && object.map) spotTextures++;
    if (!(object instanceof THREE.DirectionalLight || object instanceof THREE.PointLight || object instanceof THREE.SpotLight) || !object.castShadow) return;
    const distance = Math.max(1, object.getWorldPosition(position).distanceToSquared(eye));
    const luminance = object.color.r * 0.2126 + object.color.g * 0.7152 + object.color.b * 0.0722;
    shadows.push({ light: object, score: object instanceof THREE.DirectionalLight ? Infinity : object.intensity * luminance / distance });
  });
  let materialSamplers = 0;
  for (const material of materials) {
    // Packed glTF channels can use separate sampler uniforms for the same texture.
    const maps = Object.values(material).filter(value => value instanceof THREE.Texture).length;
    const environment = scene.environment && !material.envMap ? 1 : 0;
    const transmission = material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0 ? 1 : 0;
    materialSamplers = Math.max(materialSamplers, maps + environment + transmission);
  }
  const reserved = materialSamplers + (areaLights ? 2 : 0) + spotTextures + (planarReflection ? 1 : 0);
  const count = Math.min(shadows.length, Math.max(0, maxSamplers - reserved));
  shadows.sort((a, b) => b.score - a.score);
  for (const { light } of shadows.slice(count)) light.castShadow = false;
  return count;
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

export function sharpenThinGlass(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
  });
  const transmission = THREE.ShaderChunk.transmission_pars_fragment.replace(
    "return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );",
    "return textureLod( transmissionSamplerMap, fragCoord.xy, 0.0 );"
  );
  for (const material of materials) {
    if (!(material instanceof THREE.MeshPhysicalMaterial) || material.transmission <= 0 ||
      material.thickness > 0 || material.thicknessMap || material.normalMap || material.roughnessMap ||
      material.roughness >= 0.0525) continue;
    // Below Three's specular roughness floor, sample the base-level transmission buffer for a clear thin pane.
    const previous = material.onBeforeCompile.bind(material);
    const cacheKey = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace("#include <transmission_pars_fragment>", transmission);
    };
    material.customProgramCacheKey = () => `${cacheKey}:thin-glass`;
    material.needsUpdate = true;
  }
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
  const target = reflection.getRenderTarget();
  target.texture.generateMipmaps = true;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  reflection.updateMatrixWorld(true);
  const inverse = reflection.matrixWorld.clone().invert();
  const uniforms = {
    planarTexture: { value: target.texture },
    planarMatrix: reflectionMaterial.uniforms.textureMatrix!,
    planarInverse: { value: inverse },
    planarActive: { value: 0 },
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
        shader.fragmentShader = "uniform sampler2D planarTexture; uniform float planarActive; varying vec4 vPlanar;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", `
          #include <lights_fragment_end>
          vec2 planarUv = vPlanar.xy / max(vPlanar.w, 0.0001);
          vec2 planarEdge = min(planarUv, 1.0 - planarUv);
          float planarCoverage = planarActive * smoothstep(0.0, 0.015, min(planarEdge.x, planarEdge.y));
          vec3 planarUp = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
          planarCoverage *= smoothstep(0.5, 0.95, dot(nonPerturbedNormal, planarUp));
          float planarRoughness = smoothstep(0.035, 0.22, roughnessFactor);
          float planarWeight = planarCoverage * (1.0 - planarRoughness);
          vec3 planarColor = textureLod(planarTexture, planarUv, mix(0.75, 5.0, planarRoughness)).rgb;
          float planarDotNV = saturate(dot(geometryNormal, geometryViewDir));
          vec3 planarFresnel = F_Schlick(material.specularColor, material.specularF90, planarDotNV);
          reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, planarColor * planarFresnel, planarWeight);
          #ifdef USE_CLEARCOAT
            float planarDotNVcc = saturate(dot(geometryClearcoatNormal, geometryViewDir));
            vec3 planarCoatFresnel = F_Schlick(material.clearcoatF0, material.clearcoatF90, planarDotNVcc);
            clearcoatSpecularIndirect = mix(clearcoatSpecularIndirect, planarColor * planarCoatFresnel, planarWeight);
          #endif
        `);
      };
      material.customProgramCacheKey = () => `${previousKey}:planar-reflection`;
      return material;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0]!;
  }
  return Object.assign(reflection, {
    capture(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
      camera.updateWorldMatrix(true, false);
      uniforms.planarActive.value = Number(camera.matrixWorld.elements[13]! > reflection.position.y);
      if (!uniforms.planarActive.value) return;
      const visible = receivers.map(receiver => receiver.visible);
      receivers.forEach(receiver => { receiver.visible = false; });
      try {
        reflection.onBeforeRender(renderer, scene, camera, reflection.geometry, reflectionMaterial, null!);
      } finally {
        receivers.forEach((receiver, index) => { receiver.visible = visible[index]!; });
      }
    },
  });
}
