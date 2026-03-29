export function getTraccarApiBase(baseUrl: string, secure: boolean): string {
  let host = baseUrl.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const protocol = secure ? "https" : "http";
  return `${protocol}://${host}/api`;
}
