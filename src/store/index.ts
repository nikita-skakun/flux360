import { closeWebSocket, sendRPC } from '@/wsRPC';
import { create } from 'zustand';
import { numericEntries } from '@/util/record';
import { persist } from 'zustand/middleware';
import type { DeviceShare, DeviceMetadata } from '@/types';
import type { Store, StoreState, ThemeOptions } from './types';
import { applyOpToLabels, invertOp, opEntityId, popUndo, pushOp } from '@/labels/undo';
import { mergeFixes } from '@/labels/fixes';
import { checkPlacement } from '@/labels/validation';
import type { Label, StripFix } from '@/labels/types';
import type { LabelOp } from '@/labels/undo';

const initialState: StoreState = {
  entities: {},
  settings: {
    maptilerApiKey: '',
    historyDays: 2,
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
    isLabelMode: false,
  },
  activePointsByDevice: {},
  eventsByDevice: {},
  labelsByEntity: {},
  historyFixesByEntity: {},
  labelHistory: [],
  labelError: null,
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
          settings: {
            ...state.settings,
            maptilerApiKey: payload.maptilerApiKey,
            historyDays: payload.historyDays
          }
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

      setLabelMode: (enabled: boolean) => {
        set(state => ({
          ui: {
            ...state.ui,
            isLabelMode: enabled,
          }
        }));
      },

      setLabelError: (message: string | null) => {
        set({ labelError: message });
      },

      loadLabels: async (entityId: number) => {
        const response = await sendRPC<{ payload: { labels: Label[] } }>('list_labels', { entityId });
        set(state => ({
          labelsByEntity: { ...state.labelsByEntity, [entityId]: response.payload.labels },
        }));
      },

      loadHistory: async (entityId: number, from: number, to: number) => {
        const response = await sendRPC<{ payload: { fixes: StripFix[] } }>('get_history', { entityId, from, to });
        set(state => {
          const existing = state.historyFixesByEntity[entityId] ?? [];
          return {
            historyFixesByEntity: {
              ...state.historyFixesByEntity,
              [entityId]: mergeFixes(existing, response.payload.fixes),
            },
          };
        });
      },

      runLabelOp: async (op: LabelOp) => {
        const entityId = opEntityId(op);
        const before = get().labelsByEntity[entityId] ?? [];

        set(state => ({
          labelsByEntity: { ...state.labelsByEntity, [entityId]: applyOpToLabels(before, op) },
          labelError: null,
        }));

        try {
          const response = await sendRPC<{ payload: { labels: Label[] } }>(
            op.kind === 'remove' ? 'remove_label' : 'set_label',
            op.kind === 'remove' ? { entityId, id: op.label.id } : { label: op.kind === 'update' ? op.after : op.label }
          );
          set(state => ({
            labelsByEntity: { ...state.labelsByEntity, [entityId]: response.payload.labels },
          }));
        } catch (error) {
          set(state => ({
            labelsByEntity: { ...state.labelsByEntity, [entityId]: before },
            labelError: error instanceof Error ? error.message : String(error),
          }));
          throw error;
        }
      },

      writeLabel: async (rawLabel: Label) => {
        // A group's members change over time, so a label made against one records the
        // devices it described. Stamped here rather than at each call site, because
        // marking a single fix on a group as an outlier built its label without members
        // and was then refused for missing them.
        let label = rawLabel;
        if (label.deviceId < 0 && !label.memberDeviceIds?.length) {
          const members = get().entities[label.deviceId]?.memberDeviceIds;
          if (members?.length) label = { ...label, memberDeviceIds: members };
        }

        const all = get().labelsByEntity[label.deviceId] ?? [];
        const existing = all.find(other => other.id === label.id) ?? null;

        // Decided here so an overlapping label never reaches local state. Letting the
        // optimistic apply run and reverting on the server's refusal painted the label
        // for a frame or two before removing it.
        const placement = checkPlacement(all.filter(other => other.id !== label.id), label);
        if (!placement.ok) {
          set({ labelError: placement.reason });
          return;
        }

        const op: LabelOp = existing
          ? { kind: 'update', before: existing, after: label }
          : { kind: 'add', label };
        await get().runLabelOp(op);
        set(state => ({ labelHistory: pushOp(state.labelHistory, op) }));
      },

      deleteLabel: async (entityId: number, id: string) => {
        const existing = (get().labelsByEntity[entityId] ?? []).find(other => other.id === id);
        if (!existing) return;
        const op: LabelOp = { kind: 'remove', label: existing };
        await get().runLabelOp(op);
        set(state => ({ labelHistory: pushOp(state.labelHistory, op) }));
      },

      undoLabel: async () => {
        const { op, history } = popUndo(get().labelHistory);
        if (!op) return;
        await get().runLabelOp(invertOp(op));
        set({ labelHistory: history });
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