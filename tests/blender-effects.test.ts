import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

test("bundled Blender effects retain their pinned sources, license and reachable adapters", async () => {
  const manifest = JSON.parse(await readFile("skills/blender-effects/source.json", "utf8"));
  assert.equal(manifest.repository, "https://github.com/EL4CTEO/blender-skills");
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const license = await readFile("skills/blender-effects/LICENSE");
  assert.equal(hash(license), manifest.licenseSha256);
  assert.match(license.toString(), /Copyright \(c\) 2026 EL4CTEO/);
  const documents = [
    "skills/blender-effects/adapter.md",
    "skills/blender-scene/references/production-knowledge.md",
    "docs/blender-effects.md",
  ];
  for (const skill of manifest.skills) {
    assert.equal(skill.localPath, `skills/${skill.name}`);
    assert.equal(skill.sourcePath, skill.localPath);
    for (const [path, expected] of Object.entries(skill.files)) {
      const local = resolve(skill.localPath, path);
      assert.ok(local.startsWith(`${resolve(skill.localPath)}/`));
      assert.equal(hash(await readFile(local)), expected, `Upstream snapshot changed: ${local}`);
    }
    const entrypoint = `${skill.localPath}/SKILL.md`;
    const source = await readFile(entrypoint, "utf8");
    assert.ok(source.startsWith(`---\nname: ${skill.name}\n`));
    documents.push(entrypoint);
  }
  for (const document of documents) {
    const source = await readFile(document, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1]!;
      if (/^(?:https?:|#)/.test(link)) continue;
      const path = resolve(dirname(document), link.split("#")[0]!);
      await readFile(path); // Skill discovery must lead to bundled resources.
    }
  }
});
