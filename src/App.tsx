import { SettingsPanel } from "./ui/SettingsPanel";
import DeviceOverlay from "./ui/DeviceOverlay";
import { useTraccarConnection } from "./hooks/useTraccarConnection";
import { usePositionProcessing } from "./hooks/usePositionProcessing";
import { degreesToMeters } from "./util/geo";
import { measurementCovFromAccuracy } from "./util/appUtils";
import { Engine } from "./engine/engine";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import MapView from "./ui/MapView";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import TrackerGroupsModal from "./ui/TrackerGroupsModal";
import type { DevicePoint } from "@/ui/types";
import type { TraccarDevice } from "@/api/traccarClient";
import type { MotionProfileName } from "@/engine/motionDetector";
import type { NormalizedPosition } from "@/api/traccarClient";

export function App() {
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [showGroupsModal, setShowGroupsModal] = useState(false);

  const [deviceMotionProfiles, setDeviceMotionProfiles] = useState<Record<number, MotionProfileName>>({});
  const [groupDevices, setGroupDevices] = useState<Array<{ id: number; name: string; emoji: string; color: string; memberDeviceIds: number[] }>>([]);
  const deviceToGroupsMapRef = useRef(new Map<number, number[]>());
  const groupIdsRef = useRef<Set<number>>(new Set());

  const groupMotionProfiles = useMemo(() => {
    const profiles = new Map<number, MotionProfileName>();
    for (const group of groupDevices) {
      let profile: MotionProfileName = "person";
      for (const memberId of group.memberDeviceIds) {
        if ((deviceMotionProfiles[memberId] ?? "person") === "car") {
          profile = "car";
          break;
        }
      }
      profiles.set(group.id, profile);
    }
    return profiles;
  }, [groupDevices, deviceMotionProfiles]);



  const onDevices = async (devices: TraccarDevice[]) => {
    const { colorForDevice } = await import("@/ui/color");
    const rgbToHex = (r: number, g: number, b: number): string => `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    const nameMap: Record<number, string> = {};
    const iconMap: Record<number, string> = {};
    const lastSeenMap: Record<number, number | null> = {};
    const motionProfileMap: Record<number, MotionProfileName> = {};
    const groupDevicesMap = new Map<number, { id: number; name: string; emoji: string; color: string; memberDeviceIds: number[] }>();

    for (const d of devices) {
      if (d?.id != null) {
        nameMap[d.id] = d.name;
        iconMap[d.id] = d.emoji;
        lastSeenMap[d.id] = d.lastSeen;
        const rawProfile = typeof d.attributes?.["motionProfile"] === "string" ? d.attributes["motionProfile"] : null;
        motionProfileMap[d.id] = rawProfile === "car" ? "car" : "person";

        // Check if this is a group device
        const memberDeviceIdsStr = typeof d.attributes?.["memberDeviceIds"] === "string" ? d.attributes["memberDeviceIds"] : null;
        if (memberDeviceIdsStr) {
          try {
            const memberDeviceIds = JSON.parse(memberDeviceIdsStr) as number[];
            groupDevicesMap.set(d.id, {
              id: d.id,
              name: d.name,
              emoji: d.emoji,
              color: "#000000", // Placeholder
              memberDeviceIds: Array.isArray(memberDeviceIds) ? memberDeviceIds : [],
            });
          } catch {
            // Ignore parsing errors
          }
        }
      }
    }
    const groupDevicesArray = Array.from(groupDevicesMap.values());
    setDeviceNames(nameMap);
    setDeviceIcons(iconMap);
    setDeviceLastSeen(lastSeenMap);
    setDeviceMotionProfiles(motionProfileMap);

    // Generate colors for groups
    const groupsWithColors = groupDevicesArray.map(g => {
      const colorRgb = colorForDevice(g.id);
      const color = rgbToHex(colorRgb[0], colorRgb[1], colorRgb[2]);
      return { ...g, color };
    });
    setGroupDevices(groupsWithColors);

    // Calculate lastSeen for groups based on members
    const updatedLastSeenMap = { ...lastSeenMap };
    for (const group of groupsWithColors) {
      let maxLastSeen: number | null = null;
      for (const memberId of group.memberDeviceIds) {
        const memberLastSeen = lastSeenMap[memberId];
        if (memberLastSeen && (maxLastSeen === null || memberLastSeen > maxLastSeen)) {
          maxLastSeen = memberLastSeen;
        }
      }
      if (maxLastSeen !== null) {
        updatedLastSeenMap[group.id] = maxLastSeen;
      }
    }
    setDeviceLastSeen(updatedLastSeenMap);
  };




  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const enginesRef = useRef(new Map<number, Engine>());
  const [deviceNames, setDeviceNames] = useState<Record<number, string>>({});
  const [deviceIcons, setDeviceIcons] = useState<Record<number, string>>({});
  const [deviceLastSeen, setDeviceLastSeen] = useState<Record<number, number | null>>({});
  const positionsAllRef = useRef<NormalizedPosition[]>([]);
  const processedKeysRef = useRef(new Set<string>());
  const firstPositionRef = useRef<{ lat: number; lon: number } | null>(null);
  const RECENT_DEVICE_CUTOFF_MS = 96 * 60 * 60 * 1000; // 96 hours

  function safeGetItem(key: string): string | null {
    try {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeSetItem(key: string, value: string | null): void {
    try {
      if (typeof window === "undefined") return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // ignore localStorage errors
    }
  }





  // Get the most recent position across all devices in a group




  const [baseUrlInput, setBaseUrlInput] = useState<string>(() => safeGetItem("traccar:baseUrl") ?? "");
  const [secureInput, setSecureInput] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [tokenInput, setTokenInput] = useState<string>(() => safeGetItem("traccar:token") ?? "");
  const [traccarBaseUrl, setTraccarBaseUrl] = useState<string | null>(() => safeGetItem("traccar:baseUrl") ?? null);
  const [traccarSecure, setTraccarSecure] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [traccarToken, setTraccarToken] = useState<string | null>(() => safeGetItem("traccar:token") ?? null);

  const { wsStatus, wsError, updateCounter, reconnect, disconnect, positions } = useTraccarConnection({
    baseUrl: traccarBaseUrl,
    secure: traccarSecure,
    token: traccarToken,
    onDevices,
  });

  const { engineSnapshotsByDevice, processPositions, buildEngineSnapshotsFromByDevice } = usePositionProcessing({
    refLat,
    refLon,
    enginesRef,
    groupIdsRef,
    deviceToGroupsMapRef,
    groupMotionProfiles,
    deviceMotionProfiles,
    positionsAllRef,
    processedKeysRef,
    firstPositionRef,
    groupDevices,
  });

  useEffect(() => {
    const firstPos = processPositions(positions);
    if (firstPos) {
      if (refLat == null) setRefLat(firstPos.lat);
      if (refLon == null) setRefLon(firstPos.lon);
    }
  }, [updateCounter, processPositions]);




  // Helper: Build TraccarClientOptions
  const buildApiOpts = useCallback(() => ({
    baseUrl: traccarBaseUrl ?? "",
    secure: traccarSecure,
    auth: traccarToken ? { type: "token" as const, token: traccarToken } : { type: "none" as const },
  }), [traccarBaseUrl, traccarSecure, traccarToken]);

  // Helper: Convert RGB to hex color string
  const rgbToHex = (r: number, g: number, b: number): string =>
    `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

  // Build reverse map: deviceId -> array of groupDeviceIds it belongs to
  useEffect(() => {
    deviceToGroupsMapRef.current.clear();
    groupIdsRef.current.clear();
    for (const groupDevice of groupDevices) {
      groupIdsRef.current.add(groupDevice.id);
      for (const memberId of groupDevice.memberDeviceIds) {
        if (!deviceToGroupsMapRef.current.has(memberId)) {
          deviceToGroupsMapRef.current.set(memberId, []);
        }
        enginesRef.current.delete(groupDevice.id);
        const groups = deviceToGroupsMapRef.current.get(memberId)!;
        if (!groups.includes(groupDevice.id)) {
          groups.push(groupDevice.id);
        }
      }
    }
    // Re-process all existing positions to add them to any new groups
    // This ensures positions that arrived before the group was created get added to the group
    // IMPORTANT: Don't filter by processedKeysRef - we need to add positions to NEW groups even if they were already processed for individual devices
    if (positionsAllRef.current.length > 0) {
      for (const groupDevice of groupDevices) {
        enginesRef.current.delete(groupDevice.id);
      }
      const allPositions = positionsAllRef.current;
      const posByDevice = allPositions.reduce((acc, p) => {
        (acc[p.device] ||= []).push(p);
        const groupIds = deviceToGroupsMapRef.current.get(p.device);
        if (groupIds) {
          for (const groupId of groupIds) {
            (acc[groupId] ||= []).push(p);
          }
        }
        return acc;
      }, {} as Record<number, NormalizedPosition[]>);

      for (const arr of Object.values(posByDevice)) arr.sort((a, b) => a.timestamp - b.timestamp);

      const rawByDevice: Record<number, DevicePoint[]> = {};
      for (const [deviceKey, arr] of Object.entries(posByDevice)) {
        const deviceId = Number(deviceKey);
        const isGroup = groupIdsRef.current.has(deviceId);
        const rawArr: DevicePoint[] = arr.map((p) => {
          const useRef = firstPositionRef.current ?? { lat: refLat ?? p.lat, lon: refLon ?? p.lon };
          const { x, y } = degreesToMeters(p.lat, p.lon, useRef.lat, useRef.lon);
          const comp: DevicePoint = {
            mean: [x, y],
            cov: measurementCovFromAccuracy(p.accuracy),
            accuracy: p.accuracy,
            lat: p.lat,
            lon: p.lon,
            device: deviceId,
            timestamp: p.timestamp,
            anchorAgeMs: 0,
            confidence: 0,
            ...(isGroup ? { sourceDeviceId: p.device } : {}),
          };
          return comp;
        });
        rawByDevice[deviceId] = rawArr;
      }

      buildEngineSnapshotsFromByDevice(rawByDevice);
    }
  }, [groupDevices]);

  // Group CRUD handlers
  const handleCreateGroup = useCallback(async (name: string, memberDeviceIds: number[], emoji: string) => {
    try {
      const { createGroupDevice } = await import("@/api/traccarClient");
      const { colorForDevice } = await import("@/ui/color");

      const newGroup = await createGroupDevice(buildApiOpts(), name, emoji, memberDeviceIds);
      const colorRgb = colorForDevice(newGroup.id);
      const color = rgbToHex(colorRgb[0], colorRgb[1], colorRgb[2]);

      const newGroupObj = { id: newGroup.id, name: newGroup.name, emoji, color, memberDeviceIds };

      // Update all related state in one batch
      setDeviceIcons(prev => ({ ...prev, [newGroup.id]: emoji }));
      setDeviceNames(prev => ({ ...prev, [newGroup.id]: name }));
      setGroupDevices(prevGroups => {
        const filtered = prevGroups.filter(g => g.id !== newGroup.id);
        return [...filtered, newGroupObj];
      });
    } catch (error) {
      console.error("Failed to create group:", error);
      throw error;
    }
  }, [buildApiOpts, deviceMotionProfiles]);

  const handleDeleteGroup = useCallback(async (groupId: number) => {
    try {
      const { deleteGroupDevice } = await import("@/api/traccarClient");
      await deleteGroupDevice(buildApiOpts(), groupId);

      setGroupDevices(prevGroups => prevGroups.filter((g) => g.id !== groupId));
      setDeviceNames(prev => {
        const updated = { ...prev };
        delete updated[groupId];
        return updated;
      });
      setDeviceIcons(prev => {
        const updated = { ...prev };
        delete updated[groupId];
        return updated;
      });
    } catch (error) {
      console.error("Failed to delete group:", error);
      throw error;
    }
  }, [buildApiOpts, deviceMotionProfiles]);

  const handleAddDeviceToGroup = useCallback(async (groupId: number, deviceId: number) => {
    try {
      const { updateGroupDevice } = await import("@/api/traccarClient");
      let originalMemberIds: number[] = [];

      setGroupDevices(prevGroups => {
        const group = prevGroups.find((g) => g.id === groupId);
        if (!group || group.memberDeviceIds.includes(deviceId)) return prevGroups;

        originalMemberIds = group.memberDeviceIds;
        const newMemberIds = [...group.memberDeviceIds, deviceId];

        // Fire API update in background
        updateGroupDevice(buildApiOpts(), groupId, { memberDeviceIds: newMemberIds }).catch(error => {
          console.error("Failed to add device to group:", error);
          setGroupDevices(prevGroups => prevGroups.map((g) => g.id === groupId ? { ...g, memberDeviceIds: originalMemberIds } : g));
        });

        return prevGroups.map((g) => g.id === groupId ? { ...g, memberDeviceIds: newMemberIds } : g);
      });
    } catch (error) {
      console.error("Failed to add device to group:", error);
      throw error;
    }
  }, [buildApiOpts]);

  const handleRemoveDeviceFromGroup = useCallback(async (groupId: number, deviceId: number) => {
    try {
      const { updateGroupDevice } = await import("@/api/traccarClient");
      let originalMemberIds: number[] = [];

      setGroupDevices(prevGroups => {
        const group = prevGroups.find((g) => g.id === groupId);
        if (!group) return prevGroups;

        originalMemberIds = group.memberDeviceIds;
        const newMemberIds = group.memberDeviceIds.filter((id) => id !== deviceId);

        // Fire API update in background
        updateGroupDevice(buildApiOpts(), groupId, { memberDeviceIds: newMemberIds }).catch(error => {
          console.error("Failed to remove device from group:", error);
          setGroupDevices(prevGroups => prevGroups.map((g) => g.id === groupId ? { ...g, memberDeviceIds: originalMemberIds } : g));
        });

        return prevGroups.map((g) => g.id === groupId ? { ...g, memberDeviceIds: newMemberIds } : g);
      });
    } catch (error) {
      console.error("Failed to remove device from group:", error);
      throw error;
    }
  }, [buildApiOpts]);

  const handleUpdateMotionProfile = useCallback(async (deviceId: number, profile: MotionProfileName) => {
    const previous = deviceMotionProfiles[deviceId] ?? "person";
    setDeviceMotionProfiles(prev => ({ ...prev, [deviceId]: profile }));
    try {
      const { updateDeviceAttributes } = await import("@/api/traccarClient");
      const payload = { motionProfile: profile, motionProfileUpdatedAt: new Date().toISOString() };
      await updateDeviceAttributes(buildApiOpts(), deviceId, payload);
    } catch (error) {
      console.error("Failed to update motion profile:", error);
      setDeviceMotionProfiles(prev => ({ ...prev, [deviceId]: previous }));
    }
  }, [buildApiOpts, deviceMotionProfiles, traccarBaseUrl, traccarSecure, traccarToken]);

  const handleUpdateGroup = useCallback(async (groupId: number, updates: { name?: string }) => {
    try {
      const { updateGroupDevice } = await import("@/api/traccarClient");
      await updateGroupDevice(buildApiOpts(), groupId, updates);

      setGroupDevices(prevGroups => prevGroups.map((g) =>
        g.id === groupId ? { ...g, name: updates.name ?? g.name } : g
      ));
    } catch (error) {
      console.error("Failed to update group:", error);
      throw error;
    }
  }, [buildApiOpts]);




  function applySettings() {
    safeSetItem("traccar:baseUrl", baseUrlInput || null);
    safeSetItem("traccar:secure", secureInput.toString());
    safeSetItem("traccar:token", tokenInput || null);

    setTraccarBaseUrl(baseUrlInput || null);
    setTraccarSecure(secureInput);
    setTraccarToken(tokenInput || null);

    reconnect();
  }

  function clearSettings() {
    setBaseUrlInput("");
    setSecureInput(false);
    setTokenInput("");
    safeSetItem("traccar:baseUrl", null);
    safeSetItem("traccar:secure", "false");
    safeSetItem("traccar:token", null);
    setTraccarBaseUrl(null);
    setTraccarSecure(false);
    setTraccarToken(null);
    disconnect();
  }







  const visibleComponents = useMemo(() => {
    const engineComps = Object.values(engineSnapshotsByDevice).flat();
    const allComps = engineComps;

    // Filter devices not seen in the last 24 hours using deviceLastSeen
    const cutoff = Date.now() - RECENT_DEVICE_CUTOFF_MS;
    const activeDevices = new Set<number>();
    for (const [device, lastSeen] of Object.entries(deviceLastSeen)) {
      if (lastSeen && lastSeen > cutoff) {
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

  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(true);

  // Debug mode: show per-device ring buffer and scrub frames
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [debugFrameIndex, setDebugFrameIndex] = useState<number>(0);

  // Reset debug index when device or frame count changes
  useEffect(() => {
    if (selectedDeviceId == null || !debugMode) return;
    const frames = enginesRef.current.get(selectedDeviceId)?.getDebugFrames() ?? [];
    if (frames.length === 0) setDebugFrameIndex(0);
    else setDebugFrameIndex(Math.max(0, frames.length - 1));
  }, [selectedDeviceId, debugMode]);

  // current debug frame to render on the map (if any)
  const currentDebugFrame = (selectedDeviceId != null && debugMode && enginesRef.current.get(selectedDeviceId)) ? (() => {
    const fr = enginesRef.current.get(selectedDeviceId)?.getDebugFrames();
    if (!fr || fr.length === 0) return null;
    const idx = Math.max(0, Math.min(fr.length - 1, debugFrameIndex));
    return fr[idx] ?? null;
  })() : null;

  const currentDebugAnchors = (selectedDeviceId != null && debugMode && enginesRef.current.get(selectedDeviceId)) ? (() => {
    const eng = enginesRef.current.get(selectedDeviceId);
    if (!eng) return [] as Array<{ mean: [number, number]; cov: [number, number, number]; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }>;
    const anchors: Array<{ mean: [number, number]; cov: [number, number, number]; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }> = [];
    if (eng.activeAnchor) anchors.push({ mean: [eng.activeAnchor.mean[0], eng.activeAnchor.mean[1]], cov: [eng.activeAnchor.cov[0], eng.activeAnchor.cov[1], eng.activeAnchor.cov[2]], type: "active", startTimestamp: eng.activeAnchor.startTimestamp, endTimestamp: eng.activeAnchor.endTimestamp, confidence: eng.activeAnchor.confidence, lastUpdateTimestamp: eng.activeAnchor.lastUpdateTimestamp });
    if (eng.candidateAnchor) anchors.push({ mean: [eng.candidateAnchor.mean[0], eng.candidateAnchor.mean[1]], cov: [eng.candidateAnchor.cov[0], eng.candidateAnchor.cov[1], eng.candidateAnchor.cov[2]], type: "candidate", startTimestamp: eng.candidateAnchor.startTimestamp, endTimestamp: eng.candidateAnchor.endTimestamp, confidence: eng.candidateAnchor.confidence, lastUpdateTimestamp: eng.candidateAnchor.lastUpdateTimestamp });
    for (const anchor of eng.closedAnchors) {
      anchors.push({ mean: [anchor.mean[0], anchor.mean[1]], cov: [anchor.cov[0], anchor.cov[1], anchor.cov[2]], type: "closed", startTimestamp: anchor.startTimestamp, endTimestamp: anchor.endTimestamp, confidence: anchor.confidence, lastUpdateTimestamp: anchor.lastUpdateTimestamp });
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
        icon: deviceIcons[numId] || "device_unknown",
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
              secureInput={secureInput}
              setSecureInput={setSecureInput}
              tokenInput={tokenInput}
              setTokenInput={setTokenInput}
              wsStatus={wsStatus}
              wsError={wsError}
              onApplySettings={applySettings}
              onClearSettings={clearSettings}
              onReconnect={reconnect}
              onDisconnect={disconnect}
              onShowGroupsModal={() => setShowGroupsModal(true)}
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
