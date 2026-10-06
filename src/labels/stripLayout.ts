/**
 * Index-spaced layout for the labelling strip.
 *
 * Dots are placed by fix index, not by time, so a four hour dropout occupies the same
 * width as a four second one. That keeps every fix selectable no matter how sparse the
 * channel is. Time is carried in the readout instead of in the spacing.
 */
export type StripGeometry = {
  spacing: number;
  padding: number;
  viewportWidth: number;
  total: number;
};

const WHEEL_LINE_PIXELS = 16;
const ARROW_FRACTION = 1 / 3;
const RENDER_MARGIN_DOTS = 2;

export function usableWidth(geometry: StripGeometry): number {
  return Math.max(0, geometry.viewportWidth - 2 * geometry.padding);
}

export function visibleCount(geometry: StripGeometry): number {
  return Math.max(1, Math.floor(usableWidth(geometry) / geometry.spacing) + 1);
}

export function maxScroll(geometry: StripGeometry): number {
  return Math.max(0, geometry.total - visibleCount(geometry));
}

export function clampScroll(geometry: StripGeometry, scrollIndex: number): number {
  return Math.min(maxScroll(geometry), Math.max(0, scrollIndex));
}

export function xForIndex(geometry: StripGeometry, scrollIndex: number, index: number): number {
  return geometry.padding + (index - scrollIndex) * geometry.spacing;
}

export function indexAtX(geometry: StripGeometry, scrollIndex: number, x: number): number | null {
  const index = Math.round((x - geometry.padding) / geometry.spacing + scrollIndex);
  if (index < 0 || index >= geometry.total) return null;
  return index;
}

export function visibleRange(geometry: StripGeometry, scrollIndex: number): { first: number; last: number } {
  if (geometry.total === 0) return { first: 0, last: -1 };
  const centre = Math.floor(scrollIndex);
  return {
    first: Math.max(0, centre - RENDER_MARGIN_DOTS),
    last: Math.min(geometry.total - 1, centre + visibleCount(geometry) + RENDER_MARGIN_DOTS),
  };
}

export function pageIndices(geometry: StripGeometry): number {
  return Math.max(1, Math.round(visibleCount(geometry) * ARROW_FRACTION));
}

/**
 * Which way the wheel is being turned. Positive is towards newer fixes, negative towards
 * older, and zero is no movement at all.
 *
 * The strip has to agree with itself about this. The wheel and the arrow buttons move
 * along the same axis, and when they disagreed the strip walked backwards through time
 * while the wheel was being turned the other way.
 */
export function wheelDirection(deltaY: number): number {
  if (deltaY === 0) return 0;
  return deltaY < 0 ? 1 : -1;
}

export function normalizeWheelPixels(geometry: StripGeometry, deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PIXELS;
  if (deltaMode === 2) return deltaY * geometry.viewportWidth;
  return deltaY;
}

/**
 * The wheel moves the strip by the pixels it reports, divided by the dot spacing, so the
 * timeline scrolls like a normal document instead of by a fraction of the viewport. A
 * trackpad's many small deltas and a ridge wheel's single notch then cover distance in
 * the same proportion, and neither snaps a quarter of the window at a time.
 */
export function scrollFromWheel(
  geometry: StripGeometry,
  scrollIndex: number,
  deltaY: number,
  deltaMode: number
): number {
  const pixels = normalizeWheelPixels(geometry, deltaY, deltaMode);
  return clampScroll(geometry, scrollIndex - pixels / geometry.spacing);
}
