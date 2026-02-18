import { ClusterPopup } from "./map/ClusterPopup";
import { degreesToMeters, metersToDegrees } from "@/util/geo";
import { MaptilerLayer } from "@maptiler/leaflet-maptilersdk";
import { PulsingMarker } from "./map/PulsingMarker";
import CanvasView, { type CanvasViewHandle } from "./CanvasView";
import L from "leaflet";
import React, { useEffect, useMemo, useRef, useState, useImperativeHandle } from "react";
import type { DevicePoint, MotionSegment } from "@/types";

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
};

type Props = {
  components: DevicePoint[];
  deviceNames: Record<number, string>;
  deviceIcons: Record<number, string>;
  deviceColors: Record<number, string>;
  refLat: number | null;
  refLon: number | null;
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  height: number | string;
  overlay: React.ReactNode;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  debugFrame?: import("@/engine/engine").DebugFrame | null;
  debugAnchors?: Array<{ mean: [number, number]; variance: number; type: "active" | "candidate" | "closed" | "frame"; startTimestamp: number; endTimestamp: number | null; confidence: number; lastUpdateTimestamp: number }>;
  motionSegments?: MotionSegment[];
  pulsingDeviceIds?: number[];
  maptilerApiKey?: string;
  darkMode: boolean;
  memberDeviceIds: Set<number>;
};

