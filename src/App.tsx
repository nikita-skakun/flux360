import { fromWebMercator } from "./util/webMercator";
import { HistoryObservationBar } from "./ui/HistoryObservationBar";
import { LoginPage } from "./ui/LoginPage";
import { SettingsPanel } from "./ui/SettingsPanel";
import { TimelinePanel, type TimelineEvent } from "./ui/TimelinePanel";
import { useEffect, useState, useMemo, useRef } from "react";
import { useStore } from "./store";
import { useTraccarConnection } from "./hooks/useTraccarConnection";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import MapView, { type MapViewHandle } from "./ui/MapView";
import type { DebugAnchor, DebugFrameView, UiDevice, Timestamp } from "./types";
import UnifiedEditModal from "./ui/UnifiedEditModal";

export function App() {
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);
  const addPositions = useStore(state => state.addPositions);
  const setDevicesFromApi = useStore(state => state.setDevicesFromApi);
  const groupDevices = useStore(state => state.groups);

  const enginesRef = useStore(state => state.refs.engines);
  const devices = useStore(state => state.devices);
  const { deviceNames, deviceColors, deviceIcons, deviceLastSeen } = useMemo(() => {
    const names: Record<number, string> = {};
    const colors: Record<number, string> = {};
    const icons: Record<number, string> = {};
    const lastSeen: Record<number, Timestamp | null> = {};
    for (const id of Object.keys(devices)) {
      const numId = Number(id);
      const d = devices[numId];
      if (!d) continue;
      names[numId] = d.name;
      colors[numId] = d.color ?? "";
      icons[numId] = d.emoji;
      lastSeen[numId] = d.lastSeen;
    }
    // Add groups to deviceLastSeen
    for (const group of groupDevices) {
      let maxLastSeen: Timestamp | null = null;
      for (const memberId of group.memberDeviceIds) {
        const ts = lastSeen[memberId];
        if (ts && (maxLastSeen == null || ts > maxLastSeen)) {
          maxLastSeen = ts;
        }
      }
      lastSeen[group.id] = maxLastSeen;
    }
    return { deviceNames: names, deviceColors: colors, deviceIcons: icons, deviceLastSeen: lastSeen };
  }, [devices, groupDevices]);

  const RECENT_DEVICE_CUTOFF_MS = 48 * 60 * 60 * 1000; // 48 hours

  const traccarSecure = useStore(state => state.settings.secure);
  const traccarEmail = useStore(state => state.settings.email);
  const traccarPassword = useStore(state => state.settings.password);
  const traccarBaseUrl = useStore(state => state.settings.baseUrl);
  const maptilerApiKey = useStore(state => state.settings.maptilerApiKey);
  const theme = useStore(state => state.settings.theme);
  const setTheme = useStore(state => state.setTheme);

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

  const fetchConfig = useStore((state) => state.fetchConfig);
  const fetchMaptilerKey = useStore((state) => state.fetchMaptilerKey);
  const isAuthenticated = useStore((state) => state.auth.isAuthenticated);

  useEffect(() => {
    fetchConfig();
    if (isAuthenticated) {
      fetchMaptilerKey();
    }
  }, [fetchConfig, fetchMaptilerKey, isAuthenticated]);

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

  useTraccarConnection({
    baseUrl: traccarBaseUrl,
    secure: traccarSecure,
    email: traccarEmail,
    password: traccarPassword,
    onDevices: setDevicesFromApi,
    onPositions: addPositions,
  });

  const [pulsingDeviceIds, setPulsingDeviceIds] = useState<number[]>([]);

  const engineSnapshotsByDevice = useStore(state => state.engineSnapshotsByDevice);
  const eventsByDevice = useStore(state => state.eventsByDevice);
  const mapViewRef = useRef<MapViewHandle>(null);

  // Apply theme immediately
  const applyTheme = (nextTheme: 'light' | 'dark' | 'system') => {
    setTheme(nextTheme);
  };

  const visibleComponents = useMemo(() => {
    const allComps = Object.values(engineSnapshotsByDevice).flat();

    // Filter devices not seen in the last cutoff using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;

    // Create a set of group member IDs to hide them if they should be shown via group
    const groupMemberIds = new Set<number>();
    for (const group of groupDevices) {
      for (const memberId of group.memberDeviceIds) {
        groupMemberIds.add(memberId);
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
    const engine = enginesRef.get(selectedDeviceId);
    if (!engine) return [];
    const anchors: DebugAnchor[] = [];

    // Closed events as anchors
    for (const ev of engine.closed) {
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

    // Active draft as active anchor
    if (engine.draft) {
      if (engine.draft.type === 'stationary') {
        const stats = engine.computeStats(engine.draft.recent);
        anchors.push({
          mean: stats.mean,
          variance: stats.variance,
          confidence: 1.0,
          type: 'active',
          startTimestamp: engine.draft.start,
          endTimestamp: null,
          lastUpdateTimestamp: engine.lastTimestamp ?? engine.draft.start
        });
      }
    }
    return anchors;
  }, [debugMode, selectedDeviceId, engineSnapshotsByDevice]);

  // Reset debug index when device changes
  const lastSelectedDeviceId = useRef<number | null>(null);
  useEffect(() => {
    if (selectedDeviceId == null) return;
    if (selectedDeviceId === lastSelectedDeviceId.current) return;
    lastSelectedDeviceId.current = selectedDeviceId;

    const frames = enginesRef.get(selectedDeviceId)?.getDebugFrames() ?? [];
    if (frames.length === 0) setDebugFrameIndex(0);
    else setDebugFrameIndex(Math.max(0, frames.length - 1));
  }, [selectedDeviceId]);

  // Clear selected motion segment when device changes
  useEffect(() => {
    setSelectedTimelineEvent(null);
  }, [selectedDeviceId]);

  // Current debug frame for map rendering
  const debugFrame = useMemo((): DebugFrameView | null => {
    if (!debugMode || selectedDeviceId == null) return null;
    const eng = enginesRef.get(selectedDeviceId);
    if (!eng) return null;
    const frames = eng.getDebugFrames();
    if (frames.length === 0) return null;
    const f = frames[Math.max(0, Math.min(frames.length - 1, debugFrameIndex))];
    if (!f) return null;
    return f as DebugFrameView;
  }, [debugMode, selectedDeviceId, debugFrameIndex, engineSnapshotsByDevice]);

  const deviceList = useMemo(() => {
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const result: UiDevice[] = [];

    // Track seen IDs to prevent duplicates
    const seenIds = new Set<number>();

    // Create a set of group IDs to skip when processing individual devices
    const groupIds = new Set(groupDevices.map(g => g.id));

    // Add individual devices (skip if they're members of a group or if they're group devices themselves)
    for (const [id, name] of Object.entries(deviceNames)) {
      const numId = Number(id);

      if (groupIds.has(numId) || seenIds.has(numId)) continue;

      const lastSeen = deviceLastSeen[numId] ?? null;
      if (!lastSeen || lastSeen <= cutoff) continue; // Skip old devices

      const color = deviceColors[numId];
      result.push({
        id: numId,
        isGroup: false,
        name,
        emoji: deviceIcons[numId] ?? "device_unknown",
        lastSeen,
        hasPosition: (engineSnapshotsByDevice[numId]?.length ?? 0) > 0,
        memberDeviceIds: [],
        color: color && color !== "" ? color : null,
      });
      seenIds.add(numId);
    }

    // Add group devices
    for (const groupDevice of groupDevices) {
      // Skip if already added (defensive against duplicate group IDs)
      if (seenIds.has(groupDevice.id)) {
        continue;
      }

      // Calculate lastSeen as max of all member devices
      const groupLastSeen = deviceLastSeen[groupDevice.id] ?? null;

      result.push({
        id: groupDevice.id,
        isGroup: true,
        name: groupDevice.name,
        emoji: groupDevice.emoji,
        lastSeen: groupLastSeen,
        hasPosition: (engineSnapshotsByDevice[groupDevice.id]?.length ?? 0) > 0,
        memberDeviceIds: groupDevice.memberDeviceIds,
        color: groupDevice.color,
      });
      seenIds.add(groupDevice.id);
    }

    // Sort alphabetically
    result.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return result;
  }, [groupDevices, deviceNames, deviceLastSeen, engineSnapshotsByDevice, deviceColors]);

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
              theme={theme}
              onApplyTheme={applyTheme}
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
              enginesRef={enginesRef}
              setEditingTarget={setEditingTarget}
            />

            <TimelinePanel
              selectedDeviceId={selectedDeviceId}
              enginesRef={enginesRef}
              engineSnapshot={selectedDeviceId != null ? engineSnapshotsByDevice[selectedDeviceId] : undefined}
              eventsByDevice={eventsByDevice}
              onSelectEvent={(event) => {
                setSelectedTimelineEvent(event);
                const startTime = event.item.start;

                if (selectedDeviceId != null) {
                  const engine = enginesRef.get(selectedDeviceId);
                  if (engine) {
                    const frames = [...engine.getDebugFrames()].sort((a, b) => a.timestamp - b.timestamp);
                    const idx = frames.findIndex(f => f.timestamp >= startTime);
                    if (idx >= 0) {
                      setDebugFrameIndex(idx);
                    }
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
