export function getTraccarApiBase(baseUrl: string, secure: boolean): string {
  let host = baseUrl.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host.endsWith("/api") || host.includes("/api/")) {
    host = host.replace(/\/api\/?.*$/, "");
  }
  const protocol = secure ? "https" : "http";
  return `${protocol}://${host}/api`;
}
