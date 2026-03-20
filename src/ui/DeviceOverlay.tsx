import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Pencil, UserPlus, X } from "lucide-react";
import { useStore } from "@/store";
import { useTimeAgo } from "@/util/time";
import React, { useMemo, useState } from "react";
import type { AppDevice, DevicePoint } from "@/types";

const ICON_PENCIL = <Pencil className="h-4 w-4" />;
const ICON_USER_PLUS = <UserPlus className="h-4 w-4" />;
const ICON_CLOSE = <X className="h-4 w-4" />;

// UI confidence thresholds for display
const CONFIDENCE_HIGH_THRESHOLD = 0.8;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.5;

type Props = {
  selectedDeviceId: number | null;
  activePointsByDevice: Record<number, DevicePoint[]>;
  entities: Record<number, AppDevice>;
  setSelectedDeviceId: (id: number | null) => void;
  setEditingTarget: (target: { type: 'device' | 'group'; id: number } | null) => void;
  isOwner: boolean;
};

const DurationDisplay: React.FC<{ timestamp: number, addSuffix: boolean }> = ({ timestamp, addSuffix = true }) => {
  const timeAgo = useTimeAgo(timestamp, addSuffix);
  return <>{timeAgo}</>;
};

function DeviceOverlayComponent({
  selectedDeviceId,
  activePointsByDevice,
  entities,
  setSelectedDeviceId,
  setEditingTarget,
  isOwner,
}: Props) {
  const handleClose = React.useCallback(() => setSelectedDeviceId(null), [setSelectedDeviceId]);

  const [shareState, setShareState] = useState({
    isOpen: false,
    username: "",
    error: null as string | null,
    isSharing: false,
  });

  const points = selectedDeviceId != null ? activePointsByDevice[selectedDeviceId] ?? [] : [];
  const chosen = points.length > 0 ? points[points.length - 1] : null;

  const handleShareClick = React.useCallback(() => {
    setShareState({ isOpen: true, username: "", error: null, isSharing: false });
  }, []);

  const closeShareDialog = React.useCallback(() => {
    setShareState({ isOpen: false, username: "", error: null, isSharing: false });
  }, []);

  const handleShare = React.useCallback(async () => {
    if (selectedDeviceId == null) return;
    if (!shareState.username.trim()) {
      setShareState((prev) => ({ ...prev, error: "Please enter a username." }));
      return;
    }

    setShareState((prev) => ({ ...prev, isSharing: true, error: null }));

    const sessionToken = useStore.getState().settings.sessionToken;

    try {
      const r = await fetch(`/api/devices/${selectedDeviceId}/share`, {
        method: "POST",
        body: JSON.stringify({ username: shareState.username.trim() }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!r.ok) throw new Error(await r.text());
      closeShareDialog();
    } catch (err) {
      setShareState((prev) => ({ ...prev, error: err instanceof Error ? err.message : "Sharing failed." }));
    } finally {
      setShareState((prev) => ({ ...prev, isSharing: false }));
    }
  }, [selectedDeviceId, shareState.username, closeShareDialog]);

  // Derive group-related info
  const { group, contributors, mostRecentSourceName } = useMemo(() => {
    const entity = selectedDeviceId != null ? entities[selectedDeviceId] : null;
    if (!entity) return { group: null, contributors: [], mostRecentSourceName: null };

    const memberIds = entity.memberDeviceIds;
    if (!memberIds) {
      return { group: null, contributors: [], mostRecentSourceName: null };
    }

    const contribs = memberIds.map((id) => entities[id]?.name ?? "");
    const latestId = memberIds.reduce((latest, id) => {
      const time = entities[id]?.lastSeen ?? 0;
      const latestTime = latest ? (entities[latest]?.lastSeen ?? 0) : -1;
      return time > latestTime ? id : latest;
    }, null as number | null);

    const latestName = latestId != null ? (entities[latestId]?.name ?? null) : null;

    return { group: entity, contributors: contribs, mostRecentSourceName: latestName };
  }, [selectedDeviceId, entities]);

  const handleEdit = React.useCallback(() => {
    if (selectedDeviceId == null) return;
    setEditingTarget({ type: group ? "group" : "device", id: selectedDeviceId });
  }, [selectedDeviceId, group, setEditingTarget]);

  if (selectedDeviceId == null) return null;
  if (!chosen) return null;

  return (
    <div className="p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 h-8 flex items-center pr-1">
          <div className="text-base font-semibold leading-tight truncate">
            {group ? group.name : entities[chosen.device]?.name}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isOwner && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Share device"
                title="Share Device"
                className="h-8 w-8 text-primary"
                onClick={handleShareClick}
              >
                {ICON_USER_PLUS}
              </Button>
              <Dialog open={shareState.isOpen} onOpenChange={(open) => { if (!open) closeShareDialog(); }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Share Device</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <label className="text-sm font-medium" htmlFor="share-username">
                      Username
                    </label>
                    <Input
                      id="share-username"
                      value={shareState.username}
                      onChange={(e) => setShareState((prev) => ({ ...prev, username: e.target.value }))}
                      placeholder="Enter username"
                      disabled={shareState.isSharing}
                    />
                    {shareState.error && <div className="text-sm text-destructive">{shareState.error}</div>}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={closeShareDialog} disabled={shareState.isSharing}>
                      Cancel
                    </Button>
                    <Button onClick={handleShare} disabled={shareState.isSharing}>
                      {shareState.isSharing ? "Sharing…" : "Share"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Edit settings"
                title="Edit Settings"
                className="h-8 w-8"
                onClick={handleEdit}
              >
                {ICON_PENCIL}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Deselect device"
            title="Close"
            className="h-8 w-8"
            onClick={handleClose}
          >
            {ICON_CLOSE}
          </Button>
        </div>
      </div>

      <div className="mt-1.5">
        {group && contributors.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Sources:</span> {contributors.join(", ")}
            {mostRecentSourceName && <div className="text-muted-foreground/70 text-xs mt-0.5">Latest from: {mostRecentSourceName}</div>}
            {(chosen).sourceDeviceId != null && <div className="text-muted-foreground/70 text-xs mt-0.5">Current source: {entities[(chosen).sourceDeviceId]?.name}</div>}
          </div>
        )}
        <div className="text-xs text-muted-foreground">Accuracy: {typeof chosen.accuracy === 'number' ? Math.round(chosen.accuracy) : ""} m · {(chosen.confidence >= CONFIDENCE_HIGH_THRESHOLD ? "High" : chosen.confidence >= CONFIDENCE_MEDIUM_THRESHOLD ? "Medium" : "Low")} confidence ({chosen.confidence.toFixed(2)})</div>
        <div className="text-xs text-muted-foreground">At location for: <DurationDisplay timestamp={chosen.anchorStartTimestamp} addSuffix={false} /></div>
      </div>

      <div className="text-xs text-muted-foreground">Last updated: <DurationDisplay timestamp={entities[chosen.device]?.lastSeen ?? chosen.timestamp} addSuffix={false} /></div>

    </div>
  );
}

export const DeviceOverlay = React.memo(DeviceOverlayComponent);
