import { Button } from "@/components/ui/button";
import { Pencil, UserPlus, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useTimeAgo } from "@/util/time";
import React, { useMemo } from "react";
import type { AppDevice, DevicePoint, Timestamp } from "@/types";

// UI confidence thresholds for display
const CONFIDENCE_HIGH_THRESHOLD = 0.8;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.5;

type Props = {
  selectedDeviceId: number | null;
  engineSnapshotsByDevice: Record<number, DevicePoint[]>;
  debugMode: boolean;
  debugFrameIndex: number;
  setDebugFrameIndex: (value: number) => void;
  entities: Record<number, AppDevice>;
  setSelectedDeviceId: (id: number | null) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;
  isOwner?: boolean;
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
  entities,
  setSelectedDeviceId,
  setEditingTarget,
  isOwner,
}: Props) {
  if (selectedDeviceId == null) return null;

  const engArr = engineSnapshotsByDevice[selectedDeviceId] ?? [];
  const chosen = engArr.length > 0 ? engArr[engArr.length - 1] : null;
  if (!chosen) return null;

  // debug frames for this device (if debug enabled)
  const frames = debugMode ? engArr : [];
  const frameIndex = Math.max(0, Math.min(frames.length - 1, debugFrameIndex));
  const chosenFrame = frames.length > 0 ? frames[frameIndex] : null;

  // Derive group-related info
  const { group, contributors, mostRecentSourceName } = useMemo(() => {
    const entity = selectedDeviceId != null ? entities[selectedDeviceId] : null;
    if (!entity) return { group: null, contributors: [], mostRecentSourceName: null };

    const memberIds = entity.memberDeviceIds;
    if (!memberIds) {
      return { group: null, contributors: [], mostRecentSourceName: null };
    }

    const contribs = memberIds.map((id) => entities[id]?.name ?? `Device ${id}`);
    const latestId = memberIds.reduce((latest, id) => {
      const time = entities[id]?.lastSeen ?? 0;
      const latestTime = latest ? (entities[latest]?.lastSeen ?? 0) : -1;
      return time > latestTime ? id : latest;
    }, null as number | null);

    const latestName = latestId != null ? (entities[latestId]?.name ?? `Device ${latestId}`) : null;

    return { group: entity, contributors: contribs, mostRecentSourceName: latestName };
  }, [selectedDeviceId, entities]);

  return (
    <div className="p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300">
      <div className="flex items-start">
        <div className="flex-1">
          <div className="text-sm font-medium">
            {group ? group.name : (entities[chosen.device]?.name ?? `Device ${chosen.device}`)}
          </div>
          {group && contributors.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              <span className="font-medium">Sources:</span> {contributors.join(", ")}
              {mostRecentSourceName && <div className="text-muted-foreground/70 text-xs mt-0.5">Latest from: {mostRecentSourceName}</div>}
              {(chosen).sourceDeviceId != null && <div className="text-muted-foreground/70 text-xs mt-0.5">Current source: {entities[(chosen).sourceDeviceId]?.name ?? `Device ${(chosen).sourceDeviceId}`}</div>}
            </div>
          )}
          <div className="text-xs text-muted-foreground">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""} m · {(chosen.confidence >= CONFIDENCE_HIGH_THRESHOLD ? "High" : chosen.confidence >= CONFIDENCE_MEDIUM_THRESHOLD ? "Medium" : "Low")} confidence ({chosen.confidence.toFixed(2)})</div>
          <div className="text-xs text-muted-foreground">At location for: <DurationDisplay timestamp={chosen.anchorStartTimestamp} addSuffix={false} /></div>
        </div>
        <div className="flex items-center gap-1">
          {isOwner && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Share device"
                title="Share Device"
                className="h-8 w-8 text-primary"
                onClick={() => {
                  const username = window.prompt("Enter username to share with:");
                  if (username) {
                    void fetch(`/api/devices/${chosen.device}/share`, {
                      method: "POST",
                      body: JSON.stringify({ username }),
                      headers: { "Content-Type": "application/json" }
                    }).then(r => {
                      if (r.ok) window.alert("Shared successfully!");
                      else window.alert("Sharing failed.");
                    });
                  }
                }}
              >
                <UserPlus className="h-4 w-4" />
              </Button>
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
            </>
          )}
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
      <div className="text-xs text-muted-foreground">Last updated: <DurationDisplay timestamp={entities[chosen.device]?.lastSeen ?? chosen.timestamp} /></div>

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
              <div>Device point at {new Date(chosenFrame.timestamp).toLocaleTimeString()}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default React.memo(DeviceOverlayComponent);