const MapView = React.forwardRef<MapViewHandle, Props>(({ components, refLat, refLon, worldBounds, height, overlay, onSelectDevice, selectedDeviceId, deviceNames, deviceIcons, deviceColors, debugFrame, debugAnchors, motionSegments = [], pulsingDeviceIds, maptilerApiKey, darkMode, memberDeviceIds = new Set() }, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.Layer | null>(null);

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [centerMeters, setCenterMeters] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | null>(null);

  const canvasApiRef = useRef<CanvasViewHandle | null>(null);
  const deviceNamesRef = useRef<Record<number, string>>(deviceNames);
  const [clusterPopup, setClusterPopup] = useState<{ lat: number; lng: number; items: DevicePoint[] } | null>(null);
  const [clusterAnimation, setClusterAnimation] = useState<'idle' | 'entering' | 'visible' | 'exiting'>('idle');
  const clusterAnimationTimerRef = useRef<number | null>(null);
  const CLUSTER_ANIM_MS = 150;
  const [anchorHover, setAnchorHover] = useState<{ x: number; y: number; anchor: NonNullable<Props["debugAnchors"]>[number] } | null>(null);
  const [motionHover, setMotionHover] = useState<{ x: number; y: number; segment: MotionSegment } | null>(null);

  const clusterPopupRef = useRef<{ lat: number; lng: number; items: DevicePoint[] } | null>(null);
  const clusterAnimationRef = useRef<typeof clusterAnimation>('idle');
  const prevMaptilerApiKeyRef = useRef<string | undefined>(undefined);
  const onSelectDeviceRef = useRef(onSelectDevice);

  useEffect(() => {
    clusterPopupRef.current = clusterPopup;
    clusterAnimationRef.current = clusterAnimation;
  }, [clusterPopup, clusterAnimation]);

  useEffect(() => {
    deviceNamesRef.current = deviceNames;
  }, [deviceNames]);

  useEffect(() => {
    onSelectDeviceRef.current = onSelectDevice;
  }, [onSelectDevice]);

  const openClusterPopupAnimated = (popup: { lat: number; lng: number; items: DevicePoint[] }) => {
    if (clusterAnimationTimerRef.current) {
      window.clearTimeout(clusterAnimationTimerRef.current);
      clusterAnimationTimerRef.current = null;
    }
    clusterPopupRef.current = popup;
    setClusterPopup(popup);
    clusterAnimationRef.current = 'entering';
    setClusterAnimation('entering');
    clusterAnimationTimerRef.current = window.setTimeout(() => {
      clusterAnimationRef.current = 'visible';
      setClusterAnimation('visible');
      clusterAnimationTimerRef.current = null;
    }, 10);
  };

  const closeClusterPopupAnimated = () => {
    if (!clusterPopupRef.current || clusterAnimationRef.current === 'exiting') return;
    if (clusterAnimationTimerRef.current) {
      window.clearTimeout(clusterAnimationTimerRef.current);
      clusterAnimationTimerRef.current = null;
    }
    clusterAnimationRef.current = 'exiting';
    setClusterAnimation('exiting');
    clusterAnimationTimerRef.current = window.setTimeout(() => {
      clusterPopupRef.current = null;
      setClusterPopup(null);
      clusterAnimationRef.current = 'idle';
      setClusterAnimation('idle');
      clusterAnimationTimerRef.current = null;
    }, CLUSTER_ANIM_MS);
  };

  useEffect(() => {
    return () => {
      if (clusterAnimationTimerRef.current) {
        window.clearTimeout(clusterAnimationTimerRef.current);
        clusterAnimationTimerRef.current = null;
      }
      clusterPopupRef.current = null;
      clusterAnimationRef.current = 'idle';
    };
  }, []);

  const refLatRef = useRef<number | null>(refLat);
  const refLonRef = useRef<number | null>(refLon);
  useEffect(() => {
    refLatRef.current = refLat;
    refLonRef.current = refLon;
  }, [refLat, refLon]);

  const prevSelectedRef = useRef<number | null>(selectedDeviceId);
  const skipNextAutoFitRef = useRef(false);
  const selectedZoomedRef = useRef(false);

  const flyDurationForMeters = (meters: number) => {
    const m = Math.max(1, meters);
    const v = Math.log10(m);
    return Math.max(0.25, Math.min(1.5, v * 0.22 + 0.15));
  };

  const componentsRef = useRef(components);
  useEffect(() => { componentsRef.current = components; }, [components]);

  useImperativeHandle(ref, () => ({
    flyToDevice: (id: number) => {
      const map = mapRef.current;
      if (!map || refLatRef.current == null || refLonRef.current == null) return;

      const sel = componentsRef.current.find((c) => Number(c.device) === Number(id));
      if (!sel?.mean) return;

      const deg = metersToDegrees(sel.mean[0], sel.mean[1], refLatRef.current, refLonRef.current);
      const ZOOM_FOR_SELECTED = 18;

      try {
        if (map.stop) map.stop();
        const center = map.getCenter();
        const centerLatLng = L.latLng(center.lat, center.lng);
        const targetLatLng = L.latLng(deg.lat, deg.lon);
        const distMeters = centerLatLng.distanceTo(targetLatLng);

        const dur = flyDurationForMeters(distMeters);
        const targetZoom = Math.max(map.getZoom() || ZOOM_FOR_SELECTED, ZOOM_FOR_SELECTED);

        map.flyTo([deg.lat, deg.lon], targetZoom, { animate: true, duration: dur, easeLinearity: 0.25 });
        // Set this to true so we don't double-animate if selectedDeviceId changes right after
        selectedZoomedRef.current = true;
      } catch {
        // ignore map animation errors
      }
    }
  }));

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pulsingDeviceIds || pulsingDeviceIds.length === 0 || refLatRef.current == null || refLonRef.current == null) return;

    // Defer slightly to allow render to settle if needed, but synchronous is usually fine for map events
    // Logic: Find all selected devices in CURRENT components (latest known positions)
    const points: L.LatLng[] = [];
    for (const id of pulsingDeviceIds) {
      const comp = componentsRef.current.find(c => Number(c.device) === id);
      if (comp?.mean) {
        const deg = metersToDegrees(comp.mean[0], comp.mean[1], refLatRef.current, refLonRef.current);
        points.push(L.latLng(deg.lat, deg.lon));
      }
    }

    if (points.length === 0) return;

    try {
      if (map.stop) map.stop();
      // Use fitBounds for all cases (single or multiple) to ensure consistent behavior
      // maxZoom: 18 allows close zoom for single or clusters of devices
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18, animate: true, duration: 1.5 });
    } catch {
      // ignore map errors
    }
  }, [pulsingDeviceIds]);

  useEffect(() => {
    if (prevSelectedRef.current != null && selectedDeviceId == null) {
      skipNextAutoFitRef.current = true;
    }
    if (prevSelectedRef.current !== selectedDeviceId) selectedZoomedRef.current = false;
    prevSelectedRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  const updateTransform = () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const mpp = 156543.03392804097 * Math.cos((center.lat * Math.PI) / 180) / Math.pow(2, zoom);
      const ppm = 1 / mpp;
      setPixelsPerMeter(ppm);
      if (refLatRef.current != null && refLonRef.current != null) {
        const cm = degreesToMeters(center.lat, center.lng, refLatRef.current, refLonRef.current);
        setCenterMeters(cm);
      } else {
        setCenterMeters({ x: 0, y: 0 });
      }
    } catch {
      // ignore transform update errors
    }
  };

  useEffect(() => {
    const mapContainer = mapDivRef.current;
    if (!mapContainer) return;

    const map = L.map(mapContainer, { attributionControl: true, zoomControl: false, maxZoom: 22 });

    const initialLat = refLatRef.current;
    const initialLon = refLonRef.current;
    if (worldBounds && initialLat != null && initialLon != null) {
      const sw = metersToDegrees(worldBounds.minX, worldBounds.minY, initialLat, initialLon);
      const ne = metersToDegrees(worldBounds.maxX, worldBounds.maxY, initialLat, initialLon);
      try {
        map.fitBounds(L.latLngBounds(L.latLng(sw.lat, sw.lon), L.latLng(ne.lat, ne.lon)), { padding: [40, 40], maxZoom: 18 });
      } catch {
        map.setView([initialLat, initialLon], 15);
      }
    } else if (initialLat != null && initialLon != null) {
      map.setView([initialLat, initialLon], 15);
    } else {
      map.setView([0, 0], 2);
    }

    updateTransform();

    map.on("move", updateTransform);
    map.on("zoom", updateTransform);

    const onMapClick = (ev: L.LeafletMouseEvent) => {
      const pt = map.latLngToContainerPoint(ev.latlng);
      const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
      if (hit?.items?.length) {
        if (hit.items.length === 1) {
          const devKey = hit.items[0]!.device;
          const devNum = Number(devKey);
          if (Number.isFinite(devNum)) onSelectDeviceRef.current(devNum);
          closeClusterPopupAnimated();
        } else {
          const clusterPoint = map.containerPointToLatLng(L.point(hit.x, hit.y));
          try {
            if (map.stop) map.stop();
            const center = map.getCenter();
            const dist = L.latLng(center.lat, center.lng).distanceTo(L.latLng(clusterPoint.lat, clusterPoint.lng));
            if (dist >= 5) {
              const dur = flyDurationForMeters(dist);
              map.flyTo([clusterPoint.lat, clusterPoint.lng], map.getZoom(), { animate: true, duration: dur, easeLinearity: 0.25 });
            }
          } catch {
            // ignore map animation errors
          }
          openClusterPopupAnimated({ lat: clusterPoint.lat, lng: clusterPoint.lng, items: hit.items });
        }
      } else {
        closeClusterPopupAnimated();
      }
    };

    const onMapMove = (ev: L.LeafletMouseEvent) => {
      const pt = map.latLngToContainerPoint(ev.latlng);
      const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
      const anchorHit = canvasApiRef.current?.hitTestAnchor(pt.x, pt.y) ?? null;
      if (anchorHit) {
        setAnchorHover({ x: anchorHit.x, y: anchorHit.y, anchor: anchorHit.anchor });
      } else {
        setAnchorHover(null);
      }

      const motionHit = canvasApiRef.current?.hitTestMotionSegment?.(pt.x, pt.y) ?? null;
      if (motionHit) {
        setMotionHover({ x: motionHit.x, y: motionHit.y, segment: motionHit.segment });
      } else {
        setMotionHover(null);
      }
      
      const container = map.getContainer();
      if (hit?.items?.length) {
        container.style.cursor = "pointer";
        if (hit.items.length === 1) {
          const first = hit.items[0];
          if (first) container.title = deviceNamesRef.current[first.device] ?? String(first.device);
          else container.title = "";
        } else {
          container.title = "";
        }
      } else {
        container.style.cursor = "";
        container.title = "";
      }
    };

    const container = map.getContainer();
    const onMouseLeave = () => {
      container.style.cursor = "";
      container.title = "";
      setAnchorHover(null);
      setMotionHover(null);
    };

    map.on("click", onMapClick);
    map.on("mousemove", onMapMove);
    container.addEventListener("mouseleave", onMouseLeave);

    mapRef.current = map;

    return () => {
      map.off("move", updateTransform);
      map.off("zoom", updateTransform);
      map.off("click", onMapClick);
      map.off("mousemove", onMapMove);
      container.removeEventListener("mouseleave", onMouseLeave);
      // Stop any ongoing animations before removing the map to prevent errors
      if (map.stop) map.stop();

      // Explicitly remove tile layer first to prevent "el is undefined" errors
      if (tileLayerRef.current) {
        try {
          if (map.hasLayer(tileLayerRef.current)) {
            map.removeLayer(tileLayerRef.current);
          }
        } catch {
          // ignore removal errors
        }
        tileLayerRef.current = null;
      }

      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update tile layer when maptilerApiKey changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Optimization: if only changing style (dark mode) and API key matches, try to use setStyle
    // to avoid destroying/recreating the layer which causes animation errors.
    if (tileLayerRef.current &&
      prevMaptilerApiKeyRef.current === maptilerApiKey &&
      maptilerApiKey) {
      try {
        const layer = tileLayerRef.current as InstanceType<typeof MaptilerLayer>;
        layer.setStyle(darkMode ? "dataviz-dark" : "dataviz");
      } catch (e) {
        console.warn("Error updating layer style:", e);
      }
    }

    prevMaptilerApiKeyRef.current = maptilerApiKey;

    // Remove existing tile layer safely
    if (tileLayerRef.current) {
      try {
        if (map.hasLayer(tileLayerRef.current)) {
          map.removeLayer(tileLayerRef.current);
        }
      } catch (e) {
        console.warn("Error removing tile layer:", e);
      }
      tileLayerRef.current = null;
    }

    // Add new tile layer based on API key
    if (maptilerApiKey) {
      try {
        const ml = new MaptilerLayer({
          apiKey: maptilerApiKey,
          style: darkMode ? "dataviz-dark" : "dataviz",
        });
        ml.addTo(map);
        tileLayerRef.current = ml;
      } catch (e) {
        console.error("Error adding tile layer:", e);
      }
    }
  }, [maptilerApiKey, darkMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedDeviceId != null) return;
    if (skipNextAutoFitRef.current) {
      skipNextAutoFitRef.current = false;
      return;
    }

    if (worldBounds && refLat != null && refLon != null) {
      const sw = metersToDegrees(worldBounds.minX, worldBounds.minY, refLat, refLon);
      const ne = metersToDegrees(worldBounds.maxX, worldBounds.maxY, refLat, refLon);
      try {
        map.fitBounds(L.latLngBounds(L.latLng(sw.lat, sw.lon), L.latLng(ne.lat, ne.lon)), { padding: [40, 40], maxZoom: 18 });
      } catch {
        map.setView([refLat, refLon], 15);
      }
    } else if (refLat != null && refLon != null) {
      map.setView([refLat, refLon], 15);
    } else {
      map.setView([0, 0], 2);
    }

    updateTransform();
  }, [refLat, refLon, worldBounds, selectedDeviceId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (selectedDeviceId == null) return;

    const sel = components.find((c) => Number(c.device) === Number(selectedDeviceId));
    if (!sel?.mean || refLat == null || refLon == null)
      return;

    const deg = metersToDegrees(sel.mean[0], sel.mean[1], refLat, refLon);

    try {
      const ZOOM_FOR_SELECTED = 18;
      const PAN_DISTANCE_METERS = 20;

      const center = map.getCenter();
      const centerLatLng = L.latLng(center.lat, center.lng);
      const targetLatLng = L.latLng(deg.lat, deg.lon);
      const distMeters = centerLatLng.distanceTo(targetLatLng);

      if (!selectedZoomedRef.current) {
        if (map.stop) map.stop();
        const targetZoom = Math.max(map.getZoom() || ZOOM_FOR_SELECTED, ZOOM_FOR_SELECTED);
        if (distMeters < 5) {
          map.setZoom(targetZoom, { animate: true });
        } else {
          const dur = flyDurationForMeters(distMeters);
          map.flyTo([deg.lat, deg.lon], targetZoom, { animate: true, duration: dur, easeLinearity: 0.25 });
        }
        selectedZoomedRef.current = true;
      } else {
        if (distMeters > PAN_DISTANCE_METERS) {
          if (map.stop) map.stop();
          const dur = flyDurationForMeters(distMeters);
          map.flyTo([deg.lat, deg.lon], map.getZoom(), { animate: true, duration: dur, easeLinearity: 0.25 });
        }
      }
    } catch {
      // ignore map animation errors
    }
  }, [selectedDeviceId, components, refLat, refLon]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth || 0, height: el.clientHeight || 0 });
      if (mapRef.current) mapRef.current.invalidateSize();
    });
    ro.observe(el);
    setSize({ width: el.clientWidth || 0, height: el.clientHeight || 0 });
    return () => ro.disconnect();
  }, []);

  const clusterPoint = clusterPopup && mapRef.current ? (() => {
    const p = mapRef.current.latLngToContainerPoint(L.latLng(clusterPopup.lat, clusterPopup.lng));
    return { x: p.x, y: p.y };
  })() : null;

  const anchorHoverLabel = useMemo(() => {
    if (!anchorHover) return null;
    const { anchor } = anchorHover;
    const typeLabel = anchor.type === "active" ? "Active" : anchor.type === "candidate" ? "Candidate" : anchor.type === "frame" ? "Frame" : "Closed";
    const started = new Date(anchor.startTimestamp).toLocaleString();
    const ended = anchor.endTimestamp ? new Date(anchor.endTimestamp).toLocaleString() : null;
    const updated = new Date(anchor.lastUpdateTimestamp).toLocaleString();
    return { typeLabel, started, ended, updated, confidence: anchor.confidence };
  }, [anchorHover]);

  const motionHoverLabel = useMemo(() => {
    if (!motionHover) return null;
    const { segment } = motionHover;
    const started = new Date(segment.startAnchor.startTimestamp).toLocaleString();
    const ended = segment.endAnchor ? new Date(segment.endAnchor.startTimestamp).toLocaleString() : "In progress";
    
    // Calculate total distance and duration
    let distance = 0;
    let durationMs = 0;
    
    if (segment.endAnchor) {
      durationMs = segment.endAnchor.startTimestamp - segment.startAnchor.startTimestamp;
    } else if (segment.path.length > 0) {
       // For in-progress, we don't have an easy "current time" reference here without passing it down, 
       // but we can approximate or just show "In progress"
       durationMs = Date.now() - segment.startAnchor.startTimestamp;
    }

    // Calculate distance along path
    for (let i = 0; i < segment.path.length - 1; i++) {
        const p1 = segment.path[i]!;
        const p2 = segment.path[i+1]!;
        // Approximate distance in meters (since we have meters in Vec2)
        const dx = p1[0] - p2[0];
        const dy = p1[1] - p2[1];
        distance += Math.sqrt(dx*dx + dy*dy);
    }
    
    // Speed (m/s) -> km/h
    const speedMps = durationMs > 0 ? (distance / (durationMs / 1000)) : 0;
    const speedKmph = speedMps * 3.6;

    // Format duration
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    const durationStr = `${minutes}m ${seconds}s`;

    return { started, ended, distance: Math.round(distance), duration: durationStr, speed: speedKmph.toFixed(1) };
  }, [motionHover]);

  const pulsingMarkers = useMemo(() => {
    if (!pulsingDeviceIds || pulsingDeviceIds.length === 0 || !mapRef.current || refLat == null || refLon == null) return null;

    return pulsingDeviceIds.map(id => {
      const comp = components.find(c => Number(c.device) === id);
      if (!comp?.mean) return null;

      const deg = metersToDegrees(comp.mean[0], comp.mean[1], refLat, refLon);
      const map = mapRef.current;
      if (!map) return null;
      const pt = map.latLngToContainerPoint(L.latLng(deg.lat, deg.lon));

      return (
        <PulsingMarker key={`pulse-${id}`} x={pt.x} y={pt.y} />
      );
    });
  }, [pulsingDeviceIds, components, refLat, refLon, size, centerMeters]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: typeof height === "number" ? `${height}px` : height }}>
      <style>{`
        .leaflet-control-attribution {
          display: none !important;
        }
        .leaflet-container {
          background-color: ${darkMode ? 'rgb(40, 40, 40)' : '#ddd'} !important;
        }
      `}</style>
      <div ref={mapDivRef} className="absolute inset-0 z-0" />
      <div className="absolute inset-0 pointer-events-none z-[1000]">
        <CanvasView
          ref={canvasApiRef}
          components={components}
          deviceIcons={deviceIcons}
          deviceColors={deviceColors}
          width={size.width}
          height={size.height}
          zoom={pixelsPerMeter}
          refMeters={centerMeters}
          fitToBounds={false}
          worldBounds={null}
          selectedDeviceId={selectedDeviceId}
          openClusterPoint={clusterPoint}
          debugFrame={debugFrame ?? null}
          debugAnchors={debugAnchors ?? []}
          motionSegments={motionSegments}
          darkMode={darkMode}
          memberDeviceIds={memberDeviceIds}
        />
      </div>
      {anchorHover && anchorHoverLabel ? (
        <div
          className="absolute z-[1003] pointer-events-none"
          style={{ left: anchorHover.x + 12, top: anchorHover.y + 12 }}
        >
          <div className="text-xs bg-background/90 border shadow rounded px-2 py-1 text-foreground backdrop-blur-sm border-border">
            <div className="font-medium">{anchorHoverLabel.typeLabel} anchor</div>
            <div>Confidence: {anchorHoverLabel.confidence.toFixed(2)}</div>
            <div>Started: {anchorHoverLabel.started}</div>
            {anchorHoverLabel.ended ? <div>Ended: {anchorHoverLabel.ended}</div> : null}
            <div>Updated: {anchorHoverLabel.updated}</div>
          </div>
        </div>
      ) : null}

      {motionHover && motionHoverLabel ? (
        <div
          className="absolute z-[1003] pointer-events-none"
          style={{ left: motionHover.x + 12, top: motionHover.y + 12 }}
        >
          <div className="text-xs bg-background/90 border shadow rounded px-2 py-1 text-foreground backdrop-blur-sm border-border">
            <div className="font-medium text-emerald-500">Motion Segment</div>
            <div>Duration: {motionHoverLabel.duration}</div>
            <div>Distance: {motionHoverLabel.distance}m</div>
            <div>Avg Speed: {motionHoverLabel.speed} km/h</div>
            <div>Started: {motionHoverLabel.started}</div>
            <div>Ended: {motionHoverLabel.ended}</div>
          </div>
        </div>
      ) : null}
      {pulsingMarkers}
      {clusterPopup && clusterPoint && (
        <ClusterPopup
          x={clusterPoint.x}
          y={clusterPoint.y}
          items={clusterPopup.items}
          animationState={clusterAnimation}
          onClose={() => closeClusterPopupAnimated()}
          onSelectDevice={onSelectDevice}
          darkMode={darkMode}
          deviceColors={deviceColors}
          deviceIcons={deviceIcons}
          deviceNames={deviceNames}
        />
      )}
      <div className="absolute z-[1001] left-4 right-4 bottom-4 sm:right-4 sm:left-auto sm:top-4 sm:bottom-auto pointer-events-auto">
        <div className="w-full sm:w-80 bg-background backdrop-blur-sm rounded p-3 shadow-md max-h-[60vh] overflow-auto">
          {overlay}
        </div>
      </div>
    </div>
  );
});

export default React.memo(MapView);
