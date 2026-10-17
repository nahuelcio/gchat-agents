import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentPromptLine, MediaStore, toMessageAttachment } from "../src/media.js";

describe("MediaStore", () => {
  it("saves bytes and reads them back by id", async () => {
    const store = new MediaStore(await mkdtemp(join(tmpdir(), "gchat-media-")));
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const saved = await store.save(png, "image/png", "shot.png");
    expect(saved.id).toMatch(/^[a-f0-9]{24}$/);
    expect(toMessageAttachment(saved)).toEqual({ id: saved.id, contentType: "image/png", name: "shot.png" });
    expect(attachmentPromptLine(saved)).toContain(saved.path);
    const again = await store.read(saved.id);
    expect(again?.bytes.equals(png)).toBe(true);
    expect(again?.contentType).toBe("image/png");
    expect(again?.name).toBe("shot.png");
  });

  it("rejects bad ids", async () => {
    const store = new MediaStore(await mkdtemp(join(tmpdir(), "gchat-media-")));
    expect(await store.read("../etc/passwd")).toBeUndefined();
    expect(await store.read("zzz")).toBeUndefined();
  });
});
