export const maxSunShafts = 8;
export const maxFogVolumes = 8;
export const maxViewerAssetBytes = 256 * 1024 * 1024;

type Vec3 = [number, number, number];

export type SunShaft = {
  name: string;
  start: Vec3;
  end: Vec3;
  radii: [number, number];
  density: number;
  albedo: Vec3;
  emission: Vec3;
  anisotropy: number;
};

export type FogVolume = {
  name: string;
  min: Vec3;
  max: Vec3;
  density: number;
  ramps: { axis: number; range: [number, number]; density: [number, number] }[];
  albedo: Vec3;
  emission: Vec3;
  anisotropy: number;
};

export type ExportEffects = {
  version: 1;
  sun?: { name: string; direction: Vec3; angularRadius: number; radiance: Vec3; inBackground: boolean };
  shafts: SunShaft[];
  fog: FogVolume[];
  issues: { object: string; effect: string; status: "approximate" | "missing";
    target?: "threejs" | "threeRT"; reason: string }[];
};
