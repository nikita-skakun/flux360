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
import type { Timestamp, DebugAnchor, DebugFrame } from "./types";
import UnifiedEditModal from "./ui/UnifiedEditModal";

export function App() {
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);
  const groupDevices = useStore(state => state.groups);

  const devices = useStore(state => state.devices);
  const { deviceNames, deviceColors, deviceIcons, deviceLastSeen } = useMemo(() => {
    const base = Object.entries(devices).reduce((acc, [id, d]) => {
      const numId = Number(id);
      acc.names[numId] = d.name;
      acc.colors[numId] = d.color ?? "";
      acc.icons[numId] = d.emoji;
      acc.lastSeen[numId] = d.lastSeen;
      return acc;
    }, {
      names: {} as Record<number, string>,
      colors: {} as Record<number, string>,
      icons: {} as Record<number, string>,
      lastSeen: {} as Record<number, Timestamp | null>
    });

    // Add groups to deviceLastSeen
    groupDevices.forEach(group => {
      base.lastSeen[group.id] = group.memberDeviceIds?.reduce((max, memberId) => {
        const ts = base.lastSeen[memberId];
        return (ts && (max == null || ts > max)) ? ts : max;
      }, null as Timestamp | null) ?? null;
    });

    return {
      deviceNames: base.names,
      deviceColors: base.colors,
      deviceIcons: base.icons,
      deviceLastSeen: base.lastSeen
    };
  }, [devices, groupDevices]);

  const RECENT_DEVICE_CUTOFF_MS = 48 * 60 * 60 * 1000; // 48 hours

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
    const allComps = Object.values(engineSnapshotsByDevice).flat();

    // Filter devices not seen in the last cutoff using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;

    // Create a set of group member IDs to hide them if they should be shown via group
    const groupMemberIds = new Set<number>();
    for (const group of groupDevices) {
      if (group.memberDeviceIds) {
        for (const memberId of group.memberDeviceIds) {
          groupMemberIds.add(memberId);
        }
      }
    }

    return allComps.filter((comp) => {
      const lastSeen = deviceLastSeen[comp.device];
      const isRecent = lastSeen != null && lastSeen > cutoff;
      const isIndividual = !groupMemberIds.has(comp.device);
      return isRecent && isIndividual;
    });
  }, [engineSnapshotsByDevice, deviceLastSeen, groupDevices]);

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

  const deviceList = useMemo(() => {
    const groupIds = new Set(groupDevices.map(g => g.id));

    const individualDevices = Object.entries(deviceNames)
      .map(([id, name]) => ({ id: Number(id), name }))
      .filter(({ id }) => !groupIds.has(id))
      .map(({ id, name }) => ({
        id,
        name,
        emoji: deviceIcons[id] ?? "device_unknown",
        lastSeen: deviceLastSeen[id] ?? null,
        memberDeviceIds: null,
        color: deviceColors[id] || null,
        isOwner: devices[id]?.isOwner ?? false,
        effectiveMotionProfile: devices[id]?.effectiveMotionProfile ?? "person",
        motionProfile: devices[id]?.motionProfile ?? null
      }));

    const groups = groupDevices.map(g => ({
      ...g,
      lastSeen: deviceLastSeen[g.id] ?? null,
      isOwner: devices[g.id]?.isOwner ?? true,
    }));

    return [...individualDevices, ...groups].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [groupDevices, deviceNames, deviceLastSeen, devices]);

  const allDevicesForSelection = useMemo(() => {
    return Object.entries(deviceNames)
      .filter(([id]) => !groupDevices.some(g => g.id === Number(id)))
      .map(([id, name]) => ({
        id: Number(id),
        name,
        emoji: deviceIcons[Number(id)] ?? name?.charAt(0).toUpperCase() ?? "?"
      }));
  }, [deviceNames, groupDevices, deviceIcons]);

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
        devices={deviceList}
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
        deviceNames={deviceNames}
        deviceIcons={deviceIcons}
        deviceColors={deviceColors}
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
              deviceNames={deviceNames}
              deviceLastSeen={deviceLastSeen}
              groupDevices={groupDevices}
              setSelectedDeviceId={setSelectedDeviceId}
              setEditingTarget={setEditingTarget}
              isOwner={selectedDeviceId != null ? (devices[selectedDeviceId]?.isOwner ?? false) : false}
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
                  if (s.path.length > 0) {
                    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
                    for (const p of s.path) {
                      const geo = fromWebMercator(p);
                      minLng = Math.min(minLng, geo[0]);
                      maxLng = Math.max(maxLng, geo[0]);
                      minLat = Math.min(minLat, geo[1]);
                      maxLat = Math.max(maxLat, geo[1]);
                    }
                    if (minLng !== Infinity) {
                      const padding = Math.max(0.001, (maxLng - minLng) * 0.1, (maxLat - minLat) * 0.1);
                      mapViewRef.current?.flyToBounds([[minLng - padding, minLat - padding], [maxLng + padding, maxLat + padding]]);
                    }
                  }
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
