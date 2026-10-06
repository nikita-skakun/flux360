/**
 * Client reconnect policy.
 *
 * The distinction that matters here is transport versus authentication. A socket that
 * never opened says nothing about whether the session is still valid, and a container
 * restart never completes inside a short retry budget, so a failure to connect must
 * never end the session. Only an explicit policy-violation close from the server, which
 * is a deliberate rejection of the session, does that.
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
export const UNAUTHENTICATED_RETRY_MS = 5_000;

export function reconnectDelayMs(attempt: number, authenticated: boolean): number {
  if (!authenticated) return UNAUTHENTICATED_RETRY_MS;
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/** 1008 is what the server sends when it has decided the session is invalid. */
export function isSessionRejection(closeCode: number): boolean {
  return closeCode === 1008;
}
