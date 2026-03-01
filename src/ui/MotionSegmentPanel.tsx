import { Button } from "@/components/ui/button";
import { fromWebMercator } from "@/util/webMercator";
import { X } from "lucide-react";
import React from "react";
import type { DebugFrame } from "@/engine/engine";
import type { MotionSegment, RetrospectiveMotionSegment, Timestamp, Vec2 } from "@/types";

type Props = {
  segment: MotionSegment | RetrospectiveMotionSegment;
  debugFrames: DebugFrame[];
  onClose: () => void;
};

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h ${min}m`;
}

function formatTimestamp(ts: Timestamp): string {
  return new Date(ts).toLocaleString();
}

function pathDistance(path: Vec2[]): number {
  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i]![0] - path[i - 1]![0];
    const dy = path[i]![1] - path[i - 1]![1];
    dist += Math.sqrt(dx * dx + dy * dy);
  }
  return dist;
}

function isRetrospectiveSegment(seg: MotionSegment | RetrospectiveMotionSegment): seg is RetrospectiveMotionSegment {
  return 'confidence' in seg;
}

function MotionSegmentPanel({ segment, debugFrames, onClose }: Props) {
  const startTime = segment.startTime;
  const endTime = segment.endTime ?? Date.now();
  const duration = endTime - startTime;
  const distance = pathDistance(segment.path);
  const avgSpeedKmh = duration > 0 ? (distance / 1000) / (duration / 3600000) : 0;

  const isRetro = isRetrospectiveSegment(segment);

  const relevantFrames = debugFrames.filter(f => {
    if (f.timestamp < startTime) return false;
    if (endTime && f.timestamp > endTime) return false;
    return true;
  });

  return (
    <div className="p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300 flex flex-col shrink-0 min-h-0">
      <div className="flex items-start justify-between mb-2">
        <div className="text-sm font-medium">
          {isRetro ? 'Retrospective Segment' : 'Motion Segment'}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          title="Close"
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <div className="text-xs space-y-1 mb-3 shrink-0">
        <div><strong>Duration:</strong> {formatDuration(duration)}</div>
        <div><strong>Distance:</strong> {Math.round(distance)}m</div>
        <div><strong>Avg Speed:</strong> {avgSpeedKmh.toFixed(1)} km/h</div>
        <div><strong>Started:</strong> {formatTimestamp(startTime)}</div>
        <div><strong>Ended:</strong> {formatTimestamp(endTime)}</div>
        {isRetro && <div><strong>Confidence:</strong> {segment.confidence.toFixed(2)}</div>}
        <div><strong>Path points:</strong> {segment.path.length}</div>
      </div>

      <div className="text-xs space-y-1 mb-3 shrink-0">
        <div><strong>Start:</strong> {(() => {
          const [lon, lat] = fromWebMercator(segment.path[0]!);
          return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        })()}</div>
        <div><strong>End:</strong> {(() => {
          const [lon, lat] = fromWebMercator(segment.path[segment.path.length - 1]!);
          return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        })()}</div>
      </div>

      <div className="text-xs font-medium mb-1 shrink-0">
        Debug frames ({relevantFrames.length}):
      </div>

      <div className="max-h-32 overflow-y-auto text-xs bg-muted/50 rounded p-2 space-y-2 min-h-0">
        {relevantFrames.length === 0 ? (
          <div className="text-muted-foreground">No debug frames in this time range</div>
        ) : (
          relevantFrames.map((frame, idx) => (
            <div key={idx} className="border-b border-border/50 pb-1 last:border-0">
              <div className="font-medium">{new Date(frame.timestamp).toLocaleTimeString()}</div>
              <div>Accuracy: {Math.round(frame.measurement.accuracy)}m</div>
              <div>Location: {frame.measurement.lat.toFixed(5)}, {frame.measurement.lon.toFixed(5)}</div>
              <div>Mahal²: {frame.mahalanobis2?.toFixed(2) ?? '—'}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default React.memo(MotionSegmentPanel);
