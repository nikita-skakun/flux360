import { create } from 'zustand';
import { parseDevices, computeProcessedPositions } from './processors';
import { persist } from 'zustand/middleware';
import { rgbToHex } from '@/util/color';
import type { GroupDevice, MotionProfileName, NormalizedPosition } from '@/types';
import type { Store, StoreState } from './types';
import type { TraccarDevice } from '@/api/devices';

const initialState: StoreState = {
  devices: {},
  groups: [],
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
  ui: {
    selectedDeviceId: null,
    isSidePanelOpen: true,
    debugMode: false,
    debugFrameIndex: 0,
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
        const { colorForDevice } = await import("@/util/color");

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
        const { colorForDevice } = await import("@/util/color");

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
            const newDeviceToGroupsMap = new Map(state.refs.deviceToGroupsMap);
            for (const memberId of memberDeviceIds) {
              const groups = newDeviceToGroupsMap.get(memberId) ?? [];
              if (!groups.includes(created.id)) {
                newDeviceToGroupsMap.set(memberId, [...groups, created.id]);
              }
            }

            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: created.id } : state.ui,
              groups: state.groups.map(g => g.id === tempId ? { ...g, id: created.id, color: newColor } : g),
              devices: newDevices,
              refs: {
                ...state.refs,
                groupIds: new Set([...Array.from(state.refs.groupIds).filter(id => id !== tempId), created.id]),
                deviceToGroupsMap: newDeviceToGroupsMap,
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

          const newDeviceToGroupsMap = new Map(state.refs.deviceToGroupsMap);
          if (groupToDelete) {
            for (const memberId of groupToDelete.memberDeviceIds) {
              const groups = newDeviceToGroupsMap.get(memberId);
              if (groups) {
                newDeviceToGroupsMap.set(memberId, groups.filter(id => id !== groupId));
              }
            }
          }

          return {
            ui: state.ui.selectedDeviceId === groupId ? { ...state.ui, selectedDeviceId: null } : state.ui,
            groups: state.groups.filter(g => g.id !== groupId),
            devices: newDevices,
            refs: {
              ...state.refs,
              groupIds: new Set([...state.refs.groupIds].filter(id => id !== groupId)),
              deviceToGroupsMap: newDeviceToGroupsMap,
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
        set(state => {
          const newMap = new Map(state.refs.deviceToGroupsMap);
          const deviceGroups = newMap.get(deviceId) ?? [];
          if (!deviceGroups.includes(groupId)) {
            newMap.set(deviceId, [...deviceGroups, groupId]);
          }
          return {
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
            refs: {
              ...state.refs,
              deviceToGroupsMap: newMap,
            }
          };
        });

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
        set(state => {
          const newMap = new Map(state.refs.deviceToGroupsMap);
          const deviceGroups = newMap.get(deviceId);
          if (deviceGroups) {
            newMap.set(deviceId, deviceGroups.filter(id => id !== groupId));
          }
          return {
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
            refs: {
              ...state.refs,
              deviceToGroupsMap: newMap,
            }
          };
        });

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
          const { colorForDevice } = await import("@/util/color");
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
          }));
          throw error;
        }
      },

      updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => {
        // Wrapper for updateDevice just for motion profile (fire-and-forget)
        void get().updateDevice(deviceId, { motionProfile: profile });
      },

      addPositions: (positions: NormalizedPosition[]) => {
        set(state => {
          const newPositions = [...state.refs.positionsAll, ...positions];
          // Sort once here so engine and retrospective don't have to
          newPositions.sort((a, b) => a.timestamp - b.timestamp);

          return {
            refs: {
              ...state.refs,
              positionsAll: newPositions,
            }
          };
        });

        const { processPositions, runRetrospectiveAnalysis } = get();
        processPositions();
        runRetrospectiveAnalysis();
      },

      processPositions: () => {
        const state = get();
        const { refs } = state;
        const { deviceToGroupsMap, groupIds, engines, processedKeys, positionsAll, engineCheckpoints } = refs;

        const motionProfiles: Record<number, MotionProfileName> = Object.fromEntries(
          Object.entries(state.devices).map(([id, d]) => [id, d.effectiveMotionProfile])
        );

        const result = computeProcessedPositions(
          positionsAll,
          processedKeys,
          deviceToGroupsMap,
          state.groups,
          engines,
          engineCheckpoints,
          groupIds,
          motionProfiles
        );

        if (!result) return null;

        const { engineSnapshotsByDevice, motionSegments } = result;

        set(() => ({
          engineSnapshotsByDevice,
          motionSegments,
        }));

        return null;
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

      setEditingTarget: (target) => {
        set(state => ({
          ui: {
            ...state.ui,
            editingTarget: target,
          }
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
            const motionProfiles: Record<number, MotionProfileName> = Object.fromEntries(
              Object.entries(state.devices).map(([id, d]) => [id, d.effectiveMotionProfile])
            );

            // Group positions by device for efficient retrospective analysis
            const positionsByDevice = new Map<number, NormalizedPosition[]>();
            for (const p of state.refs.positionsAll) {
              const list = positionsByDevice.get(p.device) ?? [];
              if (list.length === 0) positionsByDevice.set(p.device, list);
              list.push(p);
            }

            const results = analyzeAllDevices(
              positionsByDevice,
              deviceIds,
              motionProfiles
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
    }),
    {
      name: 'flux360-store',
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);