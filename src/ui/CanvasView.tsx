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
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    // transparent background so the underlying map can show through

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
      const isEstimate = !!(c as any).estimate;
      const isRaw = !!(c as any).raw;
      const isTransient = !!(c as any).spawnedDuringMovement;
      return { ...c, mean, cov, weight, isEstimate, isRaw, isTransient };
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
    // Prepare draw items with geometry and visual metadata
    const drawItems = processed.map((c, idx) => {
      const x = cx + (c.mean[0] - anchorX) * localZoom;
      const y = cy - (c.mean[1] - anchorY) * localZoom; // y flip
      const { lambda1, lambda2, angle } = eigenDecomposition(c.cov);
      const a = Math.sqrt(Math.max(1e-6, lambda1)) * localZoom;
      const b = Math.sqrt(Math.max(1e-6, lambda2)) * localZoom;
      const color = palette[idx % palette.length] ?? "#5B8CFF";
      const weightAlpha = Math.max(0.06, Math.min(1, c.weight));
      let fillAlpha = Math.max(0.04, Math.min(0.6, weightAlpha * 0.5));
      let strokeAlpha = Math.max(0.12, Math.min(0.9, weightAlpha * 0.9));
      if (c.isEstimate) {
        fillAlpha = Math.max(fillAlpha, 0.06);
        strokeAlpha = Math.max(strokeAlpha, 0.25);
      } else if (c.isRaw) {
        fillAlpha = Math.min(fillAlpha, 0.36);
      }
      if ((c as any).isTransient) {
        fillAlpha = Math.min(fillAlpha, 0.12);
        strokeAlpha = Math.min(strokeAlpha, 0.28);
      }
      const dotSize = Math.max(2, Math.min(6, Math.round((c.isEstimate ? 6 : 4) * localZoom)));
      return { idx, c, x, y, a, b, angle, color, fillAlpha, strokeAlpha, dotSize, lambda1, lambda2 };
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
        ctx.fillStyle = hexToRgba(color, fillAlpha);
        ctx.beginPath();
        ctx.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = c.isEstimate ? 3 : 2;
        ctx.strokeStyle = hexToRgba(color, strokeAlpha);
        ctx.stroke();
        ctx.restore();
      }

// central device dot is now drawn on the label (moved from device center)
    // no center dot is drawn here.

      // Now prepare labels and place them to avoid collisions (radial candidate search)
      const placedRects: { x: number; y: number; w: number; h: number }[] = [];

      for (const item of drawItems) {
        const { x, y, a, b, dotSize, c, lambda1, lambda2 } = item;
        if (!c.isEstimate) continue;
        const accuracyMeters = typeof (c as any).accuracyMeters === "number" ? (c as any).accuracyMeters : Math.round(Math.sqrt(Math.max(lambda1, lambda2)));
        const action = typeof (c as any).action === "string" ? (c as any).action : "still";
        const speedVal = typeof (c as any).speed === "number" ? (c as any).speed : undefined;
        // remove dot separator from label; use the swatch as the device dot instead
        let label = `${accuracyMeters}m ${action}`;
        if (action === "moving" && typeof speedVal === "number") {
          const kmh = speedVal * 3.6;
          const speedText = kmh < 10 ? `${kmh.toFixed(1)} km/h` : `${Math.round(kmh)} km/h`;
          label = `${accuracyMeters}m ${speedText}`;
        }

        const deviceName = String((c as any).deviceName ?? (c as any).device ?? (c as any).source ?? "");
        const paddingX = 8;
        const paddingY = 4;
        const fontSize = 12;
        const deviceFontSize = 11;

        // measure widths
        ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
        const labelWidth = ctx.measureText(label).width;
        ctx.font = `${deviceFontSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
        const deviceWidth = deviceName ? ctx.measureText(deviceName).width : 0;

        // swatch size uses the scaled dot size from the device; add a small gap so bottom-row label doesn't touch the swatch
        const swatchRadius = Math.max(3, Math.round(dotSize));
        const iconsGap = 4; // small gap between swatch and bottom label text
        const leftIconsWidth = swatchRadius * 2 + iconsGap;

        const textWidth = Math.max(labelWidth + 14, deviceWidth);
        const rectW = textWidth + paddingX * 2 + leftIconsWidth;
        const extraNameTop = 4; // additional top padding for device name
        const deviceAreaH = deviceName ? deviceFontSize + paddingY + extraNameTop : 0;
        const labelAreaH = fontSize + paddingY * 2;
        const rectH = deviceAreaH + labelAreaH;

        const ellipseMargin = 4;
        const ellipseRect = { x: x - a - ellipseMargin, y: y - b - ellipseMargin, w: 2 * a + ellipseMargin * 2, h: 2 * b + ellipseMargin * 2 };

        // generate radial candidate positions
        const baseOffset = Math.max(8, Math.round(dotSize) + 8);
        const maxSteps = 6;
        const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI];

        let bestCandidate: { x: number; y: number; conflicts: number; dist: number } | null = null;

        for (let step = 0; step <= maxSteps; step++) {
          const r = baseOffset + step * (rectH + 6);
          for (const angle of angles) {
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

        let finalRect = null as { x: number; y: number; w: number; h: number } | null;
        if (bestCandidate) {
          finalRect = { x: bestCandidate.x, y: bestCandidate.y, w: rectW, h: rectH };
        } else {
          // fallback to right side clamped
          let rectX = x + baseOffset;
          if (rectX + rectW > width) rectX = x - baseOffset - rectW;
          rectX = Math.min(Math.max(rectX, 2), Math.max(2, width - rectW - 2));
          const rectY = Math.min(Math.max(y - rectH / 2, 2), Math.max(2, height - rectH - 2));
          finalRect = { x: rectX, y: rectY, w: rectW, h: rectH };
        }

        // draw label with color swatch
        const candidateRect = finalRect;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fillRect(candidateRect.x, candidateRect.y, candidateRect.w, candidateRect.h);
        ctx.strokeStyle = "rgba(0,0,0,0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(candidateRect.x + 0.5, candidateRect.y + 0.5, candidateRect.w - 1, candidateRect.h - 1);

        // color swatch (main device dot moved from the map center)
        const swatchX = candidateRect.x + paddingX + swatchRadius;
        const swatchY = candidateRect.y + (deviceAreaH + labelAreaH / 2);
        ctx.beginPath();
        ctx.fillStyle = item.color ?? "#5B8CFF";
        ctx.arc(swatchX, swatchY, swatchRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.06)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // pulse border if moving (draw around the label swatch)
        const isMoving = (c as any).action === "moving" || (typeof (c as any).speed === "number" && (c as any).speed > 0.5);
        let pulse = 0;
        if (isMoving) {
          const period = 800; // ms
          pulse = 0.5 + 0.5 * Math.sin((now as number) * (2 * Math.PI) / period + item.idx);
        }
        const outerStrokeW = 1 + 3 * pulse;
        const outerAlpha = 0.65 + 0.35 * pulse;
        if (outerStrokeW > 0) {
          ctx.beginPath();
          ctx.lineWidth = outerStrokeW;
          ctx.strokeStyle = hexToRgba(item.color ?? "#5B8CFF", outerAlpha);
          ctx.arc(swatchX, swatchY, swatchRadius + outerStrokeW / 2 + 1, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Draw device name and label text
        // Place the device name flush with the left padding, while the label text sits after the swatch on the bottom row
        const textXLabel = candidateRect.x + paddingX + leftIconsWidth;
        const textXName = candidateRect.x + paddingX; // allow device name to sit close to label edge
        if (deviceName) {
          ctx.font = `${deviceFontSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#333";
          ctx.fillText(deviceName, textXName, candidateRect.y + extraNameTop + deviceFontSize / 2);
        }

        ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
        ctx.fillStyle = "#111";
        ctx.fillText(label, textXLabel, candidateRect.y + deviceAreaH + labelAreaH / 2);

        placedRects.push(candidateRect);
      }
    }

    // start render loop: if any moving components, animate; else do a single frame
      const hasMoving = drawItems.some((item) => {
        const c = item.c as any;
        return c?.action === "moving" || (typeof c?.speed === "number" && c.speed > 0.5);
      });

      // draw once immediately
      render();
      if (hasMoving) {
        rafId = requestAnimationFrame(render);
      }

      return () => {
        destroyed = true;
        if (rafId != null) cancelAnimationFrame(rafId);
      };  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
};

export default CanvasView;
