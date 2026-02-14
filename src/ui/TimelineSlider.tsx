import React from "react";
import type { DevicePoint } from "@/types";

type Props = {
  snapshots: DevicePoint[];
  time: number;
  onChange: (time: number) => void;
};

export const TimelineSlider: React.FC<Props> = ({ snapshots, time, onChange }: Props) => {
  const hasSnapshots = snapshots && snapshots.length > 0;

  if (!hasSnapshots) {
    return (
      <div className="flex flex-col">
        <div className="w-full">
          <input type="range" min={0} max={0} value={0} disabled className="w-full opacity-50" />
        </div>
        <div className="flex justify-between items-center text-xs mt-1">
          <div className="font-mono text-sm">No snapshots</div>
        </div>
      </div>
    );
  }

  const times = snapshots.map((s) => s.timestamp);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const clamped = Math.min(Math.max(time, minTime), maxTime);
  const formatted = new Date(clamped).toLocaleString();

  const sortedTimes = times.slice().sort((a, b) => a - b);
  let prevTime: number | null = null;
  for (let i = sortedTimes.length - 1; i >= 0; i--) {
    const t = sortedTimes[i];
    if (t != null && t < clamped) {
      prevTime = t;
      break;
    }
  }
  let nextTime: number | null = null;
  for (let i = 0; i < sortedTimes.length; i++) {
    const t = sortedTimes[i];
    if (t != null && t > clamped) {
      nextTime = t;
      break;
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 h-8">
        <button
          type="button"
          title="Previous report"
          aria-label="Previous report"
          disabled={prevTime == null}
          onClick={() => prevTime != null && onChange(prevTime)}
          className="h-8 px-2 rounded border bg-background text-sm hover:bg-muted disabled:opacity-40 flex items-center justify-center leading-none text-foreground border-border"
        >
          ‹
        </button>

        <div className="relative flex-1 flex items-center">
          <input
            aria-label="Timeline"
            type="range"
            min={minTime}
            max={maxTime}
            value={clamped}
            onChange={(e) => onChange(Number(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                if (prevTime != null) onChange(prevTime);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                if (nextTime != null) onChange(nextTime);
              }
            }}
            className="timeline-range w-full relative z-10"
          />
        </div>

        <button
          type="button"
          title="Next report"
          aria-label="Next report"
          disabled={nextTime == null}
          onClick={() => nextTime != null && onChange(nextTime)}
          className="h-8 px-2 rounded border bg-background text-sm hover:bg-muted disabled:opacity-40 flex items-center justify-center leading-none text-foreground border-border"
        >
          ›
        </button>
      </div>

      <div className="flex justify-between items-center text-xs mt-1">
        <div className="font-mono text-sm">{formatted}</div>
        <div className="text-xs opacity-70">{new Date(minTime).toLocaleString()} — {new Date(maxTime).toLocaleString()}</div>
      </div>
    </div>
  );
};

export default TimelineSlider;
