import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import type { OutgoingHttpHeaders } from "node:http";

/** Skip tiny bodies — compression overhead isn't worth it. */
const MIN_BYTES = 256;

export type ContentEncoding = "br" | "gzip";

/** Prefer brotli when the client advertises it; else gzip. */
export function negotiateEncoding(acceptEncoding: string | string[] | undefined): ContentEncoding | undefined {
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? "");
  if (!raw || raw.trim() === "*") return undefined;
  const tokens = raw
    .split(",")
    .map((part) => {
      const [name, ...params] = part.trim().split(";").map((s) => s.trim());
      const q = params.find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { name: (name ?? "").toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((t) => t.name && t.quality > 0);
  const br = tokens.find((t) => t.name === "br");
  const gzip = tokens.find((t) => t.name === "gzip");
  if (br && (!gzip || br.quality >= gzip.quality)) return "br";
  if (gzip) return "gzip";
  return undefined;
}

export function isCompressible(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) return false;
  if (type === "application/octet-stream" || type === "application/zip" || type === "application/gzip") return false;
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    type === "image/svg+xml"
  );
}

export function compressBody(
  body: Buffer,
  acceptEncoding: string | string[] | undefined,
  contentType: string | undefined,
): { body: Buffer; encoding?: ContentEncoding } {
  if (body.length < MIN_BYTES || !isCompressible(contentType)) return { body };
  const encoding = negotiateEncoding(acceptEncoding);
  if (!encoding) return { body };
  const compressed =
    encoding === "br"
      ? brotliCompressSync(body, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        })
      : gzipSync(body, { level: 6 });
  // If compression grew the payload, keep the original.
  if (compressed.length >= body.length) return { body };
  return { body: compressed, encoding };
}

/** Merge Content-Encoding / Vary into response headers when compressed. */
export function withEncoding(headers: OutgoingHttpHeaders, encoding: ContentEncoding | undefined): OutgoingHttpHeaders {
  if (!encoding) return headers;
  const vary = headers.vary;
  const varyValue = vary == null ? "Accept-Encoding" : `${String(vary)}, Accept-Encoding`;
  return { ...headers, "content-encoding": encoding, vary: varyValue };
}
