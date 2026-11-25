import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXCLUDED = new Set([".git", ".canova", "canova_output", ".env", "__pycache__", ".DS_Store"]);

/** Parse JSON or JSONC (line/block comments and trailing commas) as accepted by Cursor's mcp.json. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, "$1");
  const parsed: unknown = JSON.parse(withoutTrailingCommas);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object in Cursor mcp.json.");
  }
  return parsed as Record<string, unknown>;
}

async function copyPluginTree(source: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      EXCLUDED.has(entry.name) ||
      (entry.name.startsWith(".env") && entry.name !== ".env.example") ||
      entry.name.endsWith(".zip") ||
      entry.name.endsWith(".log")
    ) {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyPluginTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      const mode = (await lstat(from)).mode & 0o777;
      await chmod(to, mode);
    }
  }
}

function expandPluginRoot(value: unknown, pluginRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll("${CURSOR_PLUGIN_ROOT}", pluginRoot);
  if (Array.isArray(value)) return value.map((item) => expandPluginRoot(item, pluginRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPluginRoot(v, pluginRoot)]));
  }
  return value;
}

export interface InstallCursorOptions {
  sourceRoot?: string;
  cursorHome?: string;
}

export interface InstallCursorResult {
  pluginName: string;
  pluginDir: string;
  mcpConfigPath: string;
  mcpServerEntry: Record<string, unknown>;
}

export async function installCursorPlugin(options: InstallCursorOptions = {}): Promise<InstallCursorResult> {
  const sourceRoot = resolve(options.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const cursorHome = resolve(options.cursorHome ?? join(homedir(), ".cursor"));

  const widgetPath = join(sourceRoot, "dist/widget.html");
  try {
    await stat(widgetPath);
  } catch {
    throw new Error(`Missing built viewer at ${widgetPath}. Run "npm ci && npm run build" first or use the release ZIP.`);
  }

  const cursorManifest = JSON.parse(await readFile(join(sourceRoot, ".cursor-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
  const pluginName = String(cursorManifest.name ?? "uni-blender-scene");
  const pluginDir = join(cursorHome, "plugins/local", pluginName);

  const cursorMcp = JSON.parse(await readFile(join(sourceRoot, "harnesses/cursor/mcp.json"), "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  const rawServer = cursorMcp.mcpServers?.[pluginName];
  if (!rawServer) {
    throw new Error(`Missing mcpServers["${pluginName}"] in harnesses/cursor/mcp.json.`);
  }

  if (resolve(sourceRoot) !== resolve(pluginDir)) {
    const stagingDir = join(cursorHome, "plugins/local", `.${pluginName}.staging-${process.pid}-${Date.now()}`);
    try {
      await copyPluginTree(sourceRoot, stagingDir);
      await rm(pluginDir, { recursive: true, force: true });
      await mkdir(dirname(pluginDir), { recursive: true });
      const { rename } = await import("node:fs/promises");
      await rename(stagingDir, pluginDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Omit mcpServers from the installed local plugin copy so Cursor Desktop loads Skills/Rules/Agents
  // from the plugin while routing MCP through global ~/.cursor/mcp.json (required for MCP Apps inline views).
  const installedManifestPath = join(pluginDir, ".cursor-plugin/plugin.json");
  const installedManifest = { ...cursorManifest };
  delete installedManifest.mcpServers;
  await writeFile(installedManifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`);

  const mcpServerEntry = expandPluginRoot(rawServer, pluginDir) as Record<string, unknown>;
  delete mcpServerEntry.type;

  const mcpConfigPath = join(cursorHome, "mcp.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = parseJsonc(await readFile(mcpConfigPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existingServers = existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
    ? (existing.mcpServers as Record<string, unknown>)
    : {};
  const nextConfig = {
    ...existing,
    mcpServers: {
      ...existingServers,
      [pluginName]: mcpServerEntry,
    },
  };
  await mkdir(dirname(mcpConfigPath), { recursive: true });
  await writeFile(mcpConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  return { pluginName, pluginDir, mcpConfigPath, mcpServerEntry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await installCursorPlugin();
  console.log(`Installed Cursor plugin to ${result.pluginDir}`);
  console.log(`Registered global MCP server "${result.pluginName}" in ${result.mcpConfigPath}`);
  console.log("Restart Cursor or run 'Developer: Reload Window' to enable Skills, Rules, Subagents, and MCP Apps inline 3D views.");
}
