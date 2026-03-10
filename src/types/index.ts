export type Timestamp = number & { readonly __u?: 'timestamp' };

export type Vec2 = [number, number];

export type DebugAnchor = {
  mean: Vec2;        // Web Mercator [x, y]
  variance: number;  // meters²
  confidence: number;
  type: "active" | "candidate" | "closed" | "frame";
  startTimestamp: Timestamp;
  endTimestamp: Timestamp | null;
  lastUpdateTimestamp: Timestamp;
};

/** Snapshot of a single debug frame for map rendering. */
export type DebugFrameView = {
  timestamp: Timestamp;
  decision: 'stationary' | 'pending' | 'motion' | 'settled-significant' | 'settled-absorbed';
  point: Vec2 | null;
  mean: Vec2 | null;
  variance: number | null;
  mahalanobis2: number | null;
  pendingCount: number;
  draftType: 'stationary' | 'motion' | 'none';
};

export type DevicePoint = {
  device: number;
  sourceDeviceId: number | null;
  geo: Vec2;
  mean: Vec2;
  timestamp: Timestamp;
  accuracy: number;
  anchorStartTimestamp: Timestamp;
  confidence: number;
};

export type NormalizedPosition = {
  device: number;
  timestamp: Timestamp;
  geo: Vec2;
  accuracy: number; // meters
};

export type MotionProfileName = 'person' | 'car';

export type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

export type GroupDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string | null;
  lastSeen: Timestamp | null;
  isGroup: true;
  memberDeviceIds: number[];
  motionProfile: MotionProfileName | null;
  effectiveMotionProfile: MotionProfileName;
  isOwner: boolean;
};

export type UiDevice = {
  id: number;
  isGroup: boolean;
  name: string;
  emoji: string;
  lastSeen: Timestamp | null;
  hasPosition: boolean;
  memberDeviceIds: number[];
  color: string | null;
  isOwner: boolean;
};

export type StationaryEvent = {
  type: 'stationary';
  start: Timestamp;
  end: Timestamp;
  mean: Vec2;
  variance: number;
  isDraft: boolean;
};

export type MotionEvent = {
  type: 'motion';
  start: Timestamp;
  end: Timestamp;
  startAnchor: Vec2;
  endAnchor: Vec2;
  path: Vec2[];
  distance: number;
  isDraft: boolean;
};

export type EngineEvent = StationaryEvent | MotionEvent;

export type StationaryDraft = {
  type: 'stationary';
  start: Timestamp;
  stationaryStartAnchor: Vec2;
  recent: DevicePoint[];  // Sliding window
  pending: DevicePoint[]; // Hysteresis buffer
};

export type MotionDraft = {
  type: 'motion';
  start: Timestamp;
  stationaryCutoff: Timestamp;
  predecessor: StationaryDraft;
  startAnchor: Vec2;
  path: DevicePoint[];
  recent: DevicePoint[]; // Settling window
};

export type EngineDraft = StationaryDraft | MotionDraft;

// --- WebSocket Protocol ---

export interface BaseAppDevice {
  name: string;
  emoji: string;
  lastSeen: Timestamp | null;
  effectiveMotionProfile: MotionProfileName;
  motionProfile: MotionProfileName | null;
  color: string | null;
}

export interface AppDevice extends BaseAppDevice {
  isOwner: boolean;
}

export type InitialStatePayload = {
  devices: Record<number, AppDevice>; // Will map to StoreState.devices
  groups: GroupDevice[];
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  eventsByDevice: Record<number, EngineEvent[]>;
};

export type ServerMessage = 
  | { type: "initial_state"; payload: InitialStatePayload }
  | { type: "positions_update"; payload: { snapshots: Record<number, DevicePoint[]>, events: Record<number, EngineEvent[]> } }
  | { type: "config_update"; payload: { devices: Record<number, AppDevice> | null, groups: GroupDevice[] | null } };

export type ClientMessage = 
  | { type: "authenticate"; token: string }; // Client sends its Traccar session token
