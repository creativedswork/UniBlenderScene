import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const frame = document.getElementById("viewer") as HTMLIFrameElement;
const bridge = new AppBridge(null, { name: "Integration host", version: "1.0.0" }, {
  serverTools: {}, message: { text: {} }, openLinks: {},
}, { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
const snapshot = await (await fetch("/scene")).json();
const inaccessible = (url: string | null) => url ? `http://127.0.0.1:1${new URL(url).pathname}` : null;
const widgetSnapshot = {
  ...snapshot,
  renderUrl: inaccessible(snapshot.renderUrl), bestRenderUrl: inaccessible(snapshot.bestRenderUrl),
  artifacts: snapshot.artifacts.map((item: { name: string; url: string }) => ({ ...item, url: inaccessible(item.url) })),
};
bridge.oncalltool = async ({ name, arguments: args }) => {
  if (name === "scene_asset_chunk") return { isError: true, content: [{ type: "text", text: "Tool list is stale" }] };
  const request = args as { asset?: { name: string; offset: number } };
  if (name !== "scene_view" || !request.asset) {
    return { content: [{ type: "text", text: "Scene progress" }], structuredContent: widgetSnapshot };
  }
  const input = request.asset;
  const url = input.name === "render" ? snapshot.renderUrl :
    input.name === "best.png" ? snapshot.bestRenderUrl :
    input.name === "reference" ? snapshot.reference?.url :
    snapshot.artifacts.find((item: { name: string }) => item.name === input.name)?.url;
  if (!url) return { isError: true, content: [{ type: "text", text: "Missing asset" }] };
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const chunk = bytes.subarray(input.offset, input.offset + 256 * 1024);
  let binary = "";
  for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
  return {
    content: [{ type: "text", text: "Scene asset chunk" }],
    structuredContent: { name: input.name, offset: input.offset, size: bytes.length,
      mimeType: input.name.endsWith(".png") || input.name === "render" ? "image/png" :
        input.name.endsWith(".json") ? "application/json" : "application/octet-stream", data: btoa(binary) },
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
