import { useState, useRef, useEffect } from "react";
import type { NormalizedPosition } from "@/types";

interface TraccarDevice {
  id: number;
  name: string;
  emoji: string;
  lastSeen: number | null;
  attributes: Record<string, unknown>;
}

type TraccarConnectionOptions = {
  baseUrl: string | null;
  secure: boolean;
  token: string | null;
  onDevices?: (devices: TraccarDevice[]) => Promise<void>;
};

export function useTraccarConnection(options: TraccarConnectionOptions) {
  const { baseUrl, secure, token, onDevices } = options;

  const [wsStatus, setWsStatus] = useState<"Unknown" | "Connecting" | "Connected" | "Disconnected" | "Error">("Unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  const clientCloseRef = useRef<(() => void) | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const positionsAllRef = useRef<NormalizedPosition[]>([]);
  const knownDevices = useRef<Set<number>>(new Set());
  const [updateCounter, setUpdateCounter] = useState(0);

  function dedupeKey(p: { device: number; timestamp: number; lat: number; lon: number }) {
    return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
  }

  useEffect(() => {
    if (!baseUrl) {
      clientCloseRef.current?.();
      setWsStatus("Disconnected");
      setWsError((prev) => (prev?.includes("No Base URL") ? prev : null));
      return;
    }

    setWsStatus("Connecting");
    setWsError(null);

    function insertSortedByTimestamp(arr: NormalizedPosition[], item: NormalizedPosition) {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((arr[mid]?.timestamp ?? 0) <= item.timestamp) lo = mid + 1;
        else hi = mid;
      }
      arr.splice(lo, 0, item);
    }

    clientCloseRef.current?.();

    void (async () => {
      try {
        const { connectRealtime } = await import("@/api/realtime");
        const { fetchPositions } = await import("@/api/positions");
        const { fetchDevices } = await import("@/api/devices");
        const client = connectRealtime({
          baseUrl: baseUrl ?? undefined,
          secure,
          auth: token ? { type: "token", token } : { type: "none" },
          autoReconnect: true,
          reconnectInitialMs: 1000,
          reconnectMaxMs: 30000,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seenRef.current.has(key)) return;
            seenRef.current.add(key);
            insertSortedByTimestamp(positionsAllRef.current, p);
            knownDevices.current.add(p.device);
            setUpdateCounter(c => c + 1);
          },
          onOpen: async (): Promise<void> => {
            setWsStatus("Connected");
            setWsError(null);
            const derivedBase = baseUrl ? { baseUrl, secure } : null;

            if (derivedBase) {
              const devices = await fetchDevices({ ...derivedBase, auth: token ? { type: "token", token } : { type: "none" } });
              if (onDevices) void onDevices(devices);
              for (const d of devices) {
                if (d?.id != null) {
                  knownDevices.current.add(d.id);
                }
              }
            }

            if (derivedBase) {
              const from = new Date(Math.max(0, Date.now() - 96 * 60 * 60 * 1000)); // 96 hours
              const to = new Date();
              const fetches = Array.from(knownDevices.current).map((deviceId) => {
                if (deviceId == null || Number.isNaN(deviceId)) return Promise.resolve([] as NormalizedPosition[]);
                return fetchPositions(
                  { ...derivedBase, auth: token ? { type: "token", token } : { type: "none" } },
                  deviceId,
                  from,
                  to,
                  {}
                );
              });

              const results = await Promise.allSettled(fetches);
              for (const res of results) {
                if (res.status !== "fulfilled") continue;
                for (const p of res.value) {
                  const key = dedupeKey(p);
                  if (seenRef.current.has(key)) continue;
                  seenRef.current.add(key);
                  positionsAllRef.current.push(p);
                }
              }
              setUpdateCounter(c => c + 1);
            }
          },
          onClose: (ev) => {
            const code = ev?.code;
            const reason = ev?.reason;
            const detail = code != null ? (reason ? `code=${code} reason=${reason}` : `code=${code}`) : "closed";
            setWsStatus((prev) => (prev === "Error" ? "Error" : "Disconnected"));
            setWsError((prev) => prev ?? `WebSocket closed: ${detail}`);
            console.warn("Traccar WS closed:", ev);
          },
          onError: (err) => {
            const message = err instanceof Event ? "WebSocket connection error (check URL/token and server)" : (err instanceof Error ? err.message : String(err));
            setWsStatus("Error");
            setWsError(message);
            console.warn("Traccar WS error:", err);
          },
        });

        clientCloseRef.current = () => {
          client.close();
        };
      } catch (e) {
        console.warn("Could not initialize realtime traccar client:", e);
        setWsStatus("Error");
        setWsError(String(e));
      }
    })();

    return () => {
      clientCloseRef.current?.();
    };
  }, [baseUrl, secure, token, wsApplyCounter]);

  const reconnect = () => {
    if (!baseUrl) {
      setWsStatus("Disconnected");
      setWsError("No Base URL configured");
    } else {
      setWsStatus("Connecting");
      setWsError(null);
      setWsApplyCounter((c) => c + 1);
    }
  };

  const disconnect = () => {
    clientCloseRef.current?.();
    setWsStatus("Disconnected");
  };

  return {
    wsStatus,
    wsError,
    positions: positionsAllRef.current,
    updateCounter,
    reconnect,
    disconnect,
  };
}