import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const sceneToolNames = [
  "scene_create", "scene_plan", "scene_plan_review", "scene_asset_strategy", "scene_graph",
  "scene_edit", "scene_get", "scene_review", "scene_revise", "scene_review_decision",
  "scene_review_views", "scene_bake", "scene_export", "scene_render_high_quality",
  "scene_preview", "scene_view", "scene_asset_chunk", "scene_continue", "scene_experience",
  "scene_library_search", "scene_skill_propose", "scene_skill_validate", "scene_skill_activate",
];

export function checkSceneTools(tools: Pick<Tool, "name" | "inputSchema">[]): void {
  const missing = sceneToolNames.filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) throw new Error(`MCP tools unavailable: ${missing.join(", ")}`);
  function checkSchema(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (schema.type === "array" && (!schema.items || typeof schema.items !== "object" ||
      Array.isArray(schema.items) || schema.prefixItems)) {
      throw new Error(`Incompatible MCP array schema at ${path}: use one items schema with minItems/maxItems, not tuples. Update and restart the MCP service before reconnecting the host.`);
    }
    for (const [key, child] of Object.entries(schema)) checkSchema(child, `${path}.${key}`);
  }
  for (const tool of tools) checkSchema(tool.inputSchema, tool.name);
}
