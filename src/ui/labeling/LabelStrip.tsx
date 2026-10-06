import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cssColor, LABEL_COLORS, UNLABELED_COLOR } from "@/labels/palette";
import { labelAtFix, labelBoundaryIndices, labelsCovering, outlierAt } from "@/labels/fixes";
import {
  clampScroll, indexAtX, maxScroll, pageIndices, scrollFromWheel, visibleCount, visibleRange, wheelDirection, xForIndex,
} from "@/labels/stripLayout";
import {
  extendSelection, isIndexSelected, selectedFixes, selectionRange, selectionWindow, togglePoint,
} from "@/labels/selection";
import { humanDurationSince } from "@/util/time";
import type { Label, StripFix } from "@/labels/types";
import type { StripSelection } from "@/labels/selection";

const SPACING = 6;
/** Dots are inset past this, which is what keeps them clear of the arrow buttons. */
const PADDING = 46;
export const BAND_HEIGHT = 132;
/** Centred in the band so the dots line up with the arrows. */
const DOT_ROW_Y = BAND_HEIGHT / 2;
const DOT_RADIUS = 2.5;
const SEAM_HALF_HEIGHT = 8;
const BAND_HALF_WIDTH = 4;
const BAND_HALF_HEIGHT = 14;
/**
 * Overlapping dots are filled into an offscreen buffer at full opacity and composited
 * once, so a dense cluster reads as one solid mass rather than a white hot spot where
 * dozens of translucent circles stack. The outlines are then drawn individually, so the
 * individual fixes are still countable.
 */
const UNION_FILL_ALPHA = 0.5;
const OUTLINE_ALPHA = 0.85;
const EASE_TAU_MS = 70;

const TAU = Math.PI * 2;
const DPR = () => window.devicePixelRatio || 1;

type Props = {
  fixes: StripFix[];
  labels: Label[];
  selection: StripSelection;
  hoveredIndex: number | null;
  scrollIndex: number;
  scrollSnap: number;
  loading: boolean;
  onSelectionChange: (selection: StripSelection) => void;
  onHover: (index: number | null) => void;
  onScrollChange: (next: number | ((current: number) => number)) => void;
  onVisibleRangeChange: (first: number, last: number) => void;
  onRequestOlder: () => void;
  onFocusSelection: (fixes: StripFix[]) => void;
};

