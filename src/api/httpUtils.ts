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

export function normalizeTraccarUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  // Remove trailing slashes and normalize /api suffix
  url = url.replace(/\/+$/, "");
  return url;
}

export function buildApiUrl(baseUrl: string, secure: boolean, path: string, params: Record<string, string> = {}, auth?: TraccarAuth): string {
  const normalized = normalizeTraccarUrl(baseUrl);
  const protocol = normalized.startsWith('http') ? '' : `${secure ? 'https' : 'http'}://`;
  const base = `${protocol}${normalized}`;
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  const combinedParams = { ...params };
  if (auth?.type === "token") {
    combinedParams["token"] = auth.token;
  }
  const qs = new URLSearchParams(combinedParams).toString();
  return `${base}/api${fullPath}${qs ? `?${qs}` : ''}`;
}

export async function performRequest<T = unknown>(
  fetcher: typeof fetch,
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  headers: Record<string, string>,
  body?: unknown
): Promise<T> {
  const options: RequestInit = {
    method,
    headers,
    credentials: "include",
  };
  if (body !== undefined) {
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetcher(url, options);
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar ${method} failed for ${url}: ${res.status} ${res.statusText} - ${errorBody}`);
  }

  if (method === "DELETE") return undefined as T;
  return (await res.json().catch(() => null)) as T;
}