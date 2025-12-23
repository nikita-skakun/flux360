import React, { useRef, useEffect } from "react";
import type { ComponentUI } from "@/ui/types";
import { eigenDecomposition } from "@/util/gaussian";
import type { Cov2 } from "@/util/gaussian";

type Props = {
  width?: number;
  height?: number;
  components: ComponentUI[];
  refMeters?: { x: number; y: number }; // reference coordinate (meters) for centering
  zoom?: number; // pixels per meter
  fitToBounds?: boolean; // if true, zoom to fit all components
  worldBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

export const CanvasView: React.FC<Props> = ({ width = 800, height = 600, components, refMeters, zoom, fitToBounds = true, worldBounds = null }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    // transparent background so the underlying map can show through

    // compute bounding box to auto-scale and center components if refMeters/zoom not provided
    const defaultCenterX = 0;
    const defaultCenterY = 0;
    let cx = width / 2;
    let cy = height / 2;
    let localZoom = zoom ?? 1;
    // normalize components for calculations (mean/cov/weight)
    const processed = components.map((c) => {
      const mean: [number, number] =
        Array.isArray(c.mean) && c.mean.length === 2 && typeof c.mean[0] === "number" && typeof c.mean[1] === "number"
          ? (c.mean as [number, number])
          : [0, 0];
      const cov: Cov2 =
        Array.isArray(c.cov) && c.cov.length === 3 && c.cov.every((n) => typeof n === "number")
          ? (c.cov as Cov2)
          : typeof c.accuracy === "number"
          ? [c.accuracy * c.accuracy, 0, c.accuracy * c.accuracy]
          : [100, 0, 100];
      const weight = typeof c.weight === "number" ? c.weight : 1;
      return { ...c, mean, cov, weight };
    });

    let anchorX = refMeters?.x ?? 0;
    let anchorY = refMeters?.y ?? 0;

    if (fitToBounds || !refMeters || typeof zoom !== "number") {
      if (processed.length > 0) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const c of processed) {
          minX = Math.min(minX, c.mean[0]);
          maxX = Math.max(maxX, c.mean[0]);
          minY = Math.min(minY, c.mean[1]);
          maxY = Math.max(maxY, c.mean[1]);
        }
        // If a worldBounds prop is provided, use that for the extents
        if (worldBounds) {
          minX = Math.min(minX, worldBounds.minX);
          minY = Math.min(minY, worldBounds.minY);
          maxX = Math.max(maxX, worldBounds.maxX);
          maxY = Math.max(maxY, worldBounds.maxY);
        }
        const widthMeters = Math.max(1, maxX - minX);
        const heightMeters = Math.max(1, maxY - minY);
        const pad = 0.86; // leave some padding
        // Compute maximum radius from covariances so a very large uncertainty doesn't blow up the zoom
        let maxRadiusMeters = 0;
        for (const c of processed) {
          try {
            const { lambda1, lambda2 } = eigenDecomposition(c.cov);
            const r = Math.sqrt(Math.max(lambda1, lambda2));
            if (r > maxRadiusMeters) maxRadiusMeters = r;
          } catch (e) {
            // ignore invalid covariance
          }
        }
        // Compute scale independently for X and Y to preserve aspect ratio
        const xScale = (width * pad) / widthMeters;
        const yScale = (height * pad) / heightMeters;
        localZoom = Math.min(xScale, yScale);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        // Determine anchor: if fitToBounds, center on bounding center; otherwise use refMeters or 0.
        anchorX = fitToBounds ? centerX : refMeters?.x ?? 0;
        anchorY = fitToBounds ? centerY : refMeters?.y ?? 0;
        cx = width / 2;
        cy = height / 2;
      } else {
        localZoom = 1;
      }
    } else {
      localZoom = zoom;
      cx = width / 2;
      cy = height / 2;
    }

    const hexToRgba = (h: string, a: number) => {
      const hex = h.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const bb = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${bb}, ${a})`;
    };
    const palette = ["#5B8CFF", "#60D394", "#FFD36E", "#FF8560", "#C77DFF", "#60C6FF"];
    for (const [idx, c] of processed.entries()) {
      const x = cx + (c.mean[0] - anchorX) * localZoom;
      const y = cy - (c.mean[1] - anchorY) * localZoom; // y flip
      // eigen-decompose covariance to get axis lengths and rotation
      const { lambda1, lambda2, angle } = eigenDecomposition(c.cov);
      const a = Math.sqrt(Math.max(1e-6, lambda1)) * localZoom; // avoid zero sizes
      const b = Math.sqrt(Math.max(1e-6, lambda2)) * localZoom;

      ctx.save();
      // Color palette by source/index
      const color = palette[idx % palette.length] ?? "#5B8CFF";
      const weightAlpha = Math.max(0.06, Math.min(1, c.weight));
      const fillAlpha = Math.max(0.04, Math.min(0.6, weightAlpha * 0.5));
      const strokeAlpha = Math.max(0.12, Math.min(0.9, weightAlpha * 0.9));
      ctx.globalAlpha = 1;
      ctx.fillStyle = hexToRgba(color, fillAlpha);
      // Draw rotated ellipse fill
      ctx.beginPath();
      ctx.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
      ctx.fill();
      // Draw border for ellipse (slightly more opaque)
      ctx.lineWidth = 2;
      ctx.strokeStyle = hexToRgba(color, strokeAlpha);
      ctx.stroke();
      // Draw the mean as a small dot so movement is always visible
      ctx.beginPath();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#222";
      const dotSize = Math.max(2, Math.min(6, Math.round(4 * localZoom)));
      ctx.arc(x, y, dotSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
};

export default CanvasView;
