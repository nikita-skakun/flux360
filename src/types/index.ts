import type { Anchor } from "@/engine/anchor";

export type Vec2 = [number, number];

export type DevicePoint = {
  device: number;
  sourceDeviceId?: number;
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

export type MotionSegment = {
  startAnchor: Anchor;
  endAnchor: Anchor | null;
  path: Vec2[];
  startTime: number;
  endTime: number | null;
};

// Retrospective analysis types
export type RetrospectiveAnchor = {
  timestamp: number;
  mean: Vec2;
  variance: number;
  type: 'stable' | 'moving' | 'settling';
};

export type RetrospectiveMotionSegment = {
  startTime: number;
  endTime: number;
  startPosition: Vec2;
  endPosition: Vec2;
  path: Vec2[];
  confidence: number;
};

export type RetrospectiveResult = {
  anchorTimeline: RetrospectiveAnchor[];
  motionSegments: RetrospectiveMotionSegment[];
};
