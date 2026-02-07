export type TraccarAuth =
  | { type: "basic"; username: string; password: string }
  | { type: "token"; token: string }
  | { type: "none" };

export type TraccarClientOptions = {
  baseUrl: string;
  secure: boolean;
  auth: TraccarAuth;
  fetchImpl?: typeof fetch;
};

export function buildAuthHeader(auth?: TraccarAuth) {
  if (!auth) return undefined;
  if (auth.type === "basic") {
    const b = btoa(`${auth.username}:${auth.password}`);
    return `Basic ${b}`;
  }
  if (auth.type === "token") {
    return `Bearer ${auth.token}`;
  }
  return undefined;
}

export async function performGet(fetcher: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetcher(url, { method: "GET", headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar fetch failed: ${res.status} ${res.statusText} - ${body}`);
  }
  return await res.json().catch(() => null);
}

export async function performPost(fetcher: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetcher(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const resBody = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar POST failed: ${res.status} ${res.statusText} - ${resBody}`);
  }
  return await res.json().catch(() => null);
}

export async function performPut(fetcher: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetcher(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const resBody = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar PUT failed: ${res.status} ${res.statusText} - ${resBody}`);
  }
  return await res.json().catch(() => null);
}

export async function performDelete(fetcher: typeof fetch, url: string, headers: Record<string, string>): Promise<void> {
  const res = await fetcher(url, { method: "DELETE", headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar DELETE failed: ${res.status} ${res.statusText} - ${body}`);
  }
}