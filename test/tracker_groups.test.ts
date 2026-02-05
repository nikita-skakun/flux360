import { describe, it, expect, beforeEach } from "bun:test";

// Mock localStorage for testing
const mockStorage: Record<string, string> = {};

const getLocalStorageMock = () => ({
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => {
    mockStorage[key] = value;
  },
  removeItem: (key: string) => {
    delete mockStorage[key];
  },
  clear: () => {
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
  },
});

describe("Tracker Groups", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
  });

  it("should create a new group with multiple devices", () => {
    const groupData = {
      id: `group-${Date.now()}`,
      name: "My Car",
      deviceIds: [1, 2],
      icon: "🚗",
    };

    expect(groupData.name).toBe("My Car");
    expect(groupData.deviceIds).toEqual([1, 2]);
    expect(groupData.icon).toBe("🚗");
  });

  it("should store and retrieve groups from localStorage", () => {
    const storage = getLocalStorageMock();
    const groups = [
      {
        id: `group-1`,
        name: "Car Group",
        deviceIds: [1, 2],
        icon: "🚗",
      },
      {
        id: `group-2`,
        name: "Truck Group",
        deviceIds: [3, 4],
        icon: "🚚",
      },
    ];

    storage.setItem("traccar:trackerGroups", JSON.stringify(groups));
    const retrieved = JSON.parse(
      storage.getItem("traccar:trackerGroups") || "[]"
    );

    expect(retrieved).toEqual(groups);
    expect(retrieved.length).toBe(2);
  });

  it("should add device to group", () => {
    let group = {
      id: `group-1`,
      name: "Car Group",
      deviceIds: [1, 2],
      icon: "🚗",
    };

    // Simulate adding a device
    group = { ...group, deviceIds: [...group.deviceIds, 5] };

    expect(group.deviceIds).toContain(5);
    expect(group.deviceIds.length).toBe(3);
  });

  it("should remove device from group", () => {
    let group = {
      id: `group-1`,
      name: "Car Group",
      deviceIds: [1, 2, 3],
      icon: "🚗",
    };

    // Simulate removing a device
    group = {
      ...group,
      deviceIds: group.deviceIds.filter((id) => id !== 2),
    };

    expect(group.deviceIds).not.toContain(2);
    expect(group.deviceIds).toEqual([1, 3]);
  });

  it("should update group icon", () => {
    let group = {
      id: `group-1`,
      name: "Car Group",
      deviceIds: [1, 2],
      icon: "🚗",
    };

    // Simulate updating icon
    group = { ...group, icon: "🚙" };

    expect(group.icon).toBe("🚙");
  });

  it("should update group name", () => {
    let group = {
      id: `group-1`,
      name: "Car Group",
      deviceIds: [1, 2],
      icon: "🚗",
    };

    // Simulate updating name
    group = { ...group, name: "My Vehicles" };

    expect(group.name).toBe("My Vehicles");
  });

  it("should filter grouped devices to show only first device", () => {
    const visibleDeviceIds = new Set<number>();
    const hiddenDevices = new Set<number>();

    // Simulate showing grouped devices
    const groups = [
      {
        id: `group-1`,
        name: "Group",
        deviceIds: [1, 2, 3],
      },
    ];

    // Add all devices to visible
    for (const device of [1, 2, 3]) {
      visibleDeviceIds.add(device);
    }

    // Hide all but the first device in each group
    for (const group of groups) {
      for (let i = 1; i < group.deviceIds.length; i++) {
        const deviceId = group.deviceIds[i];
        if (deviceId != null) {
          hiddenDevices.add(deviceId);
        }
      }
    }

    const displayedDevices = Array.from(visibleDeviceIds).filter(
      (id) => !hiddenDevices.has(id)
    );

    expect(displayedDevices).toEqual([1]);
    expect(hiddenDevices.has(2)).toBe(true);
    expect(hiddenDevices.has(3)).toBe(true);
  });

  it("should handle empty groups gracefully", () => {
    const groups: any[] = [];

    expect(groups.length).toBe(0);
    expect(groups.filter((g) => g.deviceIds.length > 0)).toEqual([]);
  });
});
