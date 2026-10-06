import type { Label } from "./types";

/**
 * Labels are written immediately, so undo has to reverse a write rather than restore a
 * snapshot. History therefore holds operations, and undo applies the inverse.
 */
export type LabelOp =
  | { kind: "add"; label: Label }
  | { kind: "remove"; label: Label }
  | { kind: "update"; before: Label; after: Label };

export type LabelIo = {
  add(label: Label): void;
  update(label: Label): boolean;
  remove(entityId: number, id: string): boolean;
};

export function invertOp(op: LabelOp): LabelOp {
  switch (op.kind) {
    case "add": return { kind: "remove", label: op.label };
    case "remove": return { kind: "add", label: op.label };
    case "update": return { kind: "update", before: op.after, after: op.before };
  }
}

export function applyOp(op: LabelOp, io: LabelIo): void {
  switch (op.kind) {
    case "add": {
      io.add(op.label);
      return;
    }
    case "remove": {
      io.remove(op.label.deviceId, op.label.id);
      return;
    }
    case "update": {
      io.update(op.after);
      return;
    }
  }
}

export function applyOpToLabels(labels: Label[], op: LabelOp): Label[] {
  switch (op.kind) {
    case "add": {
      if (!labels.some(existing => existing.id === op.label.id)) return [...labels, op.label];
      return labels.map(existing => (existing.id === op.label.id ? op.label : existing));
    }
    case "remove": return labels.filter(existing => existing.id !== op.label.id);
    case "update": return labels.map(existing => (existing.id === op.after.id ? op.after : existing));
  }
}

export function opEntityId(op: LabelOp): number {
  return op.kind === "update" ? op.after.deviceId : op.label.deviceId;
}

/** The label to send for an op, or null when the op is a removal. */
export function opLabel(op: LabelOp): Label | null {
  return op.kind === "update" ? op.after : op.kind === "add" ? op.label : null;
}

export function pushOp(history: LabelOp[], op: LabelOp): LabelOp[] {
  return [...history, op];
}

export function popUndo(history: LabelOp[]): { history: LabelOp[]; op: LabelOp | null } {
  const op = history[history.length - 1];
  if (!op) return { history, op: null };
  return { history: history.slice(0, -1), op };
}
