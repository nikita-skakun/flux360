import { performRequest, buildAuthHeader, normalizeTraccarUrl, type TraccarClientOptions } from "./httpUtils";
import type { Timestamp } from "@/types";

export type TraccarDevice = {
  id: number;
  name: string;
  emoji: string;
  lastSeen: Timestamp | null;
  attributes: Record<string, unknown>;
};

export type TraccarUser = {
  id: number;
  name: string;
  email: string;
  token?: string;
  administrator: boolean;
  attributes: Record<string, unknown>;
};

type TraccarDeviceResponse = {
  id: number;
  name?: string;
  uniqueId?: string;
  lastUpdate?: string;
  attributes?: Record<string, unknown>;
};

function buildHeaders(opts: TraccarClientOptions, json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (json) headers["Content-Type"] = "application/json";
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;
  return headers;
}

function buildBaseUrl(opts: TraccarClientOptions): string {
  const normalized = normalizeTraccarUrl(opts.baseUrl ?? "");
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
  }
  return `${opts.secure ? "https" : "http"}://${normalized}/api`;
}

function parseTraccarDevice(d: unknown): TraccarDevice | null {
  if (!d || typeof d !== "object") return null;
  const o = d as TraccarDeviceResponse;
  const id = o.id;
  if (id === undefined) return null;

  const name = String(o.name ?? o.uniqueId ?? id);
  const attrs = (o.attributes && typeof o.attributes === "object") ? o.attributes : {};
  const emoji = typeof attrs["emoji"] === "string" ? attrs["emoji"] : name.charAt(0).toUpperCase();

  return {
    id,
    name,
    emoji,
    lastSeen: typeof o.lastUpdate === "string" ? Date.parse(o.lastUpdate) : null,
    attributes: attrs
  };
}

export async function fetchDevices(opts: TraccarClientOptions): Promise<TraccarDevice[]> {
  const res = await performRequest<TraccarDeviceResponse[] | { data: TraccarDeviceResponse[] }>(opts.fetchImpl ?? fetch, `${buildBaseUrl(opts)}/devices`, "GET", buildHeaders(opts));
  const arr = Array.isArray(res) ? res : (res?.data && Array.isArray(res.data) ? res.data : []);
  return arr.flatMap((d: unknown) => parseTraccarDevice(d) ?? []);
}

export async function createGroupDevice(
  opts: TraccarClientOptions,
  name: string,
  emoji: string,
  memberDeviceIds: number[]
): Promise<TraccarDevice> {
  const payload = { name, uniqueId: `group-${Date.now()}`, attributes: { emoji, memberDeviceIds: JSON.stringify(memberDeviceIds) } };
  const obj = await performRequest<TraccarDeviceResponse>(opts.fetchImpl ?? fetch, `${buildBaseUrl(opts)}/devices`, "POST", buildHeaders(opts, true), payload);
  return {
    id: obj?.id ?? 0,
    name: obj?.name ?? name,
    emoji,
    lastSeen: null,
    attributes: obj?.attributes ?? {},
  };
}

type DeviceUpdates = {
  name?: string;
  emoji?: string;
  color?: string | null;
  motionProfile?: string | null;
  memberDeviceIds?: number[];
};

async function updateDeviceBase(opts: TraccarClientOptions, deviceId: number, updates: DeviceUpdates, notFoundError: string): Promise<void> {
  const fetcher = opts.fetchImpl ?? fetch;
  const url = `${buildBaseUrl(opts)}/devices/${deviceId}`;
  const headers = buildHeaders(opts, true);

  const obj = await performRequest<TraccarDeviceResponse>(fetcher, url, "GET", headers);
  if (!obj) throw new Error(notFoundError);

  const attributes = { ...(obj.attributes ?? {}) };
  if (updates.emoji !== undefined) attributes["emoji"] = updates.emoji;
  if (updates.color !== undefined) attributes["color"] = updates.color;
  if (updates.motionProfile !== undefined) attributes["motionProfile"] = updates.motionProfile;
  if (updates.memberDeviceIds !== undefined) attributes["memberDeviceIds"] = JSON.stringify(updates.memberDeviceIds);

  await performRequest(fetcher, url, "PUT", headers, { ...obj, attributes, name: updates.name ?? obj.name });
}

export const updateGroupDevice = (opts: TraccarClientOptions, id: number, up: DeviceUpdates) => updateDeviceBase(opts, id, up, "Group not found");
export const updateDevice = (opts: TraccarClientOptions, id: number, up: Omit<DeviceUpdates, 'memberDeviceIds'>) => updateDeviceBase(opts, id, up, "Device not found");
export const deleteGroupDevice = (opts: TraccarClientOptions, id: number) => performRequest(opts.fetchImpl ?? fetch, `${buildBaseUrl(opts)}/devices/${id}`, "DELETE", buildHeaders(opts));

export async function fetchSession(opts: TraccarClientOptions): Promise<TraccarUser> {
  const fetcher = opts.fetchImpl ?? fetch;
  const url = `${buildBaseUrl(opts)}/session`;

  if (opts.auth?.type === "basic") {
    const params = new URLSearchParams({ email: opts.auth.username, password: opts.auth.password });
    const res = await fetcher(url, {
      method: "POST",
      headers: { ...buildHeaders(opts), "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      credentials: "include"
    });

    if (res.ok) {
      const user = (await res.json()) as TraccarUser;
      console.log("[Session] POST login successful.");
      if (!user.token) console.warn("[Session] No token returned.");
      return user;
    }
    throw new Error(`Login failed: ${res.status}`);
  }

  return performRequest<TraccarUser>(fetcher, url, "GET", buildHeaders(opts));
}
