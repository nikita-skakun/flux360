import React, { useRef, useEffect, useState, useImperativeHandle, forwardRef } from "react";
import type { DevicePoint } from "@/ui/types";

import { getColorForDevice, rgbaString, type Color } from "./color";
import type { DrawItem, Cluster } from "@/util/clustering";
import { CLUSTER_DISTANCE_PX, clusterRadius, computeClusters } from "@/util/clustering";

export type CanvasViewHandle = {
  hitTestPoint: (x: number, y: number) => { items: DevicePoint[]; x: number; y: number } | null;
  getClusters: () => { items: DevicePoint[]; x: number; y: number }[];
  hitTestAnchor: (x: number, y: number) => { anchor: DebugAnchor; x: number; y: number } | null;
};

export type CanvasViewProps = {
  components: DevicePoint[];
  width: number;
  height: number;
  refMeters: { x: number; y: number };
  zoom: number | null;
  fitToBounds: boolean;
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  selectedDeviceId: number | null;
  openClusterPoint: { x: number; y: number } | null;
  debugFrame: DebugFrame | null;
  debugAnchors: DebugAnchor[];
  deviceIcons: Record<number, string>;
  deviceColors: Record<number, string>;
  darkMode: boolean;
  memberDeviceIds: Set<number>;
};

type DebugAnchor = {
  mean: [number, number];
  variance: number;
  type: "active" | "candidate" | "closed" | "frame";
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: number;
  lastUpdateTimestamp: number;
};

