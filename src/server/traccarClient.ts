import { extractPositionsFromMessage } from "./traccarAdminUtils";
import type { NormalizedPosition, TraccarDevice, Timestamp, RawTraccarPosition } from "@/types";

type ServerStateDeps = {
  // Dependencies injected from server logic so this client can push data to it
  onPositionsReceived: (positions: NormalizedPosition[]) => void;
  onDevicesReceived: (devices: TraccarDevice[]) => void;
};

export class TraccarAdminClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private syncFlags = { rest: false, ws: false, logged: false };

  constructor(
    private readonly baseUrl: string,
    private readonly secure: boolean,
    private readonly token: string,
    private readonly deps: ServerStateDeps
  ) { }

  private checkSync() {
    if (this.syncFlags.rest && this.syncFlags.ws && !this.syncFlags.logged) {
      console.log("✨ Caught up with Traccar server");
      this.syncFlags.logged = true;
    }
  }

  connect() {
    if (this.destroyed || !this.baseUrl || !this.token) return;

    const protocol = this.secure ? "wss" : "ws";
    const wsUrl = `${protocol}://${this.baseUrl}/api/socket?token=${encodeURIComponent(this.token)}`;

    try {
      void this.fetchInitialDevices();
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("✅ Traccar Admin WebSocket connected");
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.syncFlags.ws = true;
        this.checkSync();
      };

      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as { devices?: TraccarDevice[]; positions?: unknown };
          if (data.devices) this.deps.onDevicesReceived(data.devices);
          if (data.positions) this.deps.onPositionsReceived(extractPositionsFromMessage(data));
        } catch (err) { console.error("Traccar processing error:", err); }
      };

      this.ws.onclose = () => !this.destroyed && this.scheduleReconnect();
      this.ws.onerror = (err) => console.error("Traccar Admin WS error:", err);
    } catch { this.scheduleReconnect(); }
  }

  private async fetchInitialDevices() {
    try {
      const res = await fetch(`${this.secure ? "https" : "http"}://${this.baseUrl}/api/devices`, {
        headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const devices = await res.json() as TraccarDevice[];
      console.log(`[TraccarAdminClient] Fetched ${devices.length} devices via REST`);
      this.syncFlags.rest = true;
      this.deps.onDevicesReceived(devices);
      this.checkSync();
    } catch (err) { console.error("Traccar REST error:", err); }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) {
      console.log("⚠️ Traccar Admin WS closed. Reconnecting in 5s...");
      this.reconnectTimer = setTimeout(() => (this.reconnectTimer = null, this.connect()), 5000);
    }
  }

  async fetchHistory(deviceId: number, from: number, to: number): Promise<NormalizedPosition[]> {
    const fromStr = new Date(from).toISOString();
    const toStr = new Date(to).toISOString();

    const params = new URLSearchParams();
    params.set("deviceId", deviceId.toString());
    params.set("from", fromStr);
    params.set("to", toStr);

    const url = `${this.secure ? "https" : "http"}://${this.baseUrl}/api/positions?${params.toString()}`;

    console.log(`[TraccarAdminClient] Fetching history for device ${deviceId} at ${url}`);

    try {
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const rawPositions = await res.json() as RawTraccarPosition[];
      const normalized = rawPositions
        .map(p => this.normalizePosition(p))
        .filter((p): p is NormalizedPosition => p !== null);

      console.log(`[TraccarAdminClient] Received ${normalized.length} historical positions for device ${deviceId}`);
      return normalized;
    } catch (err) {
      console.error(`[TraccarAdminClient] History fetch failed for device ${deviceId}:`, err);
      return [];
    }
  }

  private normalizePosition(raw: RawTraccarPosition): NormalizedPosition | null {
    if (!raw || typeof raw !== "object") return null;

    const { latitude, longitude, fixTime, deviceId, accuracy } = raw;
    if (typeof latitude !== "number" || typeof longitude !== "number") return null;

    const ts = typeof fixTime === "string" ? Date.parse(fixTime) :
      (typeof fixTime === "number" ? fixTime : undefined);
    if (ts === undefined || Number.isNaN(ts)) return null;

    return {
      device: deviceId,
      timestamp: ts as Timestamp,
      geo: [longitude, latitude],
      accuracy: typeof accuracy === "number" ? accuracy : 100,
    };
  }

  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
