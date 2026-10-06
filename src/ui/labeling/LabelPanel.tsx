import { useMemo } from "react";
import { useStore } from "@/store";
import { KIND_LABELS, KIND_ORDER, LABEL_COLORS, cssColor } from "@/labels/palette";
import { unavailableKinds } from "@/labels/validation";
import type { Label, LabelKind } from "@/labels/types";

const NO_MEMBERS: number[] = [];

type Props = {
  entityId: number;
  labels: Label[];
  selection:
    | { kind: "segment"; start: number; end: number; count: number }
    | { kind: "point"; timestamp: number; count: number }
    | null;
  onAssign: (kind: LabelKind) => void;
  onDelete: (id: string) => void;
  selectedLabelId: string | null;
  onSelectLabel: (label: Label) => void;
};

export function LabelPanel({ entityId, labels, selection, onAssign, onDelete, selectedLabelId, onSelectLabel }: Props) {
  const memberDeviceIds = useStore(state =>
    entityId < 0 ? state.entities[entityId]?.memberDeviceIds ?? NO_MEMBERS : NO_MEMBERS
  );
  const history = useStore(state => state.labelHistory);
  const error = useStore(state => state.labelError);
  const undoLabel = useStore(state => state.undoLabel);
  const setLabelError = useStore(state => state.setLabelError);

  const grouped = labels.filter(label => label.deviceId === entityId && label.kind !== "outlier");
  const outliers = labels.filter(label => label.deviceId === entityId && label.kind === "outlier");

  const disabled = selection === null;

  // Overlaps are decided locally, so the reason a kind is unavailable is known before
  // the click rather than reported by the server afterwards.
  const blocked = useMemo(() => {
    if (selection === null || selection.kind !== "segment") return new Map<string, string>();
    const unavailable = unavailableKinds(labels, entityId, selection, memberDeviceIds, KIND_ORDER);
    return new Map(unavailable.map(entry => [entry.kind, entry.reason]));
  }, [labels, entityId, selection, memberDeviceIds]);

  return (
    <div className="pointer-events-auto absolute right-4 bottom-36 z-20 w-[300px] rounded-lg border border-white/10 bg-black/70 p-3 text-xs text-white/90 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">
          {selection === null
            ? "Select fixes to label"
            : selection.kind === "segment"
              ? `${selection.count} fixes selected`
              : `${selection.count} fix selected`}
        </span>
        <button
          type="button"
          disabled={history.length === 0}
          onClick={() => void undoLabel()}
          className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20 disabled:opacity-30"
        >
          Undo
        </button>
      </div>

      {error && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded bg-red-900/50 px-2 py-1">
          <span>{error}</span>
          <button type="button" onClick={() => setLabelError(null)} className="shrink-0 text-white/70 hover:text-white">x</button>
        </div>
      )}

      {blocked.size > 0 && (
        <div className="mb-2 rounded bg-white/5 px-2 py-1 text-white/60">
          {[...blocked.values()][0]}
        </div>
      )}

      <div className="mb-2 grid grid-cols-2 gap-1">
        {KIND_ORDER.map(kind => {
          const reason = blocked.get(kind);
          return (
            <button
              key={kind}
              type="button"
              disabled={disabled || reason !== undefined}
              title={reason}
              onClick={() => onAssign(kind)}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-white/15 disabled:opacity-30"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cssColor(LABEL_COLORS[kind]) }} />
              <span className={`truncate ${reason === undefined ? "" : "line-through"}`}>{KIND_LABELS[kind]}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={selection === null || selection.kind !== "point"}
        onClick={() => onAssign("outlier")}
        className="mb-3 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-white/15 disabled:opacity-30"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cssColor(LABEL_COLORS.outlier) }} />
        <span>Mark outlier</span>
        <span className="ml-auto text-white/50">single fix only</span>
      </button>

      <div className="mt-3 border-t border-white/10 pt-2">
        <div className="mb-1 text-white/60">
          On this entity: {grouped.length} span{grouped.length === 1 ? "" : "s"}, {outliers.length} outlier{outliers.length === 1 ? "" : "s"}
        </div>
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {grouped.map(label => (
            <div
              key={label.id}
              onClick={() => onSelectLabel(label)}
              title="Select this span"
              className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 ${selectedLabelId === label.id ? "bg-white/20" : "hover:bg-white/10"}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cssColor(LABEL_COLORS[label.kind]) }} />
              <span className="truncate">{KIND_LABELS[label.kind]}</span>
              <span className="truncate text-white/50">{new Date(label.start).toLocaleString()}</span>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onDelete(label.id); }}
                className="ml-auto shrink-0 text-white/50 hover:text-white"
              >
                remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
