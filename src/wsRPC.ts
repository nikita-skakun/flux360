import { sendMessage } from "./wsClient";

const pending = new Map<string, (resp: unknown) => void>();

export function registerCallback(requestId: string, cb: (resp: unknown) => void) {
  pending.set(requestId, cb);
}

export function handleResponse(resp: unknown) {
  if (typeof resp !== 'object' || resp === null) return;
  const { requestId } = resp as { requestId?: string };
  if (requestId) {
    const cb = pending.get(requestId);
    pending.delete(requestId);
    if (cb) cb(resp);
  }
}

export function sendRPC<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    registerCallback(requestId, (resp) => {
      const response = resp as { type?: string; message?: string };
      if (response.type === 'error') {
        reject(new Error(response.message || 'Unknown error'));
      } else {
        resolve(resp as T);
      }
    });

    try {
      sendMessage(type, payload, requestId);
    } catch (e) {
      pending.delete(requestId);
      reject(e);
    }
  });
}
