import { performGet, performPost, performPut, performDelete, buildAuthHeader, type TraccarClientOptions } from "./httpUtils";
import type { Timestamp } from "@/types";

export type TraccarDevice = {
  id: number;
  name: string;
  emoji: string;
  lastSeen: Timestamp | null;
  attributes: Record<string, unknown>;
};

function buildHeaders(opts: TraccarClientOptions, json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (json) headers["Content-Type"] = "application/json";
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;
  return headers;
}

function buildBaseUrl(opts: TraccarClientOptions): string {
  const protocol = opts.secure ? "https" : "http";
  return `${protocol}://${opts.baseUrl}/api`;
}

function parseTraccarDevice(d: unknown): TraccarDevice | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;

  const id = typeof o["id"] === "number" ? o["id"] : undefined;
  if (id === undefined) return null;

  const name = (typeof o["name"] === "string" ? o["name"] : null) ??
    (typeof o["uniqueId"] === "string" ? o["uniqueId"] : null) ??
    String(id);
  const attrs = (o["attributes"] && typeof o["attributes"] === "object") ? (o["attributes"] as Record<string, unknown>) : {};
  const emoji = typeof attrs["emoji"] === "string" ? attrs["emoji"] : name.toUpperCase().charAt(0);

  const lastUpdate = o["lastUpdate"];
  const lastSeen = typeof lastUpdate === "string" ? Date.parse(lastUpdate) : null;

  return { id, name, emoji, lastSeen, attributes: attrs };
}

export async function fetchDevices(opts: TraccarClientOptions): Promise<TraccarDevice[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = buildBaseUrl(opts);
  const url = `${base}/devices`;
  const headers = buildHeaders(opts);

  const json: unknown = await performGet(fetcher, url, headers);
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj["data"])) arr = obj["data"];
  }

  return arr.flatMap(d => parseTraccarDevice(d) ?? []);
}

export async function createGroupDevice(
  opts: TraccarClientOptions,
  name: string,
  emoji: string,
  memberDeviceIds: number[]
): Promise<TraccarDevice> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = buildBaseUrl(opts);
  const url = `${base}/devices`;
  const headers = buildHeaders(opts, true);

  const payload = {
    name,
    uniqueId: `group-${Date.now()}`,
    attributes: {
      emoji,
      memberDeviceIds: JSON.stringify(memberDeviceIds),
    },
  };

  const json = await performPost(fetcher, url, headers, payload);
  if (!json || typeof json !== "object") {
    throw new Error("Failed to create group device");
  }
  const obj = json as Record<string, unknown>;
  return {
    id: typeof obj["id"] === "number" ? obj["id"] : 0,
    name: typeof obj["name"] === "string" ? obj["name"] : name,
    emoji: emoji,
    lastSeen: null,
    attributes: typeof obj["attributes"] === "object" ? (obj["attributes"] as Record<string, unknown>) : {},
  };
}

type DeviceUpdates = {
  name?: string;
  emoji?: string;
  color?: string | null;
  motionProfile?: string | null;
  memberDeviceIds?: number[];
};

async function fetchAndMergeAttributes(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: DeviceUpdates,
  notFoundError: string
): Promise<{ obj: Record<string, unknown>; attributes: Record<string, unknown> }> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = buildBaseUrl(opts);
  const url = `${base}/devices/${deviceId}`;
  const headers = buildHeaders(opts, true);

  const existing = await performGet(fetcher, url, headers);
  if (!existing || typeof existing !== "object") throw new Error(notFoundError);
  const obj = existing as Record<string, unknown>;

  const existingAttributes = (obj["attributes"] && typeof obj["attributes"] === "object")
    ? (obj["attributes"] as Record<string, unknown>)
    : {};
  const attributes: Record<string, unknown> = { ...existingAttributes };

  if (updates.emoji !== undefined) attributes["emoji"] = updates.emoji;
  if (updates.color !== undefined) attributes["color"] = updates.color;
  if (updates.motionProfile !== undefined) attributes["motionProfile"] = updates.motionProfile;
  if (updates.memberDeviceIds !== undefined) {
    attributes["memberDeviceIds"] = JSON.stringify(updates.memberDeviceIds);
  }

  return { obj, attributes };
}

async function updateDeviceBase(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: DeviceUpdates,
  notFoundError: string
): Promise<void> {
  const { obj, attributes } = await fetchAndMergeAttributes(opts, deviceId, updates, notFoundError);

  const payload: Record<string, unknown> = { ...obj, attributes };
  if (updates.name !== undefined) payload["name"] = updates.name;

  const fetcher = opts.fetchImpl ?? fetch;
  const base = buildBaseUrl(opts);
  const url = `${base}/devices/${deviceId}`;
  const headers = buildHeaders(opts, true);

  await performPut(fetcher, url, headers, payload);
}

export async function updateGroupDevice(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: DeviceUpdates
): Promise<void> {
  await updateDeviceBase(opts, deviceId, updates, "Group not found");
}

export async function updateDevice(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: Omit<DeviceUpdates, 'memberDeviceIds'>
): Promise<void> {
  await updateDeviceBase(opts, deviceId, updates, "Device not found");
}

export async function deleteGroupDevice(
  opts: TraccarClientOptions,
  deviceId: number
): Promise<void> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = buildBaseUrl(opts);
  const url = `${base}/devices/${deviceId}`;
  const headers = buildHeaders(opts);

  await performDelete(fetcher, url, headers);
}
