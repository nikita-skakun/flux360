import React, { useState, useMemo, useEffect, useRef } from "react";
import { EMOJI_OPTIONS } from "./constants";
import { colorForDevice } from "./color";

type Device = {
  id: number | string;
  isGroup?: boolean;
  name: string;
  emoji: string;
  lastSeen: number | null;
  hasPosition: boolean;
  memberDeviceIds?: number[];
  color?: string | null;
};

const formatLastSeen = (ts: number | null): string => {
  if (!ts) return "Never";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 5) return "Just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

const DeviceListSidePanel: React.FC<{
  devices: Device[];
  selectedDeviceId: number | string | null;
  onSelectDevice: (id: number | string) => void;
  isOpen: boolean;
  onToggle: () => void;
  onCreateGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  onDeleteGroup: (groupId: number) => Promise<void>;
  onAddDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  onEditGroup: (groupId: number) => void;
  onCreateGroupSelectionChange?: (selectedIds: number[]) => void;
  allDevices: Array<{ id: number; name: string; emoji: string }>;
}> = ({
  devices,
  selectedDeviceId,
  onSelectDevice,
  isOpen,
  onToggle,
  onCreateGroup,
  onDeleteGroup,
  onAddDeviceToGroup,
  onEditGroup,
  onCreateGroupSelectionChange,
  allDevices
}) => {
    const [expanded, setExpanded] = useState<Set<number | string>>(new Set());
    const [mode, setMode] = useState<"list" | "create">("list");

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ groupId: number; x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    // Create Group State
    const [newGroupName, setNewGroupName] = useState("");
    const [selectedEmoji, setSelectedEmoji] = useState("group");
    const [selectedCreateDevices, setSelectedCreateDevices] = useState<number[]>([]);
    const [showAllIcons, setShowAllIcons] = useState(false);
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
      onCreateGroupSelectionChange?.(selectedCreateDevices);
    }, [selectedCreateDevices, onCreateGroupSelectionChange]);

    useEffect(() => { if (!isOpen) setExpanded(new Set()); }, [isOpen]);
    useEffect(() => { if (!isOpen || mode === 'list') setShowAllIcons(false); }, [isOpen, mode]);

    // Close context menu on outside click
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
          setContextMenu(null);
        }
      };
      if (contextMenu) {
        document.addEventListener("mousedown", handleClickOutside);
      }
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }, [contextMenu]);

    const { topLevel, memberMap, sort } = useMemo(() => {
      const memberIds = new Set<number>();
      const map = new Map<number | string, Device>();
      devices.forEach(d => {
        map.set(d.id, d);
        d.memberDeviceIds?.forEach(id => memberIds.add(id));
      });
      const top = devices.filter(d => !(typeof d.id === "number" && memberIds.has(d.id)));

      // Sort logic
      const sort = (list: Device[]) => [...list].sort((a, b) => {
        const aOn = a.lastSeen ? Date.now() - a.lastSeen < 300000 : false;
        const bOn = b.lastSeen ? Date.now() - b.lastSeen < 300000 : false;
        if (aOn !== bOn) return aOn ? -1 : 1;
        return (a.name || `Device ${a.id}`).localeCompare(b.name || `Device ${b.id}`);
      });

      return { topLevel: sort(top), memberMap: map, sort };
    }, [devices]);

    const toggle = (e: React.MouseEvent, id: number | string) => {
      e.stopPropagation();
      setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    const handleCreateSubmit = () => {
      void (async () => {
        if (!newGroupName.trim() || selectedCreateDevices.length === 0) return;
        setIsCreating(true);
        try {
          await onCreateGroup(newGroupName, selectedCreateDevices, selectedEmoji);
          setMode("list");
          setNewGroupName("");
          setSelectedCreateDevices([]);
          setSelectedEmoji("group");
        } finally {
          setIsCreating(false);
        }
      })();
    };

    const handleContextMenu = (e: React.MouseEvent, groupId: number) => {
      e.preventDefault();
      e.stopPropagation();
      // Position menu near cursor but ensure it fits on screen
      const x = Math.min(e.clientX, window.innerWidth - 200);
      const y = Math.min(e.clientY, window.innerHeight - 200);
      setContextMenu({ groupId, x, y });
    };

    const renderItem = (device: Device, depth: number = 0, isLast = false, isFirst = false) => {
      const colorId = typeof device.id === "string" ? device.id.split("-").pop()?.charCodeAt(0) ?? 0 : Number(device.id);
      const [r, g, b] = colorForDevice(colorId);
      const defaultColor = `rgb(${r}, ${g}, ${b})`;
      const colorStr = device.color ?? defaultColor;
      const displayName = device.name || `Device ${device.id}`;
      const children = (device.isGroup ? device.memberDeviceIds ?? [] : [])
        .map(id => memberMap.get(id)).filter((d): d is Device => !!d);

      const sortedChildren = sort(children);
      const isGroup = !!device.isGroup;

      return (
        <React.Fragment key={`${isGroup ? "g" : "d"}-${device.id}`}>
          <li onContextMenu={(e) => {
            if (isGroup && typeof device.id === 'number') {
              handleContextMenu(e, device.id);
            }
          }}>
            <div
              className={`w-full p-3 flex items-start gap-3 transition-colors relative cursor-pointer ${selectedDeviceId === device.id ? "bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500" : "hover:bg-muted/50 border-l-4 border-transparent"
                } group`}
              style={{ paddingLeft: `${12 + depth * 32}px` }}
              onClick={() => onSelectDevice(device.id)}
            >
              {depth > 0 && (
                <div className="absolute text-border pointer-events-none" style={{ left: `${depth * 32}px`, top: 0, bottom: 0, width: "16px" }}>
                  <div className="absolute left-0 w-px bg-border dark:bg-white/30" style={{ top: isFirst ? "-13px" : "0px", bottom: "50%" }} />
                  {!isLast && <div className="absolute top-1/2 bottom-0 left-0 w-px bg-border dark:bg-white/30" />}
                  <div className="absolute top-1/2 left-0 right-0 h-px bg-border dark:bg-white/30" />
                  <div className="absolute top-1/2 right-0 w-1.5 h-1.5 bg-border dark:bg-white/30 rounded-full transform -translate-y-1/2 translate-x-1/2" />
                </div>
              )}

              <div className="w-10 h-10 relative flex-shrink-0" onClick={(e) => isGroup && toggle(e, device.id)}>
                <div className={`w-10 h-10 rounded-full bg-background border-2 flex items-center justify-center ${isGroup ? "cursor-pointer hover:bg-muted" : ""}`} style={{ borderColor: colorStr }}>
                  {device.emoji?.length > 1 ? (
                    <span className="material-symbols-outlined text-lg select-none" style={{ color: colorStr }}>{device.emoji}</span>
                  ) : (
                    <span style={{ color: colorStr, fontSize: "16px", fontWeight: "600" }} className="select-none">{device.emoji || displayName}</span>
                  )}
                </div>
                {sortedChildren.length > 0 && (
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-background rounded-full border border-border shadow-sm flex items-center justify-center z-10">
                    <span className="material-symbols-outlined text-xs text-muted-foreground select-none">{expanded.has(device.id) ? "expand_less" : "expand_more"}</span>
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 h-6">
                  <span
                    className="font-medium text-foreground truncate block group-hover:text-blue-700 dark:group-hover:text-blue-400"
                    title={displayName}
                  >
                    {displayName}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Last seen: {formatLastSeen(device.lastSeen)}</div>
              </div>
            </div>
          </li>
          {expanded.has(device.id) && sortedChildren.map((c, i) => renderItem(c, depth + 1, i === sortedChildren.length - 1, i === 0))}
        </React.Fragment>
      );
    };

    return (
      <>
        <button
          onClick={() => mode === "create" ? setMode("list") : onToggle()}
          className="fixed top-4 left-4 z-[1002] px-3 py-2 rounded-lg shadow-md bg-background text-foreground hover:bg-muted transition-all"
          title={mode === "create" ? "Back to list" : (isOpen ? "Close" : "Open")}
        >
          <span className="material-symbols-outlined text-xl select-none">
            {mode === "create" ? "arrow_back" : (isOpen ? "chevron_left" : "devices")}
          </span>
        </button>

        <div className={`fixed top-0 left-0 h-full bg-background shadow-xl z-[1001] transition-all duration-300 ease-in-out ${isOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none"}`} style={{ width: "280px" }}>

          {/* Header */}
          <div className="p-4 border-b border-border bg-muted/30 flex items-center justify-between pl-20 h-[73px]">
            {mode === "list" ? (
              <>
                <div><h2 className="text-lg font-semibold text-foreground">Devices</h2><p className="text-sm text-muted-foreground">{devices.length} total</p></div>
                <button
                  onClick={() => setMode("create")}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-background border border-border shadow-sm hover:bg-muted text-blue-600 transition-all"
                  title="Create Group"
                >
                  <span className="material-symbols-outlined text-lg">add</span>
                </button>
              </>
            ) : (
              <div className="flex items-center justify-between w-full">
                <div><h2 className="text-lg font-semibold text-foreground">Create Group</h2><p className="text-sm text-transparent select-none">Spacer</p></div>
              </div>
            )}
          </div>

          {/* Content */}
          <div className="h-[calc(100%-73px)]">
            {mode === "list" ? (
              <div className="overflow-y-auto h-full p-0">
                {devices.length === 0 ? <div className="p-4 text-center text-muted-foreground text-sm">No devices found</div> : (
                  <ul className="divide-y divide-border dark:divide-white/10 text-sm pb-20">
                    {topLevel.map(d => renderItem(d))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="flex flex-col h-full bg-background">
                <div className="p-4 space-y-4 flex-shrink-0">
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Group Name</label>
                    <input
                      type="text"
                      placeholder="e.g., My Fleet"
                      className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:outline-none bg-background text-foreground border-border"
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 text-center">Icon</label>
                    <div className="grid grid-cols-4 gap-2 pb-2">
                      {(showAllIcons ? EMOJI_OPTIONS : EMOJI_OPTIONS.slice(0, 7)).map(icon => (
                        <button
                          key={icon}
                          onClick={() => setSelectedEmoji(icon)}
                          className={`aspect-square flex items-center justify-center rounded-lg hover:bg-muted/50 transition-all ${selectedEmoji === icon
                            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-background'
                            : 'text-muted-foreground bg-muted/30'
                            }`}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-3xl">{icon}</span>
                        </button>
                      ))}
                      {!showAllIcons && (
                        <button
                          onClick={() => setShowAllIcons(true)}
                          className="aspect-square flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground bg-muted/30 transition-all"
                          type="button"
                        >
                          <span className="material-symbols-outlined text-3xl">more_horiz</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 min-h-0">
                  <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 sticky top-0 bg-background z-10 py-1">Select Devices ({selectedCreateDevices.length})</label>
                  <div className="border rounded divide-y bg-muted/10 border-border">
                    {allDevices.length === 0 ? (
                      <div className="p-3 text-center text-muted-foreground text-sm">No devices available</div>
                    ) : (
                      allDevices.map(d => (
                        <label key={d.id} className="flex items-center gap-3 p-3 hover:bg-muted/30 cursor-pointer transition-colors">
                          <input
                            type="checkbox"
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                            checked={selectedCreateDevices.includes(d.id)}
                            onChange={e => {
                              if (e.target.checked) setSelectedCreateDevices(prev => [...prev, d.id]);
                              else setSelectedCreateDevices(prev => prev.filter(id => id !== d.id));
                            }}
                          />
                          <span className="text-sm font-medium text-foreground">{d.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                <div className="p-4 border-t mt-auto flex-shrink-0 bg-background border-border">
                  <button
                    className="w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    disabled={!newGroupName.trim() || selectedCreateDevices.length === 0 || isCreating}
                    onClick={handleCreateSubmit}
                  >
                    {isCreating ? "Creating..." : "Create Group"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {isOpen && mode === "create" && (
          /* Overlay for create mode on mobile */
          <div className="fixed inset-0 bg-black/20 z-[1000] lg:hidden" onClick={() => setMode("list")} />
        )}

        {/* Context Menu */}
        {contextMenu && (
          <>
            <div className="fixed inset-0 z-[1999]" onClick={() => setContextMenu(null)} />
            <div
              ref={contextMenuRef}
              className="fixed bg-background rounded-lg shadow-xl border border-border py-1 z-[2000] min-w-[180px] animate-in fade-in zoom-in-95 duration-100"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={e => e.stopPropagation()}
            >
              <button
                className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-muted/50 flex items-center gap-2"
                onClick={() => {
                  onEditGroup(contextMenu.groupId);
                  setContextMenu(null);
                }}
              >
                <span className="material-symbols-outlined text-lg text-muted-foreground">settings</span>
                Settings
              </button>

              <div className="relative group/add">
                <button
                  className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-muted/50 flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-lg text-muted-foreground">person_add</span>
                    Add Device
                  </div>
                  <span className="material-symbols-outlined text-lg text-muted-foreground">chevron_right</span>
                </button>

                {/* Submenu */}
                <div className="absolute left-full top-0 ml-1 bg-background rounded-lg shadow-xl border border-border py-1 hidden group-hover/add:block min-w-[200px] max-h-[300px] overflow-y-auto">
                  {(() => {
                    const groupDevice = devices.find(d => d.id === contextMenu.groupId);
                    const memberIds = new Set(groupDevice?.memberDeviceIds ?? []);
                    const availableDevices = allDevices.filter(d => !memberIds.has(d.id));

                    if (availableDevices.length === 0) {
                      return <div className="px-4 py-2 text-xs text-muted-foreground italic">No devices available</div>;
                    }

                    return availableDevices.map(d => (
                      <button
                        key={d.id}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-muted/50 truncate flex items-center gap-2 text-foreground"
                        onClick={() => {
                          void onAddDeviceToGroup(contextMenu.groupId, d.id).then(() => {
                            setContextMenu(null);
                          });
                        }}
                      >
                        <span className="w-6 inline-flex items-center justify-center flex-shrink-0">
                          {d.emoji?.length > 1 ? (
                            <span className="material-symbols-outlined text-lg text-muted-foreground select-none">{d.emoji}</span>
                          ) : (
                            <span className="text-muted-foreground select-none" style={{ fontSize: "16px", fontWeight: "600" }}>{d.emoji || d.name?.charAt(0)}</span>
                          )}
                        </span>
                        {d.name}
                      </button>
                    ));
                  })()}
                </div>
              </div>

              <div className="h-px bg-border dark:bg-white/10 my-1" />
              <button
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
                onClick={() => {
                  const groupName = devices.find(d => d.id === contextMenu.groupId)?.name;
                  if (window.confirm(`Delete group "${groupName}"?`)) {
                    void onDeleteGroup(contextMenu.groupId).then(() => {
                      setContextMenu(null);
                    });
                  }
                }}
              >
                <span className="material-symbols-outlined text-lg">delete</span>
                Delete Group
              </button>
            </div>
          </>
        )}
      </>
    );
  };

export default DeviceListSidePanel;
