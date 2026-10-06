import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store";
import { BAND_HEIGHT, LabelStrip } from "./LabelStrip";
import { LabelPanel } from "./LabelPanel";
import { LABEL_CHUNK_MS, labelFixRange, walkBackForFixes } from "@/labels/fixes";
import { EMPTY_SELECTION, outlierTimestamps, selectPoint, selectedFixes, selectionWindow } from "@/labels/selection";
import type { Label, LabelKind, StripFix } from "@/labels/types";
import type { StripSelection } from "@/labels/selection";

const NO_FIXES: StripFix[] = [];
const NO_LABELS: Label[] = [];

export type PickedFix = { fix: StripFix; seq: number };

type Props = {
  onViewChange: (fixes: StripFix[], hovered: StripFix | null) => void;
  onFocusSelection: (fixes: StripFix[]) => void;
  onSelectedChange: (fixes: StripFix[]) => void;
  picked: PickedFix | null;
};

type PanelSelection =
  | { kind: "segment"; start: number; end: number; count: number }
  | { kind: "point"; timestamp: number; count: number }
  | null;

/**
 * The labelling mode layer. Labels are statements about raw fixes, so the strip reads
 * Traccar history directly rather than engine output. The engine never reads a label.
 */
export function LabelingLayer({ onViewChange, onFocusSelection, onSelectedChange, picked }: Props) {
  const isLabelMode = useStore(state => state.ui.isLabelMode);
  const entityId = useStore(state => state.ui.selectedDeviceId);
  const fixes = useStore(state => (entityId === null ? NO_FIXES : state.historyFixesByEntity[entityId] ?? NO_FIXES));
  const labels = useStore(state => (entityId === null ? NO_LABELS : state.labelsByEntity[entityId] ?? NO_LABELS));
  const lastSeen = useStore(state => (entityId === null ? null : state.entities[entityId]?.lastSeen ?? null));
  const loadLabels = useStore(state => state.loadLabels);
  const loadHistory = useStore(state => state.loadHistory);
  const writeLabel = useStore(state => state.writeLabel);
  const deleteLabel = useStore(state => state.deleteLabel);
  const setLabelError = useStore(state => state.setLabelError);

  const [selection, setSelection] = useState<StripSelection>(EMPTY_SELECTION);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [scrollIndex, setScrollIndex] = useState(Number.MAX_SAFE_INTEGER);
  const [scrollSnap, setScrollSnap] = useState(0);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);

  const windows = useRef(new Map<number, { from: number; to: number }>());
  const prepending = useRef(false);
  const requesting = useRef(false);
  const previousCount = useRef(0);
  const handledPick = useRef(0);

  useEffect(() => {
    previousCount.current = 0;
    prepending.current = false;
    setSelection(EMPTY_SELECTION);
    setHoveredIndex(null);
    setSelectedLabelId(null);
    setScrollIndex(Number.MAX_SAFE_INTEGER);
    setRange(null);
  }, [entityId]);

  useEffect(() => {
    if (!isLabelMode || entityId === null) return;
    void loadLabels(entityId).catch(() => undefined);

    if (windows.current.has(entityId)) return;
    // Anchored on the last fix rather than on now. A device that stopped reporting months
    // ago otherwise opens on an empty window and has to be scrolled back to by hand.
    const to = lastSeen ?? Date.now();
    const from = to - LABEL_CHUNK_MS;
    windows.current.set(entityId, { from, to });
    setLoading(true);
    void loadHistory(entityId, from, to)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [isLabelMode, entityId, lastSeen, loadLabels, loadHistory]);

  // A page loaded backwards is prepended, so the view shifts by however many fixes
  // arrived. Without this the strip would jump under the cursor.
  useEffect(() => {
    const added = fixes.length - previousCount.current;
    previousCount.current = fixes.length;
    if (added > 0 && prepending.current) {
      prepending.current = false;
      setScrollIndex(current => current + added);
      setScrollSnap(token => token + 1);
    }
  }, [fixes.length]);

  const loadOlderPage = useCallback(async (): Promise<boolean> => {
    if (entityId === null) return false;
    const known = windows.current.get(entityId);
    if (!known) return false;

    prepending.current = true;
    let added = 0;
    await walkBackForFixes(known.from, async (from, to) => {
      // Recorded before the request so a failure does not re-ask for the same pages.
      windows.current.set(entityId, { from, to: known.to });
      const before = useStore.getState().historyFixesByEntity[entityId]?.length ?? 0;
      await loadHistory(entityId, from, to);
      added = (useStore.getState().historyFixesByEntity[entityId]?.length ?? 0) - before;
      return added;
    });
    if (added === 0) prepending.current = false;
    return added > 0;
  }, [entityId, loadHistory]);

  const requestOlder = useCallback(async () => {
    if (entityId === null || requesting.current) return;
    requesting.current = true;
    setLoading(true);

    try {
      await loadOlderPage();
    } catch {
      // Nothing was loaded, so the strip simply does not extend.
    } finally {
      requesting.current = false;
      setLoading(false);
    }
  }, [entityId, loadOlderPage]);

  // An error belongs to the attempt that produced it, so it clears as soon as the
  // selection changes and a new attempt is being set up.
  useEffect(() => {
    setLabelError(null);
  }, [selection, setLabelError]);

  // A click on the map selects that one fix, which is how a jump is marked as an outlier
  // without hunting for it in the strip. Sequence numbered, so clicking the same fix
  // twice still counts and a page arriving does not fight the user's selection.
  useEffect(() => {
    if (picked === null || picked.seq === handledPick.current) return;
    handledPick.current = picked.seq;
    const index = fixes.findIndex(other => other.device === picked.fix.device && other.timestamp === picked.fix.timestamp);
    if (index < 0) return;
    setSelectedLabelId(null);
    setSelection(selectPoint(index));
    setHoveredIndex(index);
  }, [picked, fixes]);

  const selectSpan = useCallback(async (label: Label) => {
    if (entityId === null) return;
    const targetEntity = entityId;
    const loaded = () => useStore.getState().historyFixesByEntity[targetEntity] ?? NO_FIXES;
    setLoading(true);

    try {
      while (true) {
        const before = loaded();
        if (before.length === 0 || before[0]!.timestamp <= label.start) break;
        await loadOlderPage().catch(() => false);
        if (useStore.getState().ui.selectedDeviceId !== targetEntity) return;
        const after = loaded();
        if (after.length === before.length || (after[0]?.timestamp ?? Number.POSITIVE_INFINITY) >= before[0]!.timestamp) break;
      }

      const current = loaded();
      const span = labelFixRange(current, label);
      if (span === null) return;
      setSelectedLabelId(label.id);
      setSelection({ anchor: span.first, head: span.last });
      setHoveredIndex(null);
      onFocusSelection(current.slice(span.first, span.last + 1));
      setScrollIndex(span.first);
    } finally {
      setLoading(false);
    }
  }, [entityId, loadOlderPage, onFocusSelection]);

  const handleSelectionChange = useCallback((next: StripSelection) => {
    setSelectedLabelId(null);
    setSelection(next);
  }, []);

  const onVisibleRangeChange = useCallback((first: number, last: number) => {
    setRange(current => (current && current.first === first && current.last === last ? current : { first, last }));
  }, []);

  const visibleFixes = useMemo(() => {
    if (range === null) return NO_FIXES;
    return fixes.slice(range.first, range.last + 1);
  }, [fixes, range]);

  const hoveredFix = hoveredIndex === null ? null : fixes[hoveredIndex] ?? null;

  const selected = useMemo(() => selectedFixes(selection, fixes), [selection, fixes]);

  const isActive = isLabelMode && entityId !== null;

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      event.preventDefault();
      setSelectedLabelId(null);
      setSelection(EMPTY_SELECTION);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  // The map draws the selected fixes in a distinct colour, so it needs them separately
  // from the window it already has.
  useEffect(() => {
    onSelectedChange(isActive ? selected : NO_FIXES);
  }, [isActive, selected, onSelectedChange]);

  // Leaving label mode has to clear the map layer, or the last viewed window's
  // circles would stay drawn over the normal view.
  useEffect(() => {
    onViewChange(isActive ? visibleFixes : NO_FIXES, isActive ? hoveredFix : null);
  }, [isActive, visibleFixes, hoveredFix, onViewChange]);

  const panelSelection: PanelSelection = useMemo(() => {
    const window = selectionWindow(selection, fixes);
    if (window === null) return null;
    if (window.start === window.end) return { kind: "point", timestamp: window.start, count: 1 };
    return { kind: "segment", start: window.start, end: window.end, count: window.count };
  }, [selection, fixes]);

  const onAssign = useCallback((kind: LabelKind) => {
    if (entityId === null) return;

    if (kind === "outlier") {
      const stamps = outlierTimestamps(selection, fixes);
      if (stamps === null) {
        setLabelError("Too many fixes selected to mark individually. Narrow the selection.");
        return;
      }
      // An outlier is a claim about one fix, never a span, so a range produces one
      // label per fix rather than one label covering the range.
      for (const timestamp of stamps) {
        void writeLabel({
          id: crypto.randomUUID(), deviceId: entityId, kind: "outlier",
          start: timestamp, end: timestamp, createdAt: Date.now(),
        }).catch(() => undefined);
      }
      return;
    }

    const span = selectionWindow(selection, fixes);
    if (span === null) return;
    void writeLabel({
      id: crypto.randomUUID(),
      deviceId: entityId,
      kind,
      start: span.start,
      end: span.end,
      createdAt: Date.now(),
    }).catch(() => undefined);
  }, [entityId, selection, fixes, writeLabel, setLabelError]);

  const onDelete = useCallback((id: string) => {
    if (entityId === null) return;
    void deleteLabel(entityId, id).catch(() => undefined);
  }, [entityId, deleteLabel]);

  if (!isLabelMode || entityId === null) return null;

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20">
        <LabelPanel
          entityId={entityId}
          labels={labels}
          selection={panelSelection}
          onAssign={onAssign}
          onDelete={onDelete}
          selectedLabelId={selectedLabelId}
          onSelectLabel={selectSpan}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 z-10">
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 via-black/45 to-transparent"
          style={{ height: BAND_HEIGHT }}
        />
        <LabelStrip
          fixes={fixes}
          labels={labels}
          selection={selection}
          hoveredIndex={hoveredIndex}
          scrollIndex={scrollIndex}
          scrollSnap={scrollSnap}
          loading={loading}
          onSelectionChange={handleSelectionChange}
          onHover={setHoveredIndex}
          onScrollChange={setScrollIndex}
          onVisibleRangeChange={onVisibleRangeChange}
          onRequestOlder={requestOlder}
          onFocusSelection={onFocusSelection}
        />
      </div>
    </>
  );
}
