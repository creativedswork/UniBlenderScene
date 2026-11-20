import type { VfxProfile } from "../../src/shared/vfx.js";
import {
  Scene, GLTFModel, PerspectiveCamera, DirectionalLight, PointLight, SpotLight, RectAreaLight,
  SkyGradient, SkyColor, Color, FogVolume, VolumeFunction, HomogeneousVolume, ExponentialHeightFog, RainCurtain,
  VolumeMesh, Mesh, CircleGeometry, MeshBasicMaterial,
} from "@threert/scene";
import type { ExportEffects } from "../../src/render-effects.js";

export type ThreeRTInput = {
  assetPrefix?: string;
  environment?: { zenith: number[]; horizon: number[]; ground: number[] };
  background?: number[];
  camera: { position: number[]; quaternion: number[]; fov: number; aspect: number; near: number; far: number };
  profile: {
    vfx?: VfxProfile;
    colorManagement: { exposure: number };
    render: { resolutionX: number; resolutionY: number; filmTransparent?: boolean };
    world: { color: number[]; strength: number; environmentUri?: string | null; environmentRotationY?: number };
    lights: { name: string; type: string; color: number[]; energy: number; useShadow: boolean;
      size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
    previewAppearance?: { dust?: { color: number[]; wind?: number[]; volumes: { center: number[]; radius: number[]; density: number }[] } };
    postprocessing?: { bloom?: { strength?: number; threshold?: number }; haze?: {
      color: number[]; strength: number; start: number; depth: number; falloff: string };
    };
    effects?: ExportEffects;
  };
};

const color = (rgb: number[]) => new Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!);

// Keep the engine's physical fog envelope; modulate it in world metres, like the web preview.
const localFog = new FogVolume().volume.fn;
const driftingDust = new VolumeFunction("blender_drifting_dust", {
  params: { ...localFog.params, Wind: [0, 0, 0, 0] },
  helpers: `${localFog.helpers}
    fn dust_hash(p: vec3<f32>) -> f32 { return fract(sin(dot(p, vec3<f32>(127.1,311.7,74.7))) * 43758.5453); }
    fn dust_noise(p: vec3<f32>) -> f32 {
      let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
      let a=mix(mix(dust_hash(i),dust_hash(i+vec3<f32>(1,0,0)),u.x),
        mix(dust_hash(i+vec3<f32>(0,1,0)),dust_hash(i+vec3<f32>(1,1,0)),u.x),u.y);
      let b=mix(mix(dust_hash(i+vec3<f32>(0,0,1)),dust_hash(i+vec3<f32>(1,0,1)),u.x),
        mix(dust_hash(i+vec3<f32>(0,1,1)),dust_hash(i+vec3<f32>(1,1,1)),u.x),u.y);
      return mix(a,b,u.z);
    }`,
  code: `${localFog.code}
    let drift=(i.p-$Wind.xyz*i.time*0.3)*vec3<f32>(0.32,1.1,0.32);
    let billow=0.57*dust_noise(drift)+0.28*dust_noise(drift*2.1)+0.15*dust_noise(drift*4.3);
    o.extinction *= mix(0.2,1.0,smoothstep(0.26,0.72,billow));`,
});

const solarShaft = new VolumeFunction("blender_solar_shaft", {
  params: { Start: [0, 0, 0, 0], End: [0, 0, 0, 0], Medium: [0, 0, 0, 0], Emission: [0, 0, 0, 0] },
  code: `
    let axis = $End.xyz - $Start.xyz;
    let offset = i.p - $Start.xyz;
    let along = dot(offset, axis) / dot(axis, axis);
    let radial = length(offset - axis * along) / mix($Start.w, $End.w, clamp(along, 0.0, 1.0));
    let weight = (1.0 - smoothstep(0.13, 1.0, radial)) * smoothstep(-0.018, 0.13, along) *
      (1.0 - smoothstep(0.68, 1.025, along));
    o.extinction = $Medium.w * weight;
    o.albedo = $Medium.xyz;
    o.emission = $Emission.xyz * weight;
  `,
});

const gradientFog = new VolumeFunction("blender_gradient_fog", {
  params: { Medium: [0, 0, 0, 0], Emission: [0, 0, 0, 0], Axes: [0, 0, 0, 0], RampA: [0, 1, 1, 1], RampB: [0, 1, 1, 1] },
  code: `
    let a = clamp((i.p[u32($Axes.x)] - $RampA.x) / ($RampA.y - $RampA.x), 0.0, 1.0);
    let b = clamp((i.p[u32($Axes.y)] - $RampB.x) / ($RampB.y - $RampB.x), 0.0, 1.0);
    o.extinction = $Medium.w * mix($RampA.z, $RampA.w, a) * mix($RampB.z, $RampB.w, b);
    o.albedo = $Medium.xyz;
    o.emission = $Emission.xyz;
  `,
});

