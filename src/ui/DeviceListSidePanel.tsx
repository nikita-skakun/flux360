import React from "react";
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

  const sortedDevices = [...devices].sort((a, b) => {
    const aOnline = a.lastSeen ? Date.now() - a.lastSeen < 5 * 60 * 1000 : false;
    const bOnline = b.lastSeen ? Date.now() - b.lastSeen < 5 * 60 * 1000 : false;
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return (a.name || `Device ${a.id}`).localeCompare(b.name || `Device ${b.id}`);
  });

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
              {sortedDevices.map((device) => {
                // Convert string IDs to hash for color generation
                const colorId = typeof device.id === "string"
                  ? device.id.split("-").pop()?.charCodeAt(0) ?? 0
                  : device.id;
                const [r, g, b] = colorForDevice(colorId);
                const colorStr = `rgb(${r}, ${g}, ${b})`;
                const status = getOnlineStatus(device.lastSeen);
                const isSelected = selectedDeviceId === device.id;

                const shouldShowBadge = !!(device.isGroup && device.memberDeviceIds && device.memberDeviceIds.length > 0);

                return (
                  <li key={`${device.isGroup ? "group" : "device"}-${device.id}`}>
                    <button
                      onClick={() => onSelectDevice(device.id)}
                      className={`w-full p-3 text-left transition-colors relative ${isSelected
                        ? "bg-blue-50 border-l-4 border-blue-500"
                        : "hover:bg-gray-50 border-l-4 border-transparent"
                        }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 relative">
                          <div
                            className="w-10 h-10 rounded-full bg-white border-2 flex items-center justify-center"
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
                          {shouldShowBadge && (
                            <div
                              style={{
                                position: "absolute",
                                bottom: "-6px",
                                right: "-6px",
                                width: "24px",
                                height: "24px",
                                borderRadius: "50%",
                                backgroundColor: "rgb(230, 230, 230)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                border: "2px solid white",
                                color: "rgb(0, 0, 0)",
                                fontWeight: "bold",
                                fontSize: "12px",
                                pointerEvents: "none",
                                zIndex: 10,
                              }}
                            >
                              {device.memberDeviceIds?.length}
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
                    </button>
                  </li>
                );
              })}
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
