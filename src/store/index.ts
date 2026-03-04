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
    email: '',
    password: '',
    maptilerApiKey: '',
    theme: 'system',
  },
  auth: {
    isAuthenticated: false,
    isLoggingIn: false,
    loginError: null,
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
  eventsByDevice: {},
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
          const { baseUrl, secure, email, password } = get().settings;
          const created = await createGroupDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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
          const { baseUrl, secure, email, password } = get().settings;
          await deleteGroupDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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
        const group = get().groups.find(g => g.id === groupId);
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
          const { baseUrl, secure, email, password } = get().settings;
          await updateGroupDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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
        const group = get().groups.find(g => g.id === groupId);
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
          const { baseUrl, secure, email, password } = get().settings;
          await updateGroupDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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
          const { baseUrl, secure, email, password } = get().settings;
          await updateGroupDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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
        const existing = get().devices[deviceId];
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
          const { baseUrl, secure, email, password } = get().settings;
          await updateDevice({
            baseUrl, secure, auth: { type: "basic", username: email, password }
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

        const { processPositions } = get();
        processPositions();
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

        const { engineSnapshotsByDevice, eventsByDevice } = result;

        set(() => ({
          engineSnapshotsByDevice,
          eventsByDevice,
        }));

        return null;
      },

      setTheme: (theme: 'light' | 'dark' | 'system') => {
        set(state => ({
          settings: {
            ...state.settings,
            theme,
          }
        }));
      },

      login: async (email, password) => {
        const { fetchSession } = await import("@/api/devices");
        const { settings } = get();

        set(state => ({
          auth: { ...state.auth, isLoggingIn: true, loginError: null }
        }));

        try {
          const baseUrl = settings.baseUrl;
          const secure = settings.secure;

          if (!baseUrl) throw new Error("Base URL is missing in server config");

          await fetchSession({
            baseUrl,
            secure,
            auth: { type: "basic", username: email, password }
          });

          // If fetchSession succeeds, we're authenticated
          set(state => ({
            settings: {
              ...state.settings,
              email,
              password,
            },
            auth: {
              isAuthenticated: true,
              isLoggingIn: false,
              loginError: null,
            }
          }));

          // Fetch protected configuration after login
          await get().fetchMaptilerKey();
        } catch (error) {
          set(state => ({
            auth: {
              ...state.auth,
              isLoggingIn: false,
              loginError: error instanceof Error ? error.message : String(error),
            }
          }));
          throw error;
        }
      },

      logout: () => {
        set(state => ({
          auth: {
            ...state.auth,
            isAuthenticated: false,
          },
          settings: {
            ...state.settings,
            email: '',
            password: '',
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

      // External Config
      fetchConfig: async () => {
        try {
          const response = await fetch('/api/config');
          const config = await response.json() as { traccarBaseUrl?: string; traccarSecure?: boolean };

          set(state => ({
            settings: {
              ...state.settings,
              baseUrl: config.traccarBaseUrl ?? state.settings.baseUrl,
              secure: config.traccarSecure ?? state.settings.secure,
            }
          }));
        } catch (error) {
          console.error('Failed to fetch config:', error);
        }
      },

      fetchMaptilerKey: async () => {
        try {
          const { buildAuthHeader } = await import("@/api/httpUtils");
          const { settings } = get();

          const authHeader = buildAuthHeader({
            type: "basic",
            username: settings.email,
            password: settings.password,
          });

          const response = await fetch('/api/config/maptiler', {
            headers: authHeader ? { "Authorization": authHeader } : {},
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch MapTiler key: ${response.status}`);
          }

          const config = await response.json() as { maptilerApiKey?: string };

          set(state => ({
            settings: {
              ...state.settings,
              maptilerApiKey: config.maptilerApiKey ?? state.settings.maptilerApiKey,
            }
          }));
        } catch (error) {
          console.error('Failed to fetch MapTiler key:', error);
        }
      },
    }),
    {
      name: 'flux360-store',
      partialize: (state) => ({
        settings: state.settings,
        auth: { isAuthenticated: state.auth.isAuthenticated } // Persist only auth status
      }),
    }
  )
);