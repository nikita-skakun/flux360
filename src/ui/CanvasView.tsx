import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import type { ComponentUI } from "@/ui/types";
import type { Cov2 } from "@/engine/component";

import { colorForDevice, rgbaString, type Color } from "./color";

export type CanvasViewHandle = {
  hitTestPoint: (x: number, y: number) => { items: ComponentUI[]; x: number; y: number } | null;
  getClusters: () => { items: ComponentUI[]; x: number; y: number }[];
};

type Props = {
  width?: number;
  height?: number;
  components: ComponentUI[];
  refMeters?: { x: number; y: number }; // reference coordinate (meters) for centering
  zoom?: number; // pixels per meter
  fitToBounds?: boolean; // if true, zoom to fit all components
  worldBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  selectedDeviceId?: number | null;
  openClusterPoint?: { x: number; y: number } | null;
};

export const CanvasView = forwardRef<CanvasViewHandle, Props>(function CanvasView({ width = 800, height = 600, components, refMeters, zoom, fitToBounds = true, worldBounds = null, selectedDeviceId = null, openClusterPoint = null }, ref) {
  type DrawItem = { idx: number; device: number; x: number; y: number; r: number; emoji: string; timestamp: number; color?: [number, number, number]; };
  type Cluster = { items: DrawItem[]; x: number; y: number; size: number; radius: number };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawItemsRef = useRef<DrawItem[]>([]);
  const clustersRef = useRef<Cluster[]>([]);

  const CLUSTER_DISTANCE_PX = 36; // threshold in screen pixels for grouping markers
  const PIN_R = 24; // pin head radius

  function clusterRadius(size: number) {
    return Math.max(8, Math.ceil(6 + Math.sqrt(size) * 6));
  }

  function computeClusters(items: DrawItem[], threshold = CLUSTER_DISTANCE_PX): Cluster[] {
    const n = items.length;
    if (n === 0) return [];
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = items[i]!;
        const b = items[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (Math.hypot(dx, dy) <= threshold) {
          adj[i]!.push(j);
          adj[j]!.push(i);
        }
      }
    }
    const visited = new Array(n).fill(false);
    const clusters: Cluster[] = [];
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const stack = [i];
      visited[i] = true;
      const idxs: number[] = [];
      while (stack.length > 0) {
        const v = stack.pop()!;
        idxs.push(v);
        for (const w of adj[v] || []) {
          if (!visited[w]) {
            visited[w] = true;
            stack.push(w);
          }
        }
      }
      const clusterItems = idxs.map((id) => items[id]!) as DrawItem[];
      const avgX = clusterItems.reduce((s, it) => s + it.x, 0) / clusterItems.length;
      const avgY = clusterItems.reduce((s, it) => s + it.y, 0) / clusterItems.length;
      const size = clusterItems.length;
      const radius = clusterRadius(size);
      clusters.push({ items: clusterItems, x: avgX, y: avgY, size, radius });
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
      const items = best.cluster.items.map((it) => components[it.idx] ?? ({ device: it.device, emoji: it.emoji, timestamp: it.timestamp })) as ComponentUI[];
      if (items.length === 0) return null;
      return { items, x: best.cluster.x, y: best.cluster.y };
    },
    getClusters: () => {
      return clustersRef.current.map((cl) => ({ items: cl.items.map((it) => components[it.idx] ?? ({ device: it.device, emoji: it.emoji, timestamp: it.timestamp })) as ComponentUI[], x: cl.x, y: cl.y }));
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
      const cov: Cov2 = Array.isArray(c.cov) && c.cov.length === 3 ? (c.cov as Cov2) : [100, 0, 100];
      // derive radial uncertainty from covariance diagonals (avoid full eigen decomposition)
      const diagMax = Math.max((cov?.[0] ?? 0), (cov?.[2] ?? 0));
      const radiusMeters = Math.sqrt(Math.max(1e-6, diagMax));
      const color = colorForDevice(c.device);
      return { device: c.device, emoji: c.emoji, timestamp: c.timestamp, mean, cov, radiusMeters, color };
    });

    let anchorX = refMeters?.x ?? 0;
    let anchorY = refMeters?.y ?? 0;

    if (fitToBounds || !refMeters || zoom == null) {
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

    let cx = width / 2;
    let cy = height / 2;
    const drawItems = processed.map((p, idx) => {
      const x = cx + (p.mean[0] - anchorX) * localZoom;
      const y = cy - (p.mean[1] - anchorY) * localZoom;
      const r = Math.max(1, p.radiusMeters * localZoom + 4);
      const color = colorForDevice(p.device);

      return {
        idx,
        device: p.device,
        x,
        y,
        r,
        emoji: p.emoji,
        timestamp: p.timestamp,
        color
      };
    });

    // Draw circles sorted so that larger radii are drawn first (smaller radii on top)
    drawItems.sort((u, v) => (v.r || 0) - (u.r || 0));

    // stash latest draw items and clusters for hit testing
    drawItemsRef.current = drawItems;
    // precompute a numeric selected device id to avoid repeated conversions
    const selDeviceNum = selectedDeviceId != null ? Number(selectedDeviceId) : null;
    const computedClusters = computeClusters(drawItems, CLUSTER_DISTANCE_PX);
    const adjustedClusters = selDeviceNum == null ? computedClusters : computedClusters.map((cl) => {
      const sel = cl.items.find((it) => it.device === selDeviceNum);
      return sel ? { ...cl, x: sel.x, y: sel.y } : cl;
    });
    clustersRef.current = adjustedClusters;

    // consolidated selection helper (accepts item or component-like obj)
    const isSelected = (obj: DrawItem) => selDeviceNum != null && obj.device === selDeviceNum;

    function pickClusterColor(items: DrawItem[], selDeviceNum: number | null) {
      const sel = selDeviceNum != null ? items.find((it) => it.device === selDeviceNum) : undefined;
      if (sel && sel.color) return sel.color;
      if (items && items[0] && items[0].color) return items[0].color;
      // fallback to stable color for the first item if available
      return items && items[0] ? colorForDevice(items[0].device) : colorForDevice(0);
    }

    // helper to draw a pin-shaped marker (tip at tipY). Head is drawn as a single path for crisp antialiasing.
    function drawPin(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, iconText: string, iconColor: Color, isSelected = false, badgeText?: string) {
      const r = PIN_R;

      // overall proportions tuned to SVG
      const bodyHeight = r * 1.5;
      const headY = tipY - bodyHeight;

      ctx.save();
      ctx.beginPath();

      // head
      ctx.moveTo(tipX - r, headY);
      ctx.arc(tipX, headY, r, Math.PI, 0);

      // right side
      ctx.bezierCurveTo(tipX + r, headY + r * 0.9, tipX + r * 0.35, headY + bodyHeight * 0.65, tipX, tipY);

      // left side
      ctx.bezierCurveTo(tipX - r * 0.35, headY + bodyHeight * 0.65, tipX - r, headY + r * 0.9, tipX - r, headY);

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
        ctx.font = `${r}px 'Material Symbols Outlined', 'Material Icons', -apple-system, system-ui, Arial`;
        ctx.fillText(String(iconText), tipX, headY + 1);
        ctx.restore();
      }

      // small badge (bottom-right) for cluster size
      if (badgeText) {
        const badgeRadius = 10;
        const bx = tipX + r * 0.75;
        const by = headY + r * 0.6;
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

    function shouldHideAt(x: number, y: number, radius: number) {
      if (!openClusterPoint) return false;
      const hideRadius = radius + 100;
      return Math.hypot(x - openClusterPoint.x, y - openClusterPoint.y) <= hideRadius;
    }

    function render() {
      ctx.clearRect(0, 0, width, height);

      // Draw circle highlight for the selected device (if any)
      for (const item of drawItems) {
        const { x, y, r, color } = item;
        if (!isSelected(item)) continue;

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

      // draw unclustered item markers (pin with icon)
      for (const item of drawItems) {
        if (clusteredIdxs.has(item.idx)) continue;

        // if cluster chooser is open, hide individual pins that overlap the open point
        if (shouldHideAt(item.x, item.y, item.r ?? 0)) continue;

        const { x, y, color } = item;
        drawPin(ctx, x, y, item.emoji, color, isSelected(item), undefined);
      }

      // draw cluster markers (pin with icon and count badge)
      for (const cl of clustersRef.current) {
        if (cl.size <= 1) continue;
        // hide cluster marker if the open chooser overlaps it
        if (shouldHideAt(cl.x, cl.y, cl.radius ?? clusterRadius(cl.size))) continue;

        const { x, y, size, items } = cl;
        const sel = selDeviceNum != null ? items.find((it: DrawItem) => it.device === selDeviceNum) : undefined;
        const isClusterSelected = !!sel;
        // select icon: selected device if present, otherwise latest by timestamp
        let iconText: string;
        if (sel) {
          iconText = sel.emoji;
        } else {
          const latest = items.reduce((a: DrawItem, b: DrawItem) => (a.timestamp > b.timestamp ? a : b));
          iconText = latest.emoji;
        }
        const color = pickClusterColor(items, selDeviceNum);
        drawPin(ctx, x, y, iconText, color, isClusterSelected, String(size));
      }
    }

    render();

    return () => { };
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds, selectedDeviceId, openClusterPoint]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
});

export default CanvasView;
