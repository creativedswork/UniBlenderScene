import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ensureManagedService, localOrigin, pluginVersion } from "./managed-local.js";

const transport = new StdioServerTransport();
let startup: Promise<void> | undefined;
let protocolVersion: string | undefined;

function ensureService() {
  startup ??= ensureManagedService().finally(() => { startup = undefined; });
  return startup;
}

function post(message: JSONRPCMessage) {
  return fetch(`${localOrigin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "x-uni-blender-scene-version": pluginVersion,
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(60000),
  });
}

async function forward(message: JSONRPCMessage) {
  if ("method" in message && message.method === "initialize") await ensureService();
  const response = await post(message).catch(async error => {
    // A refused connection has not accepted the call. A disconnected in-flight call may already have run.
    if (error.cause?.code !== "ECONNREFUSED") throw error;
    await ensureService();
    return post(message);
  });
  if (response.status === 202 || response.status === 204) return;
  if (!response.ok) throw new Error(await response.text());
  const reply = await response.json();
  if ("method" in message && message.method === "initialize" && typeof reply.result?.protocolVersion === "string") {
    protocolVersion = reply.result.protocolVersion;
  }
  await transport.send(reply);
}

transport.onmessage = message => {
  void forward(message).catch(async error => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(detail);
    if ("method" in message && "id" in message) {
      await transport.send({ jsonrpc: "2.0", id: message.id, error: { code: ErrorCode.InternalError, message: detail } });
    }
  });
};
transport.onerror = error => console.error(error.message);
await transport.start();
