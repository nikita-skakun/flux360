import React from "react";

type Props = {
  length: number;
  index: number;
  onChange: (index: number) => void;
};

export const TimelineSlider: React.FC<Props> = ({ length, index, onChange }) => {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={Math.max(0, length - 1)}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div className="w-12 text-xs text-center font-mono">{index}</div>
    </div>
  );
};

export default TimelineSlider;
