import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TraccarDevice } from '@/api/devices';
import type { NormalizedPosition } from '@/api/positions';
import type { DevicePoint } from '@/ui/types';
import type { MotionProfileName } from '@/engine/motionDetector';
import { Engine } from '@/engine/engine';
import type { EngineState } from '@/engine/engine';
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
  engineCheckpoints: Map<number, { timestamp: number; snapshot: EngineState }[]>;
};

export type GroupDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string;
  memberDeviceIds: number[];
  motionProfile: MotionProfileName | null;
};

type StoreState = {
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
    debugMode: boolean;
    debugFrameIndex: number;
    refLat: number | null;
    refLon: number | null;
    worldBounds: WorldBounds | null;
    editingTarget: { type: 'device' | 'group', id: number } | null;
  };

  // Refs slice (reactive)
  refs: {
    deviceToGroupsMap: Map<number, number[]>;
    groupIds: Set<number>;
    engines: Map<number, Engine>;
    processedKeys: Set<string>;
    positionsAll: NormalizedPosition[];
    firstPosition: { lat: number; lon: number } | null;
    engineCheckpoints: Map<number, { timestamp: number; snapshot: EngineState }[]>;
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
  updateGroup: (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;
  updateDevice: (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => Promise<void>;

  // Motion Profiles
  updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => void;

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
  setDebugMode: (value: boolean) => void;
  setDebugFrameIndex: (value: number) => void;
  setRefLat: (lat: number | null) => void;
  setRefLon: (lon: number | null) => void;
  setWorldBounds: (bounds: WorldBounds | null) => void;
  setEngineSnapshotsByDevice: (snapshots: Record<number, DevicePoint[]>) => void;
  setDominantAnchors: (anchors: Map<number, Anchor | null>) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;
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
    debugMode: false,
    debugFrameIndex: 0,
    refLat: null,
    refLon: null,
    worldBounds: null,
    editingTarget: null,
  },
  refs: {
    deviceToGroupsMap: new Map(),
    groupIds: new Set(),
    engines: new Map(),
    processedKeys: new Set(),
    positionsAll: [],
    firstPosition: null,
    engineCheckpoints: new Map(),
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
        const motionProfileAttributeMap: Record<number, MotionProfileName | null> = {};
        const colorAttributeMap: Record<number, string | null> = {};
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
          motionProfileAttributeMap[device.id] = (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) ? profileAttr : null;

          const colorAttr = typeof device.attributes["color"] === "string" ? device.attributes["color"] as string : null;
          colorAttributeMap[device.id] = colorAttr;

          // Check if it's a group device
          const memberDeviceIdsAttr = device.attributes["memberDeviceIds"];
          if (typeof memberDeviceIdsAttr === "string") {
            try {
              const memberDeviceIds = JSON.parse(memberDeviceIdsAttr) as unknown;
              if (Array.isArray(memberDeviceIds) && memberDeviceIds.every((id): id is number => typeof id === "number")) {
                let color = rgbToHex(...colorForDevice(device.id));
                const colorAttr = device.attributes["color"];
                if (typeof colorAttr === "string") {
                  color = colorAttr;
                }

                let groupMotionProfile: MotionProfileName | null = null;
                const mpAttr = device.attributes["motionProfile"];
                if (typeof mpAttr === "string" && (mpAttr === "person" || mpAttr === "car")) {
                  groupMotionProfile = mpAttr;
                }

                groupDevicesMap.set(device.id, {
                  id: device.id,
                  name: device.name,
                  emoji: device.emoji,
                  color,
                  memberDeviceIds,
                  motionProfile: groupMotionProfile,
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
            Object.entries(nameMap).map(([id, name]) => {
              const numId = Number(id);
              return [
                numId,
                {
                  name,
                  emoji: iconMap[numId] ?? '',
                  lastSeen: lastSeenMap[numId] ?? null,
                  effectiveMotionProfile: motionProfileMap[numId] ?? 'person',
                  motionProfile: motionProfileAttributeMap[numId] ?? null,
                  color: colorAttributeMap[numId] ?? null,
                }
              ];
            })
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
        const newGroup: GroupDevice = { id: tempId, name, emoji, color, memberDeviceIds, motionProfile: null };

        set(state => ({
          ui: { ...state.ui, selectedDeviceId: tempId },
          groups: [...state.groups, newGroup],
          devices: {
            ...state.devices,
            [tempId]: {
              name,
              emoji,
              lastSeen: Math.max(...memberDeviceIds.map(id => state.devices[id]?.lastSeen ?? 0), 0) || null,
              effectiveMotionProfile: 'person',
              motionProfile: null,
              color
            }
          },
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
          set(state => {
            const newDevices = { ...state.devices };
            const newColor = rgbToHex(...colorForDevice(created.id));
            if (newDevices[tempId]) {
              newDevices[created.id] = { ...newDevices[tempId]!, color: newColor };
              delete newDevices[tempId];
            }
            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: created.id } : state.ui,
              groups: state.groups.map(g => g.id === tempId ? { ...g, id: created.id, color: newColor } : g),
              devices: newDevices,
              refs: {
                ...state.refs,
                groupIds: new Set([...Array.from(state.refs.groupIds).filter(id => id !== tempId), created.id]),
              }
            };
          });
        } catch (error) {
          // Rollback
          set(state => {
            const newDevices = { ...state.devices };
            delete newDevices[tempId];
            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: null } : state.ui,
              groups: state.groups.filter(g => g.id !== tempId),
              devices: newDevices,
              refs: {
                ...state.refs,
                groupIds: new Set([...state.refs.groupIds].filter(id => id !== tempId)),
              }
            };
          });
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
            ui: state.ui.selectedDeviceId === groupId ? { ...state.ui, selectedDeviceId: null } : state.ui,
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
                  emoji: groupToDelete.emoji,
                  lastSeen: null,
                  effectiveMotionProfile: 'person',
                  motionProfile: null,
                  color: null,
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

      updateGroup: async (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        const { updateGroupDevice } = await import("@/api/devices");

        let defaultColor: string | null = null;
        if (updates.color === null) {
          const { colorForDevice } = await import("@/ui/color");
          const rgbToHex = (r: number, g: number, b: number): string => `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
          defaultColor = rgbToHex(...colorForDevice(groupId));
        }

        const state = get();
        const group = state.groups?.find(g => g.id === groupId);
        if (!group) return;

        // Optimistic update
        const original = { ...group };
        const newGroup = {
          ...group,
          name: updates.name ?? group.name,
          emoji: updates.emoji ?? group.emoji,
          color: updates.color === null ? defaultColor! : (updates.color ?? group.color),
          motionProfile: updates.motionProfile !== undefined ? updates.motionProfile : group.motionProfile
        };

        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? newGroup : g),
          devices: {
            ...state.devices,
            [groupId]: {
              ...state.devices[groupId]!,
              name: newGroup.name,
              emoji: newGroup.emoji,
              color: newGroup.color,
              motionProfile: newGroup.motionProfile,
            }
          }
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
            groups: state.groups.map(g => g.id === groupId ? original : g),
          }));
          throw error;
        }
      },

      updateDevice: async (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        const { updateDevice } = await import("@/api/devices");
        const state = get();
        const existing = state.devices[deviceId];
        if (!existing) return;

        // Optimistic update
        const original = { ...existing };
        const newProfileAttribute = updates.motionProfile !== undefined ? updates.motionProfile : existing.motionProfile;
        const newEffectiveProfile = newProfileAttribute ?? "person"; // Default for devices

        set(state => ({
          devices: {
            ...state.devices,
            [deviceId]: {
              ...existing,
              name: updates.name ?? existing.name,
              emoji: updates.emoji ?? existing.emoji,
              effectiveMotionProfile: newEffectiveProfile,
              motionProfile: newProfileAttribute,
              color: updates.color !== undefined ? updates.color : existing.color,
            }
          },
          motionProfiles: {
            ...state.motionProfiles,
            [deviceId]: newEffectiveProfile
          }
        }));

        try {
          await updateDevice({
            baseUrl: state.settings.baseUrl,
            secure: state.settings.secure,
            auth: { type: "token" as const, token: state.settings.token },
          }, deviceId, updates);
        } catch (error) {
          // Rollback
          set(state => ({
            devices: { ...state.devices, [deviceId]: original },
            motionProfiles: { ...state.motionProfiles, [deviceId]: original.effectiveMotionProfile }
          }));
          throw error;
        }
      },

      updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => {
        // Wrapper for updateDevice just for motion profile
        get().updateDevice(deviceId, { motionProfile: profile });
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
        const { deviceToGroupsMap, groupIds, engines, processedKeys, positionsAll, firstPosition, engineCheckpoints } = refs;
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

        // Bootstrap missing group engines (including new groups)
        for (const group of groupDevices) {
          if (!engines.has(group.id)) {
            const memberIds = new Set(group.memberDeviceIds);
            const historical = allPositions.filter(p => memberIds.has(p.device));
            if (historical.length > 0) {
              historical.sort((a, b) => a.timestamp - b.timestamp);
              posByDevice[group.id] = historical;
            }
          }
        }

        if (Object.keys(posByDevice).length === 0) return null;

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

        // Check for out-of-order data and replay if necessary
        for (const [key, newPositionsForDevice] of Object.entries(posByDevice)) {
          const deviceId = Number(key);
          const engine = engines.get(deviceId);
          if (!engine?.lastTimestamp) continue;

          newPositionsForDevice.sort((a, b) => a.timestamp - b.timestamp);
          if (newPositionsForDevice.length === 0 || !newPositionsForDevice[0]) continue;
          const minTs = newPositionsForDevice[0].timestamp;

          if (minTs < engine.lastTimestamp) {
            const checkpoints = engineCheckpoints.get(deviceId) ?? [];
            let cp = null;
            let cpIndex = -1;
            for (let i = checkpoints.length - 1; i >= 0; i--) {
              const checkpoint = checkpoints[i];
              if (checkpoint && checkpoint.timestamp < minTs) {
                cp = checkpoint;
                cpIndex = i;
                break;
              }
            }

            let replayFrom = 0;
            if (cp) {
              engine.restoreSnapshot(cp.snapshot);
              replayFrom = cp.timestamp;
              // Prune invalid future checkpoints
              const validCheckpoints = checkpoints.slice(0, cpIndex + 1);
              engineCheckpoints.set(deviceId, validCheckpoints);
            } else {
              engines.set(deviceId, new Engine());
              engineCheckpoints.set(deviceId, []);
              replayFrom = 0;
            }

            // Gather all historical positions > replayFrom
            let relevantDeviceIds = new Set<number>();
            if (groupIds.has(deviceId)) {
              const group = groupDevices.find(g => g.id === deviceId);
              if (group) {
                group.memberDeviceIds.forEach(id => relevantDeviceIds.add(id));
              }
            } else {
              relevantDeviceIds.add(deviceId);
            }

            // Must sort positionsAll if not already sorted? Assuming implicit sort by arrival.
            // But to be safe, filtering -> sort is better.
            const historical = positionsAll.filter(p => relevantDeviceIds.has(p.device) && p.timestamp > replayFrom);
            historical.sort((a, b) => a.timestamp - b.timestamp);
            posByDevice[deviceId] = historical;
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
          if (group.motionProfile) {
            groupMotionProfiles.set(group.id, group.motionProfile);
            continue;
          }
          let profile: MotionProfileName = "person";
          for (const memberId of group.memberDeviceIds) {
            if ((state.motionProfiles[memberId] ?? "person") === "car") {
              profile = "car";
              break;
            }
          }
          groupMotionProfiles.set(group.id, profile);
        }

        const result = buildEngineSnapshotsFromByDevice(rawByDevice, engines, groupIds, groupMotionProfiles, state.motionProfiles, refLat, refLon, state.refs.positionsAll);

        // Update checkpoints
        for (const [key, points] of Object.entries(rawByDevice)) {
          if (points.length === 0) continue;
          const deviceId = Number(key);
          const engine = engines.get(deviceId);
          if (engine?.lastTimestamp) {
            let checkpoints = engineCheckpoints.get(deviceId);
            if (!checkpoints) {
              checkpoints = [];
              engineCheckpoints.set(deviceId, checkpoints);
            }
            const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
            // Checkpoint every 5 minutes
            if (!lastCp || (engine.lastTimestamp - lastCp.timestamp) > 300000) {
              checkpoints.push({ timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() });
              if (checkpoints.length > 50) checkpoints.shift(); // Keep last 50
            }
          }
        }

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

      setEditingTarget: (target) => {
        set(state => ({
          ui: {
            ...state.ui,
            editingTarget: target,
          }
        }));
      },
    }),
    {
      name: 'flux360-store',
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);