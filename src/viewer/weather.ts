import * as THREE from "three";
import type { Precipitation, VfxProfile } from "../shared/vfx.js";
import { setPreviewLightEnergy } from "./lighting.js";

const namesMatch = (a: string, b: string) => THREE.PropertyBinding.sanitizeNodeName(a) === THREE.PropertyBinding.sanitizeNodeName(b);
const modulo = THREE.MathUtils.euclideanModulo;

function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function precipitation(profile: Precipitation, scene: THREE.Scene, model: THREE.Group) {
  const rain = profile.kind === "rain";
  // ponytail: CPU collision is precomputed on a bounded deterministic population. GPU emitters
  // are needed to reproduce film-scale particle counts in real time.
  const count = Math.min(4000, profile.count);
  const lives = Math.max(1, Math.min(profile.lives, Math.floor(12000 / Math.max(1, count))));
  const duration = profile.period / lives;
  const velocity = new THREE.Vector3(...profile.velocity);
  const direction = velocity.clone().normalize();
  const speed = velocity.length();
  const travel = speed * duration;
  const color = new THREE.Color().setRGB(...profile.color).add(new THREE.Color().setRGB(...profile.emission));
  const geometry = rain ? new THREE.ConeGeometry(1, 1, 3, 1, true) :
    profile.kind === "ash" ? new THREE.PlaneGeometry(2, 2) : new THREE.IcosahedronGeometry(1, 0);
  const material = new THREE.MeshBasicMaterial({ color, transparent: rain, opacity: rain ? 0.58 : 1, side: THREE.DoubleSide, depthWrite: !rain });
  const particles = new THREE.InstancedMesh(geometry, material, count);
  particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particles.frustumCulled = false;
  const ground: THREE.Object3D[] = [];
  model.traverse(object => {
    if (profile.ground.some(name => namesMatch(name, object.name))) ground.push(object);
  });
  const splashGeometry = new THREE.RingGeometry(0.75, 1, 7);
  splashGeometry.rotateX(-Math.PI / 2);
  const splashMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  const splashes = ground.length && profile.splash > 0 ? new THREE.InstancedMesh(splashGeometry, splashMaterial, count) : undefined;
  if (splashes) {
    splashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    splashes.frustumCulled = false;
    scene.add(splashes);
  }
  scene.add(particles);
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = travel;
  const rng = random(profile.seed);
  const center = new THREE.Vector3(...profile.center);
  const starts = Array.from({ length: count * lives }, () => {
    const position = new THREE.Vector3(...profile.size.map(size => (rng() - 0.5) * size) as [number, number, number]).add(center);
    ray.set(position, direction);
    const hit = (ground.length && direction.y < 0) ? ray.intersectObjects(ground, true)[0] : undefined;
    return { position, hit: hit?.point, distance: hit?.distance ?? travel, phase: rng(), scale: 0.7 + 0.6 * rng() };
  });
  const offsets = Array.from({ length: count }, rng);
  const pose = new THREE.Object3D();
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const cameraPosition = new THREE.Vector3();
  const nearSq = profile.near ** 2;
  return {
    update(time: number, camera: THREE.Camera) {
      camera.getWorldPosition(cameraPosition);
      const clock = time / duration;
      for (let i = 0; i < count; i++) {
        const age = clock + offsets[i]!;
        const state = starts[i * lives + modulo(Math.floor(age), lives)]!;
        const phase = modulo(age, 1), distance = phase * travel;
        pose.position.copy(state.position).addScaledVector(velocity, phase * duration);
        pose.position.x += profile.sway * Math.sin(2 * Math.PI * (2 * phase + state.phase));
        pose.position.z += profile.sway * Math.cos(2 * Math.PI * (1.5 * phase + state.phase));
        if (distance < state.distance && pose.position.distanceToSquared(cameraPosition) >= nearSq) {
          const fade = Math.min(1, phase * 12, (1 - phase) * 12);
          pose.quaternion.copy(orientation);
          const radius = profile.radius * state.scale * fade;
          pose.scale.set(radius, rain ? profile.streak * state.scale * fade : radius, radius);
          pose.updateMatrix();
          particles.setMatrixAt(i, pose.matrix);
        } else particles.setMatrixAt(i, hidden);
        if (splashes) {
          const afterImpact = (distance - state.distance) / Math.max(speed, 0.001);
          if (state.hit && afterImpact >= 0 && afterImpact < profile.splash) {
            pose.position.copy(state.hit);
            pose.position.y += 0.004;
            pose.quaternion.identity();
            pose.scale.setScalar(profile.radius * (4 + 20 * afterImpact / profile.splash));
            pose.updateMatrix();
            splashes.setMatrixAt(i, pose.matrix);
          } else splashes.setMatrixAt(i, hidden);
        }
      }
      particles.instanceMatrix.needsUpdate = true;
      if (splashes) splashes.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      particles.removeFromParent(); particles.dispose(); geometry.dispose(); material.dispose();
      splashes?.removeFromParent(); splashes?.dispose(); splashGeometry.dispose(); splashMaterial.dispose();
    },
  };
}

function materialsFor(model: THREE.Group, name: string, materialName: string) {
  const materials = new Set<THREE.Material>();
  model.traverse(object => {
    if (!namesMatch(object.name, name)) return;
    object.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
        if (mat.name === materialName) materials.add(mat);
      }
    });
  });
  return materials;
}

