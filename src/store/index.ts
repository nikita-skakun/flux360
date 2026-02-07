import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TraccarDevice } from '@/api/devices';
import type { NormalizedPosition } from '@/api/positions';
import type { DevicePoint } from '@/ui/types';
import type { MotionProfileName } from '@/engine/motionDetector';
import { Engine } from '@/engine/engine';
import type { Anchor } from '@/engine/anchor';
import { degreesToMeters } from '@/util/geo';
import { measurementVarianceFromAccuracy, dedupeKey, buildEngineSnapshotsFromByDevice } from '@/util/appUtils';

export type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

export type Refs = {
  deviceToGroupsMap: Map<number, number[]>;
  groupIds: Set<number>;
  engines: Map<number, Engine>;
  processedKeys: Set<string>;
  positionsAll: NormalizedPosition[];
  firstPosition: { lat: number; lon: number } | null;
};

export type GroupDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string;
  memberDeviceIds: number[];
};

type StoreState = {
  // Devices slice
  devices: Record<number, {
    name: string;
    icon: string;
    lastSeen: number | null;
    motionProfile: MotionProfileName;
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
  };

  // Positions slice
  positions: {
    allPositions: NormalizedPosition[];
    snapshots: Record<number, DevicePoint[]>;
    firstPosition: { lat: number; lon: number } | null;
  };

  // UI State slice
  ui: {
    selectedDeviceId: number | null;
    isSidePanelOpen: boolean;
    showGroupsModal: boolean;
    debugMode: boolean;
    debugFrameIndex: number;
    refLat: number | null;
    refLon: number | null;
    worldBounds: WorldBounds | null;
  };

  // Refs slice (reactive)
  refs: {
    deviceToGroupsMap: Map<number, number[]>;
    groupIds: Set<number>;
    engines: Map<number, Engine>;
    processedKeys: Set<string>;
    positionsAll: NormalizedPosition[];
    firstPosition: { lat: number; lon: number } | null;
  };

  // Engine snapshots and anchors
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  dominantAnchors: Map<number, Anchor | null>;
};

type StoreActions = {
  // Device/Group Management
  setDevicesFromApi: (devices: TraccarDevice[]) => Promise<void>;
  createGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  deleteGroup: (groupId: number) => Promise<void>;
  addDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  removeDeviceFromGroup: (groupId: number, deviceId: number) => Promise<void>;
  updateGroup: (groupId: number, updates: { name?: string }) => Promise<void>;

  // Motion Profiles
  updateMotionProfile: (deviceId: number, profile: MotionProfileName) => void;

  // Positions
  addPositions: (positions: NormalizedPosition[]) => void;
  processPositions: () => { lat: number; lon: number } | null;
  setSnapshots: (snapshots: Record<number, DevicePoint[]>) => void;
  setFirstPosition: (pos: { lat: number; lon: number } | null) => void;
  setPositionsAll: (updater: (prev: NormalizedPosition[]) => NormalizedPosition[]) => void;

  // Settings
  applySettings: () => void;
  clearSettings: () => void;
  setInputBaseUrl: (value: string) => void;
  setInputSecure: (value: boolean) => void;
  setInputToken: (value: string) => void;

  // UI
  setSelectedDeviceId: (id: number | null) => void;
  toggleSidePanel: () => void;
  setIsSidePanelOpen: (open: boolean) => void;
  setShowGroupsModal: (show: boolean) => void;
  setDebugMode: (value: boolean) => void;
  setDebugFrameIndex: (value: number) => void;
  setRefLat: (lat: number | null) => void;
  setRefLon: (lon: number | null) => void;
  setWorldBounds: (bounds: WorldBounds | null) => void;
  setEngineSnapshotsByDevice: (snapshots: Record<number, DevicePoint[]>) => void;
  setDominantAnchors: (anchors: Map<number, Anchor | null>) => void;
};

type Store = StoreState & StoreActions;

