import type { VfxProfile } from "../../src/shared/vfx.js";
import {
  Scene, GLTFModel, PerspectiveCamera, DirectionalLight, PointLight, SpotLight, RectAreaLight,
  SkyGradient, SkyColor, Color, FogVolume, VolumeFunction, HomogeneousVolume, ExponentialHeightFog, RainCurtain,
} from "@threert/scene";

export type ThreeRTInput = {
  assetPrefix?: string;
  environment?: { zenith: number[]; horizon: number[]; ground: number[] };
  background?: number[];
  camera: { position: number[]; quaternion: number[]; fov: number; aspect: number; near: number; far: number };
  profile: {
    vfx?: VfxProfile;
    colorManagement: { exposure: number };
    render: { resolutionX: number; resolutionY: number };
    world: { color: number[]; strength: number; environmentUri?: string | null; environmentRotationY?: number };
    lights: { name: string; type: string; color: number[]; energy: number; useShadow: boolean;
      size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
    previewAppearance?: { dust?: { color: number[]; wind?: number[]; volumes: { center: number[]; radius: number[]; density: number }[] } };
    postprocessing?: { bloom?: { strength?: number; threshold?: number }; haze?: {
      color: number[]; strength: number; start: number; depth: number; falloff: string };
    };
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

/** Import the saved camera and source lighting; the input GLB contains unbaked PBR materials. */
export function buildThreeRTScene({ camera: view, profile, assetPrefix = "", environment, background }: ThreeRTInput) {
  const scene = new Scene();
  scene.add(new GLTFModel(`${assetPrefix}model.glb`));
  scene.environment = environment ? new SkyGradient({ zenith: color(environment.zenith), horizon: color(environment.horizon),
    ground: color(environment.ground), intensity: profile.world.strength }) :
    new SkyColor(color(profile.world.color), profile.world.strength);
  if (background) scene.background = color(background);
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
  const camera = new PerspectiveCamera(view.fov, view.aspect, view.near, view.far);
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
