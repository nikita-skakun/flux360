import { db } from "./db";
import { SessionSchema } from "@/types";
import type { Session } from "@/types";

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const sessionStore = {
  createSession(username: string, traccarToken: string): string {
    const token = crypto.randomUUID();
    const now = Date.now();

    db.run(
      `INSERT INTO user_tokens (token, username, traccarToken, createdAt, lastActive) VALUES (?, ?, ?, ?, ?)`,
      [token, username, traccarToken, now, now]
    );

    return token;
  },

  getSession(token: string): Session | null {
    const row = db.query(`SELECT token, username, traccarToken, createdAt, lastActive FROM user_tokens WHERE token = ?`).get(token);
    if (!row) return null;

    const parsed = SessionSchema.safeParse(row);
    if (!parsed.success) {
      console.error("Invalid session in database:", parsed.error);
      db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
      return null;
    }
    const session = parsed.data;

    const now = Date.now();
    if (now - session.lastActive > SESSION_TTL) {
      db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
      return null;
    }

    // Update lastActive
    db.run(`UPDATE user_tokens SET lastActive = ? WHERE token = ?`, [now, token]);
    session.lastActive = now;

    return session;
  },

  deleteSession(token: string): void {
    db.run(`DELETE FROM user_tokens WHERE token = ?`, [token]);
  },

  cleanupExpired(): void {
    const cutoff = Date.now() - SESSION_TTL;
    db.run(`DELETE FROM user_tokens WHERE lastActive <= ?`, [cutoff]);
  }
};

// Periodically clean up expired sessions
setInterval(() => {
  sessionStore.cleanupExpired();
}, 60 * 60 * 1000); // every hour
