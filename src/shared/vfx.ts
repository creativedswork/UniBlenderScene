// render-profile VFX uses GLB world coordinates (metres, Y up) and linear RGB.
export type Vec3 = [number, number, number];
export type Volume = {
  name: string;
  min?: Vec3;
  max?: Vec3;
  density: number;
  color: Vec3;
  anisotropy: number;
  emission?: Vec3;
  noiseScale?: number;
  height?: { mode: "linear" | "exponential"; start: number; depth: number; top?: number };
};

export type Precipitation = {
  name: string;
  kind: string;
  count: number;
  center: Vec3;
  size: Vec3;
  velocity: Vec3;
  period: number;
  lives: number;
  seed: number;
  radius: number;
  streak: number;
  sway: number;
  near: number;
  splash: number;
  ground: string[];
  color: Vec3;
  emission: Vec3;
};

type AnimatedProperty = { kind: "light"; name: string } | { kind: "emission"; name: string; material: string } | { kind: "environment" };

export type VfxAnimation = {
  time: number;
  times: number[];
  tracks: (AnimatedProperty & { initial?: number[]; values: number[][] })[];
};

export type VfxProfile = {
  volumes?: Volume[];
  precipitation?: Precipitation[];
  ripples?: { name: string; material: string; strength: number; coverage: number; scale: number }[];
  animation?: VfxAnimation;
};
