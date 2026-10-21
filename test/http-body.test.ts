import { describe, expect, it } from "vite-plus/test";
import { gunzipSync } from "node:zlib";
import { encodeJsonBody } from "../web/src/http-body";

describe("encodeJsonBody", () => {
  it("leaves small JSON uncompressed", async () => {
    const encoded = await encodeJsonBody({ ok: true });
    expect(encoded.headers["content-encoding"]).toBeUndefined();
    expect(encoded.body).toBe('{"ok":true}');
  });

  it("gzips large JSON when CompressionStream exists", async () => {
    if (typeof CompressionStream === "undefined") return;
    const pad = "x".repeat(4000);
    const encoded = await encodeJsonBody({ pad });
    expect(encoded.headers["content-encoding"]).toBe("gzip");
    expect(encoded.body).toBeInstanceOf(ArrayBuffer);
    const raw = gunzipSync(Buffer.from(encoded.body as ArrayBuffer)).toString("utf8");
    expect(JSON.parse(raw)).toEqual({ pad });
  });
});
