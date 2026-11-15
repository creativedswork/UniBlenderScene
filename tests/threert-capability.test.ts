import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threeRTCapability } from "../src/service/threert.js";

test("ThreeRT distinguishes a missing engine, a static renderer and the live client", () => {
  const root = mkdtempSync(join(tmpdir(), "threert-capability-"));
  const before = process.env.THREERT_BIN;
  try {
    process.env.THREERT_BIN = join(root, "missing");
    assert.equal(threeRTCapability().available, false);
    assert.equal(threeRTCapability().liveAvailable, false);
    for (const name of ["threert-render", "threert"]) {
      const binary = join(root, name + (process.platform === "win32" ? ".exe" : ""));
      writeFileSync(binary, "", { mode: 0o755 });
      process.env.THREERT_BIN = binary;
      const capability = threeRTCapability();
      assert.equal(capability.available, true);
      assert.equal(capability.liveAvailable, name === "threert");
      if (name === "threert-render") assert.match(capability.liveReason!, /仅支持静态渲染/);
    }
  } finally {
    if (before === undefined) delete process.env.THREERT_BIN;
    else process.env.THREERT_BIN = before;
    rmSync(root, { recursive: true, force: true });
  }
});