export function LabelStrip({
  fixes, labels, selection, hoveredIndex, scrollIndex, loading,
  scrollSnap,
  onSelectionChange, onHover, onScrollChange, onVisibleRangeChange, onRequestOlder, onFocusSelection,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverCanvasRef = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<{ x: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [displayScroll, setDisplayScroll] = useState(scrollIndex);
  const displayRef = useRef(scrollIndex);
  const targetRef = useRef(scrollIndex);
  const scrollRef = useRef(scrollIndex);
  const snapRef = useRef(scrollSnap);
  const frameRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  scrollRef.current = scrollIndex;

  const ranges = useMemo(() => labelsCovering(fixes, labels), [fixes, labels]);
  const seams = useMemo(() => labelBoundaryIndices(fixes, labels), [fixes, labels]);

  const geometry = useMemo(
    () => ({ spacing: SPACING, padding: PADDING, viewportWidth: width, total: fixes.length }),
    [width, fixes.length]
  );

  const { first, last } = useMemo(() => visibleRange(geometry, scrollIndex), [geometry, scrollIndex]);
  const displayRange = useMemo(() => visibleRange(geometry, displayScroll), [geometry, displayScroll]);
  const canGoNewer = scrollIndex < maxScroll(geometry);
  const isDrawable = useCallback((x: number) => x >= PADDING && x <= width - PADDING, [width]);

  useEffect(() => {
    targetRef.current = scrollIndex;
    const snapped = scrollSnap !== snapRef.current;
    snapRef.current = scrollSnap;
    if (snapped || Math.abs(scrollIndex - displayRef.current) > visibleCount(geometry) * 4) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      displayRef.current = scrollIndex;
      setDisplayScroll(scrollIndex);
      return;
    }
    if (frameRef.current !== null) return;

    lastFrameRef.current = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(64, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const target = targetRef.current;
      const current = displayRef.current;
      const remaining = target - current;
      if (Math.abs(remaining) < 0.01) {
        displayRef.current = target;
        setDisplayScroll(target);
        frameRef.current = null;
        return;
      }
      const next = current + remaining * (1 - Math.exp(-elapsed / EASE_TAU_MS));
      displayRef.current = next;
      setDisplayScroll(next);
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [scrollIndex, scrollSnap, geometry]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const colorForIndex = useCallback((index: number) => {
    if (outlierAt(fixes, labels, index)) return LABEL_COLORS.outlier;
    const covered = labelAtFix(ranges, fixes, index);
    return covered ? LABEL_COLORS[covered.kind] : UNLABELED_COLOR;
  }, [fixes, labels, ranges]);

  const ensureUnionCanvas = useCallback((targetWidth: number, targetHeight: number, ratio: number) => {
    const canvas = fillCanvasRef.current ?? document.createElement("canvas");
    fillCanvasRef.current = canvas;
    const pixelWidth = Math.max(1, Math.round(targetWidth * ratio));
    const pixelHeight = Math.max(1, Math.round(targetHeight * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    return canvas;
  }, []);

  /**
   * The hover marker lives on its own canvas and is drawn straight from the pointer
   * position, never through React state. Routing it through a state update made it a
   * frame or two behind the cursor, which read as the dot trailing the mouse.
   */
  const drawHoverMarker = useCallback(() => {
    const canvas = hoverCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const ratio = DPR();
    if (canvas.width !== Math.round(canvas.clientWidth * ratio)) canvas.width = Math.round(canvas.clientWidth * ratio);
    if (canvas.height !== Math.round(BAND_HEIGHT * ratio)) canvas.height = Math.round(BAND_HEIGHT * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, canvas.clientWidth, BAND_HEIGHT);

    const pointer = pointerRef.current;
    if (!pointer) return;
    const index = indexAtX(geometry, displayScroll, pointer.x);
    if (index === null) return;
    const x = xForIndex(geometry, displayScroll, index);
    if (!isDrawable(x)) return;

    context.beginPath();
    context.arc(x, DOT_ROW_Y, DOT_RADIUS * 2, 0, TAU);
    context.fillStyle = cssColor(colorForIndex(index), 1);
    context.fill();
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.lineWidth = 1.5;
    context.stroke();
  }, [geometry, displayScroll, isDrawable, colorForIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setWidth(canvas.clientWidth));
    observer.observe(canvas);
    setWidth(canvas.clientWidth);
    return () => observer.disconnect();
  }, []);

  // A fresh entity starts at the newest end, which is the right edge.
  useEffect(() => {
    if (width === 0) return;
    const clamped = clampScroll(geometry, scrollIndex);
    if (clamped !== scrollIndex) onScrollChange(clamped);
  }, [width, geometry, scrollIndex, onScrollChange]);

  useEffect(() => {
    onVisibleRangeChange(first, last);
  }, [first, last, onVisibleRangeChange]);

  // Layout effects, so the dots and the hover marker are redrawn in the same frame as
  // the scroll that moved them rather than a frame later.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const ratio = DPR();
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(BAND_HEIGHT * ratio)) canvas.height = Math.round(BAND_HEIGHT * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, BAND_HEIGHT);

    const visible: { index: number; x: number }[] = [];
    for (let index = displayRange.first; index <= displayRange.last; index += 1) {
      const x = xForIndex(geometry, displayScroll, index);
      if (isDrawable(x)) visible.push({ index, x });
    }

    // Both the fills and the outlines go through this buffer, in two passes, and each
    // pass is composited onto the strip exactly once. Opaque drawing into the buffer
    // overwrites rather than accumulates, so a parked cluster where a hundred circles
    // sit within a few pixels reads as one flat mass with one outline instead of a
    // bright core. Compositing strokes directly onto the strip was the remaining
    // stacking, and it is why dense areas still looked hotter than sparse ones.
    const buffer = ensureUnionCanvas(width, BAND_HEIGHT, ratio);
    const bufferContext = buffer.getContext("2d");
    if (bufferContext) {
      bufferContext.setTransform(ratio, 0, 0, ratio, 0, 0);

      bufferContext.clearRect(0, 0, width, BAND_HEIGHT);
      for (const { index, x } of visible) {
        bufferContext.beginPath();
        bufferContext.arc(x, DOT_ROW_Y, DOT_RADIUS, 0, TAU);
        bufferContext.fillStyle = cssColor(colorForIndex(index), 1);
        bufferContext.fill();
      }
      context.globalAlpha = UNION_FILL_ALPHA;
      context.drawImage(buffer, 0, 0, width, BAND_HEIGHT);

      bufferContext.clearRect(0, 0, width, BAND_HEIGHT);
      bufferContext.lineWidth = 1;
      for (const { index, x } of visible) {
        bufferContext.beginPath();
        bufferContext.arc(x, DOT_ROW_Y, DOT_RADIUS, 0, TAU);
        bufferContext.strokeStyle = cssColor(colorForIndex(index), 1);
        bufferContext.stroke();
      }
      context.globalAlpha = OUTLINE_ALPHA;
      context.drawImage(buffer, 0, 0, width, BAND_HEIGHT);

      context.globalAlpha = 1;
    }

    // Drawn before the seams so a boundary stays visible inside a selection. Not
    // clamped to the drawable area: a highlight at either end stays centred on its dot
    // instead of being dragged inward and covering only half of it.
    const selected = selectionRange(selection);
    if (selected) {
      const from = xForIndex(geometry, displayScroll, selected.from) - BAND_HALF_WIDTH;
      const to = xForIndex(geometry, displayScroll, selected.to) + BAND_HALF_WIDTH;
      context.fillStyle = "rgba(255, 255, 255, 0.16)";
      context.fillRect(from, DOT_ROW_Y - BAND_HALF_HEIGHT, to - from, BAND_HALF_HEIGHT * 2);
    }

    context.strokeStyle = "rgba(255, 255, 255, 0.85)";
    context.lineWidth = 1.5;
    for (const index of seams) {
      const x = xForIndex(geometry, displayScroll, index);
      if (!isDrawable(x)) continue;
      context.beginPath();
      context.moveTo(x, DOT_ROW_Y - SEAM_HALF_HEIGHT);
      context.lineTo(x, DOT_ROW_Y + SEAM_HALF_HEIGHT);
      context.stroke();
    }

    // Selected fixes are drawn opaque and last, so each one is individually visible
    // rather than only being implied by the band behind them.
    if (selected) {
      for (const { index, x } of visible) {
        if (!isIndexSelected(selection, index)) continue;
        context.beginPath();
        context.arc(x, DOT_ROW_Y, DOT_RADIUS + 0.7, 0, TAU);
        context.fillStyle = cssColor(colorForIndex(index), 1);
        context.fill();
        context.strokeStyle = "rgba(255, 255, 255, 0.95)";
        context.lineWidth = 1.2;
        context.stroke();
      }
    }
  }, [
    fixes, labels, seams, selection, geometry, displayScroll, width, displayRange,
    isDrawable, colorForIndex, ensureUnionCanvas,
  ]);

  /**
   * Scrolling moves the dots under a cursor that has not moved, so the hovered fix has
   * to be recomputed from the pointer's screen position. Otherwise the highlight keeps
   * naming a fix that has since slid away.
   */
  useLayoutEffect(() => {
    drawHoverMarker();
  }, [displayScroll, drawHoverMarker]);

  useEffect(() => {
    if (displayScroll !== scrollIndex) return;
    const pointer = pointerRef.current;
    if (!pointer) return;
    const index = indexAtX(geometry, scrollIndex, pointer.x);
    onHover(index !== null && isDrawable(xForIndex(geometry, scrollIndex, index)) ? index : null);
  }, [displayScroll, scrollIndex, geometry, isDrawable, onHover]);

  // Wheel must be a non-passive listener, because the strip absorbs the event rather
  // than letting the page scroll behind it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Older fixes are asked for in the same direction the left arrow uses. Reading the
      // direction out of the shared helper keeps the wheel from disagreeing with itself.
      if (wheelDirection(event.deltaY) < 0 && scrollRef.current <= 0) {
        onRequestOlder();
        return;
      }
      onScrollChange(current => scrollFromWheel(geometry, current, event.deltaY, event.deltaMode));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [geometry, onScrollChange, onRequestOlder]);

  const indexFromEvent = (event: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < PADDING - SPACING || x > width - PADDING + SPACING) return null;
    return indexAtX(geometry, displayScroll, x);
  };

  const info = useMemo(() => {
    if (hoveredIndex === null) return null;
    const fix = fixes[hoveredIndex];
    if (!fix) return null;
    return { fix, label: labelAtFix(ranges, fixes, hoveredIndex), isOutlier: outlierAt(fixes, labels, hoveredIndex) };
  }, [hoveredIndex, fixes, ranges, labels]);

  const readout = useMemo(() => {
    if (loading && fixes.length === 0) return "Loading fixes…";
    if (fixes.length === 0) return "No fixes in this window";
    return describeFix(info, fixes, hoveredIndex) ?? describeSelection(selectionWindow(selection, fixes));
  }, [loading, fixes, info, hoveredIndex, selection]);

  const arrowClass = "absolute top-1/2 -translate-y-1/2 z-10 h-9 w-8 rounded text-lg leading-none transition-colors";

  return (
    <div className="absolute inset-x-0 bottom-0" style={{ height: BAND_HEIGHT }}>
      <div className="relative h-full w-full">
        <canvas
          ref={canvasRef}
          style={{ height: BAND_HEIGHT, touchAction: "none" }}
          className="absolute inset-0 block w-full cursor-crosshair"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const index = indexFromEvent(event);
            if (index === null) return;
            const next = event.shiftKey ? extendSelection(selection, index) : togglePoint(selection, index);
            onSelectionChange(next);
            onFocusSelection(selectedFixes(next, fixes));
          }}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            pointerRef.current = { x: event.clientX - rect.left };
            onHover(indexFromEvent(event));
            drawHoverMarker();
          }}
          onMouseLeave={() => {
            pointerRef.current = null;
            onHover(null);
            drawHoverMarker();
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        />
        <canvas
          ref={hoverCanvasRef}
          style={{ height: BAND_HEIGHT }}
          className="pointer-events-none absolute inset-0 block w-full"
        />

        <button
          type="button"
          aria-label="Older fixes"
          onClick={() => { if (scrollIndex <= 0) onRequestOlder(); else onScrollChange(clampScroll(geometry, scrollIndex - pageIndices(geometry))); }}
          className={`${arrowClass} left-1 bg-black/45 text-white/85 hover:bg-black/70 hover:text-white`}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Newer fixes"
          disabled={!canGoNewer}
          onClick={() => onScrollChange(clampScroll(geometry, scrollIndex + pageIndices(geometry)))}
          className={`${arrowClass} right-1 ${canGoNewer ? "bg-black/45 text-white/85 hover:bg-black/70 hover:text-white" : "bg-black/20 text-white/25 cursor-default"}`}
        >
          ›
        </button>

        {readout !== null && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <div className="rounded bg-black/55 px-3 py-1 text-xs text-white/85 tabular-nums whitespace-nowrap">
              {readout}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function describeFix(
  info: { fix: StripFix; label: Label | null; isOutlier: boolean } | null,
  fixes: StripFix[],
  index: number | null
): string | null {
  if (info === null) return null;

  const { fix, label, isOutlier } = info;
  const time = new Date(fix.timestamp).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  // The gap is the whole reason the strip is index-spaced: a long one is invisible in
  // the spacing, so it has to be stated.
  const previous = index === null ? undefined : fixes[index - 1];
  const gap = previous ? `+${Math.round((fix.timestamp - previous.timestamp) / 1000)}s since previous` : "";
  const kind = isOutlier ? "outlier" : label?.kind ?? "unlabeled";

  return [time, `device ${fix.device}`, `±${fix.accuracy.toFixed(0)}m`, kind, gap].filter(Boolean).join("  ·  ");
}

function describeSelection(
  window: { start: number; end: number; count: number } | null
): string | null {
  if (window === null) return null;

  const time = (timestamp: number) => new Date(timestamp).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const count = window.count === 1 ? "1 fix selected" : `${window.count} fixes selected`;
  const duration = humanDurationSince(window.start, window.end);

  return [count, `${time(window.start)} → ${time(window.end)}`, duration].join("  ·  ");
}
