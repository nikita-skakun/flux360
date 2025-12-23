import React from "react";

type Snap = { timestamp: number };

type Props = {
  snapshots: Snap[];
  time: number;
  onChange: (time: number) => void;
  step?: number;
};

export const TimelineSlider: React.FC<Props> = ({ snapshots, time, onChange, step = 1000 }) => {
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
  const range = Math.max(1, maxTime - minTime);
  const clamped = Math.min(Math.max(time, minTime), maxTime);
  const formatted = new Date(clamped).toLocaleString();

  return (
    <div className="flex flex-col">
      <div className="relative w-full">
        <input
          aria-label="Timeline"
          type="range"
          min={minTime}
          max={maxTime}
          step={step}
          value={clamped}
          onChange={(e) => onChange(Number(e.target.value))}
          className="timeline-range w-full relative z-10"
        />
      </div>

      <div className="flex justify-between items-center text-xs mt-1">
        <div className="font-mono text-sm">{formatted}</div>
        <div className="text-xs opacity-70">{new Date(minTime).toLocaleString()} — {new Date(maxTime).toLocaleString()}</div>
      </div>
    </div>
  );
};

export default TimelineSlider;
