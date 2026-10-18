import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressBody, isCompressible, negotiateEncoding } from "../src/compress.js";

describe("negotiateEncoding", () => {
  it("prefers brotli over gzip", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("br;q=0.8, gzip;q=1")).toBe("gzip");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding(undefined)).toBeUndefined();
  });
});

describe("compressBody", () => {
  it("skips tiny and binary payloads", () => {
    expect(compressBody(Buffer.from("hi"), "br", "application/json").encoding).toBeUndefined();
    expect(isCompressible("image/png")).toBe(false);
  });

  it("compresses JSON with brotli when accepted", () => {
    const raw = Buffer.from(JSON.stringify({ pad: "x".repeat(400) }));
    const packed = compressBody(raw, "br, gzip", "application/json");
    expect(packed.encoding).toBe("br");
    expect(packed.body.length).toBeLessThan(raw.length);
    expect(brotliDecompressSync(packed.body).equals(raw)).toBe(true);
  });

  it("falls back to gzip", () => {
    const raw = Buffer.from("y".repeat(400));
    const packed = compressBody(raw, "gzip", "text/plain");
    expect(packed.encoding).toBe("gzip");
    expect(gunzipSync(packed.body).equals(raw)).toBe(true);
  });
});
