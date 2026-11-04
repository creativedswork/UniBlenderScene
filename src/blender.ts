import { connect } from "node:net";

export class BlenderClient {
  constructor(
    private readonly host = process.env.BLENDER_MCP_HOST ?? "127.0.0.1",
    private readonly port = Number(process.env.BLENDER_MCP_PORT ?? "9877"),
    private readonly timeout = Number(process.env.BLENDER_TIMEOUT_MS ?? "300000"),
  ) {}

  execute(code: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let size = 0;
      socket.setTimeout(this.timeout);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ type: "execute", code, strict_json: true })}\0`),
      );
      socket.on("data", (chunk: Buffer) => {
        const end = chunk.indexOf(0);
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        size += chunk.length;
        if (size > 16 * 1024 * 1024) return fail(new Error("Blender response is too large."));
        if (end < 0) return;
        socket.destroy();
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.status !== "ok") {
            throw new Error(String(response.message ?? "Blender execution failed."));
          }
          resolve(response.result ?? {});
        } catch (error) {
          reject(error);
        }
      });
      socket.once("timeout", () => fail(new Error("Blender operation timed out.")));
      socket.once("error", fail);
      socket.once("end", () => reject(new Error("Blender disconnected before returning a result.")));
    });
  }
}

export function sceneSummaryCode(): string {
  return `
result = {
    "blenderVersion": bpy.app.version_string,
    "objects": [{"name": obj.name, "type": obj.type,
                 "location": list(obj.location), "dimensions": list(obj.dimensions)}
                for obj in bpy.context.scene.objects][:300],
    "camera": bpy.context.scene.camera.name if bpy.context.scene.camera else None,
    "world": bpy.context.scene.world.name if bpy.context.scene.world else None,
    "resolution": [bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y]
}`;
}

export function renderCode(path: string): string {
  return `
if bpy.context.scene.camera is None:
    raise RuntimeError("Set an active camera before rendering.")
bpy.context.scene.render.image_settings.file_format = "PNG"
bpy.context.scene.render.filepath = ${JSON.stringify(path)}
bpy.ops.render.render(write_still=True)
`;
}
