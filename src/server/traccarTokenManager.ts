import { db } from "./db";
import { getTraccarApiBase } from "./traccarUrlUtils";

export class TraccarTokenManager {
  private apiBase: string;

  constructor(traccarBaseUrl: string, traccarSecure: boolean) {
    this.apiBase = getTraccarApiBase(traccarBaseUrl, traccarSecure);
  }

  async getOrCreateTraccarPermanentToken(username: string, password?: string): Promise<string> {
    // 1. Try to find in DB (return any valid non-expired token for this user)
    const row = db.query("SELECT traccar_token FROM user_tokens WHERE username = ? ORDER BY last_active DESC LIMIT 1").get(username) as { traccar_token: string } | undefined;
    if (row?.traccar_token) {
      return row.traccar_token;
    }

    if (!password) {
      throw new Error(`Password required to generate new Traccar token for ${username}`);
    }

    // 2. Not found, create a new one using the user's credentials via POST /api/session/token
    const authHeader = `Basic ${btoa(`${username}:${password}`)}`;

    const tokenRes = await fetch(`${this.apiBase}/session/token`, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({ expiration: "2038-01-01T00:00:00Z" }).toString()
    });

    if (!tokenRes.ok) {
      throw new Error(`Failed to generate Traccar token: ${tokenRes.status}`);
    }

    const newToken = (await tokenRes.text()).trim();
    if (!newToken) throw new Error("Received empty token from Traccar");

    return newToken;
  }
}
