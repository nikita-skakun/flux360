import { db } from "./db";

export async function getOrCreateTraccarPermanentToken(
  apiBase: string,
  username: string,
  password: string
): Promise<string> {
  // 1. Try to find in DB (return any valid non-expired token for this user)
  const row = db.query("SELECT traccarToken FROM user_tokens WHERE username = ? ORDER BY lastActive DESC LIMIT 1").get(username) as { traccarToken: string } | undefined;
  if (row?.traccarToken) return row.traccarToken;

  // 2. Not found, create a new one using the user's credentials via POST /api/session/token
  const authHeader = `Basic ${btoa(`${username}:${password}`)}`;

  const tokenRes = await fetch(`${apiBase}/session/token`, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({ expiration: "2038-01-01T00:00:00Z" }).toString()
  });

  if (!tokenRes.ok) throw new Error(`Failed to generate Traccar token: ${tokenRes.status}`);

  const newToken = await tokenRes.text();
  if (!newToken) throw new Error("Received empty token from Traccar");

  return newToken;
}
