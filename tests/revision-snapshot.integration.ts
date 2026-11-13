import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { BlenderClient, factorGuardCode, type RevisionScope } from "../src/service/blender.js";
import { SceneStore, type Scene, type SceneNode } from "../src/service/store.js";

// Explicit opt-in, never part of tests/*.test.ts or the synthetic Blender suite.
// node --import tsx tests/revision-snapshot.integration.ts \
//   --scene-directory /absolute/private/scene_directory --pc-code /absolute/private/repair.py
// Optional: --target-node computer --protected-node desk --blender-bin /absolute/Blender
// Supplied Python is trusted executable code, NOT sandboxed by this runner.
// Copying and source hashes detect changes; they cannot prevent arbitrary code writes.
// Only private copies are injected into SceneStore; no reviews/allowances are fabricated.
// Unpacked external Blender references are rejected before any guard/edit cases.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node --import tsx tests/revision-snapshot.integration.ts --scene-directory <absolute scene directory> --pc-code <absolute Python file> [--target-node <id>] [--protected-node <id>] [--blender-bin <binary>]";

function argumentsFromCLI() {
  const options = new Map<string, string>();
  const known = new Set(["--scene-directory", "--pc-code", "--target-node", "--protected-node", "--blender-bin"]);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return undefined;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    assert.ok(known.has(key) && value && !value.startsWith("--") && !options.has(key), usage);
    options.set(key, value);
  }
  const scene = options.get("--scene-directory"), code = options.get("--pc-code");
  assert.ok(scene && isAbsolute(scene) && code && isAbsolute(code), usage);
  return { scene, code, target: options.get("--target-node"), protected: options.get("--protected-node"),
    binary: options.get("--blender-bin") ?? process.env.BLENDER_BIN ??
      (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender") };
}

function scrubDiagnostic(value: unknown, paths: string[] = []): string {
  let text = String(value).replace(/https?:\/\/[^\s<>"']+/gi, "<url>");
  for (const path of [...paths, ...process.argv.slice(2), repository].filter((item) => isAbsolute(item)).sort((a, b) => b.length - a.length)) {
    text = text.split(path).join("<private-path>");
  }
  return text.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "<private-path>")
    .replace(/(^|[\s("'=])\/[^\s"'<>]+/g, "$1<private-path>")
    .replace(/\?[A-Za-z0-9_%.-]+=[^\s"'<>]+/g, "?<query>").slice(0, 4000);
}
async function runtimeRoot(): Promise<string> {
  // Canonicalize the trusted repository first, then reject existing symlinks at
  // each runtime-directory component before creating or using any directory.
  let root = await realpath(repository);
  for (const component of [".canova", "runs"]) {
    const candidate = join(root, component);
    let info;
    try { info = await lstat(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert.ok(!info || info.isDirectory() && !info.isSymbolicLink(), "Runtime directory must not be a symlink/non-directory.");
    if (!info) await mkdir(candidate);
    const canonical = await realpath(candidate);
    assert.equal(canonical, candidate, "Runtime directory resolved through a symlink.");
    root = canonical;
  }
  return root;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function sceneFile(directory: string, file: string): string {
  assert.ok(file && !isAbsolute(file) && inside(directory, resolve(directory, file)), "Scene artifact escapes its directory.");
  return resolve(directory, file);
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function manifest(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(folder: string) {
    for (const entry of (await readdir(folder)).sort()) {
      const path = join(folder, entry), info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), "Snapshot symlinks are not safe to copy.");
      if (info.isDirectory()) await walk(path);
      else {
        assert.ok(info.isFile(), "Snapshot contains a non-file entry.");
        files[relative(directory, path)] = await sha256(path);
      }
    }
  }
  await walk(directory);
  return files;
}
function liveRevision(scene: Scene) {
  const revision = scene.revisions?.find((item) => item.id === scene.activeRevisionId && item.status === "active");
  assert.ok(revision, "Source snapshot needs its own live bounded revision grant.");
  assert.ok(Number.isSafeInteger(revision.spent) && revision.spent >= 0 && revision.spent <= revision.additionalBudget,
    "Revision spend is outside the recorded grant.");
  return revision;
}
function counters(scene: Scene) {
  return { iteration: scene.iteration, contentIteration: scene.currentContentIteration,
    revisionSpent: liveRevision(scene).spent, stageAllowances: structuredClone(scene.stageAllowances ?? {}) };
}
function findNode(scene: Scene, id: string | undefined, label: RegExp, scoped: boolean): SceneNode {
  const ids = liveRevision(scene).request.scopeNodeIds;
  const candidates = (scene.plan?.graph ?? []).filter((node) => node.kind !== "group" &&
    ids.includes(node.id) === scoped && (id ? node.id === id : label.test(`${node.id} ${node.blenderObjectNames.join(" ")}`)));
  assert.equal(candidates.length, 1, "Specify an unambiguous --target-node / --protected-node matching the existing grant.");
  return candidates[0]!;
}
function scopeFrom(scene: Scene): RevisionScope {
  return { nodeIds: [...liveRevision(scene).request.scopeNodeIds],
    graphObjects: (scene.plan?.graph ?? []).map((node) => ({ nodeId: node.id, names: [...node.blenderObjectNames] })) };
}
async function validateRequiredFiles(scene: Scene, directory: string, files: Record<string, string>) {
  assert.ok(/^scene_[a-f0-9-]+$/.test(scene.id) && scene.id === basename(directory), "Scene ID/directory mismatch.");
  assert.ok(files["run.json"] && files["current.blend"] && files["checkpoint.blend"], "Missing baseline run/current/checkpoint files.");
  const blend = await open(sceneFile(directory, "current.blend"), "r");
  const header = Buffer.alloc(7);
  try { assert.equal((await blend.read(header, 0, 7, 0)).bytesRead, 7, "Truncated current.blend header."); }
  finally { await blend.close(); }
  // Blender can save plain, gzip-compressed, or Zstandard-compressed .blend files.
  assert.ok(header.toString() === "BLENDER" || header.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    header.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), "Invalid current.blend container header.");
  const required = [scene.render, ...(scene.reviewViews ?? []), ...(scene.references ?? []).map((ref) => ref.assetName),
    scene.reference && !(scene.references?.length) ? "reference" : undefined].filter((file): file is string => Boolean(file));
  if (scene.best) required.push("best.blend", "best.png");
  const revision = liveRevision(scene);
  assert.ok(revision.spent < revision.additionalBudget, "Source revision has no remaining allowance.");
  assert.ok(revision.checkpointHashes["current.blend"], "Live revision has no recorded baseline provenance.");
  required.push(`${revision.archive}/state.json`);
  for (const [file, hash] of Object.entries(revision.checkpointHashes)) {
    const archived = `${revision.archive}/${file}`;
    sceneFile(directory, archived);
    assert.equal(files[archived], hash, `Archived checkpoint SHA mismatch: ${file}`);
    required.push(archived);
  }
  for (const file of required) {
    sceneFile(directory, file);
    assert.ok(files[file], `Required scene file missing: ${file}`);
  }
  assert.equal(scene.stage, "edit", "Source must already be in editable revision state.");
  assert.ok(!scene.job || !["running", "queued"].includes(scene.job.status), "Source snapshot is not idle.");
  assert.ok(scene.graphReview?.checks.length && scene.graphReview.checks.every((check) => check.passed), "Source has no passing graph review; do not invent one.");
  assert.equal(scene.plan?.workflow?.stages[scene.workflowIndex ?? 0]?.name, "geometry", "PC vertex cases require the existing geometry grant.");
  assert.equal(revision.request.targetPhase, "geometry");
}

// Rebase only recorded scene-object artifact references, preserving their bytes/hash.
// Prior strategy history is retained too; no provider task or authorization is changed.
async function rebaseScene(source: Scene, sourceDirectory: string, destination: string, files: Record<string, string>) {
  const scene = structuredClone(source), paths: Record<string, string> = {};
  for (const strategy of [...(scene.assetStrategies ?? []), ...(scene.assetStrategyHistory ?? []).map((item) => item.strategy)]) {
    if (!strategy.artifactPath) continue;
    assert.ok(isAbsolute(strategy.artifactPath), "Recorded artifact path must be absolute.");
    const original = await realpath(strategy.artifactPath);
    assert.ok(inside(sourceDirectory, original), "Recorded provider artifact is outside the source scene.");
    const file = relative(sourceDirectory, original), replacement = sceneFile(destination, file);
    assert.ok(files[file], "Recorded provider artifact was not copied.");
    if (strategy.sha256) assert.equal(files[file], strategy.sha256, "Recorded provider artifact SHA mismatch.");
    assert.equal(await sha256(replacement), files[file], "Copied provider artifact SHA mismatch.");
    paths[strategy.artifactPath] = replacement;
    paths[original] = replacement;
    strategy.artifactPath = replacement;
  }
  return { scene, paths };
}
async function rebaseCode(client: BlenderClient, code: string, paths: Record<string, string>): Promise<string> {
  // AST offsets are UTF-8 byte offsets, not JS character positions. Edit only path
  // literal spans; preserve all remaining source exactly (including comments).
  const output = await client.execute(`
import ast, json, os
_source = ${JSON.stringify(code)}
_paths = json.loads(${JSON.stringify(JSON.stringify(paths))})
_lines = _source.encode('utf8').splitlines(keepends=True)
_offsets = [0]
for _line in _lines: _offsets.append(_offsets[-1] + len(_line))
_replacements = []
for _node in ast.walk(ast.parse(_source)):
    if isinstance(_node, ast.Constant) and isinstance(_node.value, str):
        if _node.value in _paths:
            _replacements.append((_offsets[_node.lineno-1]+_node.col_offset,
                _offsets[_node.end_lineno-1]+_node.end_col_offset, json.dumps(_paths[_node.value]).encode('utf8')))
        elif os.path.isabs(_node.value):
            raise RuntimeError('Unrecorded absolute path literal in supplied code; refusing execution')
_bytes = _source.encode('utf8')
for _start, _end, _value in sorted(_replacements, reverse=True): _bytes = _bytes[:_start]+_value+_bytes[_end:]
_rebased = _bytes.decode('utf8')
ast.parse(_rebased)
result = {'code': _rebased, 'pathLiteralsRebased': len(_replacements)}
`);
  assert.equal(typeof output.code, "string");
  return output.code as string;
}

async function rejectUnpackedExternalReferences(client: BlenderClient, blend: string): Promise<void> {
  // Check only the copied baseline. Do not rebase image data or prime mesh/RNA
  // payloads: the guard must see exactly the original cold inputs in every case.
  const result = await client.execute(`
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(blend)})
def _packed(item):
    return bool(getattr(item, 'packed_file', None) or len(getattr(item, 'packed_files', ())))
_count = 0
for _kind in ('libraries', 'images', 'fonts', 'sounds', 'movieclips', 'volumes', 'cache_files'):
    for _item in getattr(bpy.data, _kind, ()):
        _path = getattr(_item, 'filepath', '')
        if not _path or _path == '<builtin>' or _packed(_item): continue
        if _kind == 'images' and _item.source in {'GENERATED', 'VIEWER'}: continue
        # Even paths under the original scene would otherwise resolve outside
        # the case copy. Require packing rather than changing baseline guard data.
        _count += 1
result = {'unpackedExternalReferences': _count}
`);
  assert.equal(result.unpackedExternalReferences, 0, "Baseline has unpacked external Blender references; pack them in a separate authorized snapshot before running.");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port === 9877 ? freePort() : port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
async function dedicatedBridge(binary: string, directory: string) {
  const port = await freePort();
  const child = spawn(binary, ["--background", "--factory-startup", "--python", join(repository, "runtime/blender/bridge.py"), "--", "--port", String(port)],
    { cwd: directory, env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory, BLENDER_USER_CONFIG: join(directory, "blender-config") }, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(join(directory, "bridge.log"));
  // Observe stream rejection immediately; no unhandled error event/rejection.
  const logFinished = finished(log).then(() => undefined, (error: unknown) =>
    error instanceof Error ? error : new Error("Bridge log stream failed."));
  const logFailed = new Promise<never>((_, fail) => log.once("error", fail));
  void logFailed.catch(() => {});
  const outputsFinished = Promise.all([finished(child.stdout!), finished(child.stderr!)])
    .then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error("Bridge output stream failed."));
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  async function close() {
    await stop(child);
    const outputError = await outputsFinished;
    child.stdout!.unpipe(log); child.stderr!.unpipe(log);
    log.end();
    const logError = await logFinished;
    if (outputError) throw outputError;
    if (logError) throw logError;
  }
  try {
    await Promise.race([logFailed, new Promise<void>((done, fail) => {
      const timer = setTimeout(() => finish(new Error("Dedicated factory bridge readiness timed out.")), 60000);
      let text = "";
      const data = (bytes: Buffer) => { text += bytes.toString(); if (text.includes(`bridge ready on 127.0.0.1:${port}`)) finish(); };
      const error = (value: Error) => finish(value);
      const exit = (code: number | null) => finish(new Error(`Dedicated bridge exited before readiness (${code}).`));
      function finish(value?: Error) {
        clearTimeout(timer); child.stdout!.off("data", data); child.off("error", error); child.off("exit", exit);
        value ? fail(value) : done();
      }
      child.stdout!.on("data", data); child.once("error", error); child.once("exit", exit);
    })]);
    const wire = new BlenderClient("127.0.0.1", port, 590000);
    await Promise.race([logFailed, wire.execute("result={'factory':bpy.app.background,'objects':len(bpy.data.objects)}")])
      .then((value) => assert.deepEqual(value, { factory: true, objects: 3 }));
    // SceneStore also gets log failures rather than continuing silently.
    class LoggedClient extends BlenderClient {
      override execute(code: string) { return Promise.race([logFailed, wire.execute(code)]); }
    }
    return { client: new LoggedClient("127.0.0.1", port, 590000), close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new Error(`${error instanceof Error ? error.message : "Bridge failed"}; cleanup: ${cleanupError instanceof Error ? cleanupError.message : "failed"}`); }
    throw error;
  }
}
function memoryCode(name: string): string {
  // Independent test-only observation, not the guard under test. No open_mainfile
  // here: after rejection it must observe the memory restored by SceneStore itself.
  return `
import hashlib
from array import array
bpy.context.view_layer.update()
_obj = bpy.data.objects.get(${JSON.stringify(name)})
if _obj is None: raise RuntimeError('Protected graph object missing')
_coords = array('f', [0]) * (len(_obj.data.vertices)*3) if _obj.type=='MESH' else array('f')
if _obj.type=='MESH': _obj.data.vertices.foreach_get('co', _coords)
result={'name':_obj.name,'tag':_obj.get('scene_node_id'),'location':list(_obj.location),
    'matrixWorld':[list(row) for row in _obj.matrix_world], 'vertices':len(_coords)//3,
    'vertexSha256':hashlib.sha256(memoryview(_coords)).hexdigest(),
    'parent':_obj.parent.name if _obj.parent else None,'hideRender':_obj.hide_render,
    'materials':[slot.material.name if slot.material else None for slot in _obj.material_slots]}
`;
}

async function main(options: NonNullable<ReturnType<typeof argumentsFromCLI>>) {
  const sourceDirectory = await realpath(options.scene), codePath = await realpath(options.code);
  assert.ok((await lstat(sourceDirectory)).isDirectory() && (await lstat(codePath)).isFile(), usage);
  const runs = await runtimeRoot();
  assert.ok(sourceDirectory !== runs && !inside(sourceDirectory, runs), "Runtime root cannot be inside the source scene.");
  const runtime = await mkdtemp(join(runs, "revision-snapshot-"));
  const scrub = (value: unknown) => scrubDiagnostic(value, [sourceDirectory, codePath, runtime]);
  const reports: Record<string, unknown>[] = [];
  let failed = false;
  let bridge: Awaited<ReturnType<typeof dedicatedBridge>> | undefined;
  const sourceFiles = await manifest(sourceDirectory), sourceCodeHash = await sha256(codePath);
  const source = JSON.parse(await readFile(sceneFile(sourceDirectory, "run.json"), "utf8")) as Scene;
  try {
    await validateRequiredFiles(source, sourceDirectory, sourceFiles);
    const target = findNode(source, options.target, /^(?:computer|pc)\b|\b(?:ComputerAsset|PCAsset)\b/i, true);
    const protectedNode = findNode(source, options.protected, /^desk\b|\bDeskAsset\b/i, false);
    const targetName = target.blenderObjectNames[0], protectedName = protectedNode.blenderObjectNames[0];
    assert.ok(targetName && protectedName, "Target/protected nodes need recorded Blender object names.");
    const snapshot = join(runtime, "snapshot", source.id);
    await mkdir(dirname(snapshot), { recursive: true });
    await cp(sourceDirectory, snapshot, { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual(await manifest(snapshot), sourceFiles, "Copied snapshot differs from the original.");
    assert.deepEqual(await manifest(sourceDirectory), sourceFiles, "Source changed while capturing snapshot.");
    const originalCode = await readFile(codePath, "utf8");
    assert.equal(createHash("sha256").update(originalCode).digest("hex"), sourceCodeHash, "PC code changed while capturing it or is not UTF-8.");
    assert.equal(await sha256(codePath), sourceCodeHash);
    await writeFile(join(runtime, "input-code.py"), originalCode, { flag: "wx" });
    await writeFile(join(runtime, "provenance.json"), JSON.stringify({ sourceFiles, sourceCodeSha256: sourceCodeHash,
      baselineSha256: sourceFiles["current.blend"], checkpointSha256: sourceFiles["checkpoint.blend"],
      revisionCheckpointHashes: liveRevision(source).checkpointHashes }, null, 2));
    bridge = await dedicatedBridge(options.binary, runtime);
    const client = bridge.client;
    await rejectUnpackedExternalReferences(client, join(snapshot, "current.blend"));
    const baseline = sourceFiles["current.blend"]!;
    console.log(JSON.stringify({ event: "snapshot", copiedFiles: Object.keys(sourceFiles).length, baselineSha256: baseline,
      target: targetName, protected: protectedName, counters: counters(source), bridge: "fresh-factory-dedicated" }));

    async function coldCopy(name: string) {
      const root = join(runtime, name);
      await mkdir(root);
      // Constructor sees EMPTY root: never trigger production recovery/migration.
      const store = new SceneStore(root, client);
      assert.equal(store.scenes.size, 0);
      const directory = join(root, source.id);
      await cp(snapshot, directory, { recursive: true, force: false, errorOnExist: true });
      assert.deepEqual(await manifest(directory), sourceFiles, "Cold case copy mismatch.");
      const { scene, paths } = await rebaseScene(source, sourceDirectory, directory, sourceFiles);
      assert.notEqual(scene, source);
      store.scenes.set(scene.id, scene);
      assert.deepEqual(counters(scene), counters(source));
      await client.execute(`bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(join(directory, "current.blend"))})\nresult={}`);
      return { directory, store, scene, paths };
    }
    async function runCase(name: string, work: () => Promise<Record<string, unknown>>) {
      const started = Date.now();
      try {
        const result = await work();
        const report = { case: name, status: "PASS", seconds: (Date.now() - started)/1000, ...result };
        reports.push(report); console.log(JSON.stringify(report));
      } catch (error) {
        failed = true;
        const report = { case: name, status: "FAIL", seconds: (Date.now() - started)/1000, diagnostic: scrub(error instanceof Error ? error.message : error) };
        reports.push(report); console.log(JSON.stringify(report));
      }
    }
    await runCase("cold-before-pass-after", async () => {
      const { store, scene, directory } = await coldCopy("cold-before-pass-after");
      const beforeCounters = counters(scene);
      const [before, after] = factorGuardCode(store.workflowState(scene).phase ?? undefined, scene.compositionApproved, scopeFrom(scene));
      // Direct guard no-op is diagnostic ONLY; do not spend a real scene edit on pass.
      let rejection: unknown;
      try { await client.execute(`${before}\npass\n${after}\nresult={'guard':'accepted'}`); }
      catch (error) { rejection = error; }
      const afterCounters = counters(scene), currentHash = await sha256(join(directory, "current.blend"));
      console.log(JSON.stringify({ event: "guard-observation", beforeCounters, afterCounters, currentSha256: currentHash,
        diagnostic: rejection ? scrub(rejection instanceof Error ? rejection.message : rejection) : "" }));
      assert.deepEqual(afterCounters, beforeCounters);
      assert.equal(currentHash, baseline);
      if (rejection) throw rejection;
      return { counters: afterCounters, baselineSha256: baseline };
    });

    const positives = [
      { name: "location-only", code: `bpy.data.objects[${JSON.stringify(targetName)}].location.x += 0.001` },
      { name: "vertices-only", code: `_pc = bpy.data.objects[${JSON.stringify(targetName)}]\n_pc.data.vertices[0].co.x += 0.001\n_pc.data.update()` },
      { name: "exact-pc-code", code: undefined },
    ];
    for (const item of positives) await runCase(item.name, async () => {
      const { store, scene, directory, paths } = await coldCopy(item.name);
      const beforeCounters = counters(scene), protectedBefore = await client.execute(memoryCode(protectedName));
      const targetBefore = await client.execute(memoryCode(targetName));
      const code = item.code ?? await rebaseCode(client, originalCode, paths);
      await writeFile(join(runtime, `${item.name}.py`), code, { flag: "wx" });
      store.edit(scene.id, code);
      await store.settled();
      const afterCounters = counters(scene), currentHash = await sha256(join(directory, "current.blend"));
      const checkpointHash = await sha256(join(directory, "checkpoint.blend"));
      const protectedAfter = await client.execute(memoryCode(protectedName));
      const diagnostic = scrub(scene.error ?? scene.job?.error ?? "");
      console.log(JSON.stringify({ event: "edit-observation", case: item.name, job: scene.job?.status, beforeCounters, afterCounters,
        currentSha256: currentHash, checkpointSha256: checkpointHash, protectedMemoryUnchanged: JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore), diagnostic }));
      assert.equal(checkpointHash, baseline, "Edit checkpoint must be the cold baseline.");
      assert.deepEqual(protectedAfter, protectedBefore, "Protected object memory changed.");
      assert.equal(scene.pendingIteration, undefined, "Edit left a pending iteration.");
      assert.equal(scene.pendingAttempt, undefined, "Edit left a pending revision attempt.");
      if (scene.job?.status === "failed") {
        assert.deepEqual(afterCounters, beforeCounters, "Rejected edit spent allowance or iteration.");
        assert.equal(currentHash, baseline, "Rejected edit did not restore current.blend.");
        assert.deepEqual(await client.execute(memoryCode(targetName)), targetBefore, "Rejected edit did not restore target memory.");
      }
      assert.equal(scene.job?.status, "done", diagnostic || "PC-only SceneStore.edit did not succeed.");
      assert.equal(scene.stage, "review");
      assert.equal(scene.iteration, beforeCounters.iteration + 1);
      assert.equal(scene.currentContentIteration, scene.iteration);
      assert.equal(liveRevision(scene).spent, beforeCounters.revisionSpent + 1);
      assert.deepEqual(afterCounters.stageAllowances, beforeCounters.stageAllowances);
      assert.notEqual(currentHash, baseline, "Accepted edit did not change current.blend.");
      assert.notDeepEqual(await client.execute(memoryCode(targetName)), targetBefore, "Accepted edit left the PC unchanged.");
      return { counters: afterCounters, diagnostic, checkpointSha256: checkpointHash, currentSha256: currentHash };
    });
    await runCase("protected-object-negative", async () => {
      const { store, scene, directory } = await coldCopy("protected-object-negative");
      const beforeCounters = counters(scene), protectedBefore = await client.execute(memoryCode(protectedName));
      store.edit(scene.id, `bpy.data.objects[${JSON.stringify(protectedName)}].location.x += 0.125`);
      await store.settled();
      const diagnostic = scrub(scene.error ?? scene.job?.error ?? "");
      const currentHash = await sha256(join(directory, "current.blend")), checkpointHash = await sha256(join(directory, "checkpoint.blend"));
      const protectedAfter = await client.execute(memoryCode(protectedName));
      console.log(JSON.stringify({ event: "negative-observation", job: scene.job?.status, diagnostic, beforeCounters, afterCounters: counters(scene),
        currentSha256: currentHash, checkpointSha256: checkpointHash, protectedMemoryUnchanged: JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore) }));
      assert.equal(scene.job?.status, "failed", "Protected-object edit was accepted.");
      assert.match(diagnostic, /Revision scope violation/i, "Negative case was not rejected by bounded guard.");
      assert.deepEqual(counters(scene), beforeCounters, "Rejected edit spent allowance or iteration.");
      assert.equal(scene.stage, "edit");
      assert.equal(currentHash, baseline, "Rollback current.blend SHA mismatch.");
      assert.equal(checkpointHash, baseline, "Rollback checkpoint SHA mismatch.");
      assert.deepEqual(protectedAfter, protectedBefore, "SceneStore did not restore protected object in Blender memory.");
      assert.ok(diagnostic.includes(protectedName), "Guard diagnostic must name the protected object.");
      return { diagnostic, counters: counters(scene), rollbackSha256: currentHash, protectedMemoryUnchanged: true };
    });
    assert.deepEqual(await manifest(snapshot), sourceFiles, "Frozen test snapshot was modified.");
  } catch (error) {
    failed = true;
    const report = { case: "setup-or-finalization", status: "FAIL", diagnostic: scrub(error instanceof Error ? error.message : error) };
    reports.push(report); console.log(JSON.stringify(report));
  } finally {
    try { await bridge?.close(); }
    catch (error) {
      failed = true;
      const report = { case: "bridge-cleanup", status: "FAIL", diagnostic: scrub(error instanceof Error ? error.message : error) };
      reports.push(report); console.log(JSON.stringify(report));
    }
    // This detects changes to the chosen source, not a general Python sandbox.
    // Includes run.json, assets, renders, archives and every other source byte.
    try {
      assert.deepEqual(await manifest(sourceDirectory), sourceFiles, "IMMUTABLE ORIGINAL SOURCE CHANGED.");
      assert.equal(await sha256(codePath), sourceCodeHash, "ORIGINAL INPUT CODE CHANGED.");
      console.log(JSON.stringify({ event: "source-immutability", status: "PASS", files: Object.keys(sourceFiles).length }));
    } catch (error) {
      failed = true; reports.push({ case: "source-immutability", status: "FAIL", diagnostic: scrub(error) });
      console.log(JSON.stringify(reports.at(-1)));
    }
    await writeFile(join(runtime, "results.json"), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify({ event: "summary", status: failed ? "FAIL" : "PASS", runtimeDirectory: runtime,
      passed: reports.filter((item) => item.status === "PASS").length, failed: reports.filter((item) => item.status === "FAIL").length }));
    if (failed) process.exitCode = 1;
  }
}

try {
  const options = argumentsFromCLI();
  if (!options) console.log(usage);
  else await main(options);
} catch (error) {
  // Avoid echoing caller-supplied private arguments in an uncaught stack trace.
  console.error(scrubDiagnostic(error instanceof Error ? error.message : "Snapshot regression failed."));
  process.exitCode = 1;
}
