import { useState, useRef, useEffect } from "react";
import type { NormalizedPosition, Timestamp, Vec2 } from "@/types";
import type { TraccarAuth, TraccarClientOptions } from "@/api/httpUtils";
import type { TraccarDevice } from "@/api/devices";

type TraccarConnectionOptions = {
  baseUrl: string | null;
  secure: boolean;
  email: string | null;
  password: string | null;
  onDevices?: (devices: TraccarDevice[]) => Promise<void>;
  onPositions?: (positions: NormalizedPosition[]) => void;
};

export function useTraccarConnection(options: TraccarConnectionOptions) {
  const { baseUrl, secure, email, password, onDevices, onPositions } = options;

  const [wsStatus, setWsStatus] = useState<"Unknown" | "Connecting" | "Connected" | "Disconnected" | "Error">("Unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  const clientCloseRef = useRef<(() => void) | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const knownDevices = useRef<Set<number>>(new Set());

  function dedupeKey(p: { device: number; timestamp: Timestamp; geo: Vec2 }) {
    return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
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

    clientCloseRef.current?.();

    void (async () => {
      try {
        const { connectRealtime } = await import("@/api/realtime");
        const { fetchPositions } = await import("@/api/positions");
        const { fetchDevices, fetchSession } = await import("@/api/devices");

        let sessionToken: string | undefined;
        let sessionAuth: TraccarAuth = (email && password) ? { type: "basic", username: email, password } : { type: "none" };

        if (baseUrl && email && password) {
          try {
            setWsStatus("Connecting");
            const user = await fetchSession({ baseUrl, secure, auth: sessionAuth });
            sessionToken = user?.token;
            // Once session is established, we can rely on cookies for HTTP requests
            sessionAuth = { type: "none" };
            // Small delay for cookie processing
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            setWsError(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
            setWsStatus("Error");
            return;
          }
        }

        const client = connectRealtime({
          baseUrl: baseUrl ?? undefined,
          secure,
          auth: sessionAuth,
          token: sessionToken,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seenRef.current.has(key)) return;
            seenRef.current.add(key);
            knownDevices.current.add(p.device);
            if (onPositions) onPositions([p]);
          },
          onOpen: async () => {
            setWsStatus("Connected");
            setWsError(null);
            const opts: TraccarClientOptions = { baseUrl, secure, auth: sessionAuth };

            const devices = await fetchDevices(opts);
            if (onDevices) void onDevices(devices);
            devices.forEach(d => d.id != null && knownDevices.current.add(d.id));

            const from = new Date(Date.now() - 96 * 3600000); // 96h
            const res = await Promise.allSettled(Array.from(knownDevices.current).map(id => fetchPositions(opts, id, from, new Date(), {})));

            const pos = res.flatMap(r => r.status === "fulfilled" ? r.value : [])
              .filter(p => !seenRef.current.has(dedupeKey(p)));
            pos.forEach(p => seenRef.current.add(dedupeKey(p)));
            if (onPositions && pos.length > 0) onPositions(pos);
          },
          onClose: (ev) => {
            setWsStatus(prev => prev === "Error" ? "Error" : "Disconnected");
            setWsError(prev => prev ?? `WebSocket closed (code ${ev?.code ?? "unknown"})`);
          },
          onError: () => {
            setWsStatus("Error");
            setWsError("WebSocket connection error");
          },
        });

        clientCloseRef.current = () => client.close();
      } catch (e) {
        setWsStatus("Error");
        setWsError(String(e));
      }
    })();

    return () => {
      clientCloseRef.current?.();
    };
  }, [baseUrl, secure, email, password, wsApplyCounter]);

  const reconnect = () => {
    if (!baseUrl) {
      setWsStatus("Disconnected");
      setWsError("No Base URL configured");
    } else if (!email || !password) {
      setWsStatus("Disconnected");
      setWsError("No account credentials configured");
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
    reconnect,
    disconnect,
  };
}