import React, { useState, useMemo, useEffect } from "react";
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

const getOnlineStatus = (lastSeen: number | null) => {
  if (!lastSeen) return { label: "Unknown", className: "bg-gray-100 text-gray-600" };
  const min = (Date.now() - lastSeen) / 60000;
  if (min < 5) return { label: "Online", className: "bg-green-100 text-green-700" };
  if (min < 30) return { label: "Recent", className: "bg-yellow-100 text-yellow-700" };
  return { label: "Offline", className: "bg-red-100 text-red-700" };
};

const DeviceListSidePanel: React.FC<{
  devices: Device[];
  selectedDeviceId: number | string | null;
  onSelectDevice: (id: number | string) => void;
  isOpen: boolean;
  onToggle: () => void;
  onShowGroupsModal: () => void;
}> = ({ devices, selectedDeviceId, onSelectDevice, isOpen, onToggle, onShowGroupsModal }) => {
  const [expanded, setExpanded] = useState<Set<number | string>>(new Set());

  useEffect(() => { if (!isOpen) setExpanded(new Set()); }, [isOpen]);

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
      if (next.has(id))
        next.delete(id);
      else
        next.add(id);
      return next;
    });
  };

  const renderItem = (device: Device, depth: number = 0, isLast = false, isFirst = false) => {
    const colorId = typeof device.id === "string" ? device.id.split("-").pop()?.charCodeAt(0) ?? 0 : Number(device.id);
    const [r, g, b] = colorForDevice(colorId);
    const defaultColor = `rgb(${r}, ${g}, ${b})`;
    const colorStr = device.color ?? defaultColor;
    const status = getOnlineStatus(device.lastSeen);
    const displayName = device.name || `Device ${device.id}`;
    const children = (device.isGroup ? device.memberDeviceIds ?? [] : [])
      .map(id => memberMap.get(id)).filter((d): d is Device => !!d);

    const sortedChildren = sort(children);

    return (
      <React.Fragment key={`${device.isGroup ? "g" : "d"}-${device.id}`}>
        <li>
          <div
            className={`w-full p-3 flex items-start gap-3 transition-colors relative cursor-pointer ${selectedDeviceId === device.id ? "bg-blue-50 border-l-4 border-blue-500" : "hover:bg-gray-50 border-l-4 border-transparent"
              }`}
            style={{ paddingLeft: `${12 + depth * 32}px` }}
            onClick={() => onSelectDevice(device.id)}
          >
            {depth > 0 && (
              <div className="absolute text-gray-300 pointer-events-none" style={{ left: `${depth * 32}px`, top: 0, bottom: 0, width: "16px" }}>
                <div className="absolute left-0 w-px bg-gray-300" style={{ top: isFirst ? "-13px" : "0px", bottom: "50%" }} />
                {!isLast && <div className="absolute top-1/2 bottom-0 left-0 w-px bg-gray-300" />}
                <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-300" />
                <div className="absolute top-1/2 right-0 w-1.5 h-1.5 bg-gray-300 rounded-full transform -translate-y-1/2 translate-x-1/2" />
              </div>
            )}

            <div className="w-10 h-10 relative flex-shrink-0" onClick={(e) => device.isGroup && toggle(e, device.id)}>
              <div className={`w-10 h-10 rounded-full bg-white border-2 flex items-center justify-center ${device.isGroup ? "cursor-pointer hover:bg-gray-50" : ""}`} style={{ borderColor: colorStr }}>
                {device.emoji?.length > 1 ? (
                  <span className="material-symbols-outlined text-lg select-none" style={{ color: colorStr }}>{device.emoji}</span>
                ) : (
                  <span style={{ color: colorStr, fontSize: "16px", fontWeight: "600" }} className="select-none">{device.emoji || displayName}</span>
                )}
              </div>
              {sortedChildren.length > 0 && (
                <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full border shadow-sm flex items-center justify-center z-10">
                  <span className="material-symbols-outlined text-xs text-gray-600 select-none">{expanded.has(device.id) ? "expand_less" : "expand_more"}</span>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-900 truncate block" title={displayName}>{displayName}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${status.className}`}>{status.label}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">Last seen: {formatLastSeen(device.lastSeen)}</div>
            </div>
          </div>
        </li>
        {expanded.has(device.id) && sortedChildren.map((c, i) => renderItem(c, depth + 1, i === sortedChildren.length - 1, i === 0))}
      </React.Fragment>
    );
  };

  return (
    <>
      <button onClick={onToggle} className="fixed top-4 left-4 z-[1002] px-3 py-2 rounded-lg shadow-md bg-white hover:bg-gray-50 transition-all" title={isOpen ? "Close" : "Open"}>
        <span className="material-symbols-outlined text-xl select-none">{isOpen ? "chevron_left" : "devices"}</span>
      </button>

      <div className={`fixed top-0 left-0 h-full bg-white shadow-xl z-[1001] transition-all duration-300 ease-in-out ${isOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none"}`} style={{ width: "280px" }}>
        <div className="p-4 border-b bg-gray-50 flex items-center justify-between pl-20">
          <div><h2 className="text-lg font-semibold text-gray-800">Devices</h2><p className="text-sm text-gray-500">{devices.length} total</p></div>
          <button onClick={onShowGroupsModal} className="w-10 h-10 flex items-center justify-center rounded-full bg-white shadow-sm border border-gray-200 hover:bg-gray-50 transition-all" title="Manage Tracker Groups">
            <span className="material-symbols-outlined text-gray-600">devices_other</span>
          </button>
        </div>
        <div className="overflow-y-auto" style={{ height: "calc(100% - 110px)" }}>
          {devices.length === 0 ? <div className="p-4 text-center text-gray-500 text-sm">No devices found</div> : (
            <ul className="divide-y text-sm">
              {topLevel.map(d => renderItem(d))}
            </ul>
          )}
        </div>
      </div>
      {isOpen && <div className="fixed inset-0 bg-black/20 z-[1000] lg:hidden" onClick={onToggle} />}
    </>
  );
};

export default DeviceListSidePanel;
