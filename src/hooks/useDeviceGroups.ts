import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import type { MotionProfileName } from "@/types";

type GroupDevice = { id: number; name: string; emoji: string; color: string; memberDeviceIds: number[] };

type ApiOpts = { baseUrl: string; secure: boolean; auth: { type: "token"; token: string } | { type: "none" } };

export function useDeviceGroups(deviceMotionProfiles: Record<number, MotionProfileName>, buildApiOpts: () => ApiOpts) {
  const [groupDevices, setGroupDevices] = useState<GroupDevice[]>([]);

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
  }, [groupDevices]);

  const handleCreateGroup = useCallback(async (name: string, memberDeviceIds: number[], emoji: string) => {
    try {
      const devices = await import("@/api/devices");
      const { createGroupDevice } = devices;
      const { colorForDevice } = await import("@/util/color");

      const newGroup = await createGroupDevice(buildApiOpts(), name, emoji, memberDeviceIds);
      const colorRgb = colorForDevice(newGroup.id);
      const color = `#${colorRgb[0].toString(16).padStart(2, "0")}${colorRgb[1].toString(16).padStart(2, "0")}${colorRgb[2].toString(16).padStart(2, "0")}`;

      const newGroupObj = { id: newGroup.id, name: newGroup.name, emoji, color, memberDeviceIds };

      setGroupDevices(prevGroups => {
        const filtered = prevGroups.filter(g => g.id !== newGroup.id);
        return [...filtered, newGroupObj];
      });
    } catch (error) {
      console.error("Failed to create group:", error);
      throw error;
    }
  }, [buildApiOpts]);

  const handleDeleteGroup = useCallback(async (groupId: number) => {
    try {
      const devices = await import("@/api/devices");
      const { deleteGroupDevice } = devices;
      await deleteGroupDevice(buildApiOpts(), groupId);

      setGroupDevices(prevGroups => prevGroups.filter((g) => g.id !== groupId));
    } catch (error) {
      console.error("Failed to delete group:", error);
      throw error;
    }
  }, [buildApiOpts]);

  const handleAddDeviceToGroup = useCallback(async (groupId: number, deviceId: number) => {
    try {
      const devices = await import("@/api/devices");
      const { updateGroupDevice } = devices;
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
      const devices = await import("@/api/devices");
      const { updateGroupDevice } = devices;
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

  const handleUpdateGroup = useCallback(async (groupId: number, updates: { name?: string }) => {
    try {
      const devices = await import("@/api/devices");
      const { updateGroupDevice } = devices;
      await updateGroupDevice(buildApiOpts(), groupId, updates);

      setGroupDevices(prevGroups => prevGroups.map((g) =>
        g.id === groupId ? { ...g, name: updates.name ?? g.name } : g
      ));
    } catch (error) {
      console.error("Failed to update group:", error);
      throw error;
    }
  }, [buildApiOpts]);

  return {
    groupDevices,
    groupMotionProfiles,
    deviceToGroupsMap: deviceToGroupsMapRef.current,
    groupIds: groupIdsRef.current,
    handleCreateGroup,
    handleDeleteGroup,
    handleAddDeviceToGroup,
    handleRemoveDeviceFromGroup,
    handleUpdateGroup,
  };
}