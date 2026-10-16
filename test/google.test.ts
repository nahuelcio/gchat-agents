import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GoogleConnection } from "../src/google.js";

const KEY = JSON.stringify({
  type: "service_account",
  project_id: "acme-chat",
  client_email: "bridge@acme-chat.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
});

async function setup(envValue?: string) {
  const dir = await mkdtemp(join(tmpdir(), "gchat-google-"));
  const posted: { space: string; text: string }[] = [];
  const conn = new GoogleConnection(join(dir, "google-sa.json"), envValue, () => ({
    postMessage: async (space, body) => void posted.push({ space, text: body.text }),
  }));
  return { conn, dir, posted };
}

describe("GoogleConnection", () => {
  it("starts unconfigured and refuses to post with a clear message", async () => {
    const { conn } = await setup();
    expect(conn.status()).toEqual({ configured: false, source: "none" });
    await expect(conn.postMessage("spaces/A", { text: "x" })).rejects.toThrow(/not connected/);
  });

  it("saves a pasted key (mode 600), reports who it is, and posts with it", async () => {
    const { conn, dir, posted } = await setup();
    const info = await conn.setKey(KEY);
    expect(info).toEqual({ configured: true, source: "ui", clientEmail: "bridge@acme-chat.iam.gserviceaccount.com", projectId: "acme-chat" });
    expect(statSync(join(dir, "google-sa.json")).mode & 0o777).toBe(0o600);
    await conn.postMessage("spaces/A", { text: "hi" });
    expect(posted).toEqual([{ space: "spaces/A", text: "hi" }]);
  });

  it("rejects anything that is not a service account key", async () => {
    const { conn } = await setup();
    await expect(conn.setKey("not json")).rejects.toThrow(/JSON/);
    await expect(conn.setKey(JSON.stringify({ type: "authorized_user" }))).rejects.toThrow(/service account/);
    expect(conn.status().configured).toBe(false);
  });

  it("reloads a saved key on restart and forgets it on clear", async () => {
    const { conn, dir } = await setup();
    await conn.setKey(KEY);
    const again = new GoogleConnection(join(dir, "google-sa.json"), undefined, () => ({ postMessage: async () => {} }));
    expect(again.status().clientEmail).toBe("bridge@acme-chat.iam.gserviceaccount.com");
    await again.clearKey();
    expect(again.status().configured).toBe(false);
  });

  it("lets the env var win and keeps the UI from replacing it", async () => {
    const { conn } = await setup(Buffer.from(KEY).toString("base64"));
    expect(conn.status()).toMatchObject({ configured: true, source: "env", projectId: "acme-chat" });
    await expect(conn.setKey(KEY)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});
