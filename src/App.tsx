import { DeviceListSidePanel } from "./ui/DeviceListSidePanel";
import { DeviceOverlay } from "./ui/DeviceOverlay";
import { fromWebMercator } from "./util/webMercator";
import { HistoryObservationBar } from "./ui/HistoryObservationBar";
import { LoginPage } from "./ui/LoginPage";
import { MapView } from "./ui/MapView";
import { SettingsPanel } from "./ui/SettingsPanel";
import { TimelinePanel } from "./ui/TimelinePanel";
import { UnifiedEditModal } from "./ui/UnifiedEditModal";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerConnection } from "./hooks/useServerConnection";
import { useStore } from "./store";
import type { MapViewHandle } from "./ui/MapView";
import type { TimelineEvent } from "./ui/TimelinePanel";

export function App() {
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);

  const entities = useStore(state => state.entities);
  const maptilerApiKey = useStore(state => state.settings.maptilerApiKey);
  const theme = useStore(state => state.settings.theme);

  const isDark = useMemo(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [theme]);

  useEffect(() => {
    const updateDarkMode = () => {
      const isDarkNow = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', isDarkNow);
    };

    updateDarkMode();

    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', updateDarkMode);
    return () => mediaQuery.removeEventListener('change', updateDarkMode);
  }, [theme]);

  const isAuthenticated = useStore((state) => state.auth.isAuthenticated);

  const selectedDeviceId = useStore(state => state.ui.selectedDeviceId);
  const setSelectedDeviceId = useStore(state => state.setSelectedDeviceId);
  const isSidePanelOpen = useStore(state => state.ui.isSidePanelOpen);
  const setIsSidePanelOpen = useStore(state => state.setIsSidePanelOpen);
  const editingTarget = useStore(state => state.ui.editingTarget);
  const setEditingTarget = useStore(state => state.setEditingTarget);

  const logout = useStore((state) => state.logout);

  const [selectedTimelineEvent, setSelectedTimelineEvent] = useState<TimelineEvent | null>(null);

  useServerConnection();

  const [pulsingDeviceIds, setPulsingDeviceIds] = useState<number[]>([]);

  const activePointsByDevice = useStore(state => state.activePointsByDevice);
  const eventsByDevice = useStore(state => state.eventsByDevice);
  const mapViewRef = useRef<MapViewHandle>(null);

  const visibleComponents = useMemo(() => {
    return Object.values(activePointsByDevice)
      .flat()
      .filter((comp) => entities[comp.device] != null);
  }, [activePointsByDevice, entities]);

  // Clear selected motion segment when device changes
  useEffect(() => {
    setSelectedTimelineEvent(null);
  }, [selectedDeviceId]);


  const allDevicesForSelection = useMemo(() => {
    return Object.values(entities)
      .filter(e => e.memberDeviceIds === null) // Only individual devices
      .map(e => ({
        id: e.id,
        name: e.name,
        emoji: e.emoji
      }));
  }, [entities]);

  const rootIds = useMemo(() => {
    const memberIds = new Set<number>();
    for (const entity of Object.values(entities)) {
      if (entity.memberDeviceIds)
        entity.memberDeviceIds.forEach(id => memberIds.add(id));
    }
    return Object.keys(entities).map(Number).filter(id => !memberIds.has(id));
  }, [entities]);

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div
      className="h-screen w-screen"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (!file?.name.endsWith('.json')) return;
        const reader = new FileReader();
        reader.onload = (re) => {
          try {
            const data = JSON.parse(re.target?.result as string);
            if (!data.ev) return;
            setSelectedTimelineEvent({ id: 'debug-drop', item: data.ev });
            if (data.ev.bounds) {
              const { minX, minY, maxX, maxY } = data.ev.bounds;
              const sw = fromWebMercator([minX, minY]);
              const ne = fromWebMercator([maxX, maxY]);
              const padding = Math.max(0.001, (ne[0] - sw[0]) * 0.1, (ne[1] - sw[1]) * 0.1);
              mapViewRef.current?.flyToBounds([[sw[0] - padding, sw[1] - padding], [ne[0] + padding, ne[1] + padding]]);
              return;
            } else if (data.ev.type === 'stationary') {
              const geo = fromWebMercator(data.ev.mean);
              const r = 0.001;
              mapViewRef.current?.flyToBounds([[geo[0] - r, geo[1] - r], [geo[0] + r, geo[1] + r]]);
            }
          } catch (err) {
            console.error('Failed to parse dropped JSON', err);
          }
        };
        reader.readAsText(file);
      }}
    >
      {selectedTimelineEvent && (
        <HistoryObservationBar
          event={selectedTimelineEvent}
          onClose={() => setSelectedTimelineEvent(null)}
        />
      )}
      <DeviceListSidePanel
        entities={entities}
        rootIds={rootIds}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => {
          if (typeof id === "number") {
            mapViewRef.current?.flyToDevice(id);
            setSelectedDeviceId(id);
          }
          setIsSidePanelOpen(false);
        }}
        isOpen={isSidePanelOpen}
        onToggle={() => setIsSidePanelOpen(!isSidePanelOpen)}
        onCreateGroup={createGroup}
        onDeleteGroup={deleteGroup}
        onAddDeviceToGroup={addDeviceToGroup}
        onEditGroup={(groupId) => setEditingTarget({ type: 'group', id: groupId })}
        onCreateGroupSelectionChange={setPulsingDeviceIds}
        allDevices={allDevicesForSelection}
      />
      <MapView
        ref={mapViewRef}
        activePoints={visibleComponents}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => {
          mapViewRef.current?.flyToDevice(id);
          setSelectedDeviceId(id);
        }}
        entities={entities}
        maptilerApiKey={maptilerApiKey}
        darkMode={isDark}
        pulsingDeviceIds={pulsingDeviceIds}
        selectedHistoryItem={selectedTimelineEvent?.item ?? null}
        overlay={
          <div className="flex flex-col gap-2 w-[280px]">
            <SettingsPanel
              onLogout={logout}
            />

            <DeviceOverlay
              selectedDeviceId={selectedDeviceId}
              activePointsByDevice={activePointsByDevice}
              entities={entities}
              setSelectedDeviceId={setSelectedDeviceId}
              setEditingTarget={setEditingTarget}
              isOwner={selectedDeviceId != null ? (entities[selectedDeviceId]?.isOwner ?? false) : false}
            />

            <TimelinePanel
              selectedDeviceId={selectedDeviceId}
              eventsByDevice={eventsByDevice}
              onSelectEvent={(event) => {
                setSelectedTimelineEvent(event);

                if (event.item.type === 'stationary') {
                  const geo = fromWebMercator(event.item.mean);
                  const r = 0.001; // roughly 100m padding
                  mapViewRef.current?.flyToBounds([[geo[0] - r, geo[1] - r], [geo[0] + r, geo[1] + r]]);
                } else {
                  const s = event.item;
                  // Use server-computed bounds instead of iterating through path
                  const sw = fromWebMercator([s.bounds.minX, s.bounds.minY]);
                  const ne = fromWebMercator([s.bounds.maxX, s.bounds.maxY]);
                  const padding = Math.max(0.001, (ne[0] - sw[0]) * 0.1, (ne[1] - sw[1]) * 0.1);
                  mapViewRef.current?.flyToBounds([[sw[0] - padding, sw[1] - padding], [ne[0] + padding, ne[1] + padding]]);
                }
              }}
              selectedEventId={selectedTimelineEvent?.id ?? null}
            />
          </div>
        }
      />
      {editingTarget && (
        <UnifiedEditModal
          onClose={() => setEditingTarget(null)}
          type={editingTarget.type}
          id={editingTarget.id}
        />
      )}
    </div>
  );
}

