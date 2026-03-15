import { extractPositionsFromMessage } from "./traccarAdminUtils";
import { normalizePosition } from "./serverUtils";
import { TraccarDeviceSchema, RawTraccarPositionSchema } from "@/types";
import { vlog } from "@/util/logger";
import type { NormalizedPosition, TraccarDevice } from "@/types";

type ServerStateDeps = {
  // Dependencies injected from server logic so this client can push data to it
  onPositionsReceived: (positions: NormalizedPosition[]) => void;
  onDevicesReceived: (devices: TraccarDevice[]) => void;
};

export class TraccarAdminClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly secure: boolean,
    private readonly token: string,
    private readonly deps: ServerStateDeps
  ) { }

  connect() {
    if (this.destroyed || !this.baseUrl || !this.token) return;

    const protocol = this.secure ? "wss" : "ws";
    const wsUrl = `${protocol}://${this.baseUrl}/api/socket?token=${encodeURIComponent(this.token)}`;

    try {
      void this.fetchInitialDevices();
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        vlog("✅ Traccar Admin WebSocket connected");
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      };

      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string);
          if (data.devices) {
            this.deps.onDevicesReceived(TraccarDeviceSchema.array().parse(data.devices));
          }
          if (data.positions) {
            this.deps.onPositionsReceived(extractPositionsFromMessage(data));
          }
        } catch (err) { console.error("Traccar processing error:", err); }
      };

      this.ws.onclose = () => !this.destroyed && this.scheduleReconnect();
      this.ws.onerror = (err) => console.error("Traccar Admin WS error:", err);
    } catch { this.scheduleReconnect(); }
  }

  async fetchDevices(): Promise<TraccarDevice[]> {
    try {
      const res = await fetch(`${this.secure ? "https" : "http"}://${this.baseUrl}/api/devices`, {
        headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const devices = TraccarDeviceSchema.array().parse(await res.json());
      vlog(`[TraccarAdminClient] Fetched ${devices.length} devices via REST`);
      return devices;
    } catch (err) {
      console.error("[TraccarAdminClient] Devices fetch failed:", err);
      return [];
    }
  }

  private async fetchInitialDevices() {
    const devices = await this.fetchDevices();
    this.deps.onDevicesReceived(devices);
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) {
      vlog("⚠️ Traccar Admin WS closed. Reconnecting in 5s...");
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

    vlog(`[TraccarAdminClient] Fetching history for device ${deviceId} at ${url}`);

    try {
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const normalized = RawTraccarPositionSchema.array().parse(await res.json())
        .map(p => normalizePosition(p))
        .filter((p): p is NormalizedPosition => p !== null);

      vlog(`[TraccarAdminClient] Received ${normalized.length} historical positions for device ${deviceId}`);
      return normalized;
    } catch (err) {
      console.error(`[TraccarAdminClient] History fetch failed for device ${deviceId}:`, err);
      return [];
    }
  }

  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
