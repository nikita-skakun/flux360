import React, { useState, useMemo, useEffect } from "react";
import { colorForDevice } from "./color";

type Props = {
  devices: Array<{
    id: number | string;
    isGroup?: boolean;
    name: string;
    icon: string;
    lastSeen: number | null;
    hasPosition: boolean;
    memberDeviceIds?: number[];
  }>;
  selectedDeviceId: number | string | null;
  onSelectDevice: (id: number | string) => void;
  isOpen: boolean;
  onToggle: () => void;
};

const DeviceListSidePanel: React.FC<Props> = ({
  devices,
  selectedDeviceId,
  onSelectDevice,
  isOpen,
  onToggle,
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<number | string>>(new Set());

  const formatLastSeen = (ts: number | null): string => {
    if (!ts) return "Never";
    const now = Date.now();
    const diff = now - ts;
    const seconds = Math.round(diff / 1000);
    if (seconds < 5) return "Just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  };

  const getOnlineStatus = (lastSeen: number | null): { label: string; className: string } => {
    if (!lastSeen) return { label: "Unknown", className: "bg-gray-100 text-gray-600" };
    const now = Date.now();
    const diff = now - lastSeen;
    const minutes = diff / (1000 * 60);
    if (minutes < 5) return { label: "Online", className: "bg-green-100 text-green-700" };
    if (minutes < 30) return { label: "Recent", className: "bg-yellow-100 text-yellow-700" };
    return { label: "Offline", className: "bg-red-100 text-red-700" };
  };

  const { topLevelDevices, memberMap } = useMemo(() => {
    const memberIds = new Set<number>();
    devices.forEach((d) => {
      if (d.isGroup && d.memberDeviceIds) {
        d.memberDeviceIds.forEach((id) => memberIds.add(id));
      }
    });

    const topLevel = devices.filter((d) => {
      // If it's a number ID and in the member set, it's not top level
      if (typeof d.id === "number" && memberIds.has(d.id)) {
        return false;
      }
      return true;
    });

    const map = new Map<number | string, typeof devices[0]>();
    devices.forEach(d => map.set(d.id, d));

    return { topLevelDevices: topLevel, memberMap: map };
  }, [devices]);

  const sortDevices = (list: typeof devices) => {
    return [...list].sort((a, b) => {
      const aOnline = a.lastSeen ? Date.now() - a.lastSeen < 5 * 60 * 1000 : false;
      const bOnline = b.lastSeen ? Date.now() - b.lastSeen < 5 * 60 * 1000 : false;
      if (aOnline && !bOnline) return -1;
      if (!aOnline && bOnline) return 1;
      return (a.name || `Device ${a.id}`).localeCompare(b.name || `Device ${b.id}`);
    });
  };

  const sortedTopLevel = sortDevices(topLevelDevices);

  useEffect(() => {
    if (!isOpen) {
      setExpandedGroups(new Set());
    }
  }, [isOpen]);

  const toggleGroup = (e: React.MouseEvent, id: number | string) => {
    e.stopPropagation();
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /* isFirstChild logic added to correctly handle vertical line start */
  const renderDeviceItem = (device: typeof devices[0], depth: number = 0, isLastChild: boolean = false, isFirstChild: boolean = false) => {
    // Convert string IDs to hash for color generation
    const colorId = typeof device.id === "string"
      ? device.id.split("-").pop()?.charCodeAt(0) ?? 0
      : device.id;
    const [r, g, b] = colorForDevice(colorId);
    const colorStr = `rgb(${r}, ${g}, ${b})`;
    const status = getOnlineStatus(device.lastSeen);
    const isSelected = selectedDeviceId === device.id;

    // Use memberDeviceIds to check if it has members, rather than searching the whole list again
    const childIds = device.isGroup ? device.memberDeviceIds || [] : [];
    const hasChildren = childIds.length > 0;
    const isExpanded = expandedGroups.has(device.id);

    // Get actual child objects
    const children = childIds
      .map(id => memberMap.get(id))
      .filter((d): d is typeof devices[0] => !!d);

    // Sort children same way as main list
    const sortedChildren = sortDevices(children);

    return (
      <React.Fragment key={`${device.isGroup ? "group" : "device"}-${device.id}`}>
        <li>
          <div
            className={`w-full p-3 flex items-start gap-3 transition-colors relative cursor-pointer ${isSelected
              ? "bg-blue-50 border-l-4 border-blue-500"
              : "hover:bg-gray-50 border-l-4 border-transparent"
              }`}
            style={{ paddingLeft: `${12 + depth * 32}px` }}
            onClick={() => onSelectDevice(device.id)}
          >
            {depth > 0 && (
              <div
                className="absolute text-gray-300 pointer-events-none"
                style={{
                  left: `${depth * 32}px`,
                  top: "0px",
                  bottom: "0px",
                  width: "16px"
                }}
              >
                {/* Vertical line UP (to parent or sibling) */}
                <div
                  className="absolute left-0 w-px bg-gray-300"
                  style={{
                    top: isFirstChild ? "-13px" : "0px",
                    bottom: "50%"
                  }}
                ></div>

                {/* Vertical line DOWN (to next sibling) */}
                {!isLastChild && (
                  <div className="absolute top-1/2 bottom-0 left-0 w-px bg-gray-300"></div>
                )}

                {/* Horizontal line (branch to item) */}
                <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-300"></div>

                {/* Rounded ball ending */}
                <div className="absolute top-1/2 right-0 w-1.5 h-1.5 bg-gray-300 rounded-full transform -translate-y-1/2 translate-x-1/2"></div>
              </div>
            )}

            <div className="w-10 h-10 relative flex-shrink-0" onClick={(e) => {
              if (device.isGroup) {
                toggleGroup(e, device.id);
              }
            }}>
              <div
                className={`w-10 h-10 rounded-full bg-white border-2 flex items-center justify-center ${device.isGroup ? "cursor-pointer hover:bg-gray-50" : ""}`}
                style={{ borderColor: colorStr }}
              >
                {device.icon && device.icon.length > 1 ? (
                  <span
                    className="material-symbols-outlined text-lg"
                    style={{ color: colorStr }}
                  >
                    {device.icon}
                  </span>
                ) : (
                  <span style={{ color: colorStr, fontSize: "16px", fontWeight: "600" }}>
                    {device.icon || device.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              {hasChildren && (
                <div
                  className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full border shadow-sm flex items-center justify-center z-10"
                >
                  <span className="material-symbols-outlined text-xs text-gray-600">
                    {isExpanded ? "expand_less" : "expand_more"}
                  </span>
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="font-medium text-gray-900 truncate block"
                  title={device.name || `Device ${device.id}`}
                >
                  {device.name || `Device ${device.id}`}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${status.className}`}
                >
                  {status.label}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Last seen: {formatLastSeen(device.lastSeen)}
              </div>
            </div>
          </div>
        </li>
        {isExpanded && sortedChildren.length > 0 && (
          // Recursively render children
          sortedChildren.map((child, index) => renderDeviceItem(child, depth + 1, index === sortedChildren.length - 1, index === 0))
        )}
      </React.Fragment>
    );
  };

  return (
    <>
      <button
        onClick={onToggle}
        className="fixed top-4 left-4 z-[1002] px-3 py-2 rounded-lg shadow-md bg-white hover:bg-gray-50 transition-all"
        title={isOpen ? "Close device list" : "Open device list"}
      >
        <span className="material-symbols-outlined text-xl">
          {isOpen ? "chevron_left" : "devices"}
        </span>
      </button>

      <div
        className={`fixed top-0 left-0 h-full bg-white shadow-xl z-[1001] transition-all duration-300 ease-in-out ${isOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none"
          }`}
        style={{ width: "280px" }}
      >
        <div className="p-4 border-b bg-gray-50 flex items-center gap-4 pl-16">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Devices</h2>
            <p className="text-sm text-gray-500">{devices.length} total</p>
          </div>
        </div>

        <div className="overflow-y-auto" style={{ height: "calc(100% - 110px)" }}>
          {devices.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">
              No devices found
            </div>
          ) : (
            <ul className="divide-y">
              {sortedTopLevel.map((device) => renderDeviceItem(device))}
            </ul>
          )}
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-[1000] lg:hidden"
          onClick={onToggle}
        />
      )}
    </>
  );
};

export default DeviceListSidePanel;
