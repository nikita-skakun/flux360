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
const ANGLES = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI];

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
      const deviceName = String((c as any).deviceName ?? (c as any).device ?? (c as any).source ?? "");
      const action = typeof (c as any).action === "string" ? (c as any).action : "still";
      const speedVal = typeof (c as any).speed === "number" ? (c as any).speed : undefined;
      const accuracyMeters = typeof (c as any).accuracyMeters === "number" ? (c as any).accuracyMeters : Math.round(Math.sqrt(Math.max(lambda1, lambda2)));
      let label = `${accuracyMeters}m ${action}`;
      if (action === "moving" && speedVal) {
        const kmh = speedVal * 3.6;
        label = `${accuracyMeters}m ${kmh < 10 ? kmh.toFixed(1) : Math.round(kmh)} km/h`;
      }
      return { ...c, mean, cov, weight, isEstimate, isRaw, isTransient, lambda1, lambda2, angle, color, deviceName, label };
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

    const drawItems = processed.map((c, idx) => {
      const x = cx + (c.mean[0] - anchorX) * localZoom;
      const y = cy - (c.mean[1] - anchorY) * localZoom;
      const lambda1 = c.lambda1 || 0;
      const lambda2 = c.lambda2 || 0;
      const angle = c.angle || 0;
      const a = Math.sqrt(Math.max(1e-6, lambda1)) * localZoom;
      const b = Math.sqrt(Math.max(1e-6, lambda2)) * localZoom;
      const color = String(c.color || DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]);
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

      ctx.font = `12px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
      const labelWidth = ctx.measureText((c as any).label || "").width;
      ctx.font = `11px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
      const deviceWidth = (c as any).deviceName ? ctx.measureText((c as any).deviceName).width : 0;

      const swatchRadius = Math.max(3, Math.round(dotSize));
      const leftIconsWidth = swatchRadius * 2 + 4;
      const textWidth = Math.max(labelWidth + 14, deviceWidth);
      const rectW = textWidth + 16 + leftIconsWidth;
      const deviceAreaH = (c as any).deviceName ? 11 + 4 + 4 : 0;
      const labelAreaH = 12 + 8;
      const rectH = deviceAreaH + labelAreaH;
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
        swatchRadius,
        leftIconsWidth,
        rectW,
        rectH,
        deviceAreaH,
        labelAreaH,
        ellipseRect,
        baseOffset,
      };
    });

    // Draw ellipses sorted so that larger radii are drawn first (smaller radii on top)
    drawItems.sort((u, v) => Math.max(v.a, v.b) - Math.max(u.a, u.b));

    let rafId: number | null = null;
    let destroyed = false;

    function rectsIntersect(r1: { x: number; y: number; w: number; h: number }, r2: { x: number; y: number; w: number; h: number }) {
      return !(r1.x + r1.w < r2.x || r1.x > r2.x + r2.w || r1.y + r1.h < r2.y || r1.y > r2.y + r2.h);
    }

    function render(now?: number) {
      if (destroyed) return;
      now = now ?? performance.now();
      ctx.clearRect(0, 0, width, height);

      // draw ellipses
      for (const item of drawItems) {
        const { x, y, a, b, angle, color, fillAlpha, strokeAlpha, c } = item;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = hexToRgba(String(color), fillAlpha);
        ctx.beginPath();
        ctx.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = c.isEstimate ? 3 : 2;
        ctx.strokeStyle = hexToRgba(String(color), strokeAlpha);
        ctx.stroke();
        ctx.restore();
      }

      // Now prepare labels and place them to avoid collisions (radial candidate search)
      const placedRects: { x: number; y: number; w: number; h: number }[] = [];
      let anyPulse = false;

      for (const item of drawItems) {
        const { x, y, a, b, c, swatchRadius, leftIconsWidth, rectW, rectH, deviceAreaH, labelAreaH, ellipseRect, baseOffset, idx } = item;
        if (!c.isEstimate) continue;

        const label = (c as any).label ?? "";
        const deviceName = String((c as any).deviceName ?? "");

        // generate radial candidate positions using precomputed sizes
        let bestCandidate: { x: number; y: number; conflicts: number; dist: number } | null = null;

        for (let step = 0; step <= 4; step++) {
          const r = baseOffset + step * (rectH + 6);
          for (const angle of ANGLES) {
            const dx = r * Math.cos(angle);
            const dy = r * Math.sin(angle);
            let candidateX = dx >= 0 ? x + dx : x + dx - rectW;
            let candidateY = y + dy - rectH / 2;
            // clamp to canvas
            candidateX = Math.min(Math.max(candidateX, 2), Math.max(2, width - rectW - 2));
            candidateY = Math.min(Math.max(candidateY, 2), Math.max(2, height - rectH - 2));

            // skip candidates overlapping the ellipse area
            if (rectsIntersect({ x: candidateX, y: candidateY, w: rectW, h: rectH }, ellipseRect)) continue;

            // count conflicts against already placed label rects
            let conflicts = 0;
            for (const rct of placedRects) {
              if (rectsIntersect({ x: candidateX, y: candidateY, w: rectW, h: rectH }, rct)) conflicts++;
            }

            const dist = Math.hypot(candidateX - (x - rectW / 2), candidateY - (y - rectH / 2));

            if (conflicts === 0) {
              bestCandidate = { x: candidateX, y: candidateY, conflicts: 0, dist };
              break; // ideal candidate
            }

            if (!bestCandidate || conflicts < bestCandidate.conflicts || (conflicts === bestCandidate.conflicts && dist < bestCandidate.dist)) {
              bestCandidate = { x: candidateX, y: candidateY, conflicts, dist };
            }
          }
          if (bestCandidate && bestCandidate.conflicts === 0) break;
        }

        let finalRect = bestCandidate ? { x: bestCandidate.x, y: bestCandidate.y, w: rectW, h: rectH } : { x: Math.min(Math.max(x + baseOffset, 2), width - rectW - 2), y: Math.min(Math.max(y - rectH / 2, 2), height - rectH - 2), w: rectW, h: rectH };

        // draw label with color swatch
        const candidateRect = finalRect;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fillRect(candidateRect.x, candidateRect.y, candidateRect.w, candidateRect.h);
        ctx.strokeStyle = "rgba(0,0,0,0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(candidateRect.x + 0.5, candidateRect.y + 0.5, candidateRect.w - 1, candidateRect.h - 1);

        // color swatch (main device dot moved from the map center)
        const swatchX = candidateRect.x + 8 + swatchRadius;
        const swatchY = candidateRect.y + (deviceAreaH + labelAreaH / 2);
        ctx.beginPath();
        ctx.fillStyle = String(item.color ?? DEFAULT_PALETTE[0]);
        ctx.arc(swatchX, swatchY, swatchRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.06)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // pulse border if moving (draw around the label swatch)
        const isMoving = (c as any).action === "moving" || (typeof (c as any).speed === "number" && (c as any).speed > 0.5);
        if (isMoving) {
          anyPulse = true;
          const period = 800; // ms
          const pulse = 0.5 + 0.5 * Math.sin((now as number) * (2 * Math.PI) / period + item.idx);
          const outerStrokeW = 1 + 3 * pulse;
          const outerAlpha = 0.65 + 0.35 * pulse;
          ctx.beginPath();
          ctx.lineWidth = outerStrokeW;
          // make the pulsing ring sit a bit closer to the swatch and use a slightly tinted color
          const pulseRadius = Math.max(1, swatchRadius + outerStrokeW / 2 - 1);
          ctx.strokeStyle = hexTintRgba(String(item.color ?? DEFAULT_PALETTE[0]), 0.36, outerAlpha);
          ctx.arc(swatchX, swatchY, pulseRadius, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Draw device name and label text
        // Place the device name flush with the left padding, while the label text sits after the swatch on the bottom row
        const textXLabel = candidateRect.x + 8 + leftIconsWidth;
        const textXName = candidateRect.x + 8; // allow device name to sit close to label edge
        if (deviceName) {
          ctx.font = `11px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#333";
          ctx.fillText(deviceName, textXName, candidateRect.y + 4 + 11 / 2);
        }

        ctx.font = `12px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
        ctx.fillStyle = "#111";
        ctx.fillText(label, textXLabel, candidateRect.y + deviceAreaH + labelAreaH / 2);

        placedRects.push(candidateRect);
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
