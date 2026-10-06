import { describe, expect, test } from "bun:test";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { MIN_LABEL_CIRCLE_RADIUS_PX, accuracyRadiusPixels, labelCirclePaint } from "@/ui/labeling/labelLayers";
import type { LabelCircleStyle } from "@/ui/labeling/labelLayers";

/**
 * MapLibre rejects a style outright and throws out of the layer setup when an expression
 * breaks its rules, which removes every layer, not just the offending one. The rules are
 * subtle enough that only its own validator is worth trusting, so these cases run the
 * real one rather than checking the expression by eye.
 */
function styleWith(paint: ReturnType<typeof labelCirclePaint>) {
  return {
    version: 8 as const,
    sources: {
      labels: { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } },
    },
    layers: [{ id: "label-circles", type: "circle" as const, source: "labels", paint }],
  };
}

const VARIANTS: LabelCircleStyle[] = [
  // The base layer reads its colour off the feature, so it can show the label each fix
  // carries. The selected and hovered layers stay a fixed colour.
  { color: ["get", "color"], fillOpacity: 0.1, strokeWidth: 1, strokeOpacity: 0.35 },
  { color: "#334155", fillOpacity: 0.1, strokeWidth: 1, strokeOpacity: 0.35 },
  { color: "#22d3ee", fillOpacity: 0.16, strokeWidth: 1.5, strokeOpacity: 0.9 },
  { color: "#ffffff", fillOpacity: 0.2, strokeWidth: 2, strokeOpacity: 0.9 },
];

describe("label circle layers", () => {
  test("the style spec accepts every label circle layer", () => {
    for (const variant of VARIANTS) {
      expect(validateStyleMin(styleWith(labelCirclePaint(variant))).map(error => error.message)).toEqual([]);
    }
  });

  test("the radius responds to zoom through a top level interpolate", () => {
    expect(accuracyRadiusPixels[0]).toBe("interpolate");
    expect(accuracyRadiusPixels[1]).toEqual(["exponential", 2]);
    expect(accuracyRadiusPixels[2]).toEqual(["zoom"]);
  });

  test("the floor is applied at every zoom stop", () => {
    const expression: readonly unknown[] = accuracyRadiusPixels;
    const outputs: unknown[] = [];
    for (let index = 4; index < expression.length; index += 2) outputs.push(expression[index]);

    expect(expression[3]).toBe(0);
    expect(expression[expression.length - 2]).toBe(24);
    expect(outputs).toHaveLength(25);

    for (const output of outputs) {
      expect(Array.isArray(output)).toBe(true);
      const [operator, floor] = output as [unknown, unknown];
      expect(operator).toBe("max");
      expect(floor).toBe(MIN_LABEL_CIRCLE_RADIUS_PX);
    }
  });
});
