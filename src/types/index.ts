export type TraccarDevice = {
  id: number;
  name: string;
  lastUpdate: string | null;
  attributes: Record<string, unknown>;
};

export interface Session {
  token: string;
  username: string;
  traccarToken: string;
  createdAt: number;
  lastActive: number;
}

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
export type DebugDecision = 'stationary' | 'pending' | 'motion' | 'settled-significant' | 'settled-absorbed';
export type DebugFrame = {
  timestamp: Timestamp;
  decision: DebugDecision;
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

export type AppDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string | null;
  lastSeen: Timestamp | null;
  effectiveMotionProfile: MotionProfileName;
  motionProfile: MotionProfileName | null;
  isOwner: boolean;
  memberDeviceIds: number[] | null;
};

export type StationaryEvent = {
  type: 'stationary';
  start: Timestamp;
  end: Timestamp;
  mean: Vec2;
  variance: number;
  isDraft: boolean;
  bounds: WorldBounds;
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
  bounds: WorldBounds;
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

export type EngineSnapshot = {
  draft: EngineDraft | null;
  closed: EngineEvent[];
  timestamp: Timestamp | null;
  activeConfidence: number;
};

export type EngineState = {
  draft: EngineDraft | null;
  closed: EngineEvent[];
  lastTimestamp: Timestamp | null;
  debugFrames: DebugFrame[];
  seenDebugKeys: string[];
};

export interface RawTraccarPosition {
  deviceId: number;
  fixTime: string | number;
  latitude: number;
  longitude: number;
  accuracy?: number;
  [key: string]: unknown;
}

// --- WebSocket Protocol ---

export type InitialStatePayload = {
  entities: Record<number, AppDevice>;
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  eventsByDevice: Record<number, EngineEvent[]>;
  maptilerApiKey: string;
  metadata: {
    rootIds: number[];
  };
};

export type ServerMessage =
  | { type: "initial_state"; payload: InitialStatePayload; requestId?: never }
  | { type: "positions_update"; payload: { snapshots: Record<number, DevicePoint[]>, events: Record<number, EngineEvent[]> }; requestId?: never }
  | { type: "config_update"; payload: { devices: Record<number, AppDevice> | null, groups: AppDevice[] | null }; requestId?: never }
  | { type: "update_success"; deviceId: number; requestId?: string }
  | { type: "create_success"; device: TraccarDevice; requestId?: string }
  | { type: "delete_success"; groupId: number; requestId?: string }
  | { type: "error"; message: string; requestId?: string };

export type ClientMessage =
  | { type: "authenticate"; token: string }
  | { type: "update_device"; payload: { deviceId: number; updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: string | null } }; requestId?: string }
  | { type: "create_group"; payload: { name: string; emoji: string; memberDeviceIds: number[] }; requestId?: string }
  | { type: "delete_group"; payload: { groupId: number }; requestId?: string }
  | { type: "add_device_to_group"; payload: { groupId: number; deviceId: number }; requestId?: string }
  | { type: "remove_device_from_group"; payload: { groupId: number; deviceId: number }; requestId?: string };
