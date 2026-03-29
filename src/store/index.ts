import { closeWebSocket } from '@/wsClient';
import { create } from 'zustand';
import { numericEntries } from '@/util/record';
import { persist } from 'zustand/middleware';
import { rgbToHex, colorForDevice } from '@/util/color';
import { sendRPC } from '@/wsRPC';
import type { AppDevice, MotionProfileName, DeviceShare } from '@/types';
import type { Store, StoreState } from './types';

const initialState: StoreState = {
  entities: {},
  settings: {
    maptilerApiKey: '',
    theme: 'system',
    sessionToken: null,
  },
  auth: {
    isAuthenticated: false,
    isLoggingIn: false,
    loginError: null,
    ownedDeviceIds: [],
  },
  ui: {
    selectedDeviceId: null,
    isSidePanelOpen: true,
    editingTarget: null,
  },
  activePointsByDevice: {},
  eventsByDevice: {},
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Data Handlers from WebSocket
      setInitialState: (payload) => {
        set((state) => ({
          ...state,
          entities: payload.entities,
          activePointsByDevice: payload.activePointsByDevice,
          eventsByDevice: payload.eventsByDevice,
          settings: { ...state.settings, maptilerApiKey: payload.maptilerApiKey }
        }));
      },

      setOwnedDeviceIds: (ids) => {
        set((state) => ({
          auth: { ...state.auth, ownedDeviceIds: ids }
        }));
      },

      updatePositions: ({ activePoints, events }) => {
        set((state) => {
          const nextActivePoints = { ...state.activePointsByDevice, ...activePoints };
          const nextEvents = { ...state.eventsByDevice, ...events };

          // Update lastSeen for device entities only (groups are updated via config_update)
          const newEntities = { ...state.entities };
          for (const [id, points] of numericEntries(activePoints)) {
            const entity = newEntities[id];
            // Only update if entity exists, is NOT a group (no memberDeviceIds), and has points
            if (!entity || entity.memberDeviceIds || !Array.isArray(points) || points.length === 0) continue;
            const maxTimestamp = Math.max(...points.map(p => p.timestamp));
            const currentLastSeen = entity.lastSeen;
            if (!currentLastSeen || maxTimestamp > currentLastSeen) {
              newEntities[id] = { ...entity, lastSeen: maxTimestamp };
            }
          }

          return {
            ...state,
            entities: newEntities,
            activePointsByDevice: nextActivePoints,
            eventsByDevice: nextEvents
          };
        });
      },

      updateConfig: (payload) => {
        set(state => {
          const newEntities = { ...state.entities };
          const ownedIdSet = new Set(state.auth.ownedDeviceIds);
          if (payload.devices !== null) {
            for (const [id, newDev] of numericEntries(payload.devices)) {
              newEntities[id] = {
                ...newDev,
                isOwner: state.entities[id]?.isOwner ?? newDev.isOwner ?? ownedIdSet.has(id),
              };
            }
          }

          if (payload.groups !== null) {
            for (const group of payload.groups) {
              newEntities[group.id] = {
                ...group,
                isOwner: state.entities[group.id]?.isOwner ?? group.isOwner ?? ownedIdSet.has(group.id),
              };
            }
          }

          return {
            entities: newEntities,
          };
        });
      },

      // Device/Group Management
      createGroup: async (name: string, memberDeviceIds: number[], emoji: string) => {
        const tempId = Date.now();
        const color = rgbToHex(...colorForDevice(tempId));
        const newGroup: AppDevice = {
          id: tempId,
          name,
          emoji,
          color,
          memberDeviceIds,
          motionProfile: null,
          lastSeen: Math.max(...memberDeviceIds.map(id => get().entities[id]?.lastSeen ?? 0), 0) || null,
          effectiveMotionProfile: 'person',
          isOwner: true
        };

        set(state => ({
          ui: { ...state.ui, selectedDeviceId: tempId },
          entities: {
            ...state.entities,
            [tempId]: newGroup
          },
        }));

        try {
          const resp = await sendRPC<{ device: { id: number } }>('create_group', { name, emoji, memberDeviceIds });
          const created = resp.device;

          set(state => {
            const newEntities = { ...state.entities };
            const newColor = rgbToHex(...colorForDevice(created.id));
            if (newEntities[tempId]) {
              newEntities[created.id] = { ...newEntities[tempId], id: created.id, color: newColor };
              delete newEntities[tempId];
            }

            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: created.id } : state.ui,
              entities: newEntities,
            };
          });
        } catch (error) {
          set(state => {
            const newEntities = { ...state.entities };
            delete newEntities[tempId];
            return {
              ui: state.ui.selectedDeviceId === tempId ? { ...state.ui, selectedDeviceId: null } : state.ui,
              entities: newEntities,
            };
          });
          throw error;
        }
      },

      deleteGroup: async (groupId: number) => {
        const state = get();

        const groupToDelete = state.entities[groupId];
        set(state => {
          const newEntities = { ...state.entities };
          delete newEntities[groupId];
          return {
            ui: state.ui.selectedDeviceId === groupId ? { ...state.ui, selectedDeviceId: null } : state.ui,
            entities: newEntities,
          };
        });

        if (groupId < 0) return;

        try {
          await sendRPC('delete_group', { groupId });
        } catch (error) {
          if (!groupToDelete) throw error;
          set(state => ({
            entities: {
              ...state.entities,
              [groupId]: groupToDelete
            }
          }));
          throw error;
        }
      },

      addDeviceToGroup: async (groupId: number, deviceId: number) => {
        const group = get().entities[groupId];
        if (!group?.memberDeviceIds || group.memberDeviceIds.includes(deviceId)) return;

        const originalMembers = [...group.memberDeviceIds];
        const newMembers = [...originalMembers, deviceId];
        set(state => ({
          entities: {
            ...state.entities,
            [groupId]: { ...group, memberDeviceIds: newMembers }
          }
        }));

        if (groupId < 0 || deviceId < 0) return;

        try {
          await sendRPC('add_device_to_group', { groupId, deviceId });
        } catch (error) {
          set(state => ({
            entities: {
              ...state.entities,
              [groupId]: { ...group, memberDeviceIds: originalMembers }
            }
          }));
          throw error;
        }
      },

      removeDeviceFromGroup: async (groupId: number, deviceId: number) => {
        const group = get().entities[groupId];
        if (!group?.memberDeviceIds?.includes(deviceId)) return;

        const originalMembers = [...group.memberDeviceIds];
        const newMembers = originalMembers.filter(id => id !== deviceId);
        set(state => ({
          entities: {
            ...state.entities,
            [groupId]: { ...group, memberDeviceIds: newMembers }
          }
        }));

        if (groupId < 0 || deviceId < 0) return;

        try {
          await sendRPC('remove_device_from_group', { groupId, deviceId });
        } catch (error) {
          set(state => ({
            entities: {
              ...state.entities,
              [groupId]: { ...group, memberDeviceIds: originalMembers }
            }
          }));
          throw error;
        }
      },

      updateGroup: async (groupId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        let defaultColor: string | null = null;
        if (updates.color === null) {
          defaultColor = rgbToHex(...colorForDevice(groupId));
        }

        const state = get();
        const group = state.entities[groupId];
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
          entities: {
            ...state.entities,
            [groupId]: newGroup
          }
        }));

        if (groupId < 0) return;

        try {
          await sendRPC('update_device', { deviceId: groupId, updates });
        } catch (error) {
          set(state => ({
            entities: {
              ...state.entities,
              [groupId]: original
            },
          }));
          throw error;
        }
      },

      updateDevice: async (deviceId: number, updates: { name?: string; emoji?: string; color?: string | null; motionProfile?: MotionProfileName | null }) => {
        const existing = get().entities[deviceId];
        if (!existing) return;

        const original = { ...existing };
        const newProfileAttribute = updates.motionProfile !== undefined ? updates.motionProfile : existing.motionProfile;
        const newEffectiveProfile = newProfileAttribute ?? "person";

        set(state => ({
          entities: {
            ...state.entities,
            [deviceId]: {
              ...existing,
              name: updates.name ?? existing.name,
              emoji: updates.emoji ?? existing.emoji,
              effectiveMotionProfile: newEffectiveProfile,
              motionProfile: newProfileAttribute,
              color: updates.color !== undefined ? updates.color : existing.color,
              isOwner: true,
            }
          }
        }));

        if (deviceId < 0) return;

        try {
          await sendRPC('update_device', { deviceId, updates });
        } catch (error) {
          set(state => ({
            entities: { ...state.entities, [deviceId]: original },
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

      login: async (username, password) => {
        set(state => ({
          auth: { ...state.auth, isLoggingIn: true, loginError: null }
        }));
        try {
          const { token } = await sendRPC<{ token: string }>('login', { username, password });
          set(state => ({
            settings: { ...state.settings, sessionToken: token },
            auth: {
              ...state.auth,
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

      shareDevice: async (deviceId: number, username: string) => {
        await sendRPC('share_device', { deviceId, username });
      },

      unshareDevice: async (deviceId: number, username: string) => {
        await sendRPC('unshare_device', { deviceId, username });
      },

      getShares: async () => {
        const { payload } = await sendRPC<{ payload: DeviceShare[] }>('get_shares');
        return payload;
      },

      logout: () => {
        closeWebSocket();
        set(initialState);

        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem('flux360-store');
        }
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
        auth: { isAuthenticated: state.auth.isAuthenticated, isLoggingIn: false, loginError: null, ownedDeviceIds: [] }
      }),
    }
  )
);