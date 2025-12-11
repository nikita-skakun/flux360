import React, { useRef, useEffect } from "react";
import type { Component as GComponent } from "../engine/mixture";
import { eigenDecomposition } from "../engine/gaussian";

type Props = {
  width?: number;
  height?: number;
  components: GComponent[];
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
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    // compute bounding box to auto-scale and center components if refMeters/zoom not provided
    const defaultCenterX = 0;
    const defaultCenterY = 0;
    let cx = width / 2;
    let cy = height / 2;
    let localZoom = zoom ?? 1;
    if (fitToBounds || !refMeters || typeof zoom !== "number") {
      if (components.length > 0) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const c of components) {
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
        for (const c of components) {
          try {
            const { lambda1, lambda2 } = eigenDecomposition(c.cov as any);
            const r = Math.sqrt(Math.max(lambda1, lambda2));
            if (r > maxRadiusMeters) maxRadiusMeters = r;
          } catch (e) {
            // ignore
          }
        }
        const minWorldWidth = Math.max(widthMeters, heightMeters);
        localZoom = Math.min(width * pad / minWorldWidth, height * pad / minWorldWidth);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        // Determine anchor: if fitToBounds, center on bounding center; otherwise use refMeters or 0.
        const anchorX = fitToBounds ? centerX : refMeters?.x ?? 0;
        const anchorY = fitToBounds ? centerY : refMeters?.y ?? 0;
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

    for (const c of components) {
      const anchorX = fitToBounds ? (refMeters?.x ?? 0) ?? 0 : refMeters?.x ?? 0;
      const anchorY = fitToBounds ? (refMeters?.y ?? 0) ?? 0 : refMeters?.y ?? 0;
      const x = cx + (c.mean[0] - anchorX) * localZoom;
      const y = cy - (c.mean[1] - anchorY) * localZoom; // y flip
      // eigen-decompose covariance to get axis lengths and rotation
      const { lambda1, lambda2, angle } = eigenDecomposition(c.cov as any);
      const a = Math.sqrt(Math.max(1e-6, lambda1)) * localZoom; // avoid zero sizes
      const b = Math.sqrt(Math.max(1e-6, lambda2)) * localZoom;

      ctx.save();
      ctx.globalAlpha = Math.max(0.05, Math.min(1, c.weight));
      // Color palette by source/index
      const palette = ["#5B8CFF", "#60D394", "#FFD36E", "#FF8560", "#C77DFF", "#60C6FF"];
      const color = palette[(components.indexOf(c) % palette.length)];
      ctx.fillStyle = `${color}`;
      ctx.globalAlpha = Math.max(0.06, Math.min(0.95, c.weight));
      // Draw rotated ellipse fill
      ctx.beginPath();
      ctx.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
      ctx.fill();
      // Draw border for ellipse
      ctx.globalAlpha = Math.max(0.2, Math.min(1, c.weight));
      ctx.lineWidth = 2;
      if (color)
        ctx.strokeStyle = color;
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

  return <canvas ref={canvasRef} width={width} height={height} />;
};

export default CanvasView;
