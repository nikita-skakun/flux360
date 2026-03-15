import { normalizePosition } from "./serverUtils";
import type { NormalizedPosition } from "@/types";

export function extractPositionsFromMessage(raw: unknown): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];
  const visited = new WeakSet();

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }

    const tryNorm = normalizePosition(node);
    if (tryNorm) {
      out.push(tryNorm);
      return;
    }
    const obj = node as Record<string, unknown>;
    const searchKeys = ["positions", "data", "payload", "body", "message"] as const;
    for (const k of searchKeys) {
      if (k in obj) walk(obj[k]);
    }
    for (const v of Object.values(obj)) walk(v);
  }

  walk(raw);
  return out;
}
