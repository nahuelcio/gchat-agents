import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleEvent, type ChatEvent, type HandlerDeps } from "./handler.js";

const MAX_BODY_BYTES = 1_000_000;

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createHttpServer(deps: HandlerDeps): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void (async () => {
      const url = req.url?.split("?")[0] ?? "";
      if (req.method === "GET" && url === "/healthz") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url === "/google/chat") {
        let event: ChatEvent;
        try {
          event = JSON.parse(await readBody(req)) as ChatEvent;
        } catch (err) {
          console.error("[http] bad request body:", err);
          send(res, 400, { error: "invalid JSON" });
          return;
        }
        try {
          // Google Chat requires a fast 2xx and retries errors; the actual
          // agent turn and reply happen in the background (see handler).
          const result = await handleEvent(req.headers.authorization, event, deps);
          void result.done.catch((err: unknown) => console.error("[handler] background error:", err));
          send(res, result.status, result.body);
        } catch (err) {
          console.error("[http] handler crashed:", err);
          send(res, 500, { error: "internal error" });
        }
        return;
      }
      send(res, 404, { error: "not found" });
    })();
  });
}
