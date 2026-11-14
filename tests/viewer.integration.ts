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
const reviewSnapshot = JSON.parse(await readFile(resolve(root, "composition.json"), "utf8"));
const workSnapshot = JSON.parse(await readFile(resolve(root, "geometry.json"), "utf8"));
const files = new Map<string, string>();
const include = (url: string | null) => {
  if (!url) return;
  const path = new URL(url).pathname;
  const relative = path.replace(/^\/artifacts\//, "");
  files.set(path, resolve(root, ".canova/runs", relative));
};
include(snapshot.renderUrl); include(snapshot.bestRenderUrl);
snapshot.references?.forEach((image: { url: string }) => include(image.url));
snapshot.artifacts.forEach((item: { url: string }) => include(item.url));
include(reviewSnapshot.renderUrl);include(reviewSnapshot.bestRenderUrl);
reviewSnapshot.artifacts.forEach((item:{url:string})=>include(item.url));
include(workSnapshot.renderUrl); include(workSnapshot.bestRenderUrl);
workSnapshot.artifacts.forEach((item: {url: string}) => include(item.url));
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
      }).end(widget.toString().replace("<head>", `<head><script>window.openai={uploadFile:async(file)=>({fileId:file.name}),getFileDownloadUrl:async({fileId})=>({downloadUrl:'https://files.oaiusercontent.com/'+encodeURIComponent(fileId)})};</script>`));
    } else if (path === "/scene") {
      const query = new URL(request.url!, "http://localhost").searchParams;
      const selected = query.has("review") ? reviewSnapshot : query.has("work") ? workSnapshot : snapshot;
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const rewrite = (url: string | null) => url ? `${origin}${new URL(url).pathname}` : null;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        ...selected, renderUrl: rewrite(selected.renderUrl), bestRenderUrl: rewrite(selected.bestRenderUrl),
        reference: selected.reference ? { ...selected.reference, url: rewrite(selected.reference.url) } : null,
        references: selected.references?.map((image: { url: string }) => ({ ...image, url: rewrite(image.url) })),
        artifacts: selected.artifacts.map((item: { name: string; url: string }) => ({ ...item, url: rewrite(item.url) })),
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
    const canvas = (document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelector("canvas");
    return Number(canvas?.getAttribute("data-samples")) >= 32;
  }, undefined, { timeout: 60000 });
  await frame.getByRole("button", { name: "Expand Studio" }).click();
  await frame.getByRole("treeitem", { name: "Red cube · object" }).waitFor();
  await frame.getByRole("treeitem", { name: "Red cube · object" }).click();
  await frame.locator("#selection-box").waitFor({ state: "visible" });
  assert.equal(await frame.locator("#selection-box").getAttribute("data-node-id"), "cube");
  assert.equal((await frame.locator("#selection-outline").getAttribute("d"))!.match(/M/g)?.length, 12);
  for (const axis of ["x", "y", "z"]) {
    assert.match((await frame.locator(`#selection-axis-${axis}`).getAttribute("d"))!, /^M.+L/);
    assert.equal(await frame.locator(`#selection-axis-${axis}`).getAttribute("marker-end"), `url(#axis-tip-${axis})`);
  }
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-node-selection.png") });
  await frame.getByRole("button", { name: "Clear selection", exact: true }).click();
  assert.equal(await frame.locator("#selection-box").isVisible(), false);
  // Reuse the screen position to exercise immediate re-selection after cancellation.
  const reselectBox = await frame.getByRole("treeitem", { name: "Red cube · object" }).boundingBox(); assert.ok(reselectBox);
  await page.mouse.click(reselectBox.x + reselectBox.width / 2, reselectBox.y + reselectBox.height / 2);
  assert.equal(await frame.getByRole("treeitem", { name: "Red cube · object" }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await frame.locator("#selection-box").isVisible(), false);

  await page.mouse.click(reselectBox.x + reselectBox.width / 2, reselectBox.y + reselectBox.height / 2);
  await canvas.click({ position: { x: 5, y: 5 } });
  assert.equal(await frame.locator("#selection-box").isVisible(), false, "Clicking empty viewport space clears the selection.");
  await frame.getByRole("button", { name: "Collapse Studio", exact: true }).click();
  const canvasSize = await canvas.boundingBox(); assert.ok(canvasSize);
  await canvas.click({ position: { x: canvasSize.width / 2, y: canvasSize.height / 2 } });
  assert.equal(await frame.locator("#selection-box").getAttribute("data-node-id"), "cube");
  assert.equal(await frame.getByRole("button", { name: "Collapse Studio", exact: true }).isVisible(), true, "Viewport selection expands tree ancestors.");
  assert.equal(await frame.getByRole("treeitem", { name: "Red cube · object" }).getAttribute("aria-selected"), "true");
  await frame.getByRole("treeitem", { name: "Studio · group" }).click();
  assert.equal(await frame.locator("#selection-label").textContent(), "Studio");
  assert.equal(await frame.locator("#selection-box").isVisible(), true);
  await page.waitForFunction(() => {
    const frame = document.getElementById("viewer") as HTMLIFrameElement;
    const canvas = frame.contentDocument?.querySelector("canvas");
    return canvas?.getAttribute("data-renderer") === "path-tracing" &&
      Number(canvas.getAttribute("data-samples")) >= 32;
  }, undefined, { timeout: 60000 });
  assert.equal(await canvas.getAttribute("data-bounces"), "8");
  assert.equal(await canvas.getAttribute("data-display-transform"), "blender-lut");
  assert.equal(await canvas.getAttribute("data-effects"), "bloom,haze,dust");
  assert.equal(await canvas.getAttribute("data-dust-lighting"), "sun-shadow");
  await canvas.screenshot({ path: resolve(root, "viewer-3d.png") });
  const first = await canvas.screenshot();
  const initialOutline = await frame.locator("#selection-outline").getAttribute("d");
  const initialAxis = await frame.locator("#selection-axis-x").getAttribute("d");
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 12 });
  await page.mouse.up();
  const moved = await canvas.screenshot();
  await writeFile(resolve(root, "viewer-orbit.png"), moved);
  assert.equal(first.equals(moved), false, "Orbit drag must change the rendered camera.");
  assert.notEqual(await frame.locator("#selection-outline").getAttribute("d"), initialOutline, "3D box edges follow orbit.");
  assert.notEqual(await frame.locator("#selection-axis-x").getAttribute("d"), initialAxis, "World axes follow orbit.");
  await frame.locator("#stage").screenshot({ path: resolve(root, "viewer-selection-orbit.png") });
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
  assert.equal(await frame.locator("#selection-box").isVisible(), false);
  assert.equal(await frame.locator("#render").isVisible(), true);
  assert.equal(await frame.locator("#render").evaluate((image) => (image as HTMLImageElement).naturalWidth > 0), true,
    "Render image must contain decoded pixels, not a broken URL.");
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-render.png") });
  await frame.getByRole("button", { name: "3D", exact: true }).click();
  assert.equal(await frame.locator("#selection-box").isVisible(), true);
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
  const views = frame.getByRole("combobox", { name: "Reference view", exact: true });
  assert.equal(await views.locator("option").count(), 2);
  await views.selectOption("reference-2");
  await frame.locator("#reference").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const image = (document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelector("#reference") as HTMLImageElement;
    return image?.alt === "Auxiliary: side" && image.naturalWidth > 0;
  });
  await frame.getByRole("button", { name: "Enlarge reference" }).click();
  assert.equal(await frame.locator("#reference-dialog").isVisible(), true);
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-references.png") });
  await frame.getByRole("button", { name: "Close reference" }).click();
  const inputBytes = await readFile(resolve(root, "render.png"));
  const imageFile = (name: string) => ({ name, mimeType: "image/png", buffer: inputBytes });
  await frame.locator("#file").setInputFiles([imageFile("front.png"), imageFile("side.png")]);
  await frame.getByRole("combobox", { name: "Primary view for a new scene" }).selectOption("1");
  await frame.getByRole("button", { name: "Create scene", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("sent")?.dataset.submission?.includes("scene_create"));
  const created = JSON.parse((await page.locator("#sent").getAttribute("data-submission"))!);
  assert.deepEqual(created.arguments.references.map((image: { file_name: string }) => image.file_name), ["side.png", "front.png"]);
  await frame.locator("#file").setInputFiles(Array.from({ length: 5 }, (_, index) => imageFile(`extra-${index}.png`)));
  await frame.getByRole("button", { name: "Add views to this scene" }).click();
  await frame.getByText("A scene can have at most 6 reference images in total.", { exact: true }).waitFor();
  assert.equal(JSON.parse((await page.locator("#sent").getAttribute("data-submission"))!).name, "scene_create");
  await frame.locator("#file").setInputFiles([imageFile("back.png")]);
  await frame.getByRole("button", { name: "Add views to this scene" }).click();
  await page.waitForFunction(() => document.getElementById("sent")?.dataset.submission?.includes("scene_continue"));
  const appended = JSON.parse((await page.locator("#sent").getAttribute("data-submission"))!);
  assert.equal(appended.arguments.sceneId, snapshot.id);
  assert.equal(appended.arguments.references[0].file_name, "back.png");
  await frame.locator("#file").setInputFiles(Array.from({ length: 7 }, (_, index) => imageFile(`image-${index}.png`)));
  await frame.getByText("Use up to 6 PNG, JPEG or WebP images, each at most 20 MB.", { exact: true }).waitFor();
  assert.equal(await frame.locator("#reference-upload").isVisible(), false);
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/?work=1`);
  await frame.locator("#review-panel").waitFor({ state: "visible" });
  assert.equal(await frame.locator("#review-approve").isVisible(), false, "Work drafts must not offer approval");
  assert.match(await frame.locator("#status").innerText(), /geometry.*work draft.*iteration 1.*structural/);
  await page.waitForFunction(() => {
    const canvas = (document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelector("canvas");
    return canvas?.dataset.previewMode === "structural" && Number(canvas.dataset.samples) >= 32;
  }, undefined, { timeout: 60000 });
  await page.locator("#viewer").screenshot({ path: resolve(root, "viewer-geometry-draft.png") });
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/?review=1`);
  await frame.locator("#review-panel").waitFor({state:"visible"});
  await page.waitForFunction(()=>{
    const images=(document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelectorAll<HTMLImageElement>("#review-images img");
    return images?.length===5 && Array.from(images).every(i=>i.naturalWidth>0);
  });
  await frame.getByRole("button", { name: "Render", exact: true }).click();
  await page.waitForFunction(() => {
    const image = (document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelector<HTMLImageElement>("#render");
    return image?.dataset.asset === "review-main.png" && image.naturalWidth > 0;
  });
  const colorLeaks = await frame.locator("#render").evaluate((element) => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 2) colored++;
    return colored;
  });
  assert.equal(colorLeaks, 0, "The main composition image must be grayscale");
  await frame.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = (document.getElementById("viewer") as HTMLIFrameElement).contentDocument?.querySelector("canvas");
    return canvas?.dataset.previewMode === "structural" && Number(canvas.dataset.samples) >= 32;
  }, undefined, { timeout: 60000 });
  await frame.locator("canvas").screenshot({ path: resolve(root, "viewer-structural-3d.png") });
  await page.locator("#viewer").screenshot({path:resolve(root,"viewer-composition.png")});
  await frame.locator("#review-panel").screenshot({path:resolve(root,"viewer-composition-panel.png")});
  await frame.locator("#review-feedback").fill("Window must be perpendicular to the desk");
  await frame.getByRole("button",{name:"Revise geometry",exact:true}).click();
  await page.waitForFunction(()=>document.getElementById("sent")?.dataset.decision?.includes('"approved":false'));
  assert.equal(JSON.parse((await page.locator("#sent").getAttribute("data-decision"))!).returnTo,"geometry");
  await page.reload();await frame.locator("#review-panel").waitFor({state:"visible"});
  await frame.getByRole("button",{name:"Approve",exact:true}).click();
  await page.waitForFunction(()=>document.getElementById("sent")?.dataset.decision?.includes('"approved":true'));
  assert.deepEqual(errors, []);
  await writeFile(resolve(root, "viewer-report.json"), JSON.stringify({
    status: "passed", browser: browser.version(),
    checks: ["MCP AppBridge iframe handshake", "world-space 12-edge selection box and XYZ arrows", "tree/viewport selection sync and parent group selection", "clear/Escape/empty-space deselection", "selection overlay follows orbit and render mode", "five real structural review images", "composition approve and revise-geometry controls", "asset tool transfer with inaccessible direct URLs", "decoded render image", "path tracing with Blender display LUT and 32 samples", "orbit drag", "camera reset", "render/3D switching", "refinement host message", "fullscreen request", "GLB and Blender downloads", "reference gallery and enlarged auxiliary image", "multi-file upload with primary view selection", "append reference views", "six-image input limit"],
    pageErrors: errors,
  }, null, 2));
  console.log(`Viewer integration passed; screenshots saved under ${root}`);
} catch (error) {
  console.error("Original viewer failure", error);
  const failed = browser.contexts()[0]?.pages()[0];
  if (failed) {
    await failed.screenshot({ path: resolve(root, "viewer-failure.png"), timeout: 5000 }).catch(() => {});
    console.error(await failed.frameLocator("#viewer").locator("body").innerText());
  }
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
