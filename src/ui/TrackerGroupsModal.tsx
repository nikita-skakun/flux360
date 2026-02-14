import React, { useState } from "react";

export type GroupDevice = {
  id: number;
  name: string;
  emoji: string;
  color: string;
  memberDeviceIds: number[];
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  groupDevices: GroupDevice[];
  allDevices: Array<{ id: number; name: string }>;
  onCreateGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  onDeleteGroup: (groupId: number) => Promise<void>;
  onAddDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  onRemoveDeviceFromGroup: (groupId: number, deviceId: number) => Promise<void>;
  onUpdateGroup: (groupId: number, updates: { name?: string }) => Promise<void>;
};

const TrackerGroupsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  groupDevices,
  allDevices,
  onCreateGroup,
  onDeleteGroup,
  onAddDeviceToGroup,
  onRemoveDeviceFromGroup,
  onUpdateGroup,
}) => {
  if (!isOpen) return null;

  const [newGroupName, setNewGroupName] = useState("");
  const [selectedDevices, setSelectedDevices] = useState<number[]>([]);
  const [selectedEmoji, setSelectedEmoji] = useState("group");
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleCreateGroup = async () => {
    if (newGroupName.trim() && selectedDevices.length > 0) {
      setIsLoading(true);
      try {
        await onCreateGroup(newGroupName, selectedDevices, selectedEmoji);
        setNewGroupName("");
        setSelectedDevices([]);
        setSelectedEmoji("group");
      } catch (error) {
        console.error("Failed to create group:", error);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const startEditingGroup = (group: GroupDevice) => {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const saveGroupEdit = async (groupId: number) => {
    if (editingGroupName.trim()) {
      setIsLoading(true);
      try {
        await onUpdateGroup(groupId, {
          name: editingGroupName,
        });
      } catch (error) {
        console.error("Failed to update group:", error);
      } finally {
        setIsLoading(false);
        setEditingGroupId(null);
        setEditingGroupName("");
      }
    }
  };

  const groupIds = new Set(groupDevices.map((g) => g.id));
  const memberDeviceIds = new Set(groupDevices.flatMap((g) => g.memberDeviceIds));
  // Filter out:
  // 1. Member devices (already in groups)
  // 2. Current group devices
  // 3. Devices with no name/info (deleted or stale)
  const ungroupedDevices = allDevices.filter((d) =>
    !memberDeviceIds.has(d.id) &&
    !groupIds.has(d.id) &&
    d.name && d.name.trim().length > 0 // Only include if we have a name
  );

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        className="relative bg-background rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 border-b shrink-0">
          <h2 className="text-xl font-bold">Tracker Groups</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-6">

          {/* Existing Groups */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold mb-4">Existing Groups</h3>
            {groupDevices.length === 0 ? (
              <p className="text-muted-foreground">No groups created yet</p>
            ) : (
              <div className="space-y-4">
                {groupDevices.map((group) => (
                  <div key={group.id} className="border rounded-lg p-4 bg-muted/30">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3 flex-1">
                        <span className="material-symbols-outlined text-2xl w-12 text-center" style={{ color: group.color }}>{group.emoji}</span>
                        {editingGroupId === group.id ? (
                          <input
                            type="text"
                            value={editingGroupName}
                            onChange={(e) => setEditingGroupName(e.target.value)}
                            onBlur={() => {
                              if (editingGroupName.trim()) {
                                void saveGroupEdit(group.id);
                              } else {
                                setEditingGroupId(null);
                              }
                            }}
                            autoFocus
                            className="border rounded px-2 py-1 text-sm flex-1 bg-background text-foreground"
                            disabled={isLoading}
                          />
                        ) : (
                          <h4
                            className="font-semibold cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                            onClick={() => startEditingGroup(group)}
                          >
                            {group.name}
                          </h4>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          void (async () => {
                            setIsLoading(true);
                            try {
                              await onDeleteGroup(group.id);
                            } catch (error) {
                              console.error("Failed to delete group:", error);
                            } finally {
                              setIsLoading(false);
                            }
                          })();
                        }}
                        className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-sm px-2 py-1 rounded border border-red-200 dark:border-red-800 disabled:opacity-50"
                        disabled={isLoading}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {group.memberDeviceIds.map((deviceId) => {
                        const device = allDevices.find((d) => d.id === deviceId);
                        return (
                          <span
                            key={deviceId}
                            className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-3 py-1 rounded-full text-sm flex items-center gap-2"
                          >
                            {device?.name ?? `Device ${deviceId}`}
                            <button
                              onClick={() => {
                                void (async () => {
                                  setIsLoading(true);
                                  try {
                                    await onRemoveDeviceFromGroup(group.id, deviceId);
                                  } catch (error) {
                                    console.error("Failed to remove device from group:", error);
                                  } finally {
                                    setIsLoading(false);
                                  }
                                })();
                              }}
                              className="hover:text-blue-900 dark:hover:text-blue-100 disabled:opacity-50"
                              disabled={isLoading}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                    {ungroupedDevices.length > 0 && (
                      <div className="mt-3">
                        <select
                          onChange={(e) => {
                            const deviceId = Number(e.target.value);
                            if (deviceId) {
                              void (async () => {
                                setIsLoading(true);
                                try {
                                  await onAddDeviceToGroup(group.id, deviceId);
                                  e.target.value = "";
                                } catch (error) {
                                  console.error("Failed to add device to group:", error);
                                } finally {
                                  setIsLoading(false);
                                }
                              })();
                            }
                          }}
                          className="border rounded px-2 py-1 text-sm disabled:opacity-50 bg-background text-foreground"
                          disabled={isLoading}
                        >
                          <option value="">Add device...</option>
                          {ungroupedDevices.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name || `Device ${d.id}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Create New Group */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-semibold mb-4">Create New Group</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Group Name
                </label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="e.g., My Fleet"
                  className="w-full border rounded px-3 py-2 disabled:opacity-50 bg-background text-foreground"
                  disabled={isLoading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Icon
                </label>
                <div className="flex gap-2 flex-wrap">
                  {["group", "groups", "people", "directions_car", "personal_bag", "luggage", "directions_bike", "devices"].map((icon) => (
                    <button
                      key={icon}
                      onClick={() => setSelectedEmoji(icon)}
                      className={`p-2 rounded border-2 transition-all ${selectedEmoji === icon
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                        : "border-border hover:border-muted-foreground"
                        }`}
                      disabled={isLoading}
                    >
                      <span className="material-symbols-outlined text-2xl">{icon}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Devices ({selectedDevices.length} selected)
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto border rounded p-3 bg-muted/30">
                  {ungroupedDevices.map((device) => (
                    <label key={device.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedDevices.includes(device.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDevices([
                              ...selectedDevices,
                              device.id,
                            ]);
                          } else {
                            setSelectedDevices(
                              selectedDevices.filter((id) => id !== device.id)
                            );
                          }
                        }}
                        disabled={isLoading}
                      />
                      <span>{device.name || `Device ${device.id}`}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleCreateGroup()}
                  disabled={!newGroupName.trim() || selectedDevices.length === 0 || isLoading}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Creating..." : "Create Group"}
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-2 border rounded hover:bg-muted disabled:opacity-50"
                  disabled={isLoading}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TrackerGroupsModal;
