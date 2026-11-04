import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const evidence = process.argv[2];
if (!evidence) throw new Error("Pass the evidenceDirectory printed by npm run test:blender.");
const root = resolve(evidence);
const snapshot = JSON.parse(await readFile(resolve(root, "scene.json"), "utf8"));
const files = new Map<string, string>();
const include = (url: string | null) => {
  if (!url) return;
  const path = new URL(url).pathname;
  const relative = path.replace(`/artifacts/${snapshot.id}/`, "");
  files.set(path, resolve(root, ".canova/runs", snapshot.id, relative));
};
include(snapshot.renderUrl); include(snapshot.bestRenderUrl);
snapshot.artifacts.forEach((item: { url: string }) => include(item.url));
const host = await build({ entryPoints: ["tests/viewer-host.ts"], bundle: true, platform: "browser", format: "esm", write: false });
const widget = await readFile("dist/widget.html");
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/favicon.ico") response.writeHead(204).end();
    else if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><html><head><title>MCP iframe integration</title></head><body style="margin:24px;font:14px system-ui;background:#eeede7"><iframe id="viewer" title="Blender scene" sandbox="allow-scripts allow-same-origin allow-downloads" style="width:850px;height:520px;border:1px solid #ccc;border-radius:12px"></iframe><p id="sent"></p><script type="module">${host.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
    } else if (path === "/widget") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:;",
      }).end(widget);
    } else if (path === "/scene") {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const rewrite = (url: string | null) => url ? `${origin}${new URL(url).pathname}` : null;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        ...snapshot, renderUrl: rewrite(snapshot.renderUrl), bestRenderUrl: rewrite(snapshot.bestRenderUrl),
        artifacts: snapshot.artifacts.map((item: { name: string; url: string }) => ({ ...item, url: rewrite(item.url) })),
      }));
    } else if (files.has(path)) {
      response.writeHead(200, { "Content-Type": path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : "application/octet-stream" }).end(await readFile(files.get(path)!));
    } else response.writeHead(404).end();
  } catch { response.writeHead(500).end(); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 780 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") console.error(entry.text()); });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const frame = page.frameLocator("#viewer");
  await frame.getByRole("button", { name: "3D", exact: true }).waitFor({ state: "visible" });
  try {
    await page.waitForFunction(() => {
      const frame = document.getElementById("viewer") as HTMLIFrameElement;
      return frame.contentDocument?.querySelector("#mode-3d")?.getAttribute("aria-pressed") === "true";
    }, undefined, { timeout: 60000 });
  } catch (error) {
    await page.screenshot({ path: resolve(root, "viewer-failure.png") });
    console.error(await frame.locator("body").innerText(), errors);
    throw error;
  }
  const canvas = frame.locator("canvas");
  assert.equal(await canvas.count(), 1);
  await page.waitForFunction(() => {
    const frame = document.getElementById("viewer") as HTMLIFrameElement;
    return frame.contentDocument?.querySelector("canvas")?.getAttribute("data-colorcalibrated") === "true";
  }, undefined, { timeout: 10000 });
  await canvas.screenshot({ path: resolve(root, "viewer-3d.png") });
  const first = await canvas.screenshot();
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 12 });
  await page.mouse.up();
  const moved = await canvas.screenshot();
  await writeFile(resolve(root, "viewer-orbit.png"), moved);
  assert.equal(first.equals(moved), false, "Orbit drag must change the rendered camera.");
  await frame.getByRole("button", { name: "Reset camera" }).click();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await writeFile(resolve(root, "viewer-orbit-side.png"), await canvas.screenshot());
  await frame.getByRole("button", { name: "Reset camera" }).click();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 16 });
  await page.mouse.up();
  await writeFile(resolve(root, "viewer-orbit-reverse.png"), await canvas.screenshot());
  await frame.getByRole("button", { name: "Reset camera" }).click();
  await frame.getByRole("button", { name: "Render", exact: true }).click();
  assert.equal(await frame.locator("#render").isVisible(), true);
  assert.equal(await frame.locator("#render").evaluate((image) => (image as HTMLImageElement).naturalWidth > 0), true,
    "Render image must contain decoded pixels, not a broken URL.");
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-render.png") });
  await frame.getByRole("button", { name: "3D", exact: true }).click();
  await frame.getByRole("textbox", { name: "Scene refinement" }).fill("Soften the light");
  await frame.getByRole("button", { name: "Refine", exact: true }).click();
  await page.getByText(`Refine Blender scene ${snapshot.id}: Soften the light`, { exact: true }).waitFor();
  await frame.getByRole("button", { name: "Expand viewer" }).click();
  await page.waitForFunction(() => (document.getElementById("viewer") as HTMLElement)?.style.height === "650px",
    undefined, { timeout: 10000 });
  assert.equal(await page.locator("#viewer").evaluate((element) => (element as HTMLElement).style.height), "650px");
  const [download] = await Promise.all([
    page.waitForEvent("download"), frame.getByRole("link", { name: "Download GLB", exact: true }).click(),
  ]);
  assert.equal(await download.failure(), null);
  const [blendDownload] = await Promise.all([
    page.waitForEvent("download"), frame.getByRole("link", { name: "Download Blender file", exact: true }).click(),
  ]);
  assert.equal(await blendDownload.failure(), null);
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-preview.png") });
  assert.deepEqual(errors, []);
  await writeFile(resolve(root, "viewer-report.json"), JSON.stringify({
    status: "passed", browser: browser.version(),
    checks: ["MCP AppBridge iframe handshake", "asset tool transfer with inaccessible direct URLs", "decoded render image", "WebGL GLB loading", "orbit drag", "camera reset", "render/3D switching", "refinement host message", "fullscreen request", "GLB and Blender downloads"],
    pageErrors: errors,
  }, null, 2));
  console.log(`Viewer integration passed; screenshots saved under ${root}`);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
