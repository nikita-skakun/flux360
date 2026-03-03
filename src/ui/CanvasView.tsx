import { CLUSTER_DISTANCE_PX, clusterRadius, computeClusters, type DrawItem, type Cluster } from "@/util/clustering";
import { distanceSquared, getRadiusFromVariance } from "@/util/geo";
import { drawPin, interpolateColor } from "@/util/rendering";
import { getColorForDevice, rgbaString } from "@/util/color";
import React, { useRef, useEffect, useState, useImperativeHandle, forwardRef } from "react";
import type { DevicePoint, MotionSegment, Vec2, DebugAnchor, DebugFrameView as DebugFrame } from "@/types";

export type CanvasViewHandle = {
  hitTestPoint: (x: number, y: number) => { items: DevicePoint[]; x: number; y: number } | null;
  getClusters: () => { items: DevicePoint[]; x: number; y: number }[];
  hitTestAnchor: (x: number, y: number) => { anchor: DebugAnchor; x: number; y: number } | null;
  hitTestMotionSegment: (x: number, y: number) => { segment: MotionSegment; x: number; y: number } | null;
};

export type CanvasViewProps = {
  components: DevicePoint[];
  width: number;
  height: number;
  refMeters: { x: number; y: number };
  zoom: number | null;
  fitToBounds: boolean;
  selectedDeviceId: number | null;
  openClusterPoint: { x: number; y: number } | null;
  debugFrame: DebugFrame | null;
  debugAnchors: DebugAnchor[];
  motionSegments: MotionSegment[];
  deviceIcons: Record<number, string>;
  deviceColors: Record<number, string>;
  darkMode: boolean;
  memberDeviceIds: Set<number>;
};

