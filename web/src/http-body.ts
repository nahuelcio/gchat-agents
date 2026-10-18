/** Compress JSON request bodies when large enough (images as base64, etc.). */

const MIN_BYTES = 1024;

export type EncodedBody = {
  body: BodyInit;
  headers: Record<string, string>;
};

/** Gzip via CompressionStream when available and the payload shrinks. */
export async function encodeJsonBody(payload: unknown): Promise<EncodedBody> {
  const json = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (json.length < MIN_BYTES || typeof CompressionStream === "undefined") {
    return { body: json, headers };
  }
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).arrayBuffer();
    if (compressed.byteLength >= json.length) return { body: json, headers };
    return { body: compressed, headers: { ...headers, "content-encoding": "gzip" } };
  } catch {
    return { body: json, headers };
  }
}
