import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const frame = document.getElementById("viewer") as HTMLIFrameElement;
const bridge = new AppBridge(null, { name: "Integration host", version: "1.0.0" }, {
  serverTools: {}, message: { text: {} }, openLinks: {},
}, { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
const query = new URLSearchParams(location.search);
bridge.onopenlink = async ({ url }) => {
  document.getElementById("sent")!.dataset.browserUrl = url;
  return query.has("blockBrowser") ? { isError: true } : {};
};
const snapshot = await (await fetch(query.has("cameras") ? "/scene?cameras=1" : query.has("lightmap") ? "/scene?lightmap=1" : query.has("review") ? "/scene?review=1" : query.has("work") ? "/scene?work=1" : "/scene")).json();
const inaccessible = (url: string | null) => url ? `http://127.0.0.1:1${new URL(url).pathname}` : null;
const widgetSnapshot = {
  ...snapshot,
  renderUrl: inaccessible(snapshot.renderUrl), bestRenderUrl: inaccessible(snapshot.bestRenderUrl),
  reference: snapshot.reference ? { ...snapshot.reference, url: inaccessible(snapshot.reference.url) } : null,
  references: snapshot.references?.map((image: { url: string }) => ({ ...image, url: inaccessible(image.url) })),
  referenceCameras: snapshot.referenceCameras?.map((view: { renderUrl: string | null }) => ({ ...view, renderUrl: inaccessible(view.renderUrl) })),
  artifacts: snapshot.artifacts.map((item: { name: string; url: string }) => ({ ...item, url: inaccessible(item.url) })),
};
const assetBuffers = new Map<string, Promise<Uint8Array>>();
function loadAssetBytes(url: string): Promise<Uint8Array> {
  let pending = assetBuffers.get(url);
  if (!pending) {
    pending = fetch(url).then(async response => {
      if (!response.ok) throw new Error("Preview asset could not be loaded.");
      return new Uint8Array(await response.arrayBuffer());
    }).catch(error => { assetBuffers.delete(url); throw error; });
    assetBuffers.set(url, pending);
  }
  return pending;
}
bridge.oncalltool = async ({ name, arguments: args }) => {
  if (name === "scene_review_decision") {
    document.getElementById("sent")!.dataset.decision=JSON.stringify(args);
    widgetSnapshot.stage="edit";
    const decision = args as { approved: boolean; returnTo?: string };
    const phase = decision.approved ? "materials" : decision.returnTo ?? "composition";
    widgetSnapshot.workflowState = { phase, status: "edit", compositionApproved: decision.approved, presentation: {
      mode: ["geometry", "composition"].includes(phase) ? "structural" : "appearance",
      purpose: "work", source: "current", iteration: widgetSnapshot.iteration,
    } };
    widgetSnapshot.reviewViews = []; widgetSnapshot.artifacts = [];
    widgetSnapshot.renderUrl = null; widgetSnapshot.bestRenderUrl = null;
    return {content:[{type:"text",text:"Fixture review decision recorded"}],structuredContent:widgetSnapshot};
  }
  if (name === "scene_create" || name === "scene_continue") {
    document.getElementById("sent")!.dataset.submission = JSON.stringify({ name, arguments: args });
    return { content: [{ type: "text", text: "References accepted by integration host" }], structuredContent: widgetSnapshot };
  }
  if (name === "scene_asset_chunk") return { isError: true, content: [{ type: "text", text: "Tool list is stale" }] };
  const request = args as { asset?: { name: string; offset: number } };
  if (name !== "scene_view" || !request.asset) {
    return { content: [{ type: "text", text: "Scene progress" }], structuredContent: widgetSnapshot };
  }
  const input = request.asset;
  const reference = snapshot.references?.find((image: { assetName: string }) => image.assetName === input.name) ??
    (input.name === "reference" ? snapshot.reference : undefined);
  const url = input.name === "render" ? snapshot.renderUrl :
    input.name === "best.png" ? snapshot.bestRenderUrl :
    snapshot.references?.find((image: { assetName: string }) => image.assetName === input.name)?.url ??
    (input.name === "reference" ? snapshot.reference?.url : undefined) ??
    snapshot.referenceCameras?.find((view: { renderUrl: string | null }) =>
      view.renderUrl && new URL(view.renderUrl).pathname.split("/").at(-1) === input.name)?.renderUrl ??
    snapshot.artifacts.find((item: { name: string }) => item.name === input.name)?.url;
  if (!url) return { isError: true, content: [{ type: "text", text: "Missing asset" }] };
  const bytes = await loadAssetBytes(url);
  const chunk = bytes.subarray(input.offset, input.offset + 256 * 1024);
  let binary = "";
  for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
  return {
    content: [{ type: "text", text: "Scene asset chunk" }],
    structuredContent: { name: input.name, offset: input.offset, size: bytes.length,
      mimeType: reference?.mime ?? (input.name.endsWith(".png") || input.name === "render" ? "image/png" :
        input.name.endsWith(".json") ? "application/json" : "application/octet-stream"), data: btoa(binary) },
  };
};
bridge.onmessage = async ({ content }) => {
  document.getElementById("sent")!.textContent = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return {};
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  frame.style.height = mode === "fullscreen" ? "650px" : "520px";
  return { mode };
};
bridge.oninitialized = () => {
  void bridge.sendToolInput({ arguments: { sceneId: snapshot.id } }).then(() =>
    bridge.sendToolResult({ content: [{ type: "text", text: "Scene result" }], structuredContent: widgetSnapshot }));
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = "/widget";
