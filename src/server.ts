import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DetectedAgent } from "./agents.js";
import { handleEvent, processMessage, type ChatEvent, type HandlerDeps } from "./handler.js";
import { GUEST_COMMANDS, type ShareToken } from "./share.js";
import { serveStatic } from "./static.js";

/** The shared playground: a token-gated slice of the bridge on the public port. */
export interface ShareOptions {
  token: ShareToken;
  webDir?: string;
  agents: () => Promise<DetectedAgent[]>;
}

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

async function handlePlay(req: IncomingMessage, res: ServerResponse, url: string, deps: HandlerDeps, share: ShareOptions): Promise<void> {
  if (!url.startsWith("/play/api/")) {
    // The page itself is public; it holds no data and calls the token-gated API below.
    if (req.method === "GET" && (await serveStatic(res, share.webDir, url.startsWith("/assets/") ? url : "/"))) return;
    send(res, 404, { error: "not found" });
    return;
  }
  const auth = req.headers.authorization?.replace(/^Bearer /, "");
  if (!share.token.check(auth)) {
    send(res, 401, { error: "invalid or expired share link" });
    return;
  }
  if (req.method === "GET" && url === "/play/api/agents") {
    const agents = await share.agents().catch(() => []);
    send(res, 200, agents.filter((a) => a.supported && a.installed).map(({ id, name, ready }) => ({ id, name, ready })));
    return;
  }
  if (req.method === "POST" && url === "/play/api/send") {
    let body: { thread?: string; text?: string; name?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      send(res, 400, { error: "invalid JSON" });
      return;
    }
    const thread = body.thread ?? "";
    const text = body.text?.trim() ?? "";
    const name = (body.name?.trim() || "Guest").slice(0, 40);
    if (!/^[\w-]{8,40}$/.test(thread) || !text) {
      send(res, 400, { error: "thread and text are required" });
      return;
    }
    const replies: string[] = [];
    const { ok } = await processMessage(
      { threadKey: `share/${thread}`, spaceName: "shared", text, sender: name, reply: async (r) => void replies.push(r), allowCommands: GUEST_COMMANDS },
      deps,
    );
    send(res, 200, { ok, replies });
    return;
  }
  send(res, 404, { error: "not found" });
}

export function createHttpServer(deps: HandlerDeps, share?: ShareOptions): ReturnType<typeof createServer> {
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
      if (share && (url === "/play" || url.startsWith("/play/") || url.startsWith("/assets/"))) {
        await handlePlay(req, res, url, deps, share).catch((err: unknown) => {
          console.error("[play] request failed:", err);
          send(res, 500, { error: "internal error" });
        });
        return;
      }
      send(res, 404, { error: "not found" });
    })();
  });
}
