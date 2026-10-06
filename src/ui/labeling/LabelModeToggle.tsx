import { useStore } from "@/store";

export function LabelModeToggle() {
  const isLabelMode = useStore(state => state.ui.isLabelMode);
  const setLabelMode = useStore(state => state.setLabelMode);

  return (
    <button
      type="button"
      onClick={() => setLabelMode(!isLabelMode)}
      className={`w-full rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        isLabelMode
          ? "bg-amber-500/90 text-black hover:bg-amber-400"
          : "bg-black/60 text-white/90 hover:bg-black/80"
      }`}
    >
      {isLabelMode ? "Exit labeling" : "Label mode"}
    </button>
  );
}
