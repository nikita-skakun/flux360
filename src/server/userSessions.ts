interface UserSession {
  allowed: Set<number>;
  owned: Set<number>;
  traccarToken: string;
  socketCount: number;
}

const sessions = new Map<string, UserSession>();

export function register(username: string, traccarToken: string, allowed: Set<number>, owned: Set<number>): void {
  const existing = sessions.get(username);
  if (existing) {
    existing.socketCount++;
    existing.allowed = allowed;
    existing.owned = owned;
    existing.traccarToken = traccarToken;
  } else {
    sessions.set(username, { allowed, owned, traccarToken, socketCount: 1 });
  }
}

export function deregister(username: string): void {
  const session = sessions.get(username);
  if (!session) return;

  session.socketCount--;
  if (session.socketCount <= 0) sessions.delete(username);
}

export function addAllowedDevice(username: string, deviceId: number): void {
  sessions.get(username)?.allowed.add(deviceId);
}

export function removeAllowedDevice(username: string, deviceId: number): void {
  sessions.get(username)?.allowed.delete(deviceId);
}

export function getSession(username: string): UserSession | undefined {
  return sessions.get(username);
}
