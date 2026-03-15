import { db } from "./db";
import { SessionSchema } from "@/types";
import type { Session } from "@/types";

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const sessionStore = {
  createSession(username: string, traccarToken: string): string {
    const token = crypto.randomUUID();
    const now = Date.now();

    db.run(
      `INSERT INTO user_tokens (token, username, traccar_token, created_at, last_active) VALUES (?, ?, ?, ?, ?)`,
      [token, username, traccarToken, now, now]
    );

    return token;
  },

  getSession(token: string): Session | undefined {
    const row = db.query(`SELECT token, username, traccar_token as traccarToken, created_at as createdAt, last_active as lastActive FROM user_tokens WHERE token = ?`).get(token) as unknown;

    if (!row) return undefined;

    let session: Session;
    try {
      session = SessionSchema.parse(row);
    } catch (err) {
      console.error("Invalid session in database:", err);
      db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
      return undefined;
    }

    const now = Date.now();
    if (now - session.lastActive > SESSION_TTL) {
      db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
      return undefined;
    }

    // Update last_active
    db.run(`UPDATE user_tokens SET last_active = ? WHERE token = ?`, [now, token]);
    session.lastActive = now;

    return session;
  },

  deleteSession(token: string): void {
    db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
  },

  cleanupExpired(): void {
    const cutoff = Date.now() - SESSION_TTL;
    db.run(`DELETE FROM user_tokens WHERE last_active <= ?`, [cutoff]);
  }
};

// Periodically clean up expired sessions
setInterval(() => {
  sessionStore.cleanupExpired();
}, 60 * 60 * 1000); // every hour