const CanvasView = forwardRef<CanvasViewHandle, CanvasViewProps>(({ components, width, height, refMeters, zoom, fitToBounds, selectedDeviceId, openClusterPoint, debugFrame, debugAnchors, motionSegments = [], deviceIcons, deviceColors, darkMode, memberDeviceIds = new Set() }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawItemsRef = useRef<DrawItem[]>([]);
  const clustersRef = useRef<Cluster[]>([]);
  const debugAnchorsRef = useRef<Array<{ anchor: DebugAnchor; x: number; y: number; r: number }>>([]);
  const processedComponentsRef = useRef<DevicePoint[]>([]);
  const motionSegmentsRef = useRef<Array<{ segment: MotionSegment; screenPoints: Vec2[] }>>([]);

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
        .map((it) => processedComponentsRef.current[it.idx])
        .filter((c): c is DevicePoint => !!c);
      if (items.length === 0) return null;
      return { items, x: best.cluster.x, y: best.cluster.y };
    },
    getClusters: () => {
      return clustersRef.current.map((cl) => ({
        items: cl.items
          .map((it) => processedComponentsRef.current[it.idx])
          .filter((c): c is DevicePoint => !!c),
        x: cl.x,
        y: cl.y
      }));
    },
    hitTestAnchor: (px: number, py: number) => {
      if (!debugAnchorsRef.current.length) return null;
      let best: { anchor: DebugAnchor; x: number; y: number; distSq: number } | null = null;
      for (const it of debugAnchorsRef.current) {
        const extra = it.anchor.type === "frame" ? 12 : 6;
        const pick = Math.max(10, it.r + extra);
        const distSq = distanceSquared([it.x, it.y], [px, py]);
        if (distSq > pick * pick) continue;
        if (!best || distSq < best.distSq) {
          best = { anchor: it.anchor, x: it.x, y: it.y, distSq };
        }
      }
      return best ? { anchor: best.anchor, x: best.x, y: best.y } : null;
    },
    hitTestMotionSegment: (px: number, py: number) => {
      if (!motionSegmentsRef.current.length) return null;

      const HIT_THRESHOLD = 8;
      let best: { segment: MotionSegment; distSq: number; x: number; y: number } | null = null;

      for (const { segment, screenPoints } of motionSegmentsRef.current) {
        if (screenPoints.length < 2) continue;

        // Simple point-to-segment distance for polyline
        for (let i = 0; i < screenPoints.length - 1; i++) {
          const p1 = screenPoints[i];
          const p2 = screenPoints[i + 1];
          if (!p1 || !p2) continue;

          const x1 = p1[0], y1 = p1[1];
          const x2 = p2[0], y2 = p2[1];

          // distance from point (px,py) to line segment (x1,y1)-(x2,y2)
          const A = px - x1;
          const B = py - y1;
          const C = x2 - x1;
          const D = y2 - y1;

          const dot = A * C + B * D;
          const len_sq = C * C + D * D;
          let param = -1;
          if (len_sq !== 0) param = dot / len_sq;

          let xx, yy;

          if (param < 0) {
            xx = x1;
            yy = y1;
          } else if (param > 1) {
            xx = x2;
            yy = y2;
          } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
          }

          const distSq = distanceSquared([px, py], [xx, yy]);

          if (distSq < HIT_THRESHOLD * HIT_THRESHOLD) {
            if (!best || distSq < best.distSq) {
              best = { segment, distSq, x: xx, y: yy };
            }
          }
        }
      }
      return best ? { segment: best.segment, x: best.x, y: best.y } : null;
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
        const mean: Vec2 = Array.isArray(c.mean) && c.mean.length === 2 ? c.mean : [0, 0];
        const accuracy = typeof c.accuracy === 'number' ? c.accuracy : 10;
        return { device: c.device, iconText: deviceIcons[c.device] ?? String(c.device).charAt(0).toUpperCase(), timestamp: c.timestamp, mean, accuracy, radiusMeters: accuracy, color: getColorForDevice(c.device, deviceColors[c.device]) };
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

    function shouldHideAt(x: number, y: number) {
      if (!openClusterPoint) return false;
      return Math.hypot(x - openClusterPoint.x, y - openClusterPoint.y) <= 60 || Math.hypot(x - openClusterPoint.x, (y - PIN_R * 1.5) - openClusterPoint.y) <= 60;
    }

    function render() {
      ctx.clearRect(0, 0, width, height);

      // Draw motion segments FIRST (as background/below markers)
      motionSegmentsRef.current = [];
      if (motionSegments.length > 0) {
        for (const segment of motionSegments) {
          const screenPoints: Vec2[] = [];
          // Compute bounds while converting points (single pass)
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const point of segment.path) {
            const sx = width / 2 + (point[0] - anchorX) * localZoom;
            const sy = height / 2 - (point[1] - anchorY) * localZoom;
            screenPoints.push([sx, sy]);
            minX = Math.min(minX, sx);
            maxX = Math.max(maxX, sx);
            minY = Math.min(minY, sy);
            maxY = Math.max(maxY, sy);
          }
          motionSegmentsRef.current.push({ segment, screenPoints });

          // Draw the path
          if (screenPoints.length >= 2) {
            // Viewport culling: skip if segment's bounding box is entirely outside viewport
            const margin = 5;
            if (maxX < -margin || minX > width + margin || maxY < -margin || minY > height + margin) {
              continue;
            }

            const isCompleted = segment.endAnchor !== null;
            const opacity = 0.7; // Always 0.7 since there's no selection
            const lineWidth = 3; // Always 3 since there's no selection

            // Start: Red (255,0,0)
            const startColor: [number, number, number] = [255, 0, 0];
            // End: Green (0,255,0) if completed, else Blue (0,0,255)
            const endColor: [number, number, number] = isCompleted ? [0, 200, 100] : [0, 100, 255];

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Draw segment by segment with interpolated color gradient
            const totalSegments = Math.max(1, screenPoints.length - 1);

            for (let i = 0; i < screenPoints.length - 1; i++) {
              const [x1, y1] = screenPoints[i]!;
              const [x2, y2] = screenPoints[i + 1]!;

              const t1 = i / totalSegments;
              const t2 = (i + 1) / totalSegments;

              const c1 = interpolateColor(startColor, endColor, t1);
              const c2 = interpolateColor(startColor, endColor, t2);

              const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
              gradient.addColorStop(0, c1);
              gradient.addColorStop(1, c2);

              ctx.beginPath();
              ctx.strokeStyle = gradient;
              ctx.moveTo(x1, y1);
              ctx.lineTo(x2, y2);
              ctx.stroke();
            }

            ctx.restore();
          }
        }
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
            drawPin(ctx, x, y, PIN_R, item.iconText, color, darkMode, selectedDeviceId != null && item.device === selectedDeviceId, undefined);
          }
        }
      }

      // Debug overlay: draw all anchors for selected device (if any)
      if (debugAnchors.length > 0) {
        debugAnchorsRef.current = [];
        for (const anchor of debugAnchors) {
          const ax = width / 2 + (anchor.mean[0] - anchorX) * localZoom;
          const ay = height / 2 - (anchor.mean[1] - anchorY) * localZoom;
          const anchorRadiusMeters = getRadiusFromVariance(anchor.variance);
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
          const meas = df.measurement.mean;
          const mean = df.anchor?.mean ?? meas;

          const ax = width / 2 + (mean[0] - anchorX) * localZoom;
          const ay = height / 2 - (mean[1] - anchorY) * localZoom;

          const mx = width / 2 + (meas[0] - anchorX) * localZoom;
          const my = height / 2 - (meas[1] - anchorY) * localZoom;

          // approximate anchor ellipse using diagonal variances
          const anchorVariance = df.anchor?.variance ?? 100;
          const anchorRadiusMeters = getRadiusFromVariance(anchorVariance);
          const anchorR = Math.max(3, anchorRadiusMeters * localZoom);
          debugAnchorsRef.current.push({
            anchor: {
              mean: [mean[0], mean[1]],
              variance: anchorVariance,
              type: "frame",
              startTimestamp: df.anchor?.startTimestamp ?? df.timestamp,
              endTimestamp: df.anchor ? null : null,
              confidence: df.anchor?.confidence ?? 0,
              lastUpdateTimestamp: df.anchor?.lastUpdateTimestamp ?? df.timestamp,
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
          drawPin(ctx, x, y, PIN_R, rep.iconText, rep.color, darkMode, selectedDeviceId != null && rep.device === selectedDeviceId, String(size));
        }
      }
    }

    render();

    return () => { };
  }, [components, width, height, refMeters, zoom, fitToBounds, selectedDeviceId, openClusterPoint, debugFrame, motionSegments, darkMode, memberDeviceIds]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none" }} />;
});

export default React.memo(CanvasView);
