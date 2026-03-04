import { Button } from "@/components/ui/button";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_MEDIUM_THRESHOLD } from "@/engine/anchor";
import { Engine } from "@/engine/engine";
import { Pencil, X } from "lucide-react";
import { fromWebMercator } from "@/util/webMercator";
import { Slider } from "@/components/ui/slider";
import { useTimeAgo } from "@/hooks/useTimeAgo";
import React from "react";
import type { DevicePoint, Timestamp } from "@/types";

type Props = {
  selectedDeviceId: number | null;
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  debugMode: boolean;
  debugFrameIndex: number;
  setDebugFrameIndex: (value: number) => void;
  deviceNames: Record<number, string>;
  deviceLastSeen: Record<number, Timestamp | null>;
  groupDevices: Array<{ id: number; name: string; emoji: string; color: string; memberDeviceIds: number[] }>;
  setSelectedDeviceId: (id: number | null) => void;
  enginesRef: Map<number, Engine>;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;
};

const DurationDisplay: React.FC<{ timestamp: Timestamp, addSuffix?: boolean }> = ({ timestamp, addSuffix = true }) => {
  const timeAgo = useTimeAgo(timestamp, addSuffix);
  return <>{timeAgo}</>;
};

function DeviceOverlayComponent({
  selectedDeviceId,
  engineSnapshotsByDevice,
  debugMode,
  debugFrameIndex,
  setDebugFrameIndex,
  deviceNames,
  deviceLastSeen,
  groupDevices,
  setSelectedDeviceId,
  enginesRef,
  setEditingTarget,
}: Props) {
  if (selectedDeviceId == null) return null;

  const engArr = engineSnapshotsByDevice[selectedDeviceId] ?? [];
  const chosen = engArr.length > 0 ? engArr[engArr.length - 1] : null;
  if (!chosen) return null;

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

  // debug frames for this device (if debug enabled)
  const engineForDevice = enginesRef.get(selectedDeviceId);
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
    <div className="p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300">
      <div className="flex items-start">
        <div className="flex-1">
          {(() => {
            const displayName = group ? group.name : (deviceNames[chosen.device] ?? chosen.device);
            return <div className="text-sm font-medium">{displayName}</div>;
          })()}
          {group && contributors.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              <span className="font-medium">Sources:</span> {contributors.join(", ")}
              {mostRecentSourceName && <div className="text-muted-foreground/70 text-xs mt-0.5">Latest from: {mostRecentSourceName}</div>}
              {(chosen).sourceDeviceId !== undefined && <div className="text-muted-foreground/70 text-xs mt-0.5">Current source: {deviceNames[(chosen).sourceDeviceId] ?? `Device ${(chosen).sourceDeviceId}`}</div>}
            </div>
          )}
          <div className="text-xs text-muted-foreground">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""} m · {(chosen.confidence >= CONFIDENCE_HIGH_THRESHOLD ? "High" : chosen.confidence >= CONFIDENCE_MEDIUM_THRESHOLD ? "Medium" : "Low")} confidence ({chosen.confidence.toFixed(2)})</div>
          <div className="text-xs text-muted-foreground">At location for: <DurationDisplay timestamp={chosen.anchorStartTimestamp} addSuffix={false} /></div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Edit settings"
            title="Edit Settings"
            className="h-8 w-8"
            onClick={() => setEditingTarget({ type: group ? 'group' : 'device', id: chosen.device })}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Deselect device"
            title="Close"
            className="h-8 w-8"
            onClick={() => setSelectedDeviceId(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">Last updated: <DurationDisplay timestamp={deviceLastSeen[chosen.device] ?? chosen.timestamp} /></div>

      {debugMode ? (
        <div className="mt-2 text-xs">
          <div className="mb-2">Debug frames: {frames.length}</div>
          {frames.length > 0 ? (
            <div className="flex gap-2 items-center">
              <Slider
                min={0}
                max={Math.max(0, frames.length - 1)}
                step={1}
                value={[debugFrameIndex]}
                onValueChange={(value) => setDebugFrameIndex(value[0] ?? 0)}
                className="flex-1"
              />
              <div className="w-20 text-right">#{frameIndex ?? 0}</div>
            </div>
          ) : <div className="text-xs text-muted-foreground">No debug frames</div>}

          {chosenFrame ? (
            <div className="mt-2 text-xs bg-muted/50 p-2 rounded-lg">
              <div>Decision: <span className="font-bold uppercase text-primary">{chosenFrame.decision}</span></div>
              <div>Draft Type: {chosenFrame.draftType}</div>
              <div>Mahalanobis²: {chosenFrame.mahalanobis2?.toFixed(2) ?? '—'}</div>
              <div>Pending Pts: {chosenFrame.pendingCount}</div>
              <div>Variance: {chosenFrame.variance?.toFixed(1) ?? '—'}</div>
              {chosenFrame.mean && (
                <div>Pos: {fromWebMercator(chosenFrame.mean)[1].toFixed(5)}, {fromWebMercator(chosenFrame.mean)[0].toFixed(5)}</div>
              )}
              <div className="mt-1 pt-1 border-t border-border/30 text-muted-foreground">
                {new Date(chosenFrame.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default React.memo(DeviceOverlayComponent);
