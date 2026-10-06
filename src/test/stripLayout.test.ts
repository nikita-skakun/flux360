import { describe, expect, test } from "bun:test";
import {
  clampScroll, indexAtX, maxScroll, normalizeWheelPixels, pageIndices, scrollFromWheel, usableWidth, visibleCount, visibleRange,
  wheelDirection, xForIndex,
} from "@/labels/stripLayout";
import type { StripGeometry } from "@/labels/stripLayout";

const geometry: StripGeometry = { spacing: 8, padding: 40, viewportWidth: 1000, total: 5000 };

describe("wheel direction", () => {
  test("turning the wheel up moves towards newer fixes", () => {
    expect(wheelDirection(-120)).toBe(1);
  });

  test("turning the wheel down moves towards older fixes", () => {
    expect(wheelDirection(120)).toBe(-1);
  });

  test("no movement reads as no movement", () => {
    expect(wheelDirection(0)).toBe(0);
  });

  test("the direction the strip loads older fixes on is the one that walks backwards", () => {
    const middle = clampScroll(geometry, 2000);
    expect(wheelDirection(120)).toBeLessThan(0);
    expect(scrollFromWheel(geometry, middle, 120, 0)).toBeLessThan(middle);
    expect(wheelDirection(-120)).toBeGreaterThan(0);
    expect(scrollFromWheel(geometry, middle, -120, 0)).toBeGreaterThan(middle);
  });
});

describe("strip layout", () => {
  test("usable width excludes the padding on both sides", () => {
    expect(usableWidth(geometry)).toBe(920);
  });

  test("visible count fills the usable width", () => {
    expect(visibleCount(geometry)).toBe(116);
  });

  test("the first dot sits at the padding and the last index cannot scroll past the right edge", () => {
    expect(xForIndex(geometry, 0, 0)).toBe(40);
    expect(clampScroll(geometry, maxScroll(geometry) + 500)).toBe(maxScroll(geometry));
    expect(clampScroll(geometry, -20)).toBe(0);
  });

  test("position and index round-trip", () => {
    for (const index of [0, 1, 57, 4999]) {
      const scroll = clampScroll(geometry, index - 10);
      const x = xForIndex(geometry, scroll, index);
      expect(indexAtX(geometry, scroll, x)).toBe(index);
    }
  });

  test("a click outside the fix range selects nothing", () => {
    expect(indexAtX(geometry, 0, -5000)).toBeNull();
    expect(indexAtX(geometry, maxScroll(geometry), 5000)).toBeNull();
  });

  test("scrolling up moves forward in time and down moves back", () => {
    const middle = clampScroll(geometry, 2000);
    expect(scrollFromWheel(geometry, middle, -100, 0)).toBeGreaterThan(middle);
    expect(scrollFromWheel(geometry, middle, 100, 0)).toBeLessThan(middle);
  });

  test("a wheel pixel moves the same number of dots whatever the viewport", () => {
    const wide: StripGeometry = { ...geometry, viewportWidth: 2000 };
    expect(scrollFromWheel(geometry, 1000, -60, 0)).toBeCloseTo(1000 + 60 / geometry.spacing, 5);
    expect(scrollFromWheel(wide, 1000, -60, 0)).toBeCloseTo(1000 + 60 / geometry.spacing, 5);
  });

  test("line and page wheel modes are normalised to pixels", () => {
    expect(normalizeWheelPixels(geometry, -3, 1)).toBe(-48);
    expect(scrollFromWheel(geometry, 1000, -3, 1)).toBeCloseTo(1000 + 48 / geometry.spacing, 5);
    expect(normalizeWheelPixels(geometry, -1, 2)).toBe(-geometry.viewportWidth);
    expect(scrollFromWheel(geometry, 1000, -1, 2)).toBeCloseTo(1000 + geometry.viewportWidth / geometry.spacing, 5);
  });

  test("scrolling never leaves the range", () => {
    expect(scrollFromWheel(geometry, 0, 100_000, 0)).toBe(0);
    expect(scrollFromWheel(geometry, maxScroll(geometry), -100_000, 0)).toBe(maxScroll(geometry));
  });

  test("an arrow pages about a third of the visible dots", () => {
    expect(pageIndices(geometry)).toBe(39);
    expect(pageIndices({ ...geometry, total: 5 })).toBeGreaterThanOrEqual(1);
  });

  test("the render range includes margin but stays inside the fix count", () => {
    expect(visibleRange(geometry, 0).first).toBe(0);
    const deep = visibleRange(geometry, 2000);
    expect(deep.first).toBeLessThan(2000);
    expect(deep.last).toBeGreaterThan(2000 + visibleCount(geometry) - 1);
    expect(visibleRange(geometry, maxScroll(geometry)).last).toBe(4999);
  });

  test("the dots actually drawn are the slice handed to the map", () => {
    const wide: StripGeometry = { spacing: 6, padding: 46, viewportWidth: 1000, total: 5000 };
    const scroll = 1200;
    const { first, last } = visibleRange(wide, scroll);

    const drawable: number[] = [];
    for (let index = first; index <= last; index += 1) {
      const x = xForIndex(wide, scroll, index);
      if (x >= wide.padding && x <= wide.viewportWidth - wide.padding) drawable.push(index);
    }

    expect(drawable.length).toBeGreaterThan(100);
    expect(drawable[drawable.length - 1]! - drawable[0]! + 1).toBe(drawable.length);
    expect(drawable[0]!).toBeGreaterThanOrEqual(first);
    expect(drawable[drawable.length - 1]!).toBeLessThanOrEqual(last);

    // The leftmost dot must clear a 32px arrow that starts 4px in from the edge.
    expect(xForIndex(wide, scroll, drawable[0]!)).toBeGreaterThan(4 + 32);
    expect(xForIndex(wide, scroll, drawable[drawable.length - 1]!)).toBeLessThan(1000 - 4 - 32);
  });

  test("an empty strip has nothing to render", () => {
    const empty = { ...geometry, total: 0 };
    expect(visibleRange(empty, 0)).toEqual({ first: 0, last: -1 });
    expect(maxScroll(empty)).toBe(0);
    expect(indexAtX(empty, 0, 40)).toBeNull();
  });
});
