import type { Anchor } from "@/engine/anchor";

export type Vec2 = [number, number];

export type DebugAnchor = {
  mean: Vec2;        // Web Mercator [x, y]
  variance: number;  // meters²
  confidence: number;
  type: "active" | "candidate" | "closed" | "frame";
  startTimestamp: number;
  endTimestamp: number | null;
  lastUpdateTimestamp: number;
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
    startTimestamp: number;
    lastUpdateTimestamp: number;
  } | null;
  timestamp: number;
};

export type DevicePoint = {
  device: number;
  sourceDeviceId: number | undefined;
  lat: number;
  lon: number;
  mean: Vec2;
  variance: number;
  timestamp: number;
  accuracy: number;
  anchorAgeMs: number;
  confidence: number;
};

export type NormalizedPosition = {
  device: number;
  timestamp: number; // epoch ms
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
  lastSeen: number | null;
  hasPosition: boolean;
  memberDeviceIds: number[];
  color: string | null;
};

export type MotionSegment = {
  startAnchor: Anchor;
  endAnchor: Anchor | null;
  path: Vec2[];
  startTime: number;
  endTime: number | null;
};

// Retrospective analysis types
export type RetrospectiveMotionSegment = {
  startTime: number;
  endTime: number;
  startPosition: Vec2;
  endPosition: Vec2;
  path: Vec2[];
  confidence: number;
};

export type RetrospectiveResult = {
  motionSegments: RetrospectiveMotionSegment[];
};
