import { create } from 'zustand';
import { parseDevices, computeProcessedPositions } from './processors';
import { persist } from 'zustand/middleware';
import { rgbToHex } from '@/ui/color';
import type { Anchor } from '@/engine/anchor';
import type { GroupDevice, MotionProfileName, DevicePoint, WorldBounds, NormalizedPosition } from '@/types';
import type { Store, StoreState } from './types';
import type { TraccarDevice } from '@/api/devices';

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
    maptilerApiKey: '',
    inputMaptilerApiKey: '',
    darkMode: 'system',
    inputDarkMode: 'system',
  },
  positions: {
    allPositions: [],
    snapshots: {},
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
    engineCheckpoints: new Map(),
  },
  engineSnapshotsByDevice: {},
  dominantAnchors: new Map() as Map<number, Anchor | null>,
  motionSegments: {},
  retrospective: {
    byDevice: new Map(),
    lastUpdate: 0,
    isAnalyzing: false,
  },
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Device/Group Management
      setDevicesFromApi: async (devices: TraccarDevice[]) => {
        const { colorForDevice } = await import("@/ui/color");

        const {
          nameMap,
          iconMap,
          lastSeenMap,
          motionProfileMap,
          motionProfileAttributeMap,
          colorAttributeMap,
          groups,
          deviceToGroupsMap,
          groupIds
        } = parseDevices(devices, colorForDevice);

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
          groups,
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
              newDevices[created.id] = { ...newDevices[tempId], color: newColor };
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
        // Wrapper for updateDevice just for motion profile (fire-and-forget)
        void get().updateDevice(deviceId, { motionProfile: profile });
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
        const { deviceToGroupsMap, groupIds, engines, processedKeys, positionsAll, engineCheckpoints } = refs;

        const result = computeProcessedPositions(
          positionsAll,
          processedKeys,
          deviceToGroupsMap,
          state.groups,
          engines,
          engineCheckpoints,
          groupIds,
          state.motionProfiles
        );

        if (!result) return null;

        const { engineSnapshotsByDevice, dominantAnchors, motionSegments } = result;

        set(() => ({
          engineSnapshotsByDevice,
          dominantAnchors,
          motionSegments,
        }));

        return null;
      },

      setSnapshots: (snapshots: Record<number, DevicePoint[]>) => {
        set(state => ({
          positions: {
            ...state.positions,
            snapshots,
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
            maptilerApiKey: state.settings.inputMaptilerApiKey,
            darkMode: state.settings.inputDarkMode,
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
            maptilerApiKey: '',
            inputMaptilerApiKey: '',
            darkMode: 'system',
            inputDarkMode: 'system',
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

      setInputMaptilerApiKey: (value: string) => {
        set(state => ({
          settings: {
            ...state.settings,
            inputMaptilerApiKey: value,
          }
        }));
      },

      setInputDarkMode: (value: 'light' | 'dark' | 'system') => {
        set(state => ({
          settings: {
            ...state.settings,
            inputDarkMode: value,
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

      setMotionSegments: (segments) => {
        set(() => ({
          motionSegments: segments,
        }));
      },

      runRetrospectiveAnalysis: () => {
        const state = get();

        // 1. Debounce: If already analyzing or recently analyzed, skip
        if (state.retrospective.isAnalyzing) return;

        // Simple debounce: don't run if last update was < 2 seconds ago
        // This prevents rapid-fire executions during initial data load
        if (Date.now() - state.retrospective.lastUpdate < 2000) return;

        // Get all device IDs
        const deviceIds = Object.keys(state.devices).map(id => Number(id));
        if (deviceIds.length === 0) return;

        set(prevState => ({
          retrospective: {
            ...prevState.retrospective,
            isAnalyzing: true,
          }
        }));

        // Use dynamic import to avoid circular dependencies
        void (async () => {
          try {
            // Add a small delay to let UI render first (yield to main thread)
            await new Promise(resolve => setTimeout(resolve, 50));

            const { analyzeAllDevices } = await import('@/engine/retrospective');
            const results = analyzeAllDevices(
              state.refs.positionsAll,
              deviceIds,
              state.motionProfiles
            );

            set(() => ({
              retrospective: {
                byDevice: results,
                lastUpdate: Date.now(),
                isAnalyzing: false,
              }
            }));
          } catch {
            set(prevState => ({
              retrospective: {
                ...prevState.retrospective,
                isAnalyzing: false,
              }
            }));
          }
        })();
      },

      setRetrospectiveResults: (results) => {
        set(prevState => ({
          retrospective: {
            ...prevState.retrospective,
            byDevice: results,
            lastUpdate: Date.now(),
            isAnalyzing: false,
          }
        }));
      },

      clearRetrospectiveResults: () => {
        set(prevState => ({
          retrospective: {
            byDevice: new Map(),
            lastUpdate: 0,
            isAnalyzing: prevState.retrospective.isAnalyzing,
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