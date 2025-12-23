import React from "react";

type Props = {
  length: number;
  index: number; // 0 = hidden, 1..N => snapshot index = value - 1
  onChange: (index: number) => void;
};

export const TimelineSlider: React.FC<Props> = ({ length, index, onChange }) => {
  const display = index === 0 ? "Hidden" : String(index - 1);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={Math.max(0, length)}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div className="w-12 text-xs text-center font-mono">{display}</div>
    </div>
  );
};

export default TimelineSlider; 
