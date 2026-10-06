import type { ExpressionSpecification } from "@maptiler/sdk";

/** Metres per screen pixel at zoom 0, on the equator. */
const EQUATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 156543.03392;
const DEGREES_TO_RADIANS = Math.PI / 180;
const MAX_ZOOM = 24;

/**
 * The floor, in screen pixels, on how small an accuracy circle may be drawn.
 *
 * Without it a precise fix vanishes once the view is zoomed out far enough to hold a
 * whole trip, which made selecting an entire journey paint nothing at all.
 */
export const MIN_LABEL_CIRCLE_RADIUS_PX = 4;

/** Ground metres spanned by one screen pixel at this zoom and latitude. */
export function metresPerPixel(zoom: number, latitude: number): number {
  return (EQUATOR_METERS_PER_PIXEL_AT_ZOOM_0 / 2 ** zoom) * Math.cos(latitude * DEGREES_TO_RADIANS);
}

function accuracyStopMagnitude(zoom: number): ExpressionSpecification {
  // The same metresPerPixel with the latitude left to the feature, so the floor matches
  // what a click is tested against.
  return [
    "max",
    MIN_LABEL_CIRCLE_RADIUS_PX,
    [
      "/",
      ["get", "radiusMeters"],
      ["*", metresPerPixel(zoom, 0), ["cos", ["*", ["get", "lat"], DEGREES_TO_RADIANS]]],
    ],
  ];
}

/**
 * Accuracy extent in screen pixels.
 *
 * A zoom expression is only legal as the input of a top level interpolate or step, so
 * metres to pixels cannot be written as one continuous formula. It is one stop per zoom
 * level instead, which the exponential interpolation then reproduces exactly, because
 * each level doubles the pixel size. The floor sits inside each stop, so it can only
 * bend the single interval where a circle crosses it.
 */
export const accuracyRadiusPixels: ExpressionSpecification = (() => {
  const stops: (number | ExpressionSpecification)[] = [];
  for (let zoom = 0; zoom <= MAX_ZOOM; zoom += 1) stops.push(zoom, accuracyStopMagnitude(zoom));
  return ["interpolate", ["exponential", 2], ["zoom"], ...stops];
})();

export type LabelCircleStyle = {
  /** A fixed colour, or an expression that reads one off each feature. */
  color: string | ExpressionSpecification;
  fillOpacity: number;
  strokeWidth: number;
  strokeOpacity: number;
};

export function labelCirclePaint(style: LabelCircleStyle) {
  return {
    "circle-color": style.color,
    "circle-opacity": style.fillOpacity,
    "circle-radius": accuracyRadiusPixels,
    "circle-stroke-width": style.strokeWidth,
    "circle-stroke-color": style.color,
    "circle-stroke-opacity": style.strokeOpacity,
  };
}
