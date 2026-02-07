import { useState, useCallback } from "react";
import { degreesToMeters } from "@/util/geo";
import { Engine } from "@/engine/engine";
import { buildEngineSnapshotsFromByDevice as buildEngineSnapshotsFromByDeviceUtil, dedupeKey, measurementCovFromAccuracy } from "@/util/appUtils";
import type { NormalizedPosition } from "@/api/positions";
import type { DevicePoint } from "@/ui/types";
import type { MotionProfileName } from "@/engine/motionDetector";

type UsePositionProcessingProps = {
  refLat: number | null;
  refLon: number | null;
  enginesRef: React.RefObject<Map<number, Engine>>;
  groupIdsRef: React.RefObject<Set<number>>;
  deviceToGroupsMapRef: React.RefObject<Map<number, number[]>>;
  groupMotionProfiles: Map<number, MotionProfileName>;
  deviceMotionProfiles: Record<number, MotionProfileName>;
  positionsAllRef: React.RefObject<NormalizedPosition[]>;
  processedKeysRef: React.RefObject<Set<string>>;
  firstPositionRef: React.RefObject<{ lat: number; lon: number } | null>;
  groupDevices: Array<{ id: number; name: string; emoji: string; color: string; memberDeviceIds: number[] }>;
};

export function usePositionProcessing({
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
}: UsePositionProcessingProps) {
  const [engineSnapshotsByDevice, setEngineSnapshotsByDevice] = useState<Record<number, DevicePoint[]>>({});


  const buildEngineSnapshotsFromByDevice = useCallback((byDevice: Record<string, DevicePoint[]>): DevicePoint[] => {
    const currentSnapshots = buildEngineSnapshotsFromByDeviceUtil(byDevice, enginesRef, groupIdsRef, groupMotionProfiles, deviceMotionProfiles, refLat, refLon);
    setEngineSnapshotsByDevice(currentSnapshots);
    return Object.values(currentSnapshots).flat();
  }, [enginesRef, groupIdsRef, groupMotionProfiles, deviceMotionProfiles, refLat, refLon]);

  const processPositions = useCallback((positions: NormalizedPosition[]): { lat: number; lon: number } | null => {
    if (!positions || positions.length === 0) return null;

    const newPositions = positions.filter(p => {
      const key = dedupeKey(p);
      if (processedKeysRef.current.has(key)) return false;
      processedKeysRef.current.add(key);
      return true;
    });
    if (newPositions.length === 0) return null;

    positionsAllRef.current.push(...newPositions);

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
        enginesRef.current.delete(groupId);
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

    let firstPosition: { lat: number; lon: number } | null = null;
    if (!firstPositionRef.current && newPositions.length > 0) {
      const first = newPositions[0]!;
      firstPosition = { lat: first.lat, lon: first.lon };
      firstPositionRef.current = firstPosition;
    }

    buildEngineSnapshotsFromByDevice(rawByDevice);

    return firstPosition;
  }, [positionsAllRef, deviceToGroupsMapRef, groupDevices, enginesRef, groupIdsRef, firstPositionRef, refLat, refLon, buildEngineSnapshotsFromByDevice]);

  return {
    engineSnapshotsByDevice,
    processPositions,
    buildEngineSnapshotsFromByDevice,
  };
}