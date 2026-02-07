import type { TraccarAuth } from "./httpUtils";
import type { NormalizedPosition } from "./positions";
import { normalizePosition } from "./positions";

export type RealtimeConnectOptions = {
  baseUrl: string;
  secure: boolean;
  auth: TraccarAuth;
  onPosition?: (p: NormalizedPosition) => void;
  onPositions?: (ps: NormalizedPosition[]) => void;
  onOpen?: () => Promise<void>;
  onClose?: (ev?: CloseEvent) => void;
  onError?: (err: unknown) => void;
  autoReconnect: boolean;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
};

export function connectRealtime(opts: RealtimeConnectOptions): { close: () => void; requestPositions: (params: { deviceId: number; from?: Date; to?: Date; timeoutMs?: number; message?: object; }) => Promise<NormalizedPosition[]> } {
  let ws: WebSocket | null = null;
  let destroyed = false;
  let reconnectDelay = opts.reconnectInitialMs ?? 1000;

  type PendingRequest = { resolve: (ps: NormalizedPosition[]) => void; reject: (err: unknown) => void; timeoutId: ReturnType<typeof setTimeout>; matcher: (ps: NormalizedPosition[]) => boolean };
  const pendingRequests: PendingRequest[] = [];

  function buildWsUrl() {
    if (opts.baseUrl) {
      const protocol = opts.secure ? 'wss' : 'ws';
      return `${protocol}://${opts.baseUrl}/api/socket`;
    }
    return undefined;
  }

  function attachSocket() {
    if (destroyed) return;
    const base = buildWsUrl();
    if (!base) {
      opts.onError?.(new Error("No WebSocket URL provided; not connecting."));
      return;
    }

    let wsUrl = base;
    if (opts.auth?.type === "token") {
      const sep = wsUrl.includes("?") ? "&" : "?";
      wsUrl = `${wsUrl}${sep}token=${encodeURIComponent(opts.auth.token)}`;
    }

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      opts.onError?.(e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = opts.reconnectInitialMs ?? 1000;
      opts.onOpen?.().catch(() => { });
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const raw: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) as unknown : ev.data;
        const positions = extractPositionsFromMessage(raw);
        if (positions.length > 0) {
          for (const p of positions) opts.onPosition?.(p);
          opts.onPositions?.(positions);

          for (let i = pendingRequests.length - 1; i >= 0; i--) {
            const pr = pendingRequests[i];
            if (pr?.matcher(positions)) {
              clearTimeout(pr.timeoutId);
              pr.resolve(positions);
              pendingRequests.splice(i, 1);
            }
          }
        }
      } catch (e) {
        opts.onError?.(e);
      }
    };

    ws.onclose = (ev) => {
      ws = null;
      opts.onClose?.(ev);
      if (opts.autoReconnect !== false) scheduleReconnect();
    };

    ws.onerror = (ev) => {
      opts.onError?.(ev);
    };
  }

  function scheduleReconnect() {
    if (destroyed) return;
    setTimeout(() => {
      if (destroyed) return;
      attachSocket();
      reconnectDelay = Math.min((opts.reconnectMaxMs ?? 30_000), reconnectDelay * 2);
    }, reconnectDelay);
  }

  function requestPositions(params: { deviceId: number; from?: Date; to?: Date; timeoutMs?: number; message?: object }): Promise<NormalizedPosition[]> {
    return new Promise((resolve) => {
      if (!ws) {
        resolve([]);
        return;
      }

      const message = params.message ?? {
        action: "getPositions",
        deviceId: params.deviceId,
        from: params.from ? params.from.toISOString() : undefined,
        to: params.to ? params.to.toISOString() : undefined,
      };

      try {
        ws.send(JSON.stringify(message));
      } catch {
        // ignore send errors
        resolve([]);
        return;
      }

      const timeoutMs = params.timeoutMs ?? 2000;
      const timeoutId = setTimeout(() => {
        const idx = pendingRequests.findIndex((p) => p.timeoutId === timeoutId);
        if (idx >= 0) pendingRequests.splice(idx, 1);
        resolve([]);
      }, timeoutMs);

      pendingRequests.push({ resolve, reject: () => { }, timeoutId, matcher: (ps: NormalizedPosition[]) => ps.some((p) => p.device === params.deviceId) });
    });
  }

  attachSocket();

  return {
    close() {
      destroyed = true;
      ws?.close();
      ws = null;
    },
    requestPositions,
  };
}

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
    for (const k of ["positions", "data", "payload", "body", "message"]) {
      if (obj[k] !== undefined) walk(obj[k]);
    }
    for (const v of Object.values(obj)) walk(v);
  }

  walk(raw);
  return out;
}