import { fromWebMercator } from "./util/webMercator";
import { HistoryObservationBar } from "./ui/HistoryObservationBar";
import { LoginPage } from "./ui/LoginPage";
import { SettingsPanel } from "./ui/SettingsPanel";
import { TimelinePanel, type TimelineEvent } from "./ui/TimelinePanel";
import { useEffect, useState, useMemo, useRef } from "react";
import { useServerConnection } from "./hooks/useServerConnection";
import { useStore } from "./store";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import MapView, { type MapViewHandle } from "./ui/MapView";
import type { DebugAnchor, DebugFrame } from "./types";
import UnifiedEditModal from "./ui/UnifiedEditModal";

export function App() {
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);

  const entities = useStore(state => state.entities);
  const metadata = useStore(state => state.metadata);

  const maptilerApiKey = useStore(state => state.settings.maptilerApiKey);
  const theme = useStore(state => state.settings.theme);

  // Handle theme switching with support for 'system', 'light', and 'dark'
  const isDark = useMemo(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    // System mode - check media query
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [theme]);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const isAuthenticated = useStore((state) => state.auth.isAuthenticated);

  const selectedDeviceId = useStore(state => state.ui.selectedDeviceId);
  const setSelectedDeviceId = useStore(state => state.setSelectedDeviceId);
  const isSidePanelOpen = useStore(state => state.ui.isSidePanelOpen);
  const setIsSidePanelOpen = useStore(state => state.setIsSidePanelOpen);
  const debugMode = useStore(state => state.ui.debugMode);
  const setDebugMode = useStore(state => state.setDebugMode);
  const debugFrameIndex = useStore(state => state.ui.debugFrameIndex);
  const setDebugFrameIndex = useStore(state => state.setDebugFrameIndex);
  const editingTarget = useStore(state => state.ui.editingTarget);
  const setEditingTarget = useStore(state => state.setEditingTarget);

  const logout = useStore((state) => state.logout);

  const [selectedTimelineEvent, setSelectedTimelineEvent] = useState<TimelineEvent | null>(null);

  useServerConnection();

  const [pulsingDeviceIds, setPulsingDeviceIds] = useState<number[]>([]);

  const engineSnapshotsByDevice = useStore(state => state.engineSnapshotsByDevice);
  const eventsByDevice = useStore(state => state.eventsByDevice);
  const mapViewRef = useRef<MapViewHandle>(null);

  const visibleComponents = useMemo(() => {
    return Object.values(engineSnapshotsByDevice)
      .flat()
      .filter((comp) => entities[comp.device] != null);
  }, [engineSnapshotsByDevice, entities]);

  const debugAnchors = useMemo((): DebugAnchor[] => {
    if (!debugMode || selectedDeviceId == null) return [];

    // In backend mode, we build anchors from the latest events instead of engine drafts
    const events = eventsByDevice[selectedDeviceId] || [];
    const anchors: DebugAnchor[] = [];

    // Closed events as anchors
    for (const ev of events) {
      if (ev.type === 'stationary') {
        anchors.push({
          mean: ev.mean,
          variance: ev.variance,
          confidence: 1.0,
          type: 'closed',
          startTimestamp: ev.start,
          endTimestamp: ev.end,
          lastUpdateTimestamp: ev.end
        });
      }
    }

    return anchors;
  }, [debugMode, selectedDeviceId, eventsByDevice]);

  // Reset debug index when device changes
  const lastSelectedDeviceId = useRef<number | null>(null);
  useEffect(() => {
    if (selectedDeviceId == null) return;
    if (selectedDeviceId === lastSelectedDeviceId.current) return;
    lastSelectedDeviceId.current = selectedDeviceId;

    const frames = engineSnapshotsByDevice[selectedDeviceId] ?? [];
    if (frames.length === 0) setDebugFrameIndex(0);
    else setDebugFrameIndex(Math.max(0, frames.length - 1));
  }, [selectedDeviceId, engineSnapshotsByDevice]);

  // Clear selected motion segment when device changes
  useEffect(() => {
    setSelectedTimelineEvent(null);
  }, [selectedDeviceId]);

  // Current debug frame for map rendering
  const debugFrame = useMemo((): DebugFrame | null => {
    if (!debugMode || selectedDeviceId == null) return null;
    const snapshots = engineSnapshotsByDevice[selectedDeviceId] ?? [];
    if (snapshots.length === 0) return null;
    const frame = snapshots[Math.max(0, Math.min(snapshots.length - 1, debugFrameIndex))];
    if (!frame) return null;
    return {
      timestamp: frame.timestamp,
      decision: 'unknown',
      draftType: 'none',
      mahalanobis2: 0,
      mean: frame.mean,
      point: frame.mean,
      pendingCount: 0,
      isSignificant: false, // Don't have this on snapshot points
      distance: 0,
      classification: 'unknown', // Best effort
    } as unknown as DebugFrame;
  }, [debugMode, selectedDeviceId, debugFrameIndex, engineSnapshotsByDevice]);


  const allDevicesForSelection = useMemo(() => {
    return Object.values(entities)
      .filter(e => e.memberDeviceIds === null) // Only individual devices
      .map(e => ({
        id: e.id,
        name: e.name,
        emoji: e.emoji
      }));
  }, [entities]);

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="h-screen w-screen">
      {selectedTimelineEvent && (
        <HistoryObservationBar
          event={selectedTimelineEvent}
          onClose={() => setSelectedTimelineEvent(null)}
        />
      )}
      <DeviceListSidePanel
        entities={entities}
        rootIds={metadata.rootIds}
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
        components={visibleComponents}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => {
          mapViewRef.current?.flyToDevice(id);
          setSelectedDeviceId(id);
        }}
        entities={entities}
        maptilerApiKey={maptilerApiKey}
        darkMode={isDark}
        debugAnchors={debugAnchors}
        debugFrame={debugFrame}
        pulsingDeviceIds={pulsingDeviceIds}
        selectedHistoryItem={selectedTimelineEvent?.item ?? null}
        overlay={
          <div className="flex flex-col gap-2 w-[280px]">
            <SettingsPanel
              debugMode={debugMode}
              setDebugMode={setDebugMode}
              onLogout={logout}
            />

            <DeviceOverlay
              selectedDeviceId={selectedDeviceId}
              engineSnapshotsByDevice={engineSnapshotsByDevice}
              debugMode={debugMode}
              debugFrameIndex={debugFrameIndex}
              setDebugFrameIndex={setDebugFrameIndex}
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
                const startTime = event.item.start;

                if (selectedDeviceId != null) {
                  const snapshots = engineSnapshotsByDevice[selectedDeviceId] ?? [];
                  const idx = snapshots.findIndex(s => s.timestamp >= startTime);
                  if (idx >= 0) {
                    setDebugFrameIndex(idx);
                  }
                }

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
      <UnifiedEditModal
        isOpen={!!editingTarget}
        onClose={() => setEditingTarget(null)}
        type={editingTarget?.type ?? 'device'}
        id={editingTarget?.id ?? 0}
      />
    </div>
  );
}

export default App;