type DebugFrame = {
  measurement: { lat: number; lon: number; accuracy: number; mean: [number, number]; variance: number; };
  before: { mean: [number, number]; variance: number; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  after: { mean: [number, number]; variance: number; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  timestamp: number;
};

const CanvasView = forwardRef<CanvasViewHandle, CanvasViewProps>(({ components, width, height, refMeters, zoom, fitToBounds, worldBounds, selectedDeviceId, openClusterPoint, debugFrame, debugAnchors, deviceIcons, deviceColors, darkMode, memberDeviceIds = new Set() }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawItemsRef = useRef<DrawItem[]>([]);
  const clustersRef = useRef<Cluster[]>([]);
  const debugAnchorsRef = useRef<Array<{ anchor: DebugAnchor; x: number; y: number; r: number }>>([]);
  const processedComponentsRef = useRef<DevicePoint[]>([]);

  const [pinOpacity, setPinOpacity] = useState(1);

  const PIN_R = 24;

  useEffect(() => {
    const target = openClusterPoint ? 0.3 : 1;
    let animationId: number;
    const animate = () => {
      setPinOpacity(current => {
        const diff = target - current;
        if (Math.abs(diff) < 0.01) return target;
        animationId = window.requestAnimationFrame(animate);
        return current + diff * 0.1; // slower lerp for smoother fade
      });
    };
    animationId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationId);
  }, [openClusterPoint]);

  useImperativeHandle(ref, () => ({
    hitTestPoint: (px: number, py: number) => {
      const clusters = clustersRef.current.length > 0 ? clustersRef.current : computeClusters(drawItemsRef.current);
      if (clusters.length === 0) return null;
      let best: { cluster: Cluster; dist: number; radius: number } | null = null;
      for (const cl of clusters) {
        const centerDist = Math.hypot(cl.x - px, cl.y - py);
        const centerRadius = cl.radius ?? clusterRadius(cl.size);
        const centerPick = centerRadius + 8;

        // also test the circular pin head above the tip
        const headY = cl.y - (PIN_R * 1.5);
        const headDist = Math.hypot(cl.x - px, headY - py);
        const headPick = PIN_R + 8;

        const centerHit = centerDist <= centerPick;
        const headHit = headDist <= headPick;
        if (!centerHit && !headHit) continue;

        let hitDist = centerHit ? centerDist : headDist;
        let usedRadius = centerHit ? centerRadius : PIN_R;
        if (centerHit && headHit && headDist < centerDist) {
          hitDist = headDist;
          usedRadius = PIN_R;
        }

        if (!best || hitDist < best.dist) best = { cluster: cl, dist: hitDist, radius: usedRadius };
      }
      if (!best) return null;
      // Use processedComponentsRef which already has member devices filtered out
      const items = best.cluster.items
        .map((it) => processedComponentsRef.current[it.idx] ?? ({ device: it.device, mean: [0, 0], variance: 100, lat: 0, lon: 0, timestamp: it.timestamp, accuracy: 0, anchorAgeMs: 0, confidence: 0 } as DevicePoint));
      if (items.length === 0) return null;
      return { items, x: best.cluster.x, y: best.cluster.y };
    },
    getClusters: () => {
      return clustersRef.current.map((cl) => ({ items: cl.items.map((it) => processedComponentsRef.current[it.idx] ?? ({ device: it.device, mean: [0, 0], variance: 100, lat: 0, lon: 0, timestamp: it.timestamp, accuracy: 0, anchorAgeMs: 0, confidence: 0 } as DevicePoint)), x: cl.x, y: cl.y }));
    },
    hitTestAnchor: (px: number, py: number) => {
      if (!debugAnchorsRef.current.length) return null;
      let best: { anchor: DebugAnchor; x: number; y: number; dist: number } | null = null;
      for (const it of debugAnchorsRef.current) {
        const dist = Math.hypot(it.x - px, it.y - py);
        const extra = it.anchor.type === "frame" ? 12 : 6;
        const pick = Math.max(10, it.r + extra);
        if (dist > pick) continue;
        if (!best || dist < best.dist) {
          best = { anchor: it.anchor, x: it.x, y: it.y, dist };
        }
      }
      return best ? { anchor: best.anchor, x: best.x, y: best.y } : null;
    },
  }), []);

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

    let localZoom = zoom ?? 1;
    const processed = components
      .filter(c => !memberDeviceIds?.has(c.device)) // Hide member devices of groups on the map
      .map(c => {
        const mean: [number, number] = Array.isArray(c.mean) && c.mean.length === 2 ? (c.mean as [number, number]) : [0, 0];
        const variance = typeof c.variance === 'number' ? c.variance : 100;
        return { device: c.device, iconText: deviceIcons[c.device] ?? String(c.device).charAt(0).toUpperCase(), timestamp: c.timestamp, mean, variance, radiusMeters: Math.sqrt(Math.max(1e-6, variance)), color: getColorForDevice(c.device, deviceColors[c.device]) };
      });
    
    // Store processed components for hit testing (indices in drawItems refer to this array)
    processedComponentsRef.current = components.filter(c => !memberDeviceIds?.has(c.device));

    let anchorX = refMeters.x;
    let anchorY = refMeters.y;

    if (fitToBounds || zoom == null) {
      if (processed.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of processed) {
          minX = Math.min(minX, p.mean[0]);
          maxX = Math.max(maxX, p.mean[0]);
          minY = Math.min(minY, p.mean[1]);
          maxY = Math.max(maxY, p.mean[1]);
        }
        if (worldBounds) {
          minX = Math.min(minX, worldBounds.minX);
          minY = Math.min(minY, worldBounds.minY);
          maxX = Math.max(maxX, worldBounds.maxX);
          maxY = Math.max(maxY, worldBounds.maxY);
        }
        const widthMeters = Math.max(1, maxX - minX);
        const heightMeters = Math.max(1, maxY - minY);
        localZoom = Math.min((width * 0.86) / widthMeters, (height * 0.86) / heightMeters);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        anchorX = fitToBounds ? centerX : refMeters.x;
        anchorY = fitToBounds ? centerY : refMeters.y;
      } else {
        localZoom = 1;
      }
    } else {
      localZoom = zoom;
    }

    const drawItems = processed.map((p, idx) => ({
      idx,
      device: p.device,
      x: width / 2 + (p.mean[0] - anchorX) * localZoom,
      y: height / 2 - (p.mean[1] - anchorY) * localZoom,
      r: Math.max(1, p.radiusMeters * localZoom + 4),
      iconText: p.iconText,
      timestamp: p.timestamp,
      color: p.color,
    }));

    // stash latest draw items and clusters for hit testing
    drawItemsRef.current = drawItems;
    clustersRef.current = selectedDeviceId == null ? computeClusters(drawItems, CLUSTER_DISTANCE_PX) : computeClusters(drawItems, CLUSTER_DISTANCE_PX).map((cl) => {
      const sel = cl.items.find((it) => it.device === selectedDeviceId);
      return sel ? { ...cl, x: sel.x, y: sel.y } : cl;
    });

    // helper to draw a pin-shaped marker (tip at tipY). Head is drawn as a single path for crisp antialiasing.
    function drawPin(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, iconText: string, iconColor: Color, isSelected = false, badgeText?: string) {
      // overall proportions tuned to SVG
      const bodyHeight = PIN_R * 1.5;
      const headY = tipY - bodyHeight;

      ctx.save();
      ctx.beginPath();

      // head
      ctx.moveTo(tipX - PIN_R, headY);
      ctx.arc(tipX, headY, PIN_R, Math.PI, 0);

      // right side
      ctx.bezierCurveTo(tipX + PIN_R, headY + PIN_R * 0.9, tipX + PIN_R * 0.35, headY + bodyHeight * 0.65, tipX, tipY);

      // left side
      ctx.bezierCurveTo(tipX - PIN_R * 0.35, headY + bodyHeight * 0.65, tipX - PIN_R, headY + PIN_R * 0.9, tipX - PIN_R, headY);

      ctx.closePath();

      // Marker background color: white in light mode, dark gray in dark mode
      ctx.fillStyle = darkMode ? "rgb(40,40,40)" : "rgb(255,255,255)";
      ctx.fill();

      ctx.lineWidth = isSelected ? 3 : 2;
      // Use the device color for the outline
      ctx.strokeStyle = rgbaString(iconColor, 0.7);
      ctx.lineJoin = "round";
      ctx.stroke();

      // icon (material symbol name or fallback letter)
      if (iconText) {
        ctx.save();
        ctx.fillStyle = rgbaString(iconColor, 1);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${PIN_R}px 'Material Symbols Outlined', 'Material Icons', -apple-system, system-ui, Arial`;
        ctx.fillText(String(iconText), tipX, headY + 1);
        ctx.restore();
      }

      // small badge (bottom-right) for cluster size
      if (badgeText) {
        const badgeRadius = 10;
        const bx = tipX + PIN_R * 0.75;
        const by = headY + PIN_R * 0.6;
        ctx.beginPath();
        // Badge background: light gray in light mode, dark gray in dark mode
        ctx.fillStyle = darkMode ? "rgb(30,30,30)" : "rgb(230, 230, 230)";
        ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        // Badge text: black in light mode, white in dark mode
        ctx.fillStyle = darkMode ? "rgb(255,255,255)" : "rgb(0,0,0)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${Math.round(badgeRadius)}px -apple-system, system-ui, Arial`;
        ctx.fillText(String(badgeText), bx, by);
      }

      ctx.restore();
    }

    function shouldHideAt(x: number, y: number) {
      if (!openClusterPoint) return false;
      return Math.hypot(x - openClusterPoint.x, y - openClusterPoint.y) <= 60 || Math.hypot(x - openClusterPoint.x, (y - PIN_R * 1.5) - openClusterPoint.y) <= 60;
    }

    function render() {
      ctx.clearRect(0, 0, width, height);

      // Draw circle highlight for the selected device (if any)
      for (const item of drawItems) {
        const { x, y, r, color } = item;
        if (selectedDeviceId == null || item.device !== selectedDeviceId) continue;

        ctx.save();
        ctx.fillStyle = rgbaString(color, 0.25);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgbaString(color, 0.4);
        ctx.stroke();
        ctx.restore();
      }

      // determine cluster membership
      const clusteredIdxs = new Set<number>();
      for (const cl of clustersRef.current) {
        if (cl.size > 1) for (const it of cl.items) clusteredIdxs.add(it.idx);
      }

      // draw item markers
      for (const item of drawItems) {
        const { x, y, color } = item;
        const isClustered = clusteredIdxs.has(item.idx);
        if (isClustered) {
          // draw clustered dot
          ctx.fillStyle = rgbaString(color, 1);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // unclustered
          if (shouldHideAt(x, y)) {
            ctx.save();
            ctx.globalAlpha = pinOpacity;
            ctx.fillStyle = rgbaString(color, 1);
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          } else {
            drawPin(ctx, x, y, item.iconText, color, selectedDeviceId != null && item.device === selectedDeviceId, undefined);
          }
        }
      }

      // draw cluster markers (pin with icon and count badge)
      for (const cl of clustersRef.current) {
        if (cl.size <= 1) continue;
        // hide cluster marker if the open chooser overlaps it
        const { x, y, size, items } = cl;
        const rep = (selectedDeviceId != null ? items.find(it => it.device === selectedDeviceId) : undefined) ?? items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
        if (shouldHideAt(cl.x, cl.y)) {
          ctx.save();
          ctx.globalAlpha = pinOpacity;
          ctx.fillStyle = rgbaString(rep.color, 1);
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          drawPin(ctx, x, y, rep.iconText, rep.color, selectedDeviceId != null && rep.device === selectedDeviceId, String(size));
        }
      }

      // Debug overlay: draw all anchors for selected device (if any)
      if (debugAnchors.length > 0) {
        debugAnchorsRef.current = [];
        for (const anchor of debugAnchors) {
          const ax = width / 2 + (anchor.mean[0] - anchorX) * localZoom;
          const ay = height / 2 - (anchor.mean[1] - anchorY) * localZoom;
          const anchorRadiusMeters = Math.sqrt(Math.max(1e-6, anchor.variance));
          const anchorR = Math.max(3, anchorRadiusMeters * localZoom);
          debugAnchorsRef.current.push({ anchor, x: ax, y: ay, r: anchorR });
          const stroke = anchor.type === "active" ? 'rgba(0,120,255,0.9)'
            : anchor.type === "candidate" ? 'rgba(255,165,0,0.9)'
              : anchor.type === "frame" ? 'rgba(0,0,200,0.95)'
                : 'rgba(120,120,120,0.7)';
          const fill = anchor.type === "active" ? 'rgba(0,120,255,0.12)'
            : anchor.type === "candidate" ? 'rgba(255,165,0,0.12)'
              : anchor.type === "frame" ? 'rgba(0,0,200,0.12)'
                : 'rgba(120,120,120,0.08)';
          ctx.save();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ax, ay, anchorR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.arc(ax, ay, anchorR, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // Debug overlay: draw measurement, line to anchor, and anchor ellipse for a selected debug frame (if any)
      if (debugFrame) {
        try {
          const df = debugFrame;
          const mean = df.after?.mean ?? df.before?.mean ?? df.measurement.mean;
          const meas = df.measurement.mean;

          const ax = width / 2 + (mean[0] - anchorX) * localZoom;
          const ay = height / 2 - (mean[1] - anchorY) * localZoom;

          const mx = width / 2 + (meas[0] - anchorX) * localZoom;
          const my = height / 2 - (meas[1] - anchorY) * localZoom;

          // approximate anchor ellipse using diagonal variances
          const anchorVariance = df.after?.variance ?? df.before?.variance ?? 100;
          const anchorRadiusMeters = Math.sqrt(Math.max(1e-6, anchorVariance));
          const anchorR = Math.max(3, anchorRadiusMeters * localZoom);
          debugAnchorsRef.current.push({
            anchor: {
              mean: [mean[0], mean[1]],
              variance: anchorVariance,
              type: "frame",
              startTimestamp: df.after?.startTimestamp ?? df.before?.startTimestamp ?? df.timestamp,
              endTimestamp: df.after ? null : df.before?.startTimestamp ?? null,
              confidence: df.after?.confidence ?? df.before?.confidence ?? 0,
              lastUpdateTimestamp: df.after?.lastUpdateTimestamp ?? df.before?.lastUpdateTimestamp ?? df.timestamp,
            },
            x: ax,
            y: ay,
            r: anchorR,
          });

          // measurement accuracy circle
          const measAccMeters = df.measurement.accuracy ?? 0;
          const measR = Math.max(2, (measAccMeters || 5) * localZoom);

          // draw connecting line
          ctx.save();
          ctx.strokeStyle = 'rgba(255,0,0,0.9)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(mx, my);
          ctx.stroke();
          ctx.restore();

          // measurement point
          ctx.save();
          ctx.fillStyle = 'rgba(255,0,0,0.95)';
          ctx.beginPath();
          ctx.arc(mx, my, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.12;
          ctx.beginPath();
          ctx.arc(mx, my, measR, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          // anchor circle
          ctx.save();
          ctx.strokeStyle = 'rgba(0,0,200,0.95)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ax, ay, anchorR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = 'rgba(0,0,200,0.12)';
          ctx.beginPath();
          ctx.arc(ax, ay, anchorR, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } catch {
          // swallow debug drawing errors
        }
      }
    }

    render();

    return () => { };
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds, selectedDeviceId, openClusterPoint, debugFrame, darkMode, memberDeviceIds]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
});

export default React.memo(CanvasView);
