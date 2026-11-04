"""Run inside Blender; execute all bpy work on Blender's main thread."""

import argparse
import json
import queue
import socketserver
import sys
import threading

import bpy


requests = queue.Queue()


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(600)
        data = bytearray()
        while b"\0" not in data:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            data.extend(chunk)
            if len(data) > 2 * 1024 * 1024:
                return
        response = queue.Queue(maxsize=1)
        try:
            request = json.loads(data.split(b"\0", 1)[0])
            if request.get("type") != "execute" or not isinstance(request.get("code"), str):
                raise ValueError("Expected an execute request with Python code.")
            requests.put((request["code"], response))
            result = response.get(timeout=590)
        except Exception as error:
            result = {"status": "error", "message": str(error)}
        self.request.sendall(json.dumps(result, allow_nan=False).encode() + b"\0")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def execute_one(item):
    code, response = item
    try:
        namespace = {"bpy": bpy, "result": {}}
        exec(compile(code, "<codex-blender>", "exec"), namespace)
        result = namespace.get("result", {})
        json.dumps(result, allow_nan=False)
        response.put({"status": "ok", "result": result})
    except Exception as error:
        response.put({"status": "error", "message": f"{type(error).__name__}: {error}"})


def process_pending():
    while not requests.empty():
        execute_one(requests.get_nowait())
    return 0.05


arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=9877)
args = parser.parse_args(arguments)
server = Server(("127.0.0.1", args.port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"CodexBlenderPlugin bridge ready on 127.0.0.1:{args.port}", flush=True)

if bpy.app.background:
    while True:
        execute_one(requests.get())
else:
    bpy.app.timers.register(process_pending, persistent=True)
