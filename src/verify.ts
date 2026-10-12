import { OAuth2Client } from "google-auth-library";

const CHAT_SYSTEM_ACCOUNT = "chat@system.gserviceaccount.com";

export interface TokenVerifier {
  /** Resolves if the Authorization header carries a valid Google-signed token, rejects otherwise. */
  verify(authHeader: string | undefined): Promise<void>;
}

/** Per Google Chat docs: "HTTP endpoint URL" audiences are URLs, "Project Number" audiences are numbers. */
export function audienceMode(audience: string): "url" | "project" {
  return /^https:\/\//.test(audience) ? "url" : "project";
}

/**
 * Verifies the bearer token Google Chat sends on every event, per
 * https://developers.google.com/workspace/chat/authenticate-authorize-chat-app#verify-http-header
 *
 * Two modes, picked by the shape of GOOGLE_TOKEN_AUDIENCE:
 * - "url" (connection setting = HTTP endpoint URL): the token is an OIDC ID
 *   token with aud = endpoint URL, issued by chat@system.gserviceaccount.com.
 * - "project" (connection setting = Project Number): the token is a JWT with
 *   aud = project number, signed by chat@system.gserviceaccount.com.
 */
export class GoogleTokenVerifier implements TokenVerifier {
  private audience: string;

  constructor(audience: string) {
    this.audience = audience;
  }

  async verify(authHeader: string | undefined): Promise<void> {
    const token = /^Bearer\s+(\S+)$/i.exec(authHeader ?? "")?.[1];
    if (!token) throw new Error("missing bearer token");

    const client = new OAuth2Client();
    if (audienceMode(this.audience) === "url") {
      const ticket = await client.verifyIdToken({ idToken: token, audience: this.audience });
      if (ticket.getPayload()?.email !== CHAT_SYSTEM_ACCOUNT) {
        throw new Error("token not issued by Google Chat");
      }
    } else {
      const { certs } = await client.getFederatedSignonCertsAsync();
      await client.verifySignedJwtWithCertsAsync(token, certs, this.audience, [CHAT_SYSTEM_ACCOUNT]);
    }
  }
}
