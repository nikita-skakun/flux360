/**
 * Names ending in `.localhost` are reserved for loopback and are resolved locally by
 * every browser, so a page at such an origin cannot be served from the internet. That
 * is what makes them safe to accept without configuration, and it is what allows
 * reaching the app through a proxy under a tag name instead of a forwarded port.
 */
export function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Same-origin guard for the websocket upgrade. Non-browser clients send no Origin header
 * and never reach this; only a browser-supplied origin is judged.
 */
export function isAllowedOrigin(origin: string): boolean {
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}
