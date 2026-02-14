import React from "react";

type PulsingMarkerProps = {
  x: number;
  y: number;
};

export const PulsingMarker = React.memo(({ x, y }: PulsingMarkerProps) => {
  return (
    <div
      className="absolute z-[999] pointer-events-none"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
    >
      <span className="relative flex h-12 w-12 items-center justify-center">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-8 w-8 border-2 border-blue-500 opacity-0"></span>
      </span>
    </div>
  );
});
