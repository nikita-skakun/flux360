import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rgbToHex } from '@/util/color';
import type { AppDevice, MotionProfileName } from '@/types';
import type { Store, StoreState } from './types';

const initialState: StoreState = {
  devices: {},
  groups: [],
  settings: {
    maptilerApiKey: '',
    theme: 'system',
    sessionToken: null,
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
  engineSnapshotsByDevice: {},
  eventsByDevice: {},
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Data Handlers from WebSocket
      setInitialState: (payload) => {
        set((state) => ({
          devices: payload.devices,
          groups: payload.groups,
          engineSnapshotsByDevice: payload.engineSnapshotsByDevice,
          eventsByDevice: payload.eventsByDevice,
          settings: {
            ...state.settings,
            maptilerApiKey: payload.maptilerApiKey,
          },
        }));
      },

      updatePositions: (payload) => {
        set(state => ({
          engineSnapshotsByDevice: { ...state.engineSnapshotsByDevice, ...payload.snapshots },
          eventsByDevice: { ...state.eventsByDevice, ...payload.events },
        }));
      },

      updateConfig: (payload) => {
        set(state => {
          const newDevices = { ...state.devices };
          if (payload.devices !== null) {
            for (const [idStr, newDev] of Object.entries(payload.devices)) {
              const id = parseInt(idStr);
              newDevices[id] = {
                ...newDev,
                isOwner: state.devices[id]?.isOwner ?? newDev.isOwner ?? false,
              };
            }
          }

          let newGroups = [...state.groups];
          if (payload.groups !== null) {
            const groupIdsIncoming = new Set(payload.groups.map(g => g.id));
            newGroups = newGroups.filter(g => !groupIdsIncoming.has(g.id));
            newGroups.push(...payload.groups);
          }

          return {
            devices: newDevices,
            groups: newGroups,
          };
        });
      },

      // Device/Group Management
      createGroup: async (name: string, memberDeviceIds: number[], emoji: string) => {
        const { sendRPC } = await import("@/wsRPC");
        const { colorForDevice } = await import("@/util/color");

        const tempId = Date.now();
        const color = rgbToHex(...colorForDevice(tempId));
        const newGroup: AppDevice = {
          id: tempId,
          name,
          emoji,
          color,
          memberDeviceIds,
          motionProfile: null,
          lastSeen: null,
          effectiveMotionProfile: 'person',
          isOwner: true
        };

        set(state => ({
          ui: { ...state.ui, selectedDeviceId: tempId },
          groups: [...state.groups, newGroup],
          devices: {
            ...state.devices,
            [tempId]: {
              id: tempId,
              name,
              emoji,
              lastSeen: Math.max(...memberDeviceIds.map(id => state.devices[id]?.lastSeen ?? 0), 0) || null,
              effectiveMotionProfile: 'person',
              motionProfile: null,
              color,
              isOwner: true,
              memberDeviceIds
            }
          },
        }));

        try {
          const resp = await sendRPC<{ device: { id: number } }>('create_group', { name, emoji, memberDeviceIds });
          const created = resp.device;

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
            };
          });
        } catch (error) {
          set(state => {
            const newDevices = { ...state.devices };
            delete newDevices[tempId];
            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: null } : state.ui,
              groups: state.groups.filter(g => g.id !== tempId),
              devices: newDevices,
            };
          });
          throw error;
        }
      },

      deleteGroup: async (groupId: number) => {
        const { sendRPC } = await import("@/wsRPC");
        const state = get();

        const groupToDelete = state.groups.find(g => g.id === groupId);
        set(state => {
          const newDevices = { ...state.devices };
          delete newDevices[groupId];
          return {
            ui: state.ui.selectedDeviceId === groupId ? { ...state.ui, selectedDeviceId: null } : state.ui,
            groups: state.groups.filter(g => g.id !== groupId),
            devices: newDevices,
          };
        });

        if (groupId < 0) return;

        try {
          await sendRPC('delete_group', { groupId });
        } catch (error) {
          if (groupToDelete) {
            set(state => ({
              groups: [...state.groups, groupToDelete],
              devices: {
                ...state.devices,
                [groupId]: {
                  id: groupId,
                  name: groupToDelete.name,
                  emoji: groupToDelete.emoji,
                  lastSeen: null,
                  effectiveMotionProfile: 'person',
                  motionProfile: null,
                  color: null,
                  isOwner: true,
                  memberDeviceIds: groupToDelete.memberDeviceIds
                }
              }
            }));
          }
          throw error;
        }
      },

      addDeviceToGroup: async (groupId: number, deviceId: number) => {
        const { sendRPC } = await import("@/wsRPC");
        const group = get().groups.find(g => g.id === groupId);
        if (!group || group.memberDeviceIds === null || group.memberDeviceIds.includes(deviceId)) return;

        const originalMembers = [...group.memberDeviceIds];
        const newMembers = [...originalMembers, deviceId];
        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
        }));

        if (groupId < 0 || deviceId < 0) return;

        try {
          await sendRPC('add_device_to_group', { groupId, deviceId });
        } catch (error) {
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: originalMembers } : g),
          }));
          throw error;
        }
      },

      removeDeviceFromGroup: async (groupId: number, deviceId: number) => {
        const { sendRPC } = await import("@/wsRPC");
        const group = get().groups.find(g => g.id === groupId);
        if (!group || group.memberDeviceIds === null || !group.memberDeviceIds.includes(deviceId)) return;

        const originalMembers = [...group.memberDeviceIds];
        const newMembers = originalMembers.filter(id => id !== deviceId);
        set(state => ({
          groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: newMembers } : g),
        }));

        if (groupId < 0 || deviceId < 0) return;

        try {
          await sendRPC('remove_device_from_group', { groupId, deviceId });
        } catch (error) {
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? { ...g, memberDeviceIds: originalMembers } : g),
          }));
          throw error;
        }
      },

      updateGroup: async (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        const { sendRPC } = await import("@/wsRPC");

        let defaultColor: string | null = null;
        if (updates.color === null) {
          const { colorForDevice } = await import("@/util/color");
          defaultColor = rgbToHex(...colorForDevice(groupId));
        }

        const state = get();
        const group = state.groups?.find(g => g.id === groupId);
        if (!group) return;

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
              isOwner: true,
              memberDeviceIds: newGroup.memberDeviceIds
            }
          }
        }));

        if (groupId < 0) return;

        try {
          await sendRPC('update_device', { deviceId: groupId, updates });
        } catch (error) {
          set(state => ({
            groups: state.groups.map(g => g.id === groupId ? original : g),
          }));
          throw error;
        }
      },

      updateDevice: async (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        const { sendRPC } = await import("@/wsRPC");
        const existing = get().devices[deviceId];
        if (!existing) return;

        const original = { ...existing };
        const newProfileAttribute = updates.motionProfile !== undefined ? updates.motionProfile : existing.motionProfile;
        const newEffectiveProfile = newProfileAttribute ?? "person";

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
              isOwner: true,
              memberDeviceIds: existing.memberDeviceIds
            }
          }
        }));

        if (deviceId < 0) return;

        try {
          await sendRPC('update_device', { deviceId, updates });
        } catch (error) {
          set(state => ({
            devices: { ...state.devices, [deviceId]: original },
          }));
          throw error;
        }
      },

      updateMotionProfile: (deviceId: number, profile: MotionProfileName | null) => {
        void get().updateDevice(deviceId, { motionProfile: profile });
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
        set(state => ({
          auth: { ...state.auth, isLoggingIn: true, loginError: null }
        }));

        try {
          const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || 'Login failed');
          }

          // Wait for response normally
          const { token } = (await response.json()) as { token: string };
          set(state => ({
            settings: {
              ...state.settings,
              sessionToken: token,
            },
            auth: {
              isAuthenticated: true,
              isLoggingIn: false,
              loginError: null,
            }
          }));
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
            sessionToken: null,
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

    }),
    {
      name: 'flux360-store',
      partialize: (state) => ({
        settings: state.settings,
        auth: { isAuthenticated: state.auth.isAuthenticated, isLoggingIn: false, loginError: null }
      }),
    }
  )
);