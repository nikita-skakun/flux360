import type { Anchor } from "@/engine/anchor";

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
  /** GPS measurement: geographic position + accuracy radius in meters. */
  measurement: {
    lat: number;
    lon: number;
    accuracy: number;
    mean: Vec2;
    variance: number;
  };
  /** Anchor state at this frame: Web Mercator center + variance (meters²), or null if no anchor yet. */
  anchor: {
    mean: Vec2;
    variance: number;
    confidence: number;
    startTimestamp: Timestamp;
    lastUpdateTimestamp: Timestamp;
  } | null;
  timestamp: Timestamp;
};

export type DevicePoint = {
  device: number;
  sourceDeviceId: number | undefined;
  lat: number;
  lon: number;
  mean: Vec2;
  variance: number;
  timestamp: Timestamp;
  accuracy: number;
  anchorAgeMs: number;
  confidence: number;
};

export type NormalizedPosition = {
  device: number;
  timestamp: Timestamp;
  lat: number;
  lon: number;
  accuracy: number; // meters
};

export type MotionProfileName = 'person' | 'car';

export type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

export type GroupDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string;
  memberDeviceIds: number[];
  motionProfile: MotionProfileName | null;
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
};

export type MotionSegment = {
  startAnchor: Anchor;
  endAnchor: Anchor | null;
  path: Vec2[];
  startTime: Timestamp;
  endTime: Timestamp | null;
};

// Retrospective analysis types
export type RetrospectiveMotionSegment = {
  startTime: Timestamp;
  endTime: Timestamp;
  startPosition: Vec2;
  endPosition: Vec2;
  path: Vec2[];
  confidence: number;
};

export type RetrospectiveResult = {
  motionSegments: RetrospectiveMotionSegment[];
};
