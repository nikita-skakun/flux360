import { sendMessage } from "./wsClient";

const RPC_TIMEOUT_MS = 30000;

interface PendingRequest {
  cb: (resp: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

function registerCallback(requestId: string, cb: (resp: unknown) => void) {
  const timer = setTimeout(() => {
    const entry = pending.get(requestId);
    if (entry) {
      pending.delete(requestId);
      entry.cb({ type: 'error', message: 'Request timeout' });
    }
  }, RPC_TIMEOUT_MS);

  pending.set(requestId, { cb, timer });
}

export function handleResponse(resp: unknown) {
  if (typeof resp !== 'object' || resp === null) return;
  const { requestId } = resp as { requestId: string };
  const entry = pending.get(requestId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.cb(resp);
  }
}

export function clearPendingRequests() {
  for (const [_, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    entry.cb({ type: 'error', message: 'Connection closed' });
  }
  pending.clear();
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
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      reject(e);
    }
  });
}
