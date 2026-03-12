import { clearPendingRequests } from "./wsRPC";

let ws: WebSocket | null = null;

export function setWebSocket(connection: WebSocket | null) {
  ws = connection;
  if (connection === null) {
    clearPendingRequests();
  }
}

export function sendMessage(type: string, payload?: unknown, requestId?: string): void {
  if (ws?.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not connected");
  }

  const msg: { type: string; payload?: unknown; requestId?: string } = { type, payload };
  if (requestId !== undefined) msg.requestId = requestId;
  ws.send(JSON.stringify(msg));
}
