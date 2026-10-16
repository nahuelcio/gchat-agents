import { existsSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { HttpChatClient, type ChatClient, type PostMessageBody } from "./chat-client.js";

interface ServiceAccountKey {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export interface GoogleStatus {
  configured: boolean;
  /** env = GOOGLE_SERVICE_ACCOUNT_JSON (wins), ui = key saved from the control plane. */
  source: "env" | "ui" | "none";
  clientEmail?: string;
  projectId?: string;
}

function parseKey(raw: string): ServiceAccountKey {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new Error("That is not valid JSON. Paste the whole key file you downloaded from Google Cloud.");
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error("That JSON is not a service account key (it needs type service_account, client_email and private_key).");
  }
  return key;
}

/** Reads the env var the same way HttpChatClient does: a file path or base64 JSON. */
function readEnvKey(value: string): ServiceAccountKey | undefined {
  try {
    return JSON.parse(existsSync(value) ? readFileSync(value, "utf8") : Buffer.from(value, "base64").toString("utf8")) as ServiceAccountKey;
  } catch {
    return undefined;
  }
}

/**
 * The bridge's Google Chat connection, swappable at runtime: the control plane
 * can save or clear the service account key without a restart.
 */
export class GoogleConnection implements ChatClient {
  private keyFile: string;
  private envValue?: string;
  private makeClient: (credential: string) => ChatClient;
  private client?: ChatClient;
  private info: GoogleStatus = { configured: false, source: "none" };

  constructor(keyFile: string, envValue: string | undefined, makeClient: (credential: string) => ChatClient = (c) => new HttpChatClient(c)) {
    this.keyFile = keyFile;
    this.envValue = envValue;
    this.makeClient = makeClient;
    if (envValue) this.use(envValue, "env", readEnvKey(envValue));
    else if (existsSync(keyFile)) {
      try {
        this.use(keyFile, "ui", parseKey(readFileSync(keyFile, "utf8")));
      } catch (err) {
        console.error(`[google] ignoring ${keyFile}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private use(credential: string, source: "env" | "ui", key: ServiceAccountKey | undefined): GoogleStatus {
    this.client = this.makeClient(credential);
    this.info = {
      configured: true,
      source,
      ...(key?.client_email && { clientEmail: key.client_email }),
      ...(key?.project_id && { projectId: key.project_id }),
    };
    return this.info;
  }

  status(): GoogleStatus {
    return this.info;
  }

  async setKey(raw: string): Promise<GoogleStatus> {
    if (this.envValue) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set in the environment and takes precedence; remove it to manage the key here.");
    const key = parseKey(raw.trim());
    const tmp = `${this.keyFile}.${Date.now()}.tmp`;
    // 0600: this file is a credential.
    await writeFile(tmp, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.keyFile);
    return this.use(this.keyFile, "ui", key);
  }

  async clearKey(): Promise<void> {
    if (this.envValue) throw new Error("The key comes from GOOGLE_SERVICE_ACCOUNT_JSON; remove it from the environment instead.");
    await unlink(this.keyFile).catch(() => {});
    this.client = undefined;
    this.info = { configured: false, source: "none" };
  }

  async postMessage(spaceName: string, body: PostMessageBody): Promise<void> {
    if (!this.client) throw new Error("Google Chat is not connected: add a service account key in the control plane (Settings › Google Chat).");
    await this.client.postMessage(spaceName, body);
  }
}
