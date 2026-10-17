import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";

/** One attachment shown in a transcript message (bytes live in MediaStore). */
export interface MessageAttachment {
  id: string;
  contentType: string;
  name?: string;
}

export interface StoredMedia {
  id: string;
  path: string;
  contentType: string;
  name?: string;
}

interface MediaMeta {
  contentType: string;
  name?: string;
  file: string;
}

const ID_RE = /^[a-f0-9]{24}$/;

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

function extFor(contentType: string, name?: string): string {
  const fromName = name ? extname(name) : "";
  if (fromName && fromName.length <= 8) return fromName;
  return EXT[contentType.toLowerCase()] ?? "";
}

/** Local image files for chat: saved once, referenced by id in transcripts. */
export class MediaStore {
  readonly dir: string;

  constructor(dir: string) {
    // Absolute: agents run in their workspace, so a relative path (./data/media/...) would not resolve for them.
    this.dir = resolve(dir);
    mkdirSync(dir, { recursive: true });
  }

  async save(bytes: Buffer, contentType: string, name?: string): Promise<StoredMedia> {
    const id = randomBytes(12).toString("hex");
    const fileName = `${id}${extFor(contentType, name)}`;
    const path = join(this.dir, fileName);
    const meta: MediaMeta = { contentType, file: fileName, ...(name && { name }) };
    await writeFile(path, bytes);
    await writeFile(join(this.dir, `${id}.json`), `${JSON.stringify(meta)}\n`, "utf8");
    return { id, path, contentType, ...(name && { name }) };
  }

  async read(id: string): Promise<{ bytes: Buffer; contentType: string; name?: string } | undefined> {
    if (!ID_RE.test(id)) return undefined;
    const metaPath = join(this.dir, `${id}.json`);
    if (!existsSync(metaPath)) return undefined;
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as MediaMeta;
      const file = basename(meta.file);
      if (!file.startsWith(id)) return undefined;
      const bytes = await readFile(join(this.dir, file));
      return { bytes, contentType: meta.contentType, ...(meta.name && { name: meta.name }) };
    } catch {
      return undefined;
    }
  }
}

export function toMessageAttachment(m: StoredMedia): MessageAttachment {
  return { id: m.id, contentType: m.contentType, ...(m.name && { name: m.name }) };
}

/** Line the agent sees so its file tools can open the saved image. */
export function attachmentPromptLine(m: StoredMedia): string {
  const label = m.name ? `"${m.name}"` : m.contentType;
  return `[Attached ${m.contentType} ${label}: ${m.path}]`;
}

/** Serves one media file; returns false when the id is missing or bad. */
export async function serveMedia(res: ServerResponse, store: MediaStore, id: string): Promise<boolean> {
  const file = await store.read(id);
  if (!file) return false;
  res.writeHead(200, {
    "content-type": file.contentType,
    "cache-control": "private, max-age=86400",
    ...(file.name && { "content-disposition": `inline; filename="${file.name.replace(/"/g, "")}"` }),
  });
  res.end(file.bytes);
  return true;
}
