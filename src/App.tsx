import { SettingsPanel } from "./ui/SettingsPanel";
import { useEffect, useState, useMemo, useRef } from "react";
import { useStore } from "./store";
import { useTraccarConnection } from "./hooks/useTraccarConnection";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import MapView, { type MapViewHandle } from "./ui/MapView";
import UnifiedEditModal from "./ui/UnifiedEditModal";
import MotionSegmentPanel from "./ui/MotionSegmentPanel";
import type { MotionSegment, RetrospectiveMotionSegment } from "./types";

export function App() {
  const setRefLat = useStore(state => state.setRefLat);
  const setRefLon = useStore(state => state.setRefLon);
  const setFirstPosition = useStore(state => state.setFirstPosition);
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);
  const processPositions = useStore(state => state.processPositions);
  const setDevicesFromApi = useStore(state => state.setDevicesFromApi);

  const groupDevices = useStore(state => state.groups);
  const deviceToGroupsMapRef = useStore(state => state.refs.deviceToGroupsMap);
  const groupIdsRef = useStore(state => state.refs.groupIds);

  const refLat = useStore(state => state.ui.refLat);
  const refLon = useStore(state => state.ui.refLon);
  const worldBounds = useStore(state => state.ui.worldBounds);
  const setWorldBounds = useStore(state => state.setWorldBounds);
  const enginesRef = useStore(state => state.refs.engines);
  const devices = useStore(state => state.devices);
  const { deviceNames, deviceColors, deviceIcons, deviceLastSeen } = useMemo(() => {
    const names: Record<number, string> = {};
    const colors: Record<number, string> = {};
    const icons: Record<number, string> = {};
    const lastSeen: Record<number, number | null> = {};
    for (const id of Object.keys(devices)) {
      const numId = Number(id);
      const d = devices[numId]!;
      names[numId] = d.name;
      colors[numId] = d.color ?? "";
      icons[numId] = d.emoji;
      lastSeen[numId] = d.lastSeen;
    }
    // Add groups to deviceLastSeen
    for (const group of groupDevices) {
      let maxLastSeen: number | null = null;
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

  // Build set of member device IDs to hide them on the map (but keep in side panel)
  const memberDeviceIds = useMemo(() => {
    const memberIds = new Set<number>();
    for (const group of groupDevices) {
      for (const memberId of group.memberDeviceIds) {
        memberIds.add(memberId);
      }
    }
    return memberIds;
  }, [groupDevices]);

  const positionsAllRef = useStore(state => state.refs.positionsAll);
  const setPositionsAll = useStore(state => state.setPositionsAll);
  const firstPositionRef = useStore(state => state.refs.firstPosition as { lat: number; lon: number } | null);
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

  const { wsStatus, wsError, updateCounter, reconnect, positions } = useTraccarConnection({
    baseUrl: traccarBaseUrl,
    secure: traccarSecure,
    token: traccarToken,
    onDevices: setDevicesFromApi,
  });

  const [pulsingDeviceIds, setPulsingDeviceIds] = useState<number[]>([]);

  const engineSnapshotsByDevice = useStore(state => state.engineSnapshotsByDevice);
  const motionSegments = useStore(state => state.motionSegments);
  const retrospectiveByDevice = useStore(state => state.retrospective.byDevice);
  const runRetrospectiveAnalysis = useStore(state => state.runRetrospectiveAnalysis);

  const mapViewRef = useRef<MapViewHandle>(null);

  useEffect(() => {
    if (positions.length > 0) {
      setPositionsAll(prev => [...prev, ...positions]);
      processPositions();
      const firstPos = positions[0];
      if (firstPos && refLat == null) setRefLat(firstPos.lat);
      if (firstPos && refLon == null) setRefLon(firstPos.lon);
      if (firstPos && firstPositionRef == null) setFirstPosition({ lat: firstPos.lat, lon: firstPos.lon });

      // Run retrospective analysis after positions are processed
      // This corrects motion detection lag by analyzing position history
      runRetrospectiveAnalysis();
    }
  }, [updateCounter, positions, setPositionsAll, refLat, refLon, firstPositionRef, setRefLat, setRefLon, setFirstPosition, processPositions, runRetrospectiveAnalysis]);

  // Build reverse map: deviceId -> array of groupDeviceIds it belongs to
  useEffect(() => {
    deviceToGroupsMapRef.clear();
    groupIdsRef.clear();
    for (const groupDevice of groupDevices) {
      groupIdsRef.add(groupDevice.id);
      for (const memberId of groupDevice.memberDeviceIds) {
        if (!deviceToGroupsMapRef.has(memberId)) {
          deviceToGroupsMapRef.set(memberId, []);
        }
        enginesRef.delete(groupDevice.id);
        const groups = deviceToGroupsMapRef.get(memberId)!;
        if (!groups.includes(groupDevice.id)) {
          groups.push(groupDevice.id);
        }
      }
    }
    // Re-process all existing positions to add them to any new groups
    // This ensures positions that arrived before the group was created get added to the group
    // IMPORTANT: Don't filter by processedKeysRef - we need to add positions to NEW groups even if they were already processed for individual devices
    if (positionsAllRef.length > 0) {
      for (const groupDevice of groupDevices) {
        enginesRef.delete(groupDevice.id);
      }
      processPositions();
    }
  }, [groupDevices, processPositions]);

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
    const engineComps = Object.values(engineSnapshotsByDevice).flat();
    const allComps = engineComps;

    // Filter devices not seen in the last 24 hours using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const activeDevices = new Set<number>();
    for (const [device, lastSeen] of Object.entries(deviceLastSeen)) {
      if (lastSeen == null || lastSeen > cutoff) {
        activeDevices.add(Number(device));
      }
    }

    return allComps.filter(
      (comp) =>
        activeDevices.has(comp.device) // && !hiddenDevices.has(comp.device)
    );
  }, [engineSnapshotsByDevice, deviceLastSeen, groupDevices]);

  const frame = { components: visibleComponents };

  useEffect(() => {
    if (visibleComponents.length === 0) {
      setWorldBounds(null);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of visibleComponents) {
      const m = c.mean;
      minX = Math.min(minX, m[0]);
      minY = Math.min(minY, m[1]);
      maxX = Math.max(maxX, m[0]);
      maxY = Math.max(maxY, m[1]);
    }

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      setWorldBounds(null);
    } else {
      setWorldBounds({ minX, minY, maxX, maxY });
    }
  }, [visibleComponents]);

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

  // current debug frame to render on the map (if any)
  const currentDebugFrame = useMemo(() => {
    if (selectedDeviceId == null || !debugMode) return null;
    const eng = enginesRef.get(selectedDeviceId);
    if (!eng) return null;
    const fr = eng.getDebugFrames();
    if (fr.length === 0) return null;
    return fr[Math.max(0, Math.min(fr.length - 1, debugFrameIndex))] ?? null;
  }, [selectedDeviceId, debugMode, enginesRef, debugFrameIndex]);

  const currentDebugAnchors = useMemo(() => {
    if (selectedDeviceId == null || !debugMode) return [];
    const eng = enginesRef.get(selectedDeviceId);
    if (!eng) return [];
    type AnchorView = { mean: [number, number]; variance: number; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number };
    const anchors: AnchorView[] = [];
    const pushAnchor = (a: typeof eng.activeAnchor, type: AnchorView["type"]) => {
      if (!a) return;
      anchors.push({ mean: [a.mean[0], a.mean[1]], variance: a.variance, type, startTimestamp: a.startTimestamp, endTimestamp: a.endTimestamp, confidence: a.confidence, lastUpdateTimestamp: a.lastUpdateTimestamp });
    };
    pushAnchor(eng.activeAnchor, "active");
    for (const a of eng.closedAnchors) pushAnchor(a, "closed");
    return anchors;
  }, [selectedDeviceId, debugMode, enginesRef]);

  const deviceList = useMemo(() => {
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const result: Array<{
      id: number | string;
      isGroup: boolean;
      name: string;
      emoji: string;
      lastSeen: number | null;
      hasPosition: boolean;
      memberDeviceIds?: number[];
      color?: string | null;
    }> = [];

    // Track seen IDs to prevent duplicates
    const seenIds = new Set<number | string>();

    // Create a set of group IDs to skip when processing individual devices
    const groupIds = new Set(groupDevices.map(g => g.id));

    // Add individual devices (skip if they're members of a group or if they're group devices themselves)
    for (const [id, name] of Object.entries(deviceNames)) {
      const numId = Number(id);

      if (groupIds.has(numId)) {
        continue; // Skip if it's a group device
      }
      if (seenIds.has(numId)) {
        continue; // Skip if already added
      }

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

  return (
    <div className="h-screen w-screen">
      <DeviceListSidePanel
        devices={deviceList}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => {
          if (typeof id === "number") {
            if (selectedDeviceId === id) {
              mapViewRef.current?.flyToDevice(id);
            }
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
        allDevices={Object.entries(deviceNames)
          .filter(([id]) => !groupDevices.some(g => g.id === Number(id)))
          .map(([id, name]) => ({ id: Number(id), name, emoji: deviceIcons[Number(id)] ?? name?.charAt(0).toUpperCase() ?? "?" }))}
      />
      <MapView
        ref={mapViewRef}
        debugFrame={currentDebugFrame}
        debugAnchors={currentDebugAnchors}
        motionSegments={debugMode && selectedDeviceId != null ? (motionSegments[selectedDeviceId] ?? []) : []}
        retrospectiveMotionSegments={selectedDeviceId != null ? (retrospectiveByDevice.get(selectedDeviceId)?.motionSegments ?? []) : []}
        components={frame.components}
        refLat={refLat}
        refLon={refLon}
        worldBounds={worldBounds}
        height="100vh"
        selectedDeviceId={selectedDeviceId}
        selectedMotionSegment={selectedMotionSegment}
        pulsingDeviceIds={pulsingDeviceIds}
        onSelectDevice={(id) => {
          if (selectedDeviceId === id) {
            mapViewRef.current?.flyToDevice(id);
          }
          setSelectedDeviceId(id);
        }}
        onSelectMotionSegment={(segment) => {
          if (debugMode) {
            setSelectedMotionSegment(segment);
          }
        }}
        memberDeviceIds={memberDeviceIds}
        deviceNames={deviceNames}
        deviceIcons={deviceIcons}
        deviceColors={deviceColors}
        maptilerApiKey={maptilerApiKey}
        darkMode={isDark}
        overlay={
          <div className="flex flex-col gap-2">
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
              refLat={refLat}
              refLon={refLon}
              enginesRef={enginesRef}
              setEditingTarget={setEditingTarget}
            />

            {debugMode && selectedMotionSegment && selectedDeviceId != null && (
              <MotionSegmentPanel
                segment={selectedMotionSegment}
                debugFrames={[...(enginesRef.get(selectedDeviceId)?.getDebugFrames() ?? [])]}
                refLat={refLat}
                refLon={refLon}
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
