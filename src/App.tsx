import { SettingsPanel } from "./ui/SettingsPanel";
import { useEffect, useState, useMemo, useRef } from "react";
import { useStore } from "./store";
import { useTraccarConnection } from "./hooks/useTraccarConnection";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import MapView, { type MapViewHandle } from "./ui/MapView";
import MotionSegmentPanel from "./ui/MotionSegmentPanel";
import type { MotionSegment, RetrospectiveMotionSegment, DebugAnchor, DebugFrameView, UiDevice, Timestamp } from "./types";
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

  const RECENT_DEVICE_CUTOFF_MS = 96 * 60 * 60 * 1000; // 96 hours

  const baseUrlInput = useStore(state => state.settings.inputBaseUrl);
  const setBaseUrlInput = useStore(state => state.setInputBaseUrl);
  const setSecureInput = useStore(state => state.setInputSecure);
  const setTokenInput = useStore(state => state.setInputToken);
  const setMaptilerApiKeyInput = useStore(state => state.setInputMaptilerApiKey);
  const setDarkModeInput = useStore(state => state.setInputDarkMode);
  const inputSecure = useStore(state => state.settings.inputSecure);
  const inputToken = useStore(state => state.settings.inputToken);
  const inputMaptilerApiKey = useStore(state => state.settings.inputMaptilerApiKey);
  const inputDarkMode = useStore(state => state.settings.inputDarkMode);
  const traccarSecure = useStore(state => state.settings.secure);
  const traccarToken = useStore(state => state.settings.token);
  const traccarBaseUrl = useStore(state => state.settings.baseUrl);
  const maptilerApiKey = useStore(state => state.settings.maptilerApiKey);
  const darkMode = useStore(state => state.settings.darkMode);

  // Handle theme switching with support for 'system', 'light', and 'dark'
  const isDark = useMemo(() => {
    if (darkMode === 'dark') return true;
    if (darkMode === 'light') return false;
    // System mode - check media query
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [darkMode]);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (darkMode !== 'system') return;

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
  }, [darkMode]);

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

  const [selectedMotionSegment, setSelectedMotionSegment] = useState<MotionSegment | RetrospectiveMotionSegment | null>(null);

  const { wsStatus, wsError, reconnect } = useTraccarConnection({
    baseUrl: traccarBaseUrl,
    secure: traccarSecure,
    token: traccarToken,
    onDevices: setDevicesFromApi,
    onPositions: addPositions,
  });

  const [pulsingDeviceIds, setPulsingDeviceIds] = useState<number[]>([]);

  const engineSnapshotsByDevice = useStore(state => state.engineSnapshotsByDevice);
  const mapViewRef = useRef<MapViewHandle>(null);

  const applySettings = () => {
    useStore.getState().applySettings();
    reconnect();
  };

  // Apply theme immediately without affecting other settings
  const applyTheme = (theme: 'light' | 'dark' | 'system') => {
    useStore.setState(state => ({
      settings: {
        ...state.settings,
        darkMode: theme,
        inputDarkMode: theme,
      }
    }));
  };

  const visibleComponents = useMemo(() => {
    const allComps = Object.values(engineSnapshotsByDevice).flat();

    // Filter devices not seen in the last cutoff using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;

    // Create a set of group member IDs to hide them if they should be shown via group
    const groupMemberIds = new Set<number>();
    for (const group of groupDevices) {
      for (const id of group.memberDeviceIds) {
        groupMemberIds.add(id);
      }
    }

    return allComps.filter((comp) => {
      const lastSeen = deviceLastSeen[comp.device];
      const isRecent = lastSeen != null && lastSeen > cutoff;
      const isIndividual = !groupMemberIds.has(comp.device);
      return isRecent && isIndividual;
    });
  }, [engineSnapshotsByDevice, deviceLastSeen, groupDevices]);

  const frame = { components: visibleComponents };

  const debugAnchors = useMemo((): DebugAnchor[] => {
    if (!debugMode || selectedDeviceId == null) return [];
    const engine = enginesRef.get(selectedDeviceId);
    if (!engine) return [];
    const anchors: DebugAnchor[] = [];
    for (const a of engine.closedAnchors) {
      anchors.push({ mean: a.mean, variance: a.variance, confidence: a.confidence, type: 'closed', startTimestamp: a.startTimestamp, endTimestamp: a.endTimestamp, lastUpdateTimestamp: a.lastUpdateTimestamp });
    }
    if (engine.activeAnchor) {
      const a = engine.activeAnchor;
      anchors.push({ mean: a.mean, variance: a.variance, confidence: a.confidence, type: 'active', startTimestamp: a.startTimestamp, endTimestamp: a.endTimestamp, lastUpdateTimestamp: a.lastUpdateTimestamp });
    }
    return anchors;
  }, [debugMode, selectedDeviceId, engineSnapshotsByDevice]);

  // Reset debug index when device or frame count changes
  useEffect(() => {
    if (selectedDeviceId == null || !debugMode) return;
    const frames = enginesRef.get(selectedDeviceId)?.getDebugFrames() ?? [];
    if (frames.length === 0) setDebugFrameIndex(0);
    else setDebugFrameIndex(Math.max(0, frames.length - 1));
  }, [selectedDeviceId, debugMode]);

  // Clear selected motion segment when device changes
  useEffect(() => {
    setSelectedMotionSegment(null);
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
    return {
      measurement: { ...f.measurement },
      anchor: f.anchor ? { ...f.anchor } : null,
      timestamp: f.timestamp,
    };
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

  return (
    <div className="h-screen w-screen">
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
        components={frame.components}
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
        overlay={
          <div className="flex flex-col gap-2 w-[280px]">
            <SettingsPanel
              baseUrlInput={baseUrlInput}
              setBaseUrlInput={setBaseUrlInput}
              secureInput={inputSecure}
              setSecureInput={setSecureInput}
              tokenInput={inputToken}
              setTokenInput={setTokenInput}
              maptilerApiKeyInput={inputMaptilerApiKey}
              setMaptilerApiKeyInput={setMaptilerApiKeyInput}
              darkModeInput={inputDarkMode}
              setDarkModeInput={setDarkModeInput}
              wsStatus={wsStatus}
              wsError={wsError}
              onApplySettings={applySettings}
              onApplyTheme={applyTheme}
              onReconnect={reconnect}
              debugMode={debugMode}
              setDebugMode={setDebugMode}
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

            {debugMode && selectedMotionSegment && selectedDeviceId != null && (
              <MotionSegmentPanel
                segment={selectedMotionSegment}
                debugFrames={[...(enginesRef.get(selectedDeviceId)?.getDebugFrames() ?? [])]}
                onClose={() => setSelectedMotionSegment(null)}
              />
            )}
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
