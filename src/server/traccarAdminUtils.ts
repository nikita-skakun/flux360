import { normalizePosition } from "./serverUtils";
import type { NormalizedPosition } from "@/types";

export function extractPositionsFromMessage(raw: unknown): NormalizedPosition[] {
  if (!raw || typeof raw !== "object") return [];

  const obj = raw as { positions?: unknown; data?: { positions?: unknown } };
  const positions = Array.isArray(obj.positions)
    ? obj.positions
    : Array.isArray(obj.data?.positions)
      ? obj.data?.positions
      : [];

  return positions
    .map(p => normalizePosition(p))
    .filter((p): p is NonNullable<typeof p> => p !== null);
}
