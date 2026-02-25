import type { Anchor } from '@/engine/anchor';
import type { Engine, EngineState } from '@/engine/engine';
import type { NormalizedPosition, DevicePoint, GroupDevice, WorldBounds, MotionProfileName, MotionSegment, RetrospectiveResult } from '@/types';
import type { TraccarDevice } from '@/api/devices';

export type Refs = {
  deviceToGroupsMap: Map<number, number[]>;
  groupIds: Set<number>;
  engines: Map<number, Engine>;
  processedKeys: Set<string>;
  positionsAll: NormalizedPosition[];
  engineCheckpoints: Map<number, { timestamp: number; snapshot: EngineState }[]>;
};

export type StoreState = {
  // Devices slice
  devices: Record<number, {
    name: string;
    emoji: string;
    lastSeen: number | null;
    effectiveMotionProfile: MotionProfileName;
    motionProfile: MotionProfileName | null;
    color: string | null;
  }>;

  // Groups slice
  groups: GroupDevice[];

  // Motion profiles slice
  motionProfiles: Record<number, MotionProfileName>;

  // Settings slice (persisted)
  settings: {
    baseUrl: string;
    secure: boolean;
    token: string;
    inputBaseUrl: string;
    inputSecure: boolean;
    inputToken: string;
    maptilerApiKey: string;
    inputMaptilerApiKey: string;
    darkMode: 'light' | 'dark' | 'system';
    inputDarkMode: 'light' | 'dark' | 'system';
  };

  // Positions slice
  positions: {
    allPositions: NormalizedPosition[];
    snapshots: Record<number, DevicePoint[]>;
  };

  // UI State slice
  ui: {
    selectedDeviceId: number | null;
    isSidePanelOpen: boolean;
    debugMode: boolean;
    debugFrameIndex: number;
    refLat: number | null;
    refLon: number | null;
    worldBounds: WorldBounds | null;
    editingTarget: { type: 'device' | 'group', id: number } | null;
  };

  // Refs slice (reactive)
  refs: Refs;

  // Engine snapshots and anchors
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  dominantAnchors: Map<number, Anchor | null>;

  // Motion segments
  motionSegments: Record<number, MotionSegment[]>;

  // Retrospective analysis state
  retrospective: {
    byDevice: Map<number, RetrospectiveResult>;
    lastUpdate: number;
    isAnalyzing: boolean;
  };
};

export type StoreActions = {
  // Device/Group Management
  setDevicesFromApi: (devices: TraccarDevice[]) => Promise<void>;
  createGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  deleteGroup: (groupId: number) => Promise<void>;
  addDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  removeDeviceFromGroup: (groupId: number, deviceId: number) => Promise<void>;
  updateGroup: (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;
  updateDevice: (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;

  // Motion Profiles
  updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => void;

  // Positions
  addPositions: (positions: NormalizedPosition[]) => void;
  processPositions: () => { lat: number; lon: number } | null;
  setSnapshots: (snapshots: Record<number, DevicePoint[]>) => void;
  setPositionsAll: (updater: (prev: NormalizedPosition[]) => NormalizedPosition[]) => void;

  // Settings
  applySettings: () => void;
  clearSettings: () => void;
  setInputBaseUrl: (value: string) => void;
  setInputSecure: (value: boolean) => void;
  setInputToken: (value: string) => void;
  setInputMaptilerApiKey: (value: string) => void;
  setInputDarkMode: (value: 'light' | 'dark' | 'system') => void;

  // UI
  setSelectedDeviceId: (id: number | null) => void;
  toggleSidePanel: () => void;
  setIsSidePanelOpen: (open: boolean) => void;
  setDebugMode: (value: boolean) => void;
  setDebugFrameIndex: (value: number) => void;
  setRefLat: (lat: number | null) => void;
  setRefLon: (lon: number | null) => void;
  setWorldBounds: (bounds: WorldBounds | null) => void;
  setEngineSnapshotsByDevice: (snapshots: Record<number, DevicePoint[]>) => void;
  setDominantAnchors: (anchors: Map<number, Anchor | null>) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;

  // Motion segments
  setMotionSegments: (segments: Record<number, MotionSegment[]>) => void;

  // Retrospective analysis actions
  runRetrospectiveAnalysis: () => void;
  setRetrospectiveResults: (results: Map<number, RetrospectiveResult>) => void;
  clearRetrospectiveResults: () => void;
};

export type Store = StoreState & StoreActions;
