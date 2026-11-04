import { execFileSync } from "node:child_process";
import { readdir, stat, rm, rename } from "node:fs/promises";
import { resolve } from "node:path";

const files: string[] = [];
const excluded = new Set(["node_modules", ".git", ".canova", ".env", "__pycache__", ".DS_Store"]);
async function collect(directory = "."): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || (entry.name.startsWith(".env") && entry.name !== ".env.example") ||
      entry.name.endsWith(".zip") || entry.name.endsWith(".log")) continue;
    const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collect(path);
    else files.push(path);
  }
}
await stat("dist/widget.html");
await collect();
const target = resolve("../CodexBlenderPlugin.zip");
const temporary = resolve("../CodexBlenderPlugin.build.zip");
await rm(temporary, { force: true });
execFileSync("zip", ["-q", "-@", temporary], { input: `${files.sort().join("\n")}\n` });
await rename(temporary, target);
console.log(target);
