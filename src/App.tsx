import { useEffect, useMemo } from "react";
import { SettingsPanel } from "./ui/SettingsPanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import { useTraccarConnection } from "./hooks/useTraccarConnection";
import MapView from "./ui/MapView";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import TrackerGroupsModal from "./ui/TrackerGroupsModal";
import { useStore } from "./store";

export function App() {
  const setRefLat = useStore(state => state.setRefLat);
  const setRefLon = useStore(state => state.setRefLon);
  const setFirstPosition = useStore(state => state.setFirstPosition);
  const createGroup = useStore(state => state.createGroup);
  const deleteGroup = useStore(state => state.deleteGroup);
  const addDeviceToGroup = useStore(state => state.addDeviceToGroup);
  const removeDeviceFromGroup = useStore(state => state.removeDeviceFromGroup);
  const updateGroup = useStore(state => state.updateGroup);
  const processPositions = useStore(state => state.processPositions);
  const setDevicesFromApi = useStore(state => state.setDevicesFromApi);
  const updateMotionProfile = useStore(state => state.updateMotionProfile);

  const deviceMotionProfiles = useStore(state => state.motionProfiles);
  const groupDevices = useStore(state => state.groups);
  const deviceToGroupsMapRef = useStore(state => state.refs.deviceToGroupsMap);
  const groupIdsRef = useStore(state => state.refs.groupIds);

  const refLat = useStore(state => state.ui.refLat);
  const refLon = useStore(state => state.ui.refLon);
  const worldBounds = useStore(state => state.ui.worldBounds);
  const setWorldBounds = useStore(state => state.setWorldBounds);
  const enginesRef = useStore(state => state.refs.engines);
  const devices = useStore(state => state.devices);
  const deviceNames = useMemo(() => Object.fromEntries(Object.keys(devices).map(id => [Number(id), devices[Number(id)]!.name])), [devices]);
  const deviceIcons = useMemo(() => Object.fromEntries(Object.keys(devices).map(id => [Number(id), devices[Number(id)]!.icon])), [devices]);
  const deviceLastSeen = useMemo(() => {
    const lastSeen = Object.fromEntries(Object.keys(devices).map(id => [Number(id), devices[Number(id)]!.lastSeen]));

    // Add groups to deviceLastSeen
    for (const group of groupDevices) {
      let maxLastSeen: number | null = null;
      for (const memberId of group.memberDeviceIds) {
        const memberTimestamp = lastSeen[memberId];
        if (memberTimestamp) {
          if (!maxLastSeen || memberTimestamp > maxLastSeen) {
            maxLastSeen = memberTimestamp;
          }
        }
      }
      lastSeen[group.id] = maxLastSeen;
    }

    return lastSeen;
  }, [devices, groupDevices]);
  const positionsAllRef = useStore(state => state.refs.positionsAll);
  const setPositionsAll = useStore(state => state.setPositionsAll);
  const firstPositionRef = useStore(state => state.refs.firstPosition as { lat: number; lon: number } | null);
  const RECENT_DEVICE_CUTOFF_MS = 96 * 60 * 60 * 1000; // 96 hours

  const baseUrlInput = useStore(state => state.settings.inputBaseUrl);
  const setBaseUrlInput = useStore(state => state.setInputBaseUrl);
  const setSecureInput = useStore(state => state.setInputSecure);
  const setTokenInput = useStore(state => state.setInputToken);
  const inputSecure = useStore(state => state.settings.inputSecure);
  const inputToken = useStore(state => state.settings.inputToken);
  const showGroupsModal = useStore(state => state.ui.showGroupsModal);
  const setShowGroupsModal = useStore(state => state.setShowGroupsModal);
  const traccarSecure = useStore(state => state.settings.secure);
  const traccarToken = useStore(state => state.settings.token);
  const traccarBaseUrl = useStore(state => state.settings.baseUrl);

  const selectedDeviceId = useStore(state => state.ui.selectedDeviceId);
  const setSelectedDeviceId = useStore(state => state.setSelectedDeviceId);
  const isSidePanelOpen = useStore(state => state.ui.isSidePanelOpen);
  const setIsSidePanelOpen = useStore(state => state.setIsSidePanelOpen);
  const debugMode = useStore(state => state.ui.debugMode);
  const setDebugMode = useStore(state => state.setDebugMode);
  const debugFrameIndex = useStore(state => state.ui.debugFrameIndex);
  const setDebugFrameIndex = useStore(state => state.setDebugFrameIndex);

  const { wsStatus, wsError, updateCounter, reconnect, disconnect, positions } = useTraccarConnection({
    baseUrl: traccarBaseUrl,
    secure: traccarSecure,
    token: traccarToken,
    onDevices: setDevicesFromApi,
  });

  const engineSnapshotsByDevice = useStore(state => state.engineSnapshotsByDevice);

  useEffect(() => {
    if (positions.length > 0) {
      setPositionsAll(prev => [...prev, ...positions]);
      processPositions();
      const firstPos = positions[0];
      if (firstPos && refLat == null) setRefLat(firstPos.lat);
      if (firstPos && refLon == null) setRefLon(firstPos.lon);
      if (firstPos && firstPositionRef == null) setFirstPosition({ lat: firstPos.lat, lon: firstPos.lon });
    }
  }, [updateCounter, positions, setPositionsAll, refLat, refLon, firstPositionRef, setRefLat, setRefLon, setFirstPosition, processPositions]);

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

  // Group CRUD handlers
  const handleCreateGroup = createGroup;
  const handleDeleteGroup = deleteGroup;
  const handleAddDeviceToGroup = addDeviceToGroup;
  const handleRemoveDeviceFromGroup = removeDeviceFromGroup;
  const handleUpdateMotionProfile = updateMotionProfile;
  const handleUpdateGroup = updateGroup;

  const applySettings = () => {
    useStore.getState().applySettings();
    reconnect();
  };

  const clearSettings = () => {
    useStore.getState().clearSettings();
    disconnect();
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

  // current debug frame to render on the map (if any)
  const currentDebugFrame = (selectedDeviceId != null && debugMode && enginesRef.get(selectedDeviceId)) ? (() => {
    const fr = enginesRef.get(selectedDeviceId)?.getDebugFrames();
    if (!fr || fr.length === 0) return null;
    const idx = Math.max(0, Math.min(fr.length - 1, debugFrameIndex));
    return fr[idx] ?? null;
  })() : null;

  const currentDebugAnchors = (selectedDeviceId != null && debugMode && enginesRef.get(selectedDeviceId)) ? (() => {
    const eng = enginesRef.get(selectedDeviceId);
    if (!eng) return [] as Array<{ mean: [number, number]; variance: number; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }>;
    const anchors: Array<{ mean: [number, number]; variance: number; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }> = [];
    if (eng.activeAnchor) anchors.push({ mean: [eng.activeAnchor.mean[0], eng.activeAnchor.mean[1]], variance: eng.activeAnchor.variance, type: "active", startTimestamp: eng.activeAnchor.startTimestamp, endTimestamp: eng.activeAnchor.endTimestamp, confidence: eng.activeAnchor.confidence, lastUpdateTimestamp: eng.activeAnchor.lastUpdateTimestamp });
    if (eng.candidateAnchor) anchors.push({ mean: [eng.candidateAnchor.mean[0], eng.candidateAnchor.mean[1]], variance: eng.candidateAnchor.variance, type: "candidate", startTimestamp: eng.candidateAnchor.startTimestamp, endTimestamp: eng.candidateAnchor.endTimestamp, confidence: eng.candidateAnchor.confidence, lastUpdateTimestamp: eng.candidateAnchor.lastUpdateTimestamp });
    for (const anchor of eng.closedAnchors) {
      anchors.push({ mean: [anchor.mean[0], anchor.mean[1]], variance: anchor.variance, type: "closed", startTimestamp: anchor.startTimestamp, endTimestamp: anchor.endTimestamp, confidence: anchor.confidence, lastUpdateTimestamp: anchor.lastUpdateTimestamp });
    }
    return anchors;
  })() : [];

  const deviceList = useMemo(() => {
    // Build set of member device IDs so we can skip them
    const memberDeviceIds = new Set<number>();
    for (const groupDevice of groupDevices) {
      for (const memberId of groupDevice.memberDeviceIds) {
        memberDeviceIds.add(memberId);
      }
    }

    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const devices: Array<{
      id: number | string;
      isGroup: boolean;
      name: string;
      icon: string;
      lastSeen: number | null;
      hasPosition: boolean;
      memberDeviceIds?: number[];
    }> = [];

    // Track seen IDs to prevent duplicates
    const seenIds = new Set<number | string>();

    // Create a set of group IDs to skip when processing individual devices
    const groupIds = new Set(groupDevices.map(g => g.id));

    // Add individual devices (skip if they're members of a group or if they're group devices themselves)
    for (const [id, name] of Object.entries(deviceNames)) {
      const numId = Number(id);
      // TEMP: Unhide member devices for debugging
      // if (memberDeviceIds.has(numId)) continue; // Skip members
      if (groupIds.has(numId)) {
        continue; // Skip if it's a group device
      }
      if (seenIds.has(numId)) {
        continue; // Skip if already added
      }

      const lastSeen = deviceLastSeen[numId] ?? null;
      if (!lastSeen || lastSeen <= cutoff) continue; // Skip old devices

      devices.push({
        id: numId,
        isGroup: false,
        name,
        icon: deviceIcons[numId] ?? "device_unknown",
        lastSeen,
        hasPosition: (engineSnapshotsByDevice[numId]?.length ?? 0) > 0,
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

      devices.push({
        id: groupDevice.id,
        isGroup: true,
        name: groupDevice.name,
        icon: groupDevice.emoji,
        lastSeen: groupLastSeen,
        hasPosition: (engineSnapshotsByDevice[groupDevice.id]?.length ?? 0) > 0,
        memberDeviceIds: groupDevice.memberDeviceIds,
      });
      seenIds.add(groupDevice.id);
    }

    // Sort alphabetically
    devices.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return devices;
  }, [groupDevices, deviceNames, deviceLastSeen, engineSnapshotsByDevice]);

  return (
    <div className="h-screen w-screen">
      <DeviceListSidePanel
        devices={deviceList}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => {
          if (typeof id === "number") {
            setSelectedDeviceId(id);
          }
          setIsSidePanelOpen(false);
        }}
        isOpen={isSidePanelOpen}
        onToggle={() => setIsSidePanelOpen(!isSidePanelOpen)}
        onShowGroupsModal={() => setShowGroupsModal(true)}
      />
      <MapView
        debugFrame={currentDebugFrame}
        debugAnchors={currentDebugAnchors}
        components={frame.components}
        refLat={refLat}
        refLon={refLon}
        worldBounds={worldBounds}
        height="100vh"
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={(id) => setSelectedDeviceId(id)}
        deviceNames={deviceNames}
        deviceIcons={deviceIcons}
        overlay={
          <div className="flex flex-col gap-2">
            <SettingsPanel
              baseUrlInput={baseUrlInput}
              setBaseUrlInput={setBaseUrlInput}
              secureInput={inputSecure}
              setSecureInput={setSecureInput}
              tokenInput={inputToken}
              setTokenInput={setTokenInput}
              wsStatus={wsStatus}
              wsError={wsError}
              onApplySettings={applySettings}
              onClearSettings={clearSettings}
              onReconnect={reconnect}
              onDisconnect={disconnect}
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
              deviceMotionProfiles={deviceMotionProfiles}
              handleUpdateMotionProfile={handleUpdateMotionProfile}
              setSelectedDeviceId={setSelectedDeviceId}
              refLat={refLat}
              refLon={refLon}
              enginesRef={enginesRef}
            />

          </div>
        }
      />
      <TrackerGroupsModal
        isOpen={showGroupsModal}
        onClose={() => setShowGroupsModal(false)}
        groupDevices={groupDevices}
        allDevices={Object.entries(deviceNames)
          .filter(([id]) => !groupDevices.some(g => g.id === Number(id)))
          .map(([id, name]) => ({
            id: Number(id),
            name,
          }))}
        onCreateGroup={handleCreateGroup}
        onDeleteGroup={handleDeleteGroup}
        onAddDeviceToGroup={handleAddDeviceToGroup}
        onRemoveDeviceFromGroup={handleRemoveDeviceFromGroup}
        onUpdateGroup={handleUpdateGroup}
      />
    </div>
  );
}

export default App;
