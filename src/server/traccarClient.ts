import { getTraccarApiBase } from "./traccarUrlUtils";
import { normalizePosition } from "./serverUtils";
import { TraccarDeviceSchema } from "@/types";
import { vlog } from "@/util/logger";
import type { RawGpsPosition, TraccarDevice } from "@/types";

type ServerStateDeps = {
  // Dependencies injected from server logic so this client can push data to it
  onPositionsReceived: (positions: RawGpsPosition[]) => void;
  onDevicesReceived: (devices: TraccarDevice[]) => void;
};

function extractPositionsFromMessage(raw: unknown): RawGpsPosition[] {
  return (raw as { positions: unknown[]; }).positions
    .map(p => normalizePosition(p))
    .filter((p): p is RawGpsPosition => p !== null);
}

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
    try {
      this.ws = new WebSocket(`${this.secure ? "wss" : "ws"}://${this.baseUrl}/api/socket?token=${encodeURIComponent(this.token)}`);

      this.ws.onopen = () => {
        vlog("✅ Traccar Admin WebSocket connected");
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      };

      void this.fetchInitialDevices();

      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as { devices?: unknown; positions?: unknown };
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
    const res = await fetch(`${getTraccarApiBase(this.baseUrl, this.secure)}/devices`, {
      headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
    });
    if (!res.ok) {
      console.error("[TraccarAdminClient] Devices fetch failed with HTTP", res.status, res.statusText);
      return [];
    }
    const parsed = TraccarDeviceSchema.array().safeParse(await res.json());
    if (!parsed.success) {
      console.error("[TraccarAdminClient] Devices fetch failed schema validation:", parsed.error);
      return [];
    }
    vlog(`[TraccarAdminClient] Fetched ${parsed.data.length} devices via REST`);
    return parsed.data;
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

  async fetchHistory(deviceId: number, from: number, to: number): Promise<RawGpsPosition[]> {
    const params = new URLSearchParams();
    params.set("deviceId", deviceId.toString());
    params.set("from", new Date(from).toISOString());
    params.set("to", new Date(to).toISOString());

    const url = `${getTraccarApiBase(this.baseUrl, this.secure)}/positions?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${this.token}`, "Accept": "application/json" }
    });

    if (!res.ok) {
      console.error(`[TraccarAdminClient] Fetch failed for device ${deviceId} with HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const normalized = (await res.json() as unknown[])
      .map(p => normalizePosition(p))
      .filter((p): p is RawGpsPosition => p !== null);

    vlog(`[TraccarAdminClient] Received ${normalized.length} historical positions for device ${deviceId}`);
    return normalized;
  }

  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
