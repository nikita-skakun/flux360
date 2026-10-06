import type { LabelKind } from "./types";

type Rgb = [number, number, number];

/**
 * One colour per kind, ordered by speed for the movement kinds so a glance at the
 * strip reads as faster or slower. Stationary is deliberately the least saturated
 * thing on the bar, because it is the bulk of most timelines.
 */
export const LABEL_COLORS: Record<LabelKind, Rgb> = {
  stationary: [110, 130, 160],
  walk: [90, 200, 120],
  run: [140, 210, 90],
  bike: [220, 200, 70],
  car: [235, 150, 60],
  bus: [225, 110, 70],
  train: [200, 80, 110],
  plane: [150, 110, 220],
  boat: [80, 170, 210],
  unknown: [150, 150, 150],
  outlier: [235, 70, 70],
  waypoint: [70, 210, 210],
};

/** A fix no label claims yet. */
export const UNLABELED_COLOR: Rgb = [70, 70, 78];

export const KIND_ORDER: LabelKind[] = [
  "stationary", "walk", "run", "bike", "car", "bus", "train", "plane", "boat", "unknown",
];

export const KIND_LABELS: Record<LabelKind, string> = {
  stationary: "Stationary",
  walk: "Walk",
  run: "Run",
  bike: "Bike",
  car: "Car",
  bus: "Bus",
  train: "Train",
  plane: "Plane",
  boat: "Boat",
  unknown: "Unknown (moved)",
  outlier: "Outlier",
  waypoint: "Waypoint",
};

export function cssColor(color: Rgb, alpha = 1): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}