const initialState: StoreState = {
  devices: {},
  groups: [],
  motionProfiles: {},
  settings: {
    baseUrl: '',
    secure: false,
    token: '',
    inputBaseUrl: '',
    inputSecure: false,
    inputToken: '',
  },
  positions: {
    allPositions: [],
    snapshots: {},
    firstPosition: null,
  },
  ui: {
    selectedDeviceId: null,
    isSidePanelOpen: true,
    showGroupsModal: false,
    debugMode: false,
    debugFrameIndex: 0,
    refLat: null,
    refLon: null,
    worldBounds: null,
  },
  refs: {
    deviceToGroupsMap: new Map(),
    groupIds: new Set(),
    engines: new Map(),
    processedKeys: new Set(),
    positionsAll: [],
    firstPosition: null,
  },
  engineSnapshotsByDevice: {},
  dominantAnchors: new Map() as Map<number, Anchor | null>,
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Device/Group Management
      setDevicesFromApi: async (devices: TraccarDevice[]) => {
        const { colorForDevice } = await import("@/ui/color");
        const rgbToHex = (r: number, g: number, b: number): string => `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
        const nameMap: Record<number, string> = {};
        const iconMap: Record<number, string> = {};
        const lastSeenMap: Record<number, number | null> = {};
        const motionProfileMap: Record<number, MotionProfileName> = {};
        const groupDevicesMap = new Map<number, GroupDevice>();

        for (const device of devices) {
          nameMap[device.id] = device.name;
          iconMap[device.id] = device.emoji;
          lastSeenMap[device.id] = device.lastSeen;

          let profile: MotionProfileName = "person";
          const profileAttr = device.attributes["motionProfile"];
          if (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) {
            profile = profileAttr;
          }
          motionProfileMap[device.id] = profile;

          // Check if it's a group device
          const memberDeviceIdsAttr = device.attributes["memberDeviceIds"];
          if (typeof memberDeviceIdsAttr === "string") {
            try {
              const memberDeviceIds = JSON.parse(memberDeviceIdsAttr) as unknown;
              if (Array.isArray(memberDeviceIds) && memberDeviceIds.every((id): id is number => typeof id === "number")) {
                const color = rgbToHex(...colorForDevice(device.id));
                groupDevicesMap.set(device.id, {
                  id: device.id,
                  name: device.name,
                  emoji: device.emoji,
                  color,
                  memberDeviceIds,
                });
              }
            } catch {
              // Ignore invalid JSON
            }
          }
        }

        // Update refs for group mapping
        const deviceToGroupsMap = new Map<number, number[]>();
        const groupIds = new Set<number>();
        for (const group of groupDevicesMap.values()) {
          groupIds.add(group.id);
          for (const deviceId of group.memberDeviceIds) {
            const groups = deviceToGroupsMap.get(deviceId) ?? [];
            groups.push(group.id);
            deviceToGroupsMap.set(deviceId, groups);
          }
        }

        set(state => ({
          devices: Object.fromEntries(
            Object.entries(nameMap).map(([id, name]) => [
              Number(id),
              {
                name,
                icon: iconMap[Number(id)] ?? '',
                lastSeen: lastSeenMap[Number(id)] ?? null,
                motionProfile: motionProfileMap[Number(id)] ?? 'person',
              }
            ])
          ),
          groups: Array.from(groupDevicesMap.values()),
          motionProfiles: motionProfileMap,
          refs: {
            ...state.refs,
            deviceToGroupsMap,
            groupIds,
          }
        }));
      },

      createGroup: async (name: string, memberDeviceIds: number[], emoji: string) => {
        const state = get();
        const { createGroupDevice } = await import("@/api/devices");
        const { colorForDevice } = await import("@/ui/color");
        const rgbToHex = (r: number, g: number, b: number): string => `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

        // Optimistic update
        const tempId = Date.now(); // Temporary ID until API response
        const color = rgbToHex(...colorForDevice(tempId));
        const newGroup: GroupDevice = { id: tempId, name, emoji, color, memberDeviceIds };

        set(state => ({
          groups: [...state.groups, newGroup],
          refs: {
            ...state.refs,
            groupIds: new Set([...state.refs.groupIds, tempId]),
            deviceToGroupsMap: new Map(state.refs.deviceToGroupsMap), // Update mapping
          }
        }));

        try {
          const created = await createGroupDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, name, emoji, memberDeviceIds);

          // Replace temp with real
          set(state => ({
            groups: state.groups.map(g => g.id === tempId ? { ...g, id: created.id } : g),
            refs: {
              ...state.refs,
              groupIds: new Set([...Array.from(state.refs.groupIds).filter(id => id !== tempId), created.id]),
            }
          }));
        } catch (error) {
          // Rollback
          set(state => ({
            groups: state.groups.filter(g => g.id !== tempId),
            refs: {
              ...state.refs,
              groupIds: new Set([...state.refs.groupIds].filter(id => id !== tempId)),
            }
          }));
          throw error;
        }
      },

      deleteGroup: async (groupId: number) => {
        const { deleteGroupDevice } = await import("@/api/devices");
        const state = get();

        // Optimistic update
        const groupToDelete = state.groups.find(g => g.id === groupId);
        set(state => {
          const newDevices = { ...state.devices };
          delete newDevices[groupId];
          return {
            groups: state.groups.filter(g => g.id !== groupId),
            devices: newDevices,
            refs: {
              ...state.refs,
              groupIds: new Set([...state.refs.groupIds].filter(id => id !== groupId)),
            }
          };
        });

        try {
          await deleteGroupDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, groupId);
        } catch (error) {
          // Rollback
          if (groupToDelete) {
            set(state => ({
              groups: [...state.groups, groupToDelete],
              devices: {
                ...state.devices,
                [groupId]: {
                  name: groupToDelete.name,
                  icon: groupToDelete.emoji,
                  lastSeen: null,
                  motionProfile: 'person',
                }
              },
              refs: {
                ...state.refs,
                groupIds: new Set([...state.refs.groupIds, groupId]),
              }
            }));
          }
          throw error;
        }
      },

      addDeviceToGroup: async (groupId: number, deviceId: number) => {
        const { updateGroupDevice } = await import("@/api/devices");
        const state = get();
        const group = state.groups.find(g => g.id === groupId);
        if (!group || group.memberDeviceIds.includes(deviceId)) return;

        // Optimistic update
        const originalMembers = [...group.memberDeviceIds];
        const newMembers = [...originalMembers, deviceId];
        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
        }));

        try {
          await updateGroupDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, groupId, { memberDeviceIds: newMembers });
        } catch (error) {
          // Rollback
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: originalMembers } : g),
          }));
          throw error;
        }
      },

      removeDeviceFromGroup: async (groupId: number, deviceId: number) => {
        const { updateGroupDevice } = await import("@/api/devices");
        const state = get();
        const group = state.groups.find(g => g.id === groupId);
        if (!group?.memberDeviceIds.includes(deviceId)) return;

        // Optimistic update
        const originalMembers = [...group.memberDeviceIds];
        const newMembers = originalMembers.filter(id => id !== deviceId);
        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
        }));

        try {
          await updateGroupDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, groupId, { memberDeviceIds: newMembers });
        } catch (error) {
          // Rollback
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: originalMembers } : g),
          }));
          throw error;
        }
      },

      updateGroup: async (groupId: number, updates: { name?: string }) => {
        const { updateGroupDevice } = await import("@/api/devices");
        const state = get();
        const group = state.groups?.find(g => g.id === groupId);
        if (!group) return;

        // Optimistic update
        const originalName = group.name;
        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? { ...g, name: updates.name ?? g.name } : g),
        }));

        try {
          await updateGroupDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, groupId, updates);
        } catch (error) {
          // Rollback
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? { ...g, name: originalName } : g),
          }));
          throw error;
        }
      },

      updateMotionProfile: (deviceId: number, profile: MotionProfileName) => {
        set(state => {
          const existing = state.devices[deviceId];
          if (!existing) return state; // No-op if device not in state
          return {
            devices: {
              ...state.devices,
              [deviceId]: {
                ...existing,
                motionProfile: profile,
              }
            },
            motionProfiles: {
              ...state.motionProfiles,
              [deviceId]: profile,
            }
          };
        });

        // Async API call
        void (async () => {
          const { updateDeviceAttributes } = await import("@/api/devices");
          const state = get();
          try {
            await updateDeviceAttributes({
              baseUrl: state.settings.baseUrl,
              secure: state.settings.secure,
              auth: { type: "token" as const, token: state.settings.token },
            }, deviceId, { motionProfile: profile });
          } catch {
            // Rollback
            set(state => {
              const existing = state.devices[deviceId];
              if (!existing) return state;
              return {
                devices: {
                  ...state.devices,
                  [deviceId]: {
                    ...existing,
                    motionProfile: existing.motionProfile, // Restore original
                  }
                },
                motionProfiles: {
                  ...state.motionProfiles,
                  [deviceId]: existing.motionProfile,
                }
              };
            });
          }
        })();
      },

      addPositions: (positions: NormalizedPosition[]) => {
        set(state => ({
          positions: {
            ...state.positions,
            allPositions: [...state.positions.allPositions, ...positions],
          }
        }));
      },

      processPositions: () => {
        const state = get();
        const { refs } = state;
        const { deviceToGroupsMap, groupIds, engines, processedKeys, positionsAll, firstPosition } = refs;
        const { refLat, refLon } = state.ui;
        const allPositions = positionsAll;
        const groupDevices = state.groups;

        if (!allPositions || allPositions.length === 0) return null;

        const newPositions = allPositions.filter((p: NormalizedPosition) => {
          const key = dedupeKey(p);
          if (processedKeys.has(key)) return false;
          processedKeys.add(key);
          return true;
        });
        if (newPositions.length === 0) return null;

        const groupIdsTouched = new Set<number>();
        for (const p of newPositions) {
          const groupIds = deviceToGroupsMap.get(p.device);
          if (groupIds) {
            for (const groupId of groupIds) {
              groupIdsTouched.add(groupId);
            }
          }
        }

        // Group positions by device AND by any groups they belong to
        const posByDevice = newPositions.reduce((acc, p) => {
          // Add position to the original device
          (acc[p.device] ||= []).push(p);

          // Also add position to any groups this device belongs to
          const groupIds = deviceToGroupsMap.get(p.device);
          if (groupIds) {
            for (const groupId of groupIds) {
              (acc[groupId] ||= []).push(p);
            }
          }

          return acc;
        }, {} as Record<number, NormalizedPosition[]>);

        if (groupIdsTouched.size > 0) {
          const membersByGroup = new Map<number, number[]>();
          for (const group of groupDevices) {
            membersByGroup.set(group.id, group.memberDeviceIds);
          }
          for (const groupId of groupIdsTouched) {
            const memberIds = membersByGroup.get(groupId);
            if (!memberIds || memberIds.length === 0) continue;
            const memberSet = new Set(memberIds);
            posByDevice[groupId] = newPositions.filter((p) => memberSet.has(p.device));
          }
        }

        for (const arr of Object.values(posByDevice)) arr.sort((a, b) => a.timestamp - b.timestamp);

        const rawByDevice: Record<number, DevicePoint[]> = {};
        for (const [deviceKey, arr] of Object.entries(posByDevice)) {
          const deviceId = Number(deviceKey);
          const isGroup = groupIds.has(deviceId);
          const rawArr: DevicePoint[] = arr.map((p) => {
            const useRef = firstPosition ?? { lat: refLat ?? p.lat, lon: refLon ?? p.lon };
            const { x, y } = degreesToMeters(p.lat, p.lon, useRef.lat, useRef.lon);
            const comp: DevicePoint = {
              mean: [x, y],
              variance: measurementVarianceFromAccuracy(p.accuracy),
              accuracy: p.accuracy,
              lat: p.lat,
              lon: p.lon,
              device: deviceId,
              timestamp: p.timestamp,
              anchorAgeMs: 0,
              confidence: 0,
              ...(isGroup ? { sourceDeviceId: p.device } : {}),
            };
            return comp;
          });
          rawByDevice[deviceId] = rawArr;
        }

        let firstPos: { lat: number; lon: number } | null = null;
        if (!firstPosition && newPositions.length > 0) {
          const first = newPositions[0]!;
          firstPos = { lat: first.lat, lon: first.lon };
        }

        const groupMotionProfiles = new Map<number, MotionProfileName>();
        for (const group of groupDevices) {
          let profile: MotionProfileName = "person";
          for (const memberId of group.memberDeviceIds) {
            if ((state.motionProfiles[memberId] ?? "person") === "car") {
              profile = "car";
              break;
            }
          }
          groupMotionProfiles.set(group.id, profile);
        }

        const result = buildEngineSnapshotsFromByDevice(rawByDevice, engines, groupIds, groupMotionProfiles, state.motionProfiles, refLat, refLon);
        // deviceMotionProfiles is empty, need to pass proper profiles
        // Wait, in the code, groupMotionProfiles was used, but removed.
        // For now, pass empty or default.

        // Set the results
        set(state => ({
          engineSnapshotsByDevice: result.positionsByDevice,
          dominantAnchors: result.dominantAnchors,
          refs: {
            ...state.refs,
            firstPosition: firstPos ?? state.refs.firstPosition,
          }
        }));

        return firstPos;
      },

      setSnapshots: (snapshots: Record<number, DevicePoint[]>) => {
        set(state => ({
          positions: {
            ...state.positions,
            snapshots,
          }
        }));
      },

      setFirstPosition: (pos) => {
        set(state => ({
          refs: {
            ...state.refs,
            firstPosition: pos,
          }
        }));
      },

      setPositionsAll: (updater) => {
        set(state => ({
          refs: {
            ...state.refs,
            positionsAll: updater(state.refs.positionsAll),
          }
        }));
      },

      applySettings: () => {
        set(state => ({
          settings: {
            ...state.settings,
            baseUrl: state.settings.inputBaseUrl,
            secure: state.settings.inputSecure,
            token: state.settings.inputToken,
          }
        }));
      },

      clearSettings: () => {
        set(state => ({
          settings: {
            ...state.settings,
            baseUrl: '',
            secure: false,
            token: '',
            inputBaseUrl: '',
            inputSecure: false,
            inputToken: '',
          }
        }));
      },

      setInputBaseUrl: (value: string) => {
        set(state => ({
          settings: {
            ...state.settings,
            inputBaseUrl: value,
          }
        }));
      },

      setInputSecure: (value: boolean) => {
        set(state => ({
          settings: {
            ...state.settings,
            inputSecure: value,
          }
        }));
      },

      setInputToken: (value: string) => {
        set(state => ({
          settings: {
            ...state.settings,
            inputToken: value,
          }
        }));
      },

      setSelectedDeviceId: (id: number | null) => {
        set(state => ({
          ui: {
            ...state.ui,
            selectedDeviceId: id,
          }
        }));
      },

      toggleSidePanel: () => {
        set(state => ({
          ui: {
            ...state.ui,
            isSidePanelOpen: !state.ui.isSidePanelOpen,
          }
        }));
      },

      setIsSidePanelOpen: (open: boolean) => {
        set(state => ({
          ui: {
            ...state.ui,
            isSidePanelOpen: open,
          }
        }));
      },

      setShowGroupsModal: (show: boolean) => {
        set(state => ({
          ui: {
            ...state.ui,
            showGroupsModal: show,
          }
        }));
      },

      setDebugMode: (value: boolean) => {
        set(state => ({
          ui: {
            ...state.ui,
            debugMode: value,
          }
        }));
      },

      setDebugFrameIndex: (value: number) => {
        set(state => ({
          ui: {
            ...state.ui,
            debugFrameIndex: value,
          }
        }));
      },

      setRefLat: (lat: number | null) => {
        set(state => ({
          ui: {
            ...state.ui,
            refLat: lat,
          }
        }));
      },

      setRefLon: (lon: number | null) => {
        set(state => ({
          ui: {
            ...state.ui,
            refLon: lon,
          }
        }));
      },

      setWorldBounds: (bounds: WorldBounds | null) => {
        set(state => ({
          ui: {
            ...state.ui,
            worldBounds: bounds,
          }
        }));
      },

      setEngineSnapshotsByDevice: (snapshots) => {
        set(() => ({
          engineSnapshotsByDevice: snapshots,
        }));
      },

      setDominantAnchors: (anchors) => {
        set(() => ({
          dominantAnchors: anchors,
        }));
      },
    }),
    {
      name: 'flux360-store',
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);