import { closeWebSocket, sendRPC } from '@/wsRPC';
import { create } from 'zustand';
import { numericEntries } from '@/util/record';
import { persist } from 'zustand/middleware';
import type { DeviceShare, DeviceMetadata } from '@/types';
import type { Store, StoreState, ThemeOptions } from './types';

const initialState: StoreState = {
  entities: {},
  settings: {
    maptilerApiKey: '',
    theme: 'Auto',
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
          const ownedIdSet = new Set(payload.ownedDeviceIds);
          const allowedIdSet = new Set(payload.allowedDeviceIds);

          for (const [id, newDev] of numericEntries(payload.devices)) {
            newEntities[id] = {
              ...newDev,
              isOwner: ownedIdSet.has(id),
            };
          }

          for (const group of payload.groups) {
            newEntities[group.id] = {
              ...group,
              isOwner: ownedIdSet.has(group.id),
            };
          }

          // Reconciliation: Remove entities not in the allowed list (source of truth)
          for (const idStr of Object.keys(newEntities)) {
            const id = Number(idStr);
            if (!allowedIdSet.has(id)) delete newEntities[id];
          }

          return {
            entities: newEntities,
            auth: { ...state.auth, ownedDeviceIds: payload.ownedDeviceIds },
          };
        });
      },

      // Device/Group Management
      createGroup: (name: string, memberDeviceIds: number[], icon: string) =>
        sendRPC<{ device: { id: number } }>('create_group', { name, icon, memberDeviceIds }).then(() => undefined),

      deleteGroup: (groupId: number) =>
        sendRPC('delete_group', { groupId }).then(() => undefined),

      addDeviceToGroup: async (groupId: number, deviceId: number) => {
        const group = get().entities[groupId];
        if (!group?.memberDeviceIds || group.memberDeviceIds.includes(deviceId)) return Promise.resolve();
        await sendRPC('add_device_to_group', { groupId, deviceId });
      },

      removeDeviceFromGroup: async (groupId: number, deviceId: number) => {
        const group = get().entities[groupId];
        if (!group?.memberDeviceIds?.includes(deviceId)) return Promise.resolve();
        await sendRPC('remove_device_from_group', { groupId, deviceId });
      },

      updateDevice: (deviceId: number, updates: DeviceMetadata) =>
        sendRPC('update_device', { deviceId, updates }).then(() => undefined),

      setTheme: (theme: ThemeOptions) => {
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

      shareDevice: (deviceId: number, username: string) =>
        sendRPC('share_device', { deviceId, username }).then(() => undefined),

      unshareDevice: (deviceId: number, username: string) =>
        sendRPC('unshare_device', { deviceId, username }).then(() => undefined),

      getShares: () =>
        sendRPC<{ payload: DeviceShare[] }>('get_shares').then(({ payload }) => payload),

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