import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStore } from "@/store";
import { X, Share2 } from "lucide-react";
import React, { useEffect, useState } from "react";

const ICON_SHARE = <Share2 className="h-4 w-4" />;
const ICON_CLOSE = <X className="h-4 w-4" />;

type Share = {
  deviceId: number;
  deviceName: string;
  sharedWith: string;
  sharedAt: number;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export const SharingManagementPanel = React.memo(function SharingManagementPanel({
  isOpen,
  onClose,
}: Props) {
  const [shares, setShares] = useState<Share[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingShare, setRemovingShare] = useState<{ deviceId: number; username: string } | null>(null);

  const sessionToken = useStore(state => state.settings.sessionToken);

  useEffect(() => {
    if (!isOpen) return;

    const fetchShares = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/devices/shares", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });

        if (!response.ok) throw new Error("Failed to fetch shares");

        setShares((await response.json() as { shares: Share[]; }).shares);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch shares");
      } finally {
        setIsLoading(false);
      }
    };

    void fetchShares();
  }, [isOpen, sessionToken]);

  const handleRemoveShare = async (deviceId: number, username: string) => {
    setRemovingShare({ deviceId, username });
    try {
      const response = await fetch(`/api/devices/${deviceId}/share/${username}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) throw new Error("Failed to remove share");

      setShares(shares.filter(s => !(s.deviceId === deviceId && s.sharedWith === username)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove share");
    } finally {
      setRemovingShare(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {ICON_SHARE}
            Shared Devices
          </DialogTitle>
          <DialogDescription>
            Review devices you shared and remove access if needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <div className="p-3 rounded bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8">Loading shares...</div>
          ) : shares.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">No shared devices</div>
          ) : (
            <div className="space-y-2">
              {shares.map((share) => (
                <div
                  key={`${share.deviceId}-${share.sharedWith}`}
                  className="flex items-center justify-between p-3 rounded border border-border bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{share.deviceName}</div>
                    <div className="text-xs text-muted-foreground">Shared with: {share.sharedWith}</div>
                    <div className="text-xs text-muted-foreground">
                      Shared at: {new Date(share.sharedAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { void handleRemoveShare(share.deviceId, share.sharedWith); }}
                    disabled={removingShare?.deviceId === share.deviceId && removingShare?.username === share.sharedWith}
                    className="h-7 w-7 ml-2 flex-shrink-0"
                    title="Remove share"
                  >
                    {ICON_CLOSE}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});