/** Import the saved camera and source lighting; the input GLB contains unbaked PBR materials. */
export function buildThreeRTScene({ camera: view, profile, assetPrefix = "", environment, background }: ThreeRTInput) {
  const scene = new Scene();
  scene.add(new GLTFModel(`${assetPrefix}model.glb`));
  scene.environment = environment ? new SkyGradient({ zenith: color(environment.zenith), horizon: color(environment.horizon),
    ground: color(environment.ground), intensity: profile.world.strength }) :
    new SkyColor(color(profile.world.color), profile.world.strength);
  if (background) scene.background = color(background);
  let sun: DirectionalLight | undefined;
  for (const source of profile.lights) {
    const energy = Math.max(0, source.energy);
    const width = Math.max(0.01, source.size), height = ["RECTANGLE", "ELLIPSE"].includes(source.shape) ? Math.max(0.01, source.sizeY) : width;
    const light = source.type === "SUN" ? new DirectionalLight(color(source.color), energy) :
      source.type === "AREA" ? new RectAreaLight(color(source.color), energy / (Math.PI * width * height), width, height) :
      source.type === "SPOT" ? new SpotLight(color(source.color), energy / (4 * Math.PI), 0, source.spotSize / 2, source.spotBlend) :
      new PointLight(color(source.color), energy / (4 * Math.PI));
    light.name = source.name;
    // The exported matrix already carries the full light transform, including the sun direction.
    light.matrix.fromArray(source.worldMatrix).decompose(light.position, light.quaternion, light.scale);
    if (light instanceof DirectionalLight || light instanceof SpotLight) light.target = null;
    if (light instanceof RectAreaLight) light.card = false;
    light.castShadow = source.useShadow;
    scene.add(light);
    if (light instanceof DirectionalLight && source.name === profile.effects?.sun?.name) sun = light;
  }
  const solar = profile.effects?.sun;
  const solarDistance = Math.max(view.far * 2, 100000);
  if (sun && solar) {
    sun.angularDiameter = solar.angularRadius * 360 / Math.PI;
    if (!profile.render.filmTransparent) {
      const { angularRadius, direction, radiance } = solar;
      const disk = new Mesh(new CircleGeometry(solarDistance * Math.tan(angularRadius), 48), new MeshBasicMaterial({ color: color(radiance) }));
      disk.name = "Solar disk";
      disk.castShadow = false;
      disk.position.set(view.position[0]! + direction[0] * solarDistance, view.position[1]! + direction[1] * solarDistance,
        view.position[2]! + direction[2] * solarDistance);
      disk.lookAt(view.position[0]!, view.position[1]!, view.position[2]!);
      scene.add(disk);
    }
  }
  for (const shaft of profile.effects?.shafts ?? []) {
    const padding = Math.max(...shaft.radii);
    const size = shaft.start.map((start, i) => Math.abs(start - shaft.end[i]!) * 1.05 + 2 * padding) as [number, number, number];
    const center = shaft.start.map((start, i) => (start + shaft.end[i]!) / 2) as [number, number, number];
    const volume = new VolumeMesh({ shape: "box", volume: solarShaft.with({
      Start: [...shaft.start, shaft.radii[0]], End: [...shaft.end, shaft.radii[1]],
      Medium: [...shaft.albedo, shaft.density], Emission: [...shaft.emission, 0],
    }), majorant: Math.max(0.00001, shaft.density), anisotropy: shaft.anisotropy });
    volume.name = shaft.name;
    volume.position.set(...center);
    volume.scale.set(...size);
    scene.add(volume);
  }
  for (const fog of profile.effects?.fog ?? []) {
    if (profile.vfx?.volumes?.some(volume => volume.name === fog.name)) continue;
    const { min, max, density, ramps, emission, albedo, anisotropy } = fog;
    const ramp = (index: number): [number, number, number, number] =>
      ramps[index] ? [...ramps[index]!.range, ...ramps[index]!.density] : [0, 1, 1, 1];
    const fogBox = ramps.length ? new VolumeMesh({ shape: "box", volume: gradientFog.with({
      Medium: [...albedo, density], Emission: [...emission, 0], Axes: [ramps[0]?.axis ?? 0, ramps[1]?.axis ?? 0, 0, 0],
      RampA: ramp(0), RampB: ramp(1),
    }), majorant: Math.max(0.00001, ramps.reduce((bound, r) => bound * Math.max(...r.density), density)), anisotropy }) :
      new HomogeneousVolume({ shape: "box", extinction: density, albedo, emission, anisotropy });
    fogBox.name = fog.name;
    fogBox.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    fogBox.scale.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    scene.add(fogBox);
  }
  const dust = profile.previewAppearance?.dust;
  for (const volume of dust?.volumes ?? []) {
    // FogVolume combines coverages, rather than adding extinction. A saturated height
    // term preserves the profile's radial density; two small terms nearly erase thin air.
    const fog = new FogVolume({ radialExtinction: volume.density, heightExtinction: 20,
      heightFalloff: 0, albedo: dust!.color.slice(0, 3) as [number, number, number], phaseG: 0.45 });
    fog.volume.fn = driftingDust;
    const wind = dust!.wind ?? [0, 0, 0];
    fog.volume.params.Wind = [wind[0]!, wind[2]!, -wind[1]!, 0];
    // Profile volumes use Blender Z-up; GLB and ThreeRT use Y-up. Scale is the diameter.
    fog.position.set(volume.center[0]!, volume.center[2]!, -volume.center[1]!);
    fog.scale.set(volume.radius[0]! * 2, volume.radius[2]! * 2, volume.radius[1]! * 2);
    scene.add(fog);
  }
  const worldVolume = profile.vfx?.volumes?.find(volume => !volume.min || !volume.max);
  const mist = profile.postprocessing?.haze;
  if (worldVolume) {
    const height = worldVolume.height;
    const fog = new ExponentialHeightFog(worldVolume.density, height ? 1 / height.depth : 0, color(worldVolume.color));
    fog.height = height?.start ?? 0;
    fog.setVolumetric(1, worldVolume.anisotropy);
    scene.fog = fog;
  } else if (mist) {
    const opacity = Math.max(0, Math.min(0.98, mist.strength));
    const fog = new ExponentialHeightFog(-Math.log1p(-opacity) / Math.max(0.001, mist.depth), 0, color(mist.color));
    fog.startDistance = mist.start;
    fog.maxOpacity = opacity;
    scene.fog = fog;
  }
  for (const volume of profile.vfx?.volumes ?? []) {
    if (!volume.min || !volume.max) continue;
    const [x, y, z] = volume.max.map((bound, i) => bound - volume.min![i]!) as [number, number, number];
    const center = volume.min.map((bound, i) => (bound + volume.max![i]!) / 2) as [number, number, number];
    const h = volume.height;
    const fog = h || volume.noiseScale ? new FogVolume({
      radialExtinction: Math.max(volume.density, h?.top ?? 0), heightExtinction: 20,
      heightFalloff: h ? y / (2 * Math.max(h.depth, 0.001)) : 0, heightOffset: h ? (h.start - center[1]) * 2 / y : 0,
      albedo: volume.color, phaseG: volume.anisotropy, emissive: volume.emission,
    }) : new HomogeneousVolume({ shape: "box", extinction: volume.density, albedo: volume.color,
      anisotropy: volume.anisotropy, emission: volume.emission });
    fog.name = volume.name;
    fog.position.set(...center);
    fog.scale.set(x, y, z);
    scene.add(fog);
  }
  for (const precipitation of profile.vfx?.precipitation ?? []) {
    if (precipitation.kind !== "rain" || precipitation.count <= 0) continue;
    scene.rain = 1;
    scene.add(new RainCurtain({ drops: Math.min(precipitation.count, 16000), box: precipitation.size,
      speed: Math.abs(precipitation.velocity[1]), wind: [precipitation.velocity[0], precipitation.velocity[2]],
      width: precipitation.radius * 2, length: precipitation.streak, color: precipitation.color, emissive: precipitation.emission }));
  }
  const camera = new PerspectiveCamera(view.fov, view.aspect, view.near, solar ? solarDistance * 1.01 : view.far);
  camera.position.set(view.position[0]!, view.position[1]!, view.position[2]!);
  camera.quaternion.set(view.quaternion[0]!, view.quaternion[1]!, view.quaternion[2]!, view.quaternion[3]!);
  camera.setManualExposure(-profile.colorManagement.exposure);
  scene.add(camera);
  return { scene, camera, options: { name: "Blender scene · ThreeRT", preset: "cinematic" as const,
    width: profile.render.resolutionX, height: profile.render.resolutionY,
    // Do not add the cinematic preset's gamut expansion / blue correction to Blender's linear colors.
    // ThreeRT still uses its native Filmic curve; this does not reproduce the exported AgX display LUT.
    overrides: { post: { colorGrading: { expandGamut: 0, blueCorrection: 0 },
      bloom: { intensity: profile.postprocessing?.bloom?.strength ?? 0,
      threshold: profile.postprocessing?.bloom?.threshold ?? 1.2 } } } } };
}
