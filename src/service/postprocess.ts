import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { BlenderClient } from "./blender.js";
import { fileHash } from "./experience.js";

export type LightingBake = { objectName: string; resolution: number; mode?: "appearance" | "lightmap"; samples?: number };
export type BakeResult = {
  id: string; sourceBlendSha256: string; pipelineHash: string; lightingEnabled: boolean;
  lightingBakes: LightingBake[]; directory: string; cacheHit: boolean;
  bakedObjects: string[]; bakedTints: Record<string, number[]>;
  lightmaps: { objectName: string; uri: string; uvChannel: number; scale: number; samples: number; resolution: number }[];
  materials: { objects: number; textures: number };
};

export function lightingBakeRequests(requests: LightingBake[]): LightingBake[] {
  const bakes = structuredClone(requests).sort((a, b) => a.objectName.localeCompare(b.objectName));
  if (bakes.length > 100 || new Set(bakes.map(item => item.objectName)).size !== bakes.length || bakes.some(item =>
    !item.objectName.trim() || item.objectName.length > 256 || !Number.isInteger(item.resolution) || item.resolution < 64 || item.resolution > 4096 ||
    item.mode !== undefined && !["appearance", "lightmap"].includes(item.mode) ||
    item.samples !== undefined && (!Number.isInteger(item.samples) || item.samples < 16 || item.samples > 1024))) {
    throw new Error("Lighting bakes need distinct mesh names, resolutions from 64 to 4096 and samples from 16 to 1024.");
  }
  return bakes;
}

/** Call inside SceneStore's serialized Blender queue; this never edits the source checkpoint. */
export async function prepareBake(blender: BlenderClient, source: string, sceneDirectory: string,
  lightingBakes: LightingBake[], lightingEnabled = true): Promise<BakeResult> {
  const template = readFileSync(new URL("../../runtime/blender/postprocess/bake.py", import.meta.url), "utf8");
  const pipelineHash = createHash("sha256").update(template).digest("hex");
  const info = { version: 1, sourceBlendSha256: fileHash(source), pipelineHash, lightingBakes, lightingEnabled };
  const id = createHash("sha256").update(JSON.stringify(info)).digest("hex");
  const directory = join(sceneDirectory, "postprocess", "bakes", id);
  const read = (): Omit<BakeResult, "directory" | "cacheHit"> | undefined => {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "bake.json"), "utf8"));
      if (metadata.id !== id || metadata.sourceBlendSha256 !== info.sourceBlendSha256 ||
          !existsSync(join(directory, "prepared.blend")) || !Array.isArray(metadata.lightmaps) || metadata.lightmaps.some((map: { uri: string }) =>
            !/^lightmap-\d+\.png$/.test(map.uri) || !existsSync(join(directory, map.uri)))) return;
      return metadata;
    } catch { return; }
  };
  let metadata = read();
  const cacheHit = Boolean(metadata);
  if (!metadata) {
    mkdirSync(directory, { recursive: true });
    rmSync(join(directory, "bake.json"), { force: true });
    const code = template.replace("__SOURCE_BLEND__", JSON.stringify(source))
      .replace("__OUTPUT_DIRECTORY__", JSON.stringify(directory))
      .replace("__LIGHTING_BAKES__", JSON.stringify(lightingBakes))
      .replace("__LIGHTING_ENABLED__", lightingEnabled ? "True" : "False")
      .replace("__BAKE_INFO_JSON__", JSON.stringify(JSON.stringify({ ...info, id })));
    await blender.execute(code);
    metadata = read();
    if (!metadata) throw new Error("Baking did not produce a complete scene copy and lightmap report.");
  }
  return { ...metadata, directory: relative(sceneDirectory, directory).replaceAll("\\", "/"), cacheHit };
}
