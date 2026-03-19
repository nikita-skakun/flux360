import type { AppDevice, DevicePoint, EngineEvent, InitialStatePayload, MotionProfileName } from '@/types';

export type StoreState = {
  // Entities slice (unifies devices and groups)
  entities: Record<number, AppDevice>;

  // Settings slice (persisted)
  settings: {
    maptilerApiKey: string;
    theme: 'light' | 'dark' | 'system';
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
  };

  // Map marker points and engine states
  activePointsByDevice: Record<number, DevicePoint[]>;

  // Engine events (Stationary/Motion)
  eventsByDevice: Record<number, EngineEvent[]>;
};

export type StoreActions = {
  // Device/Group Management
  createGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  deleteGroup: (groupId: number) => Promise<void>;
  addDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  removeDeviceFromGroup: (groupId: number, deviceId: number) => Promise<void>;
  updateGroup: (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;
  updateDevice: (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;

  // Data Handlers from WebSocket
  setInitialState: (payload: InitialStatePayload) => void;
  setOwnedDeviceIds: (ids: number[]) => void;
  updatePositions: (payload: { activePoints: Record<number, DevicePoint[]>, events: Record<number, EngineEvent[]> }) => void;
  updateConfig: (payload: { devices: Record<number, AppDevice> | null; groups: AppDevice[] | null }) => void;

  // Motion Profiles
  updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => void;

  // Settings & Auth
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;

  // UI
  setSelectedDeviceId: (id: number | null) => void;
  setIsSidePanelOpen: (open: boolean) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;
};

export type Store = StoreState & StoreActions;
