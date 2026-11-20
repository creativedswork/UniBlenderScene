import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, stat, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

const excluded = new Set(["node_modules", ".git", ".canova", "canova_output", ".env", "__pycache__", ".DS_Store", ".package-lock.json"]);
async function collect(root: string, directory = ".", includeDependencies = false): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if ((excluded.has(entry.name) && !(includeDependencies && entry.name === "node_modules")) ||
      (entry.name.startsWith(".env") && entry.name !== ".env.example") ||
      entry.name.endsWith(".zip") || entry.name.endsWith(".log")) continue;
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(root, path, includeDependencies));
    else files.push(path);
  }
  return files;
}

async function stageRuntime(root: string, os: string, cpu: string) {
  await mkdir(root);
  for (const name of ["package.json", "package-lock.json"]) await cp(name, join(root, name));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--os", os, "--cpu", cpu],
    { cwd: root, stdio: "inherit" });
}

await stat("dist/widget.html");
await mkdir(".canova/runs", { recursive: true });
const staging = await mkdtemp(resolve(".canova/runs/package-"));
const runtime = join(staging, "runtime");
const target = resolve("../UniBlenderScene.zip");
const temporary = join(staging, "UniBlenderScene.zip");
try {
  const platforms = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"]] as const;
  const [os, cpu] = platforms[0];
  await stageRuntime(runtime, os, cpu);
  // Both the service and tsx use esbuild and resolve its native executable from their installed packages.
  for (const [platform, arch] of platforms.slice(1)) {
    const variant = join(staging, `${platform}-${arch}`);
    await stageRuntime(variant, platform, arch);
    for (const directory of ["node_modules/@esbuild", "node_modules/tsx/node_modules/@esbuild"]) {
      await cp(join(variant, directory), join(runtime, directory), { recursive: true });
    }
  }
  const files = await collect(".");
  const dependencies = await collect(runtime, "node_modules", true);
  execFileSync("zip", ["-q", "-@", temporary], { input: `${files.sort().join("\n")}\n` });
  execFileSync("zip", ["-q", "-@", temporary], { cwd: runtime, input: `${dependencies.sort().join("\n")}\n` });
  await rename(temporary, target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(target);
