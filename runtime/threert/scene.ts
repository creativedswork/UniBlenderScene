import {
  Scene, GLTFModel, PerspectiveCamera, DirectionalLight, PointLight, SpotLight, RectAreaLight,
  SkyGradient, SkyColor, Color, FogVolume,
} from "@threert/scene";

export type ThreeRTInput = {
  assetPrefix?: string;
  environment?: { zenith: number[]; horizon: number[]; ground: number[] };
  background?: number[];
  camera: { position: number[]; quaternion: number[]; fov: number; aspect: number; near: number; far: number };
  profile: {
    colorManagement: { exposure: number };
    render: { resolutionX: number; resolutionY: number };
    world: { color: number[]; strength: number; environmentUri?: string | null; environmentRotationY?: number };
    lights: { name: string; type: string; color: number[]; energy: number; useShadow: boolean;
      size: number; sizeY: number; shape: string; spotSize: number; spotBlend: number; worldMatrix: number[] }[];
    previewAppearance?: { dust?: { color: number[]; volumes: { center: number[]; radius: number[]; density: number }[] } };
    postprocessing?: { bloom?: { strength?: number; threshold?: number } };
  };
};

const color = (rgb: number[]) => new Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!);

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
    const fog = new FogVolume({ radialExtinction: volume.density, heightExtinction: volume.density,
      heightFalloff: 0, albedo: dust!.color.slice(0, 3) as [number, number, number], phaseG: 0.45 });
    // Profile volumes use Blender Z-up; GLB and ThreeRT use Y-up. Scale is the diameter.
    fog.position.set(volume.center[0]!, volume.center[2]!, -volume.center[1]!);
    fog.scale.set(volume.radius[0]! * 2, volume.radius[2]! * 2, volume.radius[1]! * 2);
    scene.add(fog);
  }
  const camera = new PerspectiveCamera(view.fov, view.aspect, view.near, view.far);
  camera.position.set(view.position[0]!, view.position[1]!, view.position[2]!);
  camera.quaternion.set(view.quaternion[0]!, view.quaternion[1]!, view.quaternion[2]!, view.quaternion[3]!);
  camera.setManualExposure(-profile.colorManagement.exposure);
  scene.add(camera);
  return { scene, camera, options: { name: "Blender scene · ThreeRT", preset: "cinematic" as const,
    width: profile.render.resolutionX, height: profile.render.resolutionY,
    overrides: { post: { bloom: { intensity: profile.postprocessing?.bloom?.strength ?? 0,
      threshold: profile.postprocessing?.bloom?.threshold ?? 1.2 } } } } };
}