export function createWeather(profile: VfxProfile | undefined, scene: THREE.Scene, model: THREE.Group, clips: THREE.AnimationClip[]) {
  const particles = (profile?.precipitation ?? []).filter(effect => effect.count > 0 && effect.period > 0).map(effect => precipitation(effect, scene, model));
  const mixer = clips.length ? new THREE.AnimationMixer(model) : undefined;
  clips.forEach(clip => mixer!.clipAction(clip).play());
  const animation = profile?.animation;
  const updates = animation?.tracks.map(track => {
    let apply: (values: number[]) => void;
    if (track.kind === "environment") {
      const original = scene.environmentIntensity, background = scene.backgroundIntensity;
      const initial = track.initial?.[0] || track.values.find(values => values[0]! > 0)?.[0] || 1;
      apply = ([strength]) => {
        scene.environmentIntensity = original * strength! / initial;
        scene.backgroundIntensity = background * strength! / initial;
      };
    } else if (track.kind === "light") {
      let light: THREE.Light | undefined;
      model.traverse(object => { if (object instanceof THREE.Light && namesMatch(object.name, track.name)) light = object; });
      apply = ([energy, r, g, b]) => {
        if (!light) return;
        light.color.setRGB(r!, g!, b!);
        setPreviewLightEnergy(light, energy!);
      };
    } else {
      const materials = materialsFor(model, track.name, track.material);
      apply = ([energy, r, g, b]) => {
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial) {
            material.emissive.setRGB(r!, g!, b!);
            material.emissiveIntensity = energy!;
          } else if (material instanceof THREE.MeshBasicMaterial) {
            material.color.setRGB(r!, g!, b!).multiplyScalar(energy!);
          }
        }
      };
    }
    return { values: track.values, apply };
  }) ?? [];
  const clock = { value: 0 };
  const restore: (() => void)[] = [];
  const ripples = new Map<THREE.MeshPhysicalMaterial, { strength: number; coverage: number; scale: number }>();
  for (const effect of profile?.ripples ?? []) {
    for (const material of materialsFor(model, effect.name, effect.material)) {
      if (material instanceof THREE.MeshPhysicalMaterial) ripples.set(material, effect);
    }
  }
  for (const [material, effect] of ripples) {
    const previous = material.onBeforeCompile, cacheKey = material.customProgramCacheKey;
    material.customProgramCacheKey = () => "weather-ripples:" + cacheKey.call(material);
    material.onBeforeCompile = function(shader, renderer) {
      previous.call(this, shader, renderer);
      shader.uniforms.rippleTime = clock;
      shader.uniforms.rippleSettings = { value: new THREE.Vector3(effect.strength, effect.coverage, Math.max(0.01, effect.scale)) };
      shader.vertexShader = "varying vec3 ripplePosition;\n" + shader.vertexShader.replace("#include <worldpos_vertex>",
        "#include <worldpos_vertex>\n ripplePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = `varying vec3 ripplePosition;
        uniform float rippleTime;
        uniform vec3 rippleSettings;
        float rippleHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      ` + shader.fragmentShader.replace("#include <clearcoat_normal_fragment_maps>", `#include <clearcoat_normal_fragment_maps>
        #ifdef USE_CLEARCOAT
        vec2 rippleCell = ripplePosition.xz * 6.0;
        float phase = fract(rippleTime * 3.0 + rippleHash(floor(rippleCell)));
        float spread = rippleHash(floor(ripplePosition.xz / rippleSettings.z));
        float mask = smoothstep(0.62 - 0.24 * rippleSettings.y, 0.66 - 0.24 * rippleSettings.y, spread)
          * smoothstep(0.85, 0.97, abs(normalize(cross(dFdx(ripplePosition), dFdy(ripplePosition))).y));
        float ring = 1.0 - smoothstep(0.01, 0.06, abs(length(fract(rippleCell) - 0.5) - phase * 0.5));
        float ripple = ring * (1.0-phase) * rippleSettings.x * mask;
        clearcoatNormal = normalize(clearcoatNormal - 0.05 * vec3(dFdx(ripple), dFdy(ripple), 0.0));
        #endif`);
    };
    material.needsUpdate = true;
    restore.push(() => { material.onBeforeCompile = previous; material.customProgramCacheKey = cacheKey; });
  }
  if (!(particles.length || mixer || updates.length || ripples.size)) return;
  const start = performance.now() / 1000;
  return {
    geometryChanges: Boolean(particles.length || mixer),
    update(camera: THREE.Camera) {
      const time = performance.now() / 1000 - start;
      clock.value = time;
      mixer?.setTime(time);
      for (const emitter of particles) emitter.update(time, camera);
      if (animation && updates.length) {
        const duration = animation.times.at(-1) ?? 0;
        const position = duration > 0 ? modulo(time + animation.time, duration) : 0;
        const next = Math.max(1, animation.times.findIndex(key => key > position));
        const a = animation.times[next - 1] ?? 0, b = animation.times[next] ?? a;
        const mix = b > a ? (position - a) / (b - a) : 0;
        for (const track of updates) {
          const values = track.values[next - 1]!;
          track.apply(values.map((value, i) => THREE.MathUtils.lerp(value, track.values[next]?.[i] ?? value, mix)));
        }
      }
    },
    dispose() {
      for (const emitter of particles) emitter.dispose();
      for (const cleanup of restore) cleanup();
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
    },
  };
}
