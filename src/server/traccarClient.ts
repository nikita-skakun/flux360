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
          const raw = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
          if (raw?.devices) this.deps.onDevicesReceived(raw.devices);
          const pos = extractPositionsFromMessage(raw);
          if (pos.length) this.deps.onPositionsReceived(pos);
        } catch (err) { console.error("Traccar processing error:", err); }
      };

      this.ws.onclose = () => !this.destroyed && this.scheduleReconnect();
      this.ws.onerror = (err) => console.error("Traccar Admin WS error:", err);
    } catch (err) { this.scheduleReconnect(); }
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

  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
