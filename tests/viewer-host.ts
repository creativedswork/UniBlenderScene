import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const frame = document.getElementById("viewer") as HTMLIFrameElement;
const bridge = new AppBridge(null, { name: "Integration host", version: "1.0.0" }, {
  serverTools: {}, message: { text: {} }, openLinks: {},
}, { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
const snapshot = await (await fetch("/scene")).json();
bridge.oncalltool = async () => ({ content: [{ type: "text", text: "Scene progress" }], structuredContent: snapshot });
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
    bridge.sendToolResult({ content: [{ type: "text", text: "Scene result" }], structuredContent: snapshot }));
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = "/widget";
