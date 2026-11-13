import { readFile, writeFile } from "node:fs/promises";

const value = process.argv[2] ?? process.env.PUBLIC_BASE_URL;
if (!value) throw new Error("Pass the deployed service URL: npm run configure -- URL");
const url = new URL(value);
if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("Remote MCP services require HTTPS.");
}
if (url.username || url.password || url.search || url.hash) {
  throw new Error("Use an origin without credentials, query parameters, or fragments.");
}
const manifest = JSON.parse(await readFile("mcp.json", "utf8"));
manifest.mcpServers["uni-blender-scene"].url = `${url.origin}/mcp`;
const claude = JSON.parse(await readFile("harnesses/claude-code/mcp.json", "utf8"));
claude.mcpServers["uni-blender-scene"].url = `${url.origin}/mcp`;
await writeFile("mcp.json", `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile("harnesses/claude-code/mcp.json", `${JSON.stringify(claude, null, 2)}\n`);
console.log(`Configured Codex and Claude Code at ${url.origin}/mcp; set PUBLIC_BASE_URL to the same origin.`);
