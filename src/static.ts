import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com";

/**
 * Serves the built UI (web/dist): the file under `webDir`, else index.html for
 * client-side routes. Resolves false when there is nothing to serve (caller sends 404).
 */
export async function serveStatic(res: ServerResponse, webDir: string | undefined, url: string): Promise<boolean> {
  if (!webDir) return false;
  const root = resolve(webDir);
  const file = resolve(join(root, url === "/" ? "index.html" : decodeURIComponent(url)));
  if (file !== root && !file.startsWith(root + sep)) return false; // path traversal
  let body: Buffer;
  let type: string;
  try {
    body = await readFile(file);
    type = TYPES[extname(file)] ?? "application/octet-stream";
  } catch {
    if (url.startsWith("/assets/")) return false;
    try {
      body = await readFile(join(root, "index.html")); // SPA fallback
      type = TYPES[".html"]!;
    } catch {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("UI not built. Run: npm run build:web");
      return true;
    }
  }
  res.writeHead(200, { "content-type": type, "content-security-policy": CSP });
  res.end(body);
  return true;
}
