import { useRef, useEffect, useState, useImperativeHandle, forwardRef } from "react";
import type { Cov2 } from "@/ui/types";
import type { DevicePoint } from "@/ui/types";

import { colorForDevice, rgbaString, type Color } from "./color";

export type CanvasViewHandle = {
  hitTestPoint: (x: number, y: number) => { items: DevicePoint[]; x: number; y: number } | null;
  getClusters: () => { items: DevicePoint[]; x: number; y: number }[];
};

type Props = {
  width: number;
  height: number;
  components: DevicePoint[];
  deviceIcons: Record<number, string>;
  refMeters: { x: number; y: number };
  zoom: number | undefined;
  fitToBounds: boolean;
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  selectedDeviceId: number | null;
  openClusterPoint: { x: number; y: number } | null;
};

export const CanvasView = forwardRef<CanvasViewHandle, Props>(function CanvasView({ width = 800, height = 600, components, deviceIcons, refMeters, zoom, fitToBounds = true, worldBounds = null, selectedDeviceId = null, openClusterPoint = null }, ref) {
  type DrawItem = { idx: number; device: number; x: number; y: number; r: number; timestamp: number; iconText: string; color: [number, number, number]; };
  type Cluster = { items: DrawItem[]; x: number; y: number; size: number; radius: number };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawItemsRef = useRef<DrawItem[]>([]);
  const clustersRef = useRef<Cluster[]>([]);

  const [pinOpacity, setPinOpacity] = useState(1);

  const CLUSTER_DISTANCE_PX = 36;
  const PIN_R = 24;

  function clusterRadius(size: number) {
    return Math.max(8, Math.ceil(6 + Math.sqrt(size) * 6));
  }

  useEffect(() => {
    const target = openClusterPoint ? 0.3 : 1;
    let animationId: number;
    const animate = () => {
      setPinOpacity(current => {
        const diff = target - current;
        if (Math.abs(diff) < 0.01) return target;
        animationId = requestAnimationFrame(animate);
        return current + diff * 0.1; // slower lerp for smoother fade
      });
    };
    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [openClusterPoint]);

  function computeClusters(items: DrawItem[], threshold = CLUSTER_DISTANCE_PX): Cluster[] {
    const n = items.length;
    if (n === 0) return [];
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => parent[i]! === i ? i : parent[i]! = find(parent[i]!);
    const union = (i: number, j: number) => { const pi = find(i), pj = find(j); if (pi !== pj) parent[pi]! = pj; };
    const cellSize = threshold;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const item = items[i]!;
      const key = `${Math.floor(item.x / cellSize)},${Math.floor(item.y / cellSize)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
    }
    for (let i = 0; i < n; i++) {
      const item = items[i]!;
      const cellX = Math.floor(item.x / cellSize);
      const cellY = Math.floor(item.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(`${cellX + dx},${cellY + dy}`);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue;
            const other = items[j]!;
            if (Math.hypot(item.x - other.x, item.y - other.y) <= threshold) union(i, j);
          }
        }
      }
    }
    const groups = Array.from({ length: n }, () => [] as DrawItem[]);
    for (let i = 0; i < n; i++) groups[find(i)]!.push(items[i]!);
    const clusters: Cluster[] = [];
    for (let i = 0; i < n; i++) {
      const clusterItems = groups[i]!;
      if (clusterItems.length === 0) continue;
      const avgX = clusterItems.reduce((s, it) => s + it.x, 0) / clusterItems.length;
      const avgY = clusterItems.reduce((s, it) => s + it.y, 0) / clusterItems.length;
      clusters.push({ items: clusterItems, x: avgX, y: avgY, size: clusterItems.length, radius: clusterRadius(clusterItems.length) });
    }
    return clusters;
  }

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
      const items = best.cluster.items.map((it) => components[it.idx] ?? ({ device: it.device, mean: [0, 0], cov: [0, 0, 0], lat: 0, lon: 0, timestamp: it.timestamp })) as DevicePoint[];
      if (items.length === 0) return null;
      return { items, x: best.cluster.x, y: best.cluster.y };
    },
    getClusters: () => {
      return clustersRef.current.map((cl) => ({ items: cl.items.map((it) => components[it.idx] ?? ({ device: it.device, mean: [0, 0], cov: [0, 0, 0], lat: 0, lon: 0, timestamp: it.timestamp })) as DevicePoint[], x: cl.x, y: cl.y }));
    },
  }), [components]);

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
    const processed = components.map(c => {
      const mean: [number, number] = Array.isArray(c.mean) && c.mean.length === 2 ? (c.mean as [number, number]) : [0, 0];
      const cov: Cov2 = Array.isArray(c.cov) && c.cov.length === 3 ? (c.cov) : [100, 0, 100];
      return { device: c.device, iconText: deviceIcons[c.device] ?? String(c.device).charAt(0).toUpperCase(), timestamp: c.timestamp, mean, cov, radiusMeters: Math.sqrt(Math.max(1e-6, Math.max((cov?.[0] ?? 0), (cov?.[2] ?? 0)))), color: colorForDevice(c.device) };
    });

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

      ctx.fillStyle = "rgb(255,255,255)";
      ctx.fill();

      ctx.lineWidth = isSelected ? 3 : 1;
      ctx.strokeStyle = "rgba(0,0,0,0.1)";
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
        ctx.fillStyle = "rgb(230, 230, 230)";
        ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgb(0,0,0)";
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
        const rep = (selectedDeviceId != null ? items.find(it => it.device === selectedDeviceId) : undefined) || items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
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
    }

    render();

    return () => { };
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds, selectedDeviceId, openClusterPoint]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
});

export default CanvasView;
