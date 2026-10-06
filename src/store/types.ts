import type { AppDevice, DevicePoint, EngineEvent, InitialStatePayload, DeviceShare, DeviceMetadata } from '@/types';
import type { Label, StripFix } from '@/labels/types';
import type { LabelOp } from '@/labels/undo';

export type ThemeOptions = 'Light' | 'Dark' | 'Auto';

export type StoreState = {
  // Entities slice (unifies devices and groups)
  entities: Record<number, AppDevice>;

  // Settings slice (persisted)
  settings: {
    maptilerApiKey: string;
    historyDays: number;
    theme: ThemeOptions;
    sessionToken: string | null;
  };

  // Auth State
  auth: {
    isAuthenticated: boolean;
    isLoggingIn: boolean;
    loginError: string | null;
    ownedDeviceIds: number[];
  };

  // UI State slice
  ui: {
    selectedDeviceId: number | null;
    isSidePanelOpen: boolean;
    editingTarget: { type: 'device' | 'group', id: number } | null;
    isLabelMode: boolean;
  };

  // Map marker points and engine states
  activePointsByDevice: Record<number, DevicePoint[]>;

  // Engine events (Stationary/Motion)
  eventsByDevice: Record<number, EngineEvent[]>;

  // Hand-authored ground truth, keyed by entity (groups are negative ids)
  labelsByEntity: Record<number, Label[]>;
  // Raw fixes loaded for the labelling strip, never engine output
  historyFixesByEntity: Record<number, StripFix[]>;
  // Session undo history. Labels write immediately, so undo reverses an operation
  labelHistory: LabelOp[];
  labelError: string | null;
};

type StoreActions = {
  // Device/Group Management
  createGroup: (name: string, memberDeviceIds: number[], icon: string) => Promise<void>;
  deleteGroup: (groupId: number) => Promise<void>;
  addDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  removeDeviceFromGroup: (groupId: number, deviceId: number) => Promise<void>;
  updateDevice: (deviceId: number, updates: DeviceMetadata) => Promise<void>;

  // Data Handlers from WebSocket
  setInitialState: (payload: InitialStatePayload) => void;
  setOwnedDeviceIds: (ids: number[]) => void;
  updatePositions: (payload: { activePoints: Record<number, DevicePoint[]>, events: Record<number, EngineEvent[]> }) => void;
  updateConfig: (payload: { devices: Record<number, AppDevice>, groups: AppDevice[], allowedDeviceIds: number[], ownedDeviceIds: number[] }) => void;

  // Settings & Auth
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setTheme: (theme: ThemeOptions) => void;

  // UI
  setSelectedDeviceId: (id: number | null) => void;
  setIsSidePanelOpen: (open: boolean) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;

  // Labelling
  setLabelMode: (enabled: boolean) => void;
  loadLabels: (entityId: number) => Promise<void>;
  loadHistory: (entityId: number, from: number, to: number) => Promise<void>;
  writeLabel: (label: Label) => Promise<void>;
  deleteLabel: (entityId: number, id: string) => Promise<void>;
  undoLabel: () => Promise<void>;
  runLabelOp: (op: LabelOp) => Promise<void>;
  setLabelError: (message: string | null) => void;

  // Sharing
  shareDevice: (deviceId: number, username: string) => Promise<void>;
  unshareDevice: (deviceId: number, username: string) => Promise<void>;
  getShares: () => Promise<DeviceShare[]>;
};

export type Store = StoreState & StoreActions;
