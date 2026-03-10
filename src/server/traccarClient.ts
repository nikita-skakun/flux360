import { extractPositionsFromMessage } from "./traccarAdminUtils";
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
    if (this.destroyed) return;

    if (!this.baseUrl || !this.token) {
      console.error("TraccarAdminClient: Missing baseUrl or token");
      return;
    }

    const protocol = this.secure ? "wss" : "ws";
    const wsUrl = `${protocol}://${this.baseUrl}/api/socket?token=${encodeURIComponent(this.token)}`;

    try {
      void this.fetchInitialDevices();
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("✅ Traccar Admin WebSocket connected");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (ev) => {
        try {
          const raw = typeof ev.data === "string" ? JSON.parse(ev.data) as Record<string, unknown> : ev.data as Record<string, unknown>;

          // Check for device updates (which Traccar sends over WS)
          if (raw && typeof raw === 'object' && 'devices' in raw && Array.isArray((raw)['devices'])) {
            this.deps.onDevicesReceived((raw)['devices'] as TraccarDevice[]);
          }

          // Extract positions generically
          const positions = extractPositionsFromMessage(raw);
          if (positions.length > 0) {
            this.deps.onPositionsReceived(positions);
          }
        } catch {
          console.error("Error processing Traccar message");
        }
      };

      this.ws.onclose = () => {
        if (!this.destroyed) {
          console.log("⚠️ Traccar Admin WebSocket closed. Reconnecting in 5s...");
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.error("Traccar Admin WebSocket error:", err);
      };
    } catch (err) {
      console.error("Failed to establish Traccar Admin WebSocket:", err);
      this.scheduleReconnect();
    }
  }

  private async fetchInitialDevices() {
    try {
      const protocol = this.secure ? "https" : "http";
      const res = await fetch(`${protocol}://${this.baseUrl}/api/devices`, {
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/json"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const devices = (await res.json()) as TraccarDevice[];

      console.log(`[TraccarAdminClient] Successfully fetched ${devices.length} initial devices via REST`);
      this.deps.onDevicesReceived(devices);
    } catch (err) {
      console.error("TraccarAdminClient: Failed to fetch initial devices:", err);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
