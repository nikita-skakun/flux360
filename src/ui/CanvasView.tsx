import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import type { ComponentUI } from "@/ui/types";
import type { Cov2 } from "@/engine/component";


function rgbaFromArr(col: [number, number, number] | undefined, alpha: number) {
  const [r, g, b] = col || [0, 0, 0];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function tintFromArr(col: [number, number, number] | undefined, factor = 0.2, alpha = 1) {
  const blend = (n: number) => Math.round(Math.min(255, Math.max(0, Math.round(n + (255 - n) * factor))));
  const [r, g, b] = col || [0, 0, 0];
  return `rgba(${blend(r)}, ${blend(g)}, ${blend(b)}, ${alpha})`;
}

const DEFAULT_PALETTE: Array<[number, number, number]> = [
  [91, 140, 255],
  [96, 211, 148],
  [255, 211, 110],
  [255, 133, 96],
  [199, 125, 255],
  [96, 198, 255],
];

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
};

export const CanvasView = forwardRef<CanvasViewHandle, Props>(function CanvasView({ width = 800, height = 600, components, refMeters, zoom, fitToBounds = true, worldBounds = null, selectedDeviceId = null }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawItemsRef = useRef<any[]>([]);
  const clustersRef = useRef<{ items: any[]; x: number; y: number; size: number; radius?: number }[]>([]);

  const CLUSTER_DISTANCE_PX = 36; // threshold in screen pixels for grouping markers

  function computeClusters(items: any[], threshold = CLUSTER_DISTANCE_PX) {
    const n = items.length;
    if (n === 0) return [] as { items: any[]; x: number; y: number; size: number }[];
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = items[i].x - items[j].x;
        const dy = items[i].y - items[j].y;
        if (Math.hypot(dx, dy) <= threshold) {
          adj[i]!.push(j);
          adj[j]!.push(i);
        }
      }
    }
    const visited = new Array(n).fill(false);
    const clusters: { items: any[]; x: number; y: number; size: number }[] = [];
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
      const clusterItems = idxs.map((id) => items[id]);
      const avgX = clusterItems.reduce((s, it) => s + it.x, 0) / clusterItems.length;
      const avgY = clusterItems.reduce((s, it) => s + it.y, 0) / clusterItems.length;
      clusters.push({ items: clusterItems, x: avgX, y: avgY, size: clusterItems.length });
    }
    return clusters;
  }

  useImperativeHandle(ref, () => ({
    hitTestPoint: (px: number, py: number) => {
      const clusters = clustersRef.current.length > 0 ? clustersRef.current : computeClusters(drawItemsRef.current);
      if (!clusters || clusters.length === 0) return null;
      let best: { cluster: { items: any[]; x: number; y: number; size: number }; dist: number; radius: number } | null = null;
      for (const cl of clusters) {
        const dx = cl.x - px;
        const dy = cl.y - py;
        const dist = Math.hypot(dx, dy);
        const radius = Math.max(8, Math.ceil(6 + Math.sqrt(cl.size) * 6));
        const pickRadius = radius + 8;
        if (dist <= pickRadius) {
          if (!best || dist < best.dist) best = { cluster: cl, dist, radius };
        }
      }
      if (!best) return null;
      return { items: best.cluster.items.map((it) => it.c ?? it), x: best.cluster.x, y: best.cluster.y };
    },
    getClusters: () => {
      return clustersRef.current.map((cl) => ({ items: cl.items.map((it) => it.c ?? it), x: cl.x, y: cl.y }));
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
      // derive radial uncertainty from covariance diagonals (avoid full eigen decomposition)
      const diagMax = Math.max((cov?.[0] ?? 0), (cov?.[2] ?? 0));
      const radiusMeters = Math.sqrt(Math.max(1e-6, diagMax));
      const color = DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length];
      const action = typeof (c as any).action === "string" ? (c as any).action : "still";
      const speedVal = typeof (c as any).speed === "number" ? (c as any).speed : undefined;
      const accuracyMeters = typeof (c as any).accuracyMeters === "number" ? (c as any).accuracyMeters : Math.round(radiusMeters);
      return { ...c, mean, cov, weight, isEstimate, isRaw, isTransient, radiusMeters, color, accuracyMeters, speed: speedVal, action };
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
      const radiusMeters = (c as any).radiusMeters || 0;
      const r = Math.max(1, radiusMeters * localZoom + 4);
      const color = c.color ?? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length];
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

      // markers only — we don't compute label layout metrics here

      return {
        idx,
        c,
        x,
        y,
        r,
        color,
        fillAlpha,
        strokeAlpha
      };
    });

    // Draw circles sorted so that larger radii are drawn first (smaller radii on top)
    drawItems.sort((u, v) => (v.r || 0) - (u.r || 0));

    // stash latest draw items and clusters for hit testing
    drawItemsRef.current = drawItems;
    // precompute a numeric selected device id to avoid repeated conversions
    const selDeviceNum = selectedDeviceId != null ? Number(selectedDeviceId) : null;
    const computedClusters = computeClusters(drawItems, CLUSTER_DISTANCE_PX).map((cl) => ({ ...cl, radius: Math.max(8, Math.ceil(6 + Math.sqrt(cl.size) * 6)) }));
    const adjustedClusters = selDeviceNum == null ? computedClusters : computedClusters.map((cl) => {
      const sel = cl.items.find((it) => Number((it.c as any)?.device) === selDeviceNum);
      return sel ? { ...cl, x: sel.x, y: sel.y } : cl;
    });
    clustersRef.current = adjustedClusters;

    // Helpers for selection checks (precompute numeric id for faster comparisons)
    const isComponentSelected = (comp: any) => selDeviceNum != null && Number((comp as any)?.device) === selDeviceNum;
    const isItemSelected = (item: any) => isComponentSelected(item.c);

    let rafId: number | null = null;
    let destroyed = false;

    // helper to draw a pin-shaped marker (tip at tipY). Head is moved up so it doesn't overlap target.
    function drawPin(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, iconText?: string, iconColor?: [number, number, number], isSelected = false, badgeText?: string) {
      // position the circular head above the tip so it doesn't overlap the ground point
      const headRadius = 24;
      const headCenterY = tipY - headRadius / 2;
      ctx.beginPath();
      ctx.arc(tipX, headCenterY - headRadius / 2, headRadius, 0, Math.PI * 2);
      ctx.moveTo(tipX + headRadius * 0.6, headCenterY + headRadius * 0.3);
      ctx.quadraticCurveTo(tipX, tipY + headRadius * 0.9, tipX - headRadius * 0.6, headCenterY + headRadius * 0.3);
      ctx.closePath();
      ctx.fillStyle = "rgb(255,255,255)";
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 1;
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      ctx.lineJoin = "round";
      ctx.stroke();

      // icon (material symbol name or fallback letter) — icon is colored by device color, head stays white
      if (iconText) {
        ctx.save();
        ctx.fillStyle = rgbaFromArr(iconColor, 1);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${Math.round((headRadius * 0.9))}px 'Material Symbols Outlined', 'Material Icons', -apple-system, system-ui, Arial`;
        ctx.fillText(String(iconText), tipX, headCenterY - headRadius /2 + 1);
        ctx.restore();
      }

      // small badge (bottom-left) for cluster size
      if (badgeText) {
        const badgeRadius = Math.max(6, Math.round(headRadius * 0.35));
        const bx = tipX - headRadius * 0.6;
        const by = headCenterY + headRadius * 0.5;
        ctx.beginPath();
        ctx.fillStyle = "rgba(0,0,0,0.9)";
        ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${Math.round(badgeRadius)}px -apple-system, system-ui, Arial`;
        ctx.fillText(String(badgeText), bx, by);
      }
    }

    function render(now?: number) {
      if (destroyed) return;
      now = now ?? performance.now();
      ctx.clearRect(0, 0, width, height);

      // Draw circle highlight for the selected device (if any)
      for (const item of drawItems) {
        const { x, y, r, color, fillAlpha, strokeAlpha, c } = item;
        if (!isItemSelected(item)) continue;

        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgbaFromArr(color, fillAlpha);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = c.isEstimate ? 3 : 1;
        ctx.strokeStyle = rgbaFromArr(color, strokeAlpha);
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
        const { x, y, color, c } = item;
        const isSelected = isItemSelected(item);
        const iconText = (c as any)?.emoji ?? ((c as any)?.deviceName ?? (c as any)?.device).toString().charAt(0).toUpperCase();
        drawPin(ctx, x, y, iconText, color, isSelected, undefined);
      }

      // draw cluster markers (pin with icon and count badge)
      for (const cl of clustersRef.current) {
        if (cl.size <= 1) continue;
        const { x, y, size, items } = cl as any;
        const sel = selDeviceNum != null ? items.find((it: any) => Number((it.c as any).device) === selDeviceNum) : undefined;
        const isClusterSelected = !!sel;
        // select icon: selected device if present, otherwise latest by timestamp
        let iconText: string | undefined;
        if (sel) {
          iconText = sel?.c?.emoji ?? ((sel?.c?.deviceName ?? sel?.c?.device)).toString().charAt(0).toUpperCase();
        } else {
          const latest = items.reduce((a: any, b: any) => ((a.c?.timestamp ?? 0) > (b.c?.timestamp ?? 0) ? a : b));
          iconText = latest?.c?.emoji ?? ((latest?.c?.deviceName ?? latest?.c?.device)).toString().charAt(0).toUpperCase();
        }
        const color = items?.[0]?.color ?? DEFAULT_PALETTE[0];
        drawPin(ctx, x, y, iconText, color, isClusterSelected, size);
      }
    }

    render();

    return () => {
      destroyed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [components, width, height, refMeters, zoom, fitToBounds, worldBounds, selectedDeviceId]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", position: "absolute", left: 0, top: 0, width: `${width}px`, height: `${height}px`, pointerEvents: "none", zIndex: 1000 }} />;
});

export default CanvasView;
