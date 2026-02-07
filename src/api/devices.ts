import type { TraccarClientOptions } from "./httpUtils";
import { performGet, performPost, performPut, performDelete, buildAuthHeader } from "./httpUtils";

export type TraccarDevice = {
  id: number;
  name: string;
  emoji: string;
  lastSeen: number | null;
  attributes: Record<string, unknown>;
};

export async function fetchDevices(opts: TraccarClientOptions): Promise<TraccarDevice[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? 'https' : 'http';
  const base = `${protocol}://${opts.baseUrl}/api`;
  let url = `${base}/devices`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const json: unknown = await performGet(fetcher, url, headers);
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj["data"])) arr = obj["data"];
  }

  return arr.flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const o = d as Record<string, unknown>;

    const id = o["id"];
    if (typeof id !== "number") return [];

    const name = (typeof o["name"] === "string" ? o["name"] : null) ?? (typeof o["uniqueId"] === "string" ? o["uniqueId"] : null) ?? String(id);
    const attrs = typeof o["attributes"] === "object" ? (o["attributes"] as Record<string, unknown>) : {};
    const emoji = typeof attrs["emoji"] === "string" ? attrs["emoji"] : name.toUpperCase().charAt(0);

    const lastUpdate = o["lastUpdate"];
    const lastSeen = typeof lastUpdate === "string" ? Date.parse(lastUpdate) : null;

    return [{ id, name, emoji, lastSeen, attributes: attrs }];
  });
}

export async function createGroupDevice(
  opts: TraccarClientOptions,
  name: string,
  emoji: string,
  memberDeviceIds: number[]
): Promise<TraccarDevice> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? 'https' : 'http';
  const base = `${protocol}://${opts.baseUrl}/api`;
  const url = `${base}/devices`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

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

export async function updateGroupDevice(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: {
    name?: string;
    emoji?: string;
    color?: string;
    memberDeviceIds?: number[];
  }
): Promise<void> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? 'https' : 'http';
  const base = `${protocol}://${opts.baseUrl}/api`;
  const url = `${base}/devices/${deviceId}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  // Build the attributes object with updated values
  const attributes: Record<string, unknown> = {};
  if (updates.emoji !== undefined) attributes["emoji"] = updates.emoji;
  if (updates.color !== undefined) attributes["color"] = updates.color;
  if (updates.memberDeviceIds !== undefined) {
    attributes["memberDeviceIds"] = JSON.stringify(updates.memberDeviceIds);
  }

  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload["name"] = updates.name;
  if (Object.keys(attributes).length > 0) payload["attributes"] = attributes;

  await performPut(fetcher, url, headers, payload);
}

export async function updateDeviceAttributes(
  opts: TraccarClientOptions,
  deviceId: number,
  updates: Record<string, unknown>
): Promise<unknown> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? "https" : "http";
  const base = `${protocol}://${opts.baseUrl}/api`;
  const url = `${base}/devices/${deviceId}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const existing = await performGet(fetcher, url, headers);
  const device = (existing && typeof existing === "object") ? (existing as Record<string, unknown>) : {};
  const existingAttributes = (device["attributes"] && typeof device["attributes"] === "object")
    ? (device["attributes"] as Record<string, unknown>)
    : {};
  const attributes: Record<string, unknown> = { ...existingAttributes, ...updates };

  const payload: Record<string, unknown> = { ...device, attributes };
  return await performPut(fetcher, url, headers, payload);
}

export async function deleteGroupDevice(
  opts: TraccarClientOptions,
  deviceId: number
): Promise<void> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? 'https' : 'http';
  const base = `${protocol}://${opts.baseUrl}/api`;
  const url = `${base}/devices/${deviceId}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  await performDelete(fetcher, url, headers);
}