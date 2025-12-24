import React, { useRef, useEffect } from "react";
import type { ComponentUI } from "@/ui/types";
import { eigenDecomposition } from "@/util/gaussian";
import type { Cov2 } from "@/util/gaussian";

// compact color helpers (smaller, easier to read)
function hexToRgba(hex: string, a: number) {
  const h = (hex || "").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hexTintRgba(hex: string, factor = 0.2, alpha = 1) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return hexToRgba(hex, alpha);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (n: number) => Math.round(Math.min(255, Math.max(0, n + (255 - n) * factor)));
  return `rgba(${blend(r)}, ${blend(g)}, ${blend(b)}, ${alpha})`;
}

const DEFAULT_PALETTE = ["#5B8CFF", "#60D394", "#FFD36E", "#FF8560", "#C77DFF", "#60C6FF"];



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
    const ctx = canvas.getContext("2d")!;

    // handle high-DPI displays (draw in device pixels, scale ctx for CSS pixels)
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    // scale context so that drawing uses CSS pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    let cx = width / 2;
    let cy = height / 2;
    let localZoom = zoom ?? 1;
    const processed = components.map((c, idx) => {
      const mean: [number, number] = Array.isArray(c.mean) && c.mean.length === 2 ? (c.mean as [number, number]) : [0, 0];
      const cov: Cov2 = Array.isArray(c.cov) && c.cov.length === 3 ? (c.cov as Cov2) : typeof c.accuracy === "number" ? [c.accuracy ** 2, 0, c.accuracy ** 2] : [100, 0, 100];
      const weight = typeof c.weight === "number" ? c.weight : 1;
      const isEstimate = !!(c as any).estimate;
      const isRaw = !!(c as any).raw;
      const isTransient = !!(c as any).spawnedDuringMovement;
      let lambda1 = 0, lambda2 = 0, angle = 0;
      try {
        const ed = eigenDecomposition(cov);
        lambda1 = ed.lambda1;
        lambda2 = ed.lambda2;
        angle = ed.angle;
      } catch { }
      const color = String(DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length] || DEFAULT_PALETTE[0]);
      const action = typeof (c as any).action === "string" ? (c as any).action : "still";
      const speedVal = typeof (c as any).speed === "number" ? (c as any).speed : undefined;
      const accuracyMeters = typeof (c as any).accuracyMeters === "number" ? (c as any).accuracyMeters : Math.round(Math.sqrt(Math.max(lambda1, lambda2)));
      // marker size for rendering and clustering
      const dotSize = Math.max(2, Math.min(6, Math.round((isEstimate ? 6 : 4) * localZoom)));
      return { ...c, mean, cov, weight, isEstimate, isRaw, isTransient, lambda1, lambda2, angle, color, accuracyMeters, speed: speedVal, action, dotSize };
    });

    let anchorX = refMeters?.x ?? 0;
    let anchorY = refMeters?.y ?? 0;

    if (fitToBounds || !refMeters || zoom == null) {
      if (processed.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of processed) {
          minX = Math.min(minX, c.mean[0]);
          maxX = Math.max(maxX, c.mean[0]);
          minY = Math.min(minY, c.mean[1]);
          maxY = Math.max(maxY, c.mean[1]);
        }
        if (worldBounds) {
          minX = Math.min(minX, worldBounds.minX);
          minY = Math.min(minY, worldBounds.minY);
          maxX = Math.max(maxX, worldBounds.maxX);
          maxY = Math.max(maxY, worldBounds.maxY);
        }
        const widthMeters = Math.max(1, maxX - minX);
        const heightMeters = Math.max(1, maxY - minY);
        const xScale = (width * 0.86) / widthMeters;
        const yScale = (height * 0.86) / heightMeters;
        localZoom = Math.min(xScale, yScale);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        anchorX = fitToBounds ? centerX : refMeters?.x ?? 0;
        anchorY = fitToBounds ? centerY : refMeters?.y ?? 0;
      } else {
        localZoom = 1;
      }
    } else {
      localZoom = zoom;
    }

    const drawItems = processed.map((c, idx) => {
      const x = cx + (c.mean[0] - anchorX) * localZoom;
      const y = cy - (c.mean[1] - anchorY) * localZoom;
      const lambda1 = c.lambda1 || 0;
      const lambda2 = c.lambda2 || 0;
      const angle = c.angle || 0;
      const a = Math.sqrt(Math.max(1e-6, lambda1)) * localZoom;
      const b = Math.sqrt(Math.max(1e-6, lambda2)) * localZoom;
      const color = String(c.color ?? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]);
      const weightAlpha = Math.max(0.06, Math.min(1, c.weight));
      let fillAlpha = Math.max(0.04, Math.min(0.6, weightAlpha * 0.5));
      let strokeAlpha = Math.max(0.12, Math.min(0.9, weightAlpha * 0.9));
      if (c.isEstimate) {
        fillAlpha = Math.max(fillAlpha, 0.06);
        strokeAlpha = Math.max(strokeAlpha, 0.25);
      } else if (c.isRaw) {
        fillAlpha = Math.min(fillAlpha, 0.36);
      }
      if (c.isTransient) {
        fillAlpha = Math.min(fillAlpha, 0.12);
        strokeAlpha = Math.min(strokeAlpha, 0.28);
      }
      const dotSize = Math.max(2, Math.min(6, Math.round((c.isEstimate ? 6 : 4) * localZoom)));

      // markers only — we don't compute label layout metrics here

      const ellipseRect = { x: x - a - 4, y: y - b - 4, w: 2 * a + 8, h: 2 * b + 8 };
      const baseOffset = Math.max(8, Math.round(dotSize) + 8);

      return {
        idx,
        c,
        x,
        y,
        a,
        b,
        angle,
        color,
        fillAlpha,
        strokeAlpha,
        dotSize,
        ellipseRect,
        baseOffset,
      };
    });

    // Draw ellipses sorted so that larger radii are drawn first (smaller radii on top)
    drawItems.sort((u, v) => Math.max(v.a, v.b) - Math.max(u.a, u.b));

    let rafId: number | null = null;
    let destroyed = false;



    function render(now?: number) {
      if (destroyed) return;
      now = now ?? performance.now();
      ctx.clearRect(0, 0, width, height);

      // draw ellipses
      for (const item of drawItems) {
        const { x, y, a, b, angle, color, fillAlpha, strokeAlpha, c } = item;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = hexToRgba(color, fillAlpha);
        ctx.beginPath();
        ctx.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = c.isEstimate ? 3 : 2;
        ctx.strokeStyle = hexToRgba(color, strokeAlpha);
        ctx.stroke();
        ctx.restore();
      }

      // draw center marker for each component
      for (const item of drawItems) {
        const { x, y, dotSize, color } = item;
        const r = Math.max(2, Math.round(dotSize));
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = String(color);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.06)";
        ctx.stroke();
        ctx.restore();
      }

      // Draw simple pulsing markers for moving estimates (no labels)
      let anyPulse = false;
      for (const item of drawItems) {
        const { x, y, c } = item;
        const isMoving = (c as any).action === "moving" || (typeof (c as any).speed === "number" && (c as any).speed > 0.5);
        if (isMoving) {
          anyPulse = true;
          const period = 800; // ms
          const pulse = 0.5 + 0.5 * Math.sin((now as number) * (2 * Math.PI) / period + item.idx);
          const outerStrokeW = 1 + 3 * pulse;
          const outerAlpha = 0.65 + 0.35 * pulse;
          const pulseRadius = Math.max(1, Math.round(4 + outerStrokeW * 0.5));

          ctx.save();
          ctx.beginPath();
          ctx.lineWidth = outerStrokeW;
          ctx.strokeStyle = hexTintRgba(String(item.color ?? DEFAULT_PALETTE[0]), 0.36, outerAlpha);
          ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Schedule next frame if any items are pulsing
      if (anyPulse && !destroyed) {
        rafId = requestAnimationFrame(render);
      } else {
        rafId = null;
      }
    }

    // draw once immediately; render() will continue to schedule frames while needed
    render();

    return () => {
      destroyed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
};

export default CanvasView;
