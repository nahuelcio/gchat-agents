import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "google-auth-library";

export interface PostMessageBody {
  text: string;
  thread?: { name?: string; threadKey?: string };
  /** Google Chat cards. Present when the agent asked a question with clickable options. */
  cardsV2?: {
    cardId: string;
    card: {
      header?: { title?: string; subtitle?: string };
      sections?: {
        widgets?: Record<string, unknown>[];
      }[];
    };
  }[];
}

export interface ChatClient {
  postMessage(spaceName: string, body: PostMessageBody): Promise<void>;
  /** Bytes of an uploaded Chat attachment (not Drive). Omitted on fakes that never ingest media. */
  downloadMedia?(resourceName: string): Promise<Buffer>;
}

const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

function authOptions(value: string): { keyFile: string } | { key: object } {
  if (existsSync(value)) return { keyFile: value };
  try {
    return { key: JSON.parse(Buffer.from(value, "base64").toString("utf8")) as object };
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON must be a readable file path or base64-encoded service account JSON",
    );
  }
}

/** Posts messages to Google Chat with a chat.bot-scoped service account. */
export class HttpChatClient implements ChatClient {
  private auth: GoogleAuth;

  constructor(serviceAccountJson: string) {
    this.auth = new GoogleAuth({ ...authOptions(serviceAccountJson), scopes: [CHAT_BOT_SCOPE] });
  }

  async postMessage(spaceName: string, body: PostMessageBody): Promise<void> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("could not obtain Google access token");
    const post = () =>
      // threadKey only groups replies with this option (otherwise every post opens a new thread).
      fetch(`https://chat.googleapis.com/v1/${spaceName}/messages${body.thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : ""}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        // Hard stop: a wedged call must not park this thread's queue slot.
        signal: AbortSignal.timeout(30_000),
      });
    let res = await post();
    // ponytail: one blind retry on transient failures; add backoff/jitter if rate limits bite.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      res = await post();
    }
    if (!res.ok) {
      throw new Error(`Chat API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
  }

  async downloadMedia(resourceName: string): Promise<Buffer> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("could not obtain Google access token");
    // resourceName is already the media path segment from attachmentDataRef.
    const res = await fetch(`https://chat.googleapis.com/v1/media/${resourceName}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Chat media ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
