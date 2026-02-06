// @ts-ignore - allow importing CSS without type declarations
import "./index.css";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_MEDIUM_THRESHOLD } from "./engine/anchor";
import { degreesToMeters, metersToDegrees } from "./util/geo";
import { Engine } from "./engine/engine";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import MapView from "./ui/MapView";
import DeviceListSidePanel from "./ui/DeviceListSidePanel";
import TrackerGroupsModal from "./ui/TrackerGroupsModal";
import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";
import type { MotionProfileName } from "@/engine/engine";
import type { NormalizedPosition } from "@/api/traccarClient";

export function App() {
  type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

  const [showGroupsModal, setShowGroupsModal] = useState(false);

  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<number, DevicePoint[]>>({});
  const [refLat, setRefLat] = useState<number | null>(null);
  const [refLon, setRefLon] = useState<number | null>(null);
  const [worldBounds, setWorldBounds] = useState<WorldBounds | null>(null);
  const enginesRef = useRef<Record<number, Engine>>({});
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

  function measurementCovFromAccuracy(accuracyMeters: number): Cov2 {
    const v = accuracyMeters * accuracyMeters;
    return [v, 0, v];
  }

  function createDevicePoint(mean: Vec2, cov: Cov2, timestamp: number, deviceId: number, refLat: number | null, refLon: number | null, anchorAgeMs: number, confidence: number): DevicePoint {
    const diagMax = Math.max(cov[0], cov[2]);
    const accuracyVal = Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, diagMax))));
    const { lat: compLat, lon: compLon } = (refLat != null && refLon != null) ? metersToDegrees(mean[0], mean[1], refLat, refLon) : { lat: 0, lon: 0 };
    return { mean, cov, timestamp, device: deviceId, lat: compLat, lon: compLon, accuracy: accuracyVal, anchorAgeMs, confidence };
  }

  // Get the most recent position across all devices in a group
  function getMostRecentGroupDevice(groupDeviceIds: number[]): number | null {
    let mostRecentDevice: number | null = null;
    let mostRecentTime = 0;
    for (const deviceId of groupDeviceIds) {
      const lastSeen = deviceLastSeen[deviceId] ?? 0;
      if (lastSeen > mostRecentTime) {
        mostRecentTime = lastSeen;
        mostRecentDevice = deviceId;
      }
    }
    return mostRecentDevice;
  }

  function buildEngineSnapshotsFromByDevice(byDevice: Record<string, DevicePoint[]>): DevicePoint[] {
    try {
      const measurementsByDevice: Record<number, DevicePoint[]> = {};

      for (const [deviceKey, arr] of Object.entries(byDevice)) {
        const deviceId = Number(deviceKey);
        if (!enginesRef.current[deviceId]) {
          enginesRef.current[deviceId] = new Engine();
        }
        const profile = groupIdsRef.current.has(deviceId)
          ? (groupMotionProfiles.get(deviceId) ?? "person")
          : (deviceMotionProfiles[deviceId] ?? "person");
        enginesRef.current[deviceId].setMotionProfile(profile);
        // Ensure measurements are sorted by timestamp
        const sortedArr = [...arr].sort((a, b) => a.timestamp - b.timestamp);
        measurementsByDevice[deviceId] = sortedArr;
        enginesRef.current[deviceId].processMeasurements(sortedArr);
      }

      const currentSnapshots: Record<number, DevicePoint[]> = {};
      for (const [deviceId, engine] of Object.entries(enginesRef.current)) {
        const snapshot = engine.getCurrentSnapshot();
        if (snapshot.activeAnchor) {
          // Use the latest timestamp from the measurements we just processed, not engine.lastTimestamp
          const dId = Number(deviceId);
          const measurements = measurementsByDevice[dId];
          const latestMeasurementTime = measurements && measurements.length > 0
            ? measurements[measurements.length - 1]!.timestamp
            : engine.lastTimestamp ?? Date.now();

          const timestamp = latestMeasurementTime;
          const anchorStartTs = (typeof snapshot.activeAnchor.startTimestamp === 'number' && Number.isFinite(snapshot.activeAnchor.startTimestamp)) ? snapshot.activeAnchor.startTimestamp : timestamp;
          const anchorAgeMs = Math.max(0, Date.now() - anchorStartTs);

          const point = createDevicePoint(snapshot.activeAnchor.mean, snapshot.activeAnchor.cov, timestamp, dId, refLat ?? 0, refLon ?? 0, anchorAgeMs, snapshot.activeConfidence);
          currentSnapshots[dId] = [point];
        } else {
          currentSnapshots[Number(deviceId)] = [];
        }
      }
      setEngineSnapshotsByDevice(currentSnapshots);
      return Object.values(currentSnapshots).flat();
    } catch (e) {
      console.error("Error building engine snapshots:", e);
      return [];
    }
  }

  const [baseUrlInput, setBaseUrlInput] = useState<string>(() => safeGetItem("traccar:baseUrl") ?? "");
  const [secureInput, setSecureInput] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [tokenInput, setTokenInput] = useState<string>(() => safeGetItem("traccar:token") ?? "");
  const [traccarBaseUrl, setTraccarBaseUrl] = useState<string | null>(() => safeGetItem("traccar:baseUrl") ?? null);
  const [traccarSecure, setTraccarSecure] = useState<boolean>(() => (safeGetItem("traccar:secure") ?? "false") === "true");
  const [traccarToken, setTraccarToken] = useState<string | null>(() => safeGetItem("traccar:token") ?? null);
  const clientCloseRef = useRef<(() => void) | null>(null);
  const [deviceNames, setDeviceNames] = useState<Record<number, string>>({});
  const [deviceIcons, setDeviceIcons] = useState<Record<number, string>>({});
  const [deviceLastSeen, setDeviceLastSeen] = useState<Record<number, number | null>>({});
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

  const seenRef = useRef<Set<string>>(new Set());
  const processedKeysRef = useRef<Set<string>>(new Set());
  const positionsAllRef = useRef<NormalizedPosition[]>([]);

  function dedupeKey(p: { device: number; timestamp: number; lat: number; lon: number }) {
    return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
  }

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
        delete enginesRef.current[groupDevice.id];
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
  const [wsStatus, setWsStatus] = useState<"unknown" | "connecting" | "connected" | "disconnected" | "error">("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsApplyCounter, setWsApplyCounter] = useState(0);

  function applySettings() {
    safeSetItem("traccar:baseUrl", baseUrlInput || null);
    safeSetItem("traccar:secure", secureInput.toString());
    safeSetItem("traccar:token", tokenInput || null);

    setTraccarBaseUrl(baseUrlInput || null);
    setTraccarSecure(secureInput);
    setTraccarToken(tokenInput || null);

    if (baseUrlInput && baseUrlInput.trim() !== "") {
      setWsStatus("connecting");
      setWsError(null);
    } else {
      setWsStatus("disconnected");
      setWsError("No Base URL configured");
    }

    setWsApplyCounter((c) => c + 1);
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
    setWsStatus("disconnected");
    setWsError(null);
    setWsApplyCounter((c) => c + 1);
  }

  function processPositions(positions: NormalizedPosition[]) {
    if (!positions || positions.length === 0) return;

    const newPositions = positions.filter(p => {
      const key = dedupeKey(p);
      if (processedKeysRef.current.has(key)) return false;
      processedKeysRef.current.add(key);
      return true;
    });
    if (newPositions.length === 0) return;

    const groupIdsTouched = new Set<number>();
    for (const p of newPositions) {
      const groupIds = deviceToGroupsMapRef.current.get(p.device);
      if (groupIds) {
        for (const groupId of groupIds) {
          groupIdsTouched.add(groupId);
        }
      }
    }

    // Group positions by device AND by any groups they belong to
    const posByDevice = newPositions.reduce((acc, p) => {
      // Add position to the original device
      (acc[p.device] ||= []).push(p);

      // Also add position to any groups this device belongs to
      const groupIds = deviceToGroupsMapRef.current.get(p.device);
      if (groupIds) {
        for (const groupId of groupIds) {
          (acc[groupId] ||= []).push(p);
        }
      }

      return acc;
    }, {} as Record<number, NormalizedPosition[]>);

    if (groupIdsTouched.size > 0) {
      const membersByGroup = new Map<number, number[]>();
      for (const group of groupDevices) {
        membersByGroup.set(group.id, group.memberDeviceIds);
      }
      const allPositions = positionsAllRef.current;
      for (const groupId of groupIdsTouched) {
        const memberIds = membersByGroup.get(groupId);
        if (!memberIds || memberIds.length === 0) continue;
        delete enginesRef.current[groupId];
        const memberSet = new Set(memberIds);
        posByDevice[groupId] = allPositions.filter((p) => memberSet.has(p.device));
      }
    }

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

    if (!firstPositionRef.current && newPositions.length > 0) {
      const first = newPositions[0]!;
      firstPositionRef.current = { lat: first.lat, lon: first.lon };
      if (refLat == null) setRefLat(first.lat);
      if (refLon == null) setRefLon(first.lon);
    }

    buildEngineSnapshotsFromByDevice(rawByDevice);

    // Update last seen timestamps - for original devices AND their groups
    const latestPerDevice: Record<number, number> = {};
    for (const p of newPositions) {
      latestPerDevice[p.device] = Math.max(latestPerDevice[p.device] ?? 0, p.timestamp);

      // Also update lastSeen for groups this device belongs to
      const groupIds = deviceToGroupsMapRef.current.get(p.device);
      if (groupIds) {
        for (const groupId of groupIds) {
          latestPerDevice[groupId] = Math.max(latestPerDevice[groupId] ?? 0, p.timestamp);
        }
      }
    }
    setDeviceLastSeen(prev => ({ ...prev, ...latestPerDevice }));
  }

  useEffect(() => {
    if (!traccarBaseUrl) {
      clientCloseRef.current?.();
      setWsStatus("disconnected");
      setWsError((prev) => (prev && prev.includes("No Base URL") ? prev : prev ?? null));
      return;
    }

    setWsStatus("connecting");
    setWsError(null);

    const knownDevices = new Set<number>();

    function insertSortedByTimestamp(arr: NormalizedPosition[], item: NormalizedPosition) {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((arr[mid]?.timestamp ?? 0) <= item.timestamp) lo = mid + 1;
        else hi = mid;
      }
      arr.splice(lo, 0, item);
    }

    clientCloseRef.current?.();

    (async () => {
      try {
        const { connectRealtime, fetchPositions, fetchDevices } = await import("@/api/traccarClient");
        const client = connectRealtime({
          baseUrl: traccarBaseUrl ?? undefined,
          secure: traccarSecure,
          auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" },
          autoReconnect: true,
          reconnectInitialMs: 1000,
          reconnectMaxMs: 30000,
          onPosition: (p) => {
            const key = dedupeKey(p);
            if (seenRef.current.has(key)) return;
            seenRef.current.add(key);
            insertSortedByTimestamp(positionsAllRef.current, p);
            knownDevices.add(p.device);
            processPositions(positionsAllRef.current);
          },
          onOpen: () => {
            (async () => {
              setWsStatus("connected");
              setWsError(null);
              try {
                const derivedBase = traccarBaseUrl ? { baseUrl: traccarBaseUrl, secure: traccarSecure } : null;

                if (derivedBase) {
                  const devices = await fetchDevices({ ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" } });
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
                          // Color is not stored in Traccar, generate from group ID
                          // (Will be set properly after import)
                          groupDevicesMap.set(d.id, {
                            id: d.id,
                            name: d.name,
                            emoji: d.emoji,
                            color: "#000000", // Placeholder, will be updated
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

                  // Generate colors for groups from their IDs
                  const { colorForDevice } = await import("@/ui/color");
                  const groupsWithColors = groupDevicesArray.map(g => {
                    const colorRgb = colorForDevice(g.id);
                    const color = rgbToHex(colorRgb[0], colorRgb[1], colorRgb[2]);
                    return { ...g, color };
                  });
                  setGroupDevices(groupsWithColors);
                  // Only add individual devices (not groups) to knownDevices for fetching positions
                  const groupIds = new Set(groupDevicesMap.keys());
                  for (const id of Object.keys(nameMap)) {
                    const numId = Number(id);
                    if (!groupIds.has(numId)) {
                      knownDevices.add(numId);
                    }
                  }
                }

                if (derivedBase) {
                  const from = new Date(Math.max(0, Date.now() - RECENT_DEVICE_CUTOFF_MS));
                  const to = new Date();
                  const fetches = Array.from(knownDevices).map((deviceId) => {
                    if (deviceId == null || Number.isNaN(deviceId)) return Promise.resolve([] as NormalizedPosition[]);
                    return fetchPositions(
                      { ...derivedBase, auth: traccarToken ? { type: "token", token: traccarToken } : { type: "none" } },
                      deviceId,
                      from,
                      to,
                      {}
                    );
                  });

                  const results = await Promise.allSettled(fetches);
                  for (const res of results) {
                    if (res.status !== "fulfilled") continue;
                    for (const p of res.value) {
                      const key = dedupeKey(p);
                      if (seenRef.current.has(key)) continue;
                      seenRef.current.add(key);
                      positionsAllRef.current.push(p);
                    }
                  }

                  if (positionsAllRef.current.length > 0) {
                    processPositions(positionsAllRef.current);
                  }
                }
              } catch {
                // ignore fetch errors
              }
            })().catch(() => { });
          },
          onClose: (ev) => {
            const code = ev?.code;
            const reason = ev?.reason;
            const detail = code != null ? (reason ? `code=${code} reason=${reason}` : `code=${code}`) : "closed";
            setWsStatus((prev) => (prev === "error" ? "error" : "disconnected"));
            setWsError((prev) => prev ?? `WebSocket closed: ${detail}`);
            console.warn("Traccar WS closed:", ev);
          },
          onError: (err) => {
            const message = err instanceof Event ? "WebSocket connection error (check URL/token and server)" : (err instanceof Error ? err.message : String(err));
            setWsStatus("error");
            setWsError(message);
            console.warn("Traccar WS error:", err);
          },
        });

        clientCloseRef.current = () => {
          client.close();
        };
      } catch (e) {
        console.warn("Could not initialize realtime traccar client:", e);
        setWsStatus("error");
        setWsError(String(e));
      }
    })();

    return () => {
      clientCloseRef.current?.();
    };
  }, [traccarBaseUrl, traccarSecure, traccarToken, wsApplyCounter]);

  function humanDurationSince(ts: number, now: number = Date.now()): string {
    const s = Math.round((now - (ts ?? now)) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    return `${d}d`;
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
    const frames = enginesRef.current[selectedDeviceId]?.getDebugFrames() ?? [];
    if (frames.length === 0) setDebugFrameIndex(0);
    else setDebugFrameIndex(Math.max(0, frames.length - 1));
  }, [selectedDeviceId, debugMode]);

  // current debug frame to render on the map (if any)
  const currentDebugFrame = (selectedDeviceId != null && debugMode && enginesRef.current[selectedDeviceId]) ? (() => {
    const fr = enginesRef.current[selectedDeviceId]?.getDebugFrames();
    if (!fr || fr.length === 0) return null;
    const idx = Math.max(0, Math.min(fr.length - 1, debugFrameIndex));
    return fr[idx] ?? null;
  })() : null;

  const currentDebugAnchors = (selectedDeviceId != null && debugMode && enginesRef.current[selectedDeviceId]) ? (() => {
    const eng = enginesRef.current[selectedDeviceId];
    if (!eng) return [] as Array<{ mean: [number, number]; cov: [number, number, number]; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }>;
    const anchors: Array<{ mean: [number, number]; cov: [number, number, number]; type: "active" | "candidate" | "closed"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }> = [];
    if (eng.activeAnchor) anchors.push({ mean: [eng.activeAnchor.mean[0], eng.activeAnchor.mean[1]], cov: [eng.activeAnchor.cov[0], eng.activeAnchor.cov[1], eng.activeAnchor.cov[2]], type: "active", startTimestamp: eng.activeAnchor.startTimestamp, endTimestamp: eng.activeAnchor.endTimestamp, confidence: eng.activeAnchor.confidence, lastUpdateTimestamp: eng.activeAnchor.lastUpdateTimestamp });
    if (eng.candidateAnchor) anchors.push({ mean: [eng.candidateAnchor.mean[0], eng.candidateAnchor.mean[1]], cov: [eng.candidateAnchor.cov[0], eng.candidateAnchor.cov[1], eng.candidateAnchor.cov[2]], type: "candidate", startTimestamp: eng.candidateAnchor.startTimestamp, endTimestamp: eng.candidateAnchor.endTimestamp, confidence: eng.candidateAnchor.confidence, lastUpdateTimestamp: eng.candidateAnchor.lastUpdateTimestamp });
    for (const anchor of eng.closedAnchors) {
      anchors.push({ mean: [anchor.mean[0], anchor.mean[1]], cov: [anchor.cov[0], anchor.cov[1], anchor.cov[2]], type: "closed", startTimestamp: anchor.startTimestamp, endTimestamp: anchor.endTimestamp, confidence: anchor.confidence, lastUpdateTimestamp: anchor.lastUpdateTimestamp });
    }
    return anchors;
  })() : [];

  const deviceList = (() => {
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
      let lastSeen: number | null = null;
      for (const memberId of groupDevice.memberDeviceIds) {
        const memberLastSeen = deviceLastSeen[memberId];
        if (memberLastSeen && (!lastSeen || memberLastSeen > lastSeen)) {
          lastSeen = memberLastSeen;
        }
      }

      // Always show groups, even if member devices don't have recent lastSeen
      // Use the max from member devices, or null if none have data
      const groupLastSeen = lastSeen ?? null;

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
  })();

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
            <div className="w-full">
              <div className="mb-3 p-2 rounded bg-muted/10 border">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className="border rounded px-2 py-1 w-[24rem]"
                    placeholder="Traccar Base URL (e.g. localhost:8082)"
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                  />
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={secureInput}
                      onChange={(e) => setSecureInput(e.target.checked)}
                    />
                    Secure (HTTPS/WSS)
                  </label>
                  <input
                    type="password"
                    className="border rounded px-2 py-1 w-48"
                    placeholder="API Token"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                  />
                  <button className="px-3 py-1 rounded bg-primary text-white" onClick={() => applySettings()}>
                    Save
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => clearSettings()}>
                    Clear
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => {
                    if (!traccarBaseUrl) {
                      setWsStatus("disconnected");
                      setWsError("No Base URL configured");
                    } else {
                      setWsStatus("connecting");
                      setWsError(null);
                      setWsApplyCounter((c) => c + 1);
                    }
                  }}>
                    Reconnect
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => { clientCloseRef.current?.(); setWsStatus("disconnected"); }}>
                    Disconnect
                  </button>
                  <button className="px-3 py-1 rounded border" onClick={() => setShowGroupsModal(true)}>
                    Tracker Groups
                  </button>
                  <label className="flex items-center gap-1 px-2">
                    <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
                    <span className="text-xs">Debug</span>
                  </label>
                </div>
                <div className="text-xs mt-2">
                  <span className="mr-2">Status: <strong>{wsStatus}</strong></span>
                  {wsError ? <span className="text-red-500">Error: {wsError}</span> : null}
                </div>
              </div>
            </div>

            {selectedDeviceId != null ? (
              (() => {
                const engArr = engineSnapshotsByDevice[selectedDeviceId] ?? [];
                const chosen = engArr.length > 0 ? engArr[engArr.length - 1] : null;
                if (!chosen) return null;

                // debug frames for this device (if debug enabled)
                const engineForDevice = enginesRef.current[selectedDeviceId];
                const frames = debugMode && engineForDevice
                  ? [...engineForDevice.getDebugFrames()].sort((a, b) => a.timestamp - b.timestamp)
                  : [];
                const frameIndex = Math.max(0, Math.min(frames.length - 1, debugFrameIndex));
                const chosenFrame = frames.length > 0 ? frames[frameIndex] : null;

                // Check if this device IS a group (not if it belongs to a group)
                const group = groupDevices.find((g) => g.id === chosen.device);
                const contributors = group ? group.memberDeviceIds.map((id) => deviceNames[id] ?? `Device ${id}`) : [];
                const mostRecentSourceId = group ? getMostRecentGroupDevice(group.memberDeviceIds) : null;
                const mostRecentSourceName = mostRecentSourceId ? (deviceNames[mostRecentSourceId] ?? `Device ${mostRecentSourceId}`) : null;

                return (
                  <div className="p-2 rounded border bg-white/90 text-foreground">
                    <div className="flex items-start">
                      <div className="flex-1">
                        {(() => {
                          const displayName = group ? group.name : (deviceNames[chosen.device] ?? chosen.device);
                          return <div className="text-sm font-medium">{displayName}</div>;
                        })()}
                        {group && contributors.length > 0 && (
                          <div className="text-xs text-foreground/60 mt-1">
                            <span className="font-medium">Sources:</span> {contributors.join(", ")}
                            {mostRecentSourceName && <div className="text-foreground/50 text-xs mt-0.5">Latest from: {mostRecentSourceName}</div>}
                            {(chosen as DevicePoint).sourceDeviceId !== undefined && <div className="text-foreground/50 text-xs mt-0.5">Current source: {deviceNames[(chosen as DevicePoint).sourceDeviceId!] ?? `Device ${(chosen as DevicePoint).sourceDeviceId}`}</div>}
                          </div>
                        )}
                        {!group && typeof chosen.device === "number" && (
                          <div className="mt-2 text-xs text-foreground/70">
                            <label className="block text-[11px] uppercase tracking-wide text-foreground/50 mb-1">Motion profile</label>
                            <select
                              className="border rounded px-2 py-1 text-xs bg-white"
                              value={deviceMotionProfiles[chosen.device] ?? "person"}
                              onChange={(e) => handleUpdateMotionProfile(chosen.device, e.target.value === "car" ? "car" : "person")}
                            >
                              <option value="person">Person</option>
                              <option value="car">Car</option>
                            </select>
                          </div>
                        )}
                        <div className="text-xs text-foreground/70">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""} m · {(chosen.confidence >= CONFIDENCE_HIGH_THRESHOLD ? "High" : chosen.confidence >= CONFIDENCE_MEDIUM_THRESHOLD ? "Medium" : "Low")} confidence ({chosen.confidence.toFixed(2)})</div>
                        <div className="text-xs text-foreground/70">At location for: {humanDurationSince(Date.now() - chosen.anchorAgeMs)}</div>
                      </div>
                      <button aria-label="Deselect device" title="Close" className="ml-2 text-sm px-2 py-1 rounded border" onClick={() => setSelectedDeviceId(null)}>×</button>
                    </div>
                    <div className="text-xs text-foreground/70">Last updated: {humanDurationSince(deviceLastSeen[chosen.device] ?? chosen.timestamp)}</div>

                    {debugMode ? (
                      <div className="mt-2 text-xs">
                        <div className="mb-2">Debug frames: {frames.length}</div>
                        {frames.length > 0 ? (
                          <div className="flex gap-2 items-center">
                            <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={debugFrameIndex} onChange={(e) => setDebugFrameIndex(Number(e.target.value))} />
                            <div className="w-20 text-right">#{frameIndex}</div>
                          </div>
                        ) : <div className="text-xs text-foreground/60">No debug frames</div>}

                        {chosenFrame ? (
                          <div className="mt-2 text-xs bg-muted/20 p-2 rounded">
                            <div>Accuracy: {Math.round(chosenFrame.measurement.accuracy)} m</div>
                            <div>Mahalanobis^2: {chosenFrame.mahalanobis2 == null ? '—' : chosenFrame.mahalanobis2.toFixed(2)}</div>
                            <div>Motion active (before): {chosenFrame.motionActiveBefore ? 'yes' : 'no'}</div>
                            <div>Motion active: {chosenFrame.motionActive ? 'yes' : 'no'}</div>
                            {chosenFrame.motionStartTimestamp != null ? <div>Motion start: {new Date(chosenFrame.motionStartTimestamp).toLocaleString()}</div> : null}
                            {chosenFrame.lastAnchorConfirmTimestamp != null ? <div>Last anchor confirm: {new Date(chosenFrame.lastAnchorConfirmTimestamp).toLocaleString()}</div> : null}
                            {chosenFrame.motionDistance != null ? <div>Motion distance: {Math.round(chosenFrame.motionDistance)} m</div> : null}
                            {chosenFrame.motionTimeFactor != null ? <div>Time factor: {chosenFrame.motionTimeFactor.toFixed(2)}</div> : null}
                            {chosenFrame.motionScore != null ? <div>Motion score: {chosenFrame.motionScore.toFixed(2)}</div> : null}
                            {chosenFrame.motionScoreSum != null ? <div>Score sum: {chosenFrame.motionScoreSum.toFixed(2)}</div> : null}
                            {chosenFrame.motionCoherent != null ? <div>Coherent: {chosenFrame.motionCoherent ? 'yes' : 'no'}</div> : null}
                            {chosenFrame.motionSinglePointOverride != null ? <div>Single-point override: {chosenFrame.motionSinglePointOverride ? 'yes' : 'no'}</div> : null}
                            <div>Outliers: {chosenFrame.outlierCount}</div>
                            {chosenFrame.anchorCovarianceScale != null ? <div>Anchor cov inflate: ×{chosenFrame.anchorCovarianceScale.toFixed(2)}</div> : null}
                            <div>Confidence: {chosenFrame.before ? chosenFrame.before.confidence.toFixed(2) : '—'} → {chosenFrame.after ? chosenFrame.after.confidence.toFixed(2) : '—'}</div>
                            <div>Decision: <strong>{chosenFrame.decision}</strong></div>
                            {chosenFrame.sourceDeviceId !== undefined ? <div>Source: <strong>{deviceNames[chosenFrame.sourceDeviceId] ?? `Device ${chosenFrame.sourceDeviceId}`}</strong></div> : null}
                            <div>Anchor start: {(chosenFrame.after?.startTimestamp ?? chosenFrame.before?.startTimestamp) != null ? humanDurationSince((chosenFrame.after?.startTimestamp ?? chosenFrame.before?.startTimestamp) as number) : '—'}</div>
                            <div>Raw lat/lon: {chosenFrame.measurement.lat.toFixed(5)}, {chosenFrame.measurement.lon.toFixed(5)}</div>
                            <div>Anchor lat/lon: {(() => { if (chosenFrame.after?.mean == null) return '—'; const d = metersToDegrees(chosenFrame.after.mean[0], chosenFrame.after.mean[1], refLat ?? 0, refLon ?? 0); return `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`; })()}</div>
                            <div>{new Date(chosenFrame.timestamp).toLocaleString()}</div>
                          </div>
                        ) : null}

                      </div>
                    ) : null}

                  </div>
                );
              })()
            ) : null}
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
