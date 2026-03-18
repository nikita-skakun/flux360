import { ArrowLeft, ChevronLeft, ChevronUp, ChevronDown, Smartphone, Plus, Settings, UserPlus, ChevronRight, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { colorForDevice } from "@/util/color";
import { EMOJI_OPTIONS } from "@/util/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useTimeAgo } from "@/util/time";
import React, { useState, useMemo, useEffect, useRef } from "react";
import type { AppDevice } from "@/types";

const ICON_CHEVRON_UP = <ChevronUp className="h-3 w-3 text-muted-foreground" />;
const ICON_CHEVRON_DOWN = <ChevronDown className="h-3 w-3 text-muted-foreground" />;
const ICON_ARROW_LEFT = <ArrowLeft className="h-5 w-5" />;
const ICON_CHEVRON_LEFT = <ChevronLeft className="h-5 w-5" />;
const ICON_SMARTPHONE = <Smartphone className="h-5 w-5" />;
const ICON_PLUS = <Plus className="h-4 w-4" />;
const ICON_MORE_HORIZONTAL = <MoreHorizontal className="h-6 w-6" />;
const ICON_SETTINGS = <Settings className="h-4 w-4 mr-2 text-muted-foreground" />;
const ICON_USER_PLUS = <UserPlus className="h-4 w-4 text-muted-foreground" />;
const ICON_CHEVRON_RIGHT = <ChevronRight className="h-4 w-4 text-muted-foreground" />;
const ICON_TRASH2 = <Trash2 className="h-4 w-4 mr-2" />;

const LastSeenDisplay: React.FC<{ timestamp: number | null; enabled: boolean }> = ({ timestamp, enabled }) => {
  const timeAgo = timestamp !== null ? useTimeAgo(timestamp, true, enabled) : "Never";
  return <>{timeAgo}</>;
};

export const DeviceListSidePanel: React.FC<{
  entities: Record<number, AppDevice>;
  rootIds: number[];
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  isOpen: boolean;
  onToggle: () => void;
  onCreateGroup: (name: string, memberDeviceIds: number[], emoji: string) => Promise<void>;
  onDeleteGroup: (groupId: number) => Promise<void>;
  onAddDeviceToGroup: (groupId: number, deviceId: number) => Promise<void>;
  onEditGroup: (groupId: number) => void;
  onCreateGroupSelectionChange: (selectedIds: number[]) => void;
  allDevices: Array<{ id: number; name: string; emoji: string }>;
}> = ({
  entities,
  rootIds,
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
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
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

    const setDeviceSelection = (id: number, selected: boolean) => {
      setSelectedCreateDevices(prev => {
        if (selected) {
          return prev.includes(id) ? prev : [...prev, id];
        }
        return prev.filter(i => i !== id);
      });
    };

    useEffect(() => {
      onCreateGroupSelectionChange?.(selectedCreateDevices);
    }, [selectedCreateDevices, onCreateGroupSelectionChange]);

    useEffect(() => {
      if (!isOpen) {
        setExpanded(new Set());
        setMode("list");
        setContextMenu(null);
        setShowAllIcons(false);
        return;
      }

      if (mode === "list") {
        setShowAllIcons(false);
      }
    }, [isOpen, mode]);

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

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const isRecent = (d: AppDevice) => d.lastSeen !== null && now - d.lastSeen < THIRTY_DAYS_MS;
    const sortDevices = (list: AppDevice[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

    const topLevel = useMemo(() => {
      if (!isOpen) return [];
      const top = rootIds
        .map(id => entities[id])
        .filter((e): e is AppDevice => !!e && isRecent(e));
      return sortDevices(top);
    }, [isOpen, rootIds, entities]);

    const toggle = (e: React.MouseEvent, id: number) => {
      e.stopPropagation();
      setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    const handleCreateSubmit = async () => {
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
    };

    const handleContextMenu = (e: React.MouseEvent, groupId: number) => {
      e.preventDefault();
      e.stopPropagation();
      // Position menu near cursor but ensure it fits on screen
      const x = Math.min(e.clientX, window.innerWidth - 200);
      const y = Math.min(e.clientY, window.innerHeight - 200);
      setContextMenu({ groupId, x, y });
    };

    const renderItem = (device: AppDevice, depth: number = 0, isLast = false, isFirst = false) => {
      const [r, g, b] = colorForDevice(device.id);
      const defaultColor = `rgb(${r}, ${g}, ${b})`;
      const colorStr = device.color ?? defaultColor;
      const displayName = device.name;
      const children = (device.memberDeviceIds ?? [])
        .map(id => entities[id])
        .filter((d: AppDevice | undefined): d is AppDevice => !!d && isRecent(d));

      const sortedChildren = sortDevices(children);

      return (
        <React.Fragment key={`${device.memberDeviceIds !== null ? "g" : "d"}-${device.id}`}>
          <li onContextMenu={(e) => {
            if (device.memberDeviceIds !== null && device.isOwner) {
              handleContextMenu(e, device.id);
            }
          }}>
            <div
              className={`w-full p-3 flex items-start gap-3 transition-colors relative cursor-pointer ${selectedDeviceId === device.id ? "bg-primary/10 border-l-4 border-primary" : "hover:bg-muted/50 border-l-4 border-transparent"
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

              <div className="w-10 h-10 relative flex-shrink-0" onClick={(e) => device.memberDeviceIds !== null && toggle(e, device.id)}>
                <div className={`w-10 h-10 rounded-full bg-background border-2 flex items-center justify-center ${device.memberDeviceIds !== null ? "cursor-pointer hover:bg-muted" : ""}`} style={{ borderColor: colorStr }}>
                  {device.emoji?.length > 1 ? (
                    <span className="material-symbols-outlined text-lg select-none" style={{ color: colorStr }}>{device.emoji}</span>
                  ) : (
                    <span style={{ color: colorStr, fontSize: "16px", fontWeight: "600" }} className="select-none">{device.emoji || displayName}</span>
                  )}
                </div>
                {sortedChildren.length > 0 && (
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-background rounded-full border border-border shadow-sm flex items-center justify-center z-10">
                    {expanded.has(device.id) ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 h-6">
                  <span
                    className="font-medium text-foreground truncate block group-hover:text-primary"
                    title={displayName}
                  >
                    {displayName}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Last seen: <LastSeenDisplay timestamp={device.lastSeen} enabled={isOpen} /></div>
              </div>
            </div>
          </li>
          {expanded.has(device.id) && sortedChildren.map((c: AppDevice, i: number) => renderItem(c, depth + 1, i === sortedChildren.length - 1, i === 0))}
        </React.Fragment>
      );
    };

    const toggleButton = (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => mode === "create" ? setMode("list") : onToggle()}
        className="fixed top-4 left-4 z-[1002] shadow-md"
        title={mode === "create" ? "Back to list" : (isOpen ? "Close" : "Open")}
      >
        {mode === "create" ? ICON_ARROW_LEFT : (isOpen ? ICON_CHEVRON_LEFT : ICON_SMARTPHONE)}
      </Button>
    );

    if (!isOpen) {
      return toggleButton;
    }

    return (
      <>
        {toggleButton}

        <div className="fixed top-0 left-0 h-full w-[280px] bg-background shadow-xl z-[1001] transition-all duration-300 ease-in-out translate-x-0 pointer-events-auto">

          {/* Header */}
          <div className="p-4 border-b border-border bg-muted/30 flex items-center justify-between pl-20 h-[73px]">
            {mode === "list" ? (
              <>
                <div><h2 className="text-lg font-semibold text-foreground">Devices</h2><p className="text-sm text-muted-foreground">{Object.keys(entities).length} total</p></div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setMode("create")}
                  className="h-8 w-8 rounded-full"
                  title="Create Group"
                >
                  {ICON_PLUS}
                </Button>
              </>
            ) : (
              <div className="flex items-center w-full">
                <h2 className="text-lg font-semibold text-foreground">Create Group</h2>
              </div>
            )}
          </div>

          {/* Content */}
          <div className="h-[calc(100%-73px)]">
            {mode === "list" ? (
              <div className="overflow-y-auto h-full p-0">
                {topLevel.length === 0 ? <div className="p-4 text-center text-muted-foreground text-sm">No devices found</div> : (
                  <ul className="divide-y divide-border dark:divide-white/10 text-sm pb-20">
                    {topLevel.map(d => renderItem(d))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="flex flex-col h-full bg-background transition-colors duration-300">
                <div className="p-4 space-y-4 flex-shrink-0">
                  <div>
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Group Name</Label>
                    <Input
                      type="text"
                      placeholder="e.g., My Fleet"
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      className="mt-2"
                      autoFocus
                    />
                  </div>

                  <div>
                    <Label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 text-center">Icon</Label>
                    <div className="grid grid-cols-4 gap-2 pb-2">
                      {(showAllIcons ? EMOJI_OPTIONS : EMOJI_OPTIONS.slice(0, 7)).map((icon: string) => (
                        <Button
                          key={icon}
                          variant={selectedEmoji === icon ? "default" : "ghost"}
                          size="icon"
                          onClick={() => setSelectedEmoji(icon)}
                          className="aspect-square h-auto w-auto"
                          type="button"
                        >
                          <span className="material-symbols-outlined text-2xl">{icon}</span>
                        </Button>
                      ))}
                      {!showAllIcons && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setShowAllIcons(true)}
                          className="aspect-square h-auto w-auto"
                          type="button"
                        >
                          {ICON_MORE_HORIZONTAL}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 min-h-0">
                  <Label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 sticky top-0 z-10 py-1">Select Devices ({selectedCreateDevices.length})</Label>
                  <div className="border rounded divide-y bg-muted/10 border-border">
                    {allDevices.length === 0 ? (
                      <div className="p-3 text-center text-muted-foreground text-sm">No devices available</div>
                    ) : (
                      allDevices.map(d => (
                        <div
                          key={d.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => setDeviceSelection(d.id, !selectedCreateDevices.includes(d.id))}
                        >
                          <Checkbox
                            checked={selectedCreateDevices.includes(d.id)}
                            onCheckedChange={(checked) => setDeviceSelection(d.id, Boolean(checked))}
                          />
                          <Label className="text-sm font-medium text-foreground cursor-pointer flex-1">
                            {d.name}
                          </Label>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="p-4 border-t mt-auto flex-shrink-0 bg-background border-border transition-colors duration-300">
                  <Button
                    className="w-full"
                    disabled={!newGroupName.trim() || selectedCreateDevices.length === 0 || isCreating}
                    onClick={() => void handleCreateSubmit()}
                  >
                    {isCreating ? "Creating..." : "Create Group"}
                  </Button>
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
              <Button
                variant="ghost"
                className="w-full justify-start px-4 py-2 text-sm"
                onClick={() => {
                  onEditGroup(contextMenu.groupId);
                  setContextMenu(null);
                }}
              >
                {ICON_SETTINGS}
                Settings
              </Button>

              <div className="relative group/add">
                <Button
                  variant="ghost"
                  className="w-full justify-between px-4 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    {ICON_USER_PLUS}
                    Add Device
                  </div>
                  {ICON_CHEVRON_RIGHT}
                </Button>

                {/* Submenu */}
                <div className="absolute left-full top-0 ml-1 bg-background rounded-lg shadow-xl border border-border py-1 hidden group-hover/add:block min-w-[200px] max-h-[300px] overflow-y-auto">
                  {(() => {
                    const groupDevice = entities[contextMenu.groupId];
                    const memberIds = new Set(groupDevice?.memberDeviceIds ?? []);
                    const availableDevices = allDevices.filter(d => !memberIds.has(d.id));

                    return availableDevices.length === 0 ? (
                      <div className="px-4 py-2 text-xs text-muted-foreground italic">No devices available</div>
                    ) : (
                      availableDevices.map(d => (
                        <Button
                          key={d.id}
                          variant="ghost"
                          className="w-full justify-start px-4 py-2 text-sm truncate"
                          onClick={() => {
                            void onAddDeviceToGroup(contextMenu.groupId, d.id).then(() => {
                              setContextMenu(null);
                            });
                          }}
                        >
                          <span className="w-6 inline-flex items-center justify-center flex-shrink-0 text-muted-foreground">
                            {d.emoji?.length > 1 ? (
                              <span className="material-symbols-outlined text-lg select-none">{d.emoji}</span>
                            ) : (
                              <span className="select-none text-sm font-semibold">{d.emoji || d.name?.charAt(0)}</span>
                            )}
                          </span>
                          {d.name}
                        </Button>
                      ))
                    );
                  })()}
                </div>
              </div>

              <Separator className="my-1" />
              <Button
                variant="ghost"
                className="w-full justify-start px-4 py-2 text-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  const groupName = entities[contextMenu.groupId]?.name;
                  if (window.confirm(`Delete group "${groupName}"?`)) {
                    void onDeleteGroup(contextMenu.groupId).then(() => {
                      setContextMenu(null);
                    });
                  }
                }}
              >
                {ICON_TRASH2}
                Delete Group
              </Button>
            </div>
          </>
        )}
      </>
    );
  };
