import { degreesToMeters, metersToDegrees } from "../util/geo";
import CanvasView, { type CanvasViewHandle } from "./CanvasView";
import L from "leaflet";
import React, { useEffect, useRef, useState } from "react";
import type { ComponentUI } from "@/ui/types";

// color palette must match the one used in CanvasView for consistent device coloring
const DEFAULT_PALETTE: Array<[number, number, number]> = [
  [91, 140, 255],
  [96, 211, 148],
  [255, 211, 110],
  [255, 133, 96],
  [199, 125, 255],
  [96, 198, 255],
];

type Props = {
  components: ComponentUI[];
  refLat: number | null;
  refLon: number | null;
  worldBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  height?: number | string;
  overlay?: React.ReactNode;
  onSelectDevice?: (id: number | null) => void;
  selectedDeviceId?: number | null;
};

const MapView: React.FC<Props> = ({ components, refLat, refLon, worldBounds = null, height = 600, overlay, onSelectDevice, selectedDeviceId }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [centerMeters, setCenterMeters] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | undefined>(undefined);

  const canvasApiRef = useRef<CanvasViewHandle | null>(null);
  // store anchor as map lat/lng so the chooser stays pinned to the map
  const [clusterPopup, setClusterPopup] = useState<{ lat: number; lng: number; items: ComponentUI[] } | null>(null);

  // animation state for the cluster popup so we can animate open/close
  const [clusterAnimation, setClusterAnimation] = useState<'idle' | 'entering' | 'visible' | 'exiting'>('idle');
  const clusterAnimationTimerRef = useRef<number | null>(null);
  const CLUSTER_ANIM_MS = 150;

  // refs to hold latest values so event handlers registered once can see them
  const clusterPopupRef = useRef<{ lat: number; lng: number; items: ComponentUI[] } | null>(null);
  const clusterAnimationRef = useRef<typeof clusterAnimation>('idle');

  useEffect(() => {
    clusterPopupRef.current = clusterPopup;
  }, [clusterPopup]);
  useEffect(() => {
    clusterAnimationRef.current = clusterAnimation;
  }, [clusterAnimation]);

  // open helper (animated) — now accepts lat/lng anchor
  const openClusterPopupAnimated = (popup: { lat: number; lng: number; items: ComponentUI[] }) => {
    if (clusterAnimationTimerRef.current) {
      window.clearTimeout(clusterAnimationTimerRef.current);
      clusterAnimationTimerRef.current = null;
    }
    // set both state and refs immediately so handlers see the popup
    clusterPopupRef.current = popup;
    setClusterPopup(popup);

    clusterAnimationRef.current = 'entering';
    setClusterAnimation('entering');

    // small tick so CSS transition can go from initial -> visible
    clusterAnimationTimerRef.current = window.setTimeout(() => {
      clusterAnimationRef.current = 'visible';
      setClusterAnimation('visible');
      clusterAnimationTimerRef.current = null;
    }, 10);
  };

  // close helper (animated)
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

  // ensure timers are cleared if the component unmounts
  useEffect(() => {
    return () => {
      if (clusterAnimationTimerRef.current) {
        window.clearTimeout(clusterAnimationTimerRef.current);
        clusterAnimationTimerRef.current = null;
      }
      // clear refs on unmount
      clusterPopupRef.current = null;
      clusterAnimationRef.current = 'idle';
    };
  }, []);

  // keep latest refLat/refLon in refs to avoid stale closures
  const refLatRef = useRef<number | null>(refLat);
  const refLonRef = useRef<number | null>(refLon);
  useEffect(() => {
    refLatRef.current = refLat;
    refLonRef.current = refLon;
  }, [refLat, refLon]);

  // Track selection transitions so we don't auto-fit right after deselection
  const prevSelectedRef = useRef<number | null>(selectedDeviceId);
  const skipNextAutoFitRef = useRef(false);
  // Track whether we've already performed the initial zoom for the current selection
  const selectedZoomedRef = useRef(false);

  // Compute fly duration from distance (meters). Uses a small logarithmic curve so
  // longer moves take slightly more time but are still bounded.
  const flyDurationForMeters = (meters: number) => {
    const m = Math.max(1, meters);
    const v = Math.log10(m);
    return Math.max(0.25, Math.min(1.5, v * 0.22 + 0.15));
  };

  // Minimum distance (meters) below which we won't flyTo to avoid tiny jitter
  const MIN_FLY_METERS = 5;
  useEffect(() => {
    if (prevSelectedRef.current != null && selectedDeviceId == null) {
      // we just deselected a device — skip the next auto-fit to avoid jumping the map
      skipNextAutoFitRef.current = true;
    }
    // When selection changes (including new selection), reset the "zoomed" flag so the
    // first update zooms in; subsequent updates will pan more gently.
    if (prevSelectedRef.current !== selectedDeviceId) selectedZoomedRef.current = false;

    prevSelectedRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  // Initialize map once and wire move/zoom listeners
  useEffect(() => {
    const mapContainer = mapDivRef.current;
    if (!mapContainer) return;

    const map = L.map(mapContainer, { attributionControl: false, zoomControl: false });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Ensure the map has an initial view to avoid Leaflet throwing "Set map center and zoom first."
    const initialLat = refLatRef.current;
    const initialLon = refLonRef.current;
    if (worldBounds && initialLat != null && initialLon != null) {
      const sw = metersToDegrees(worldBounds.minX, worldBounds.minY, initialLat, initialLon);
      const ne = metersToDegrees(worldBounds.maxX, worldBounds.maxY, initialLat, initialLon);
      try {
        map.fitBounds(L.latLngBounds(L.latLng(sw.lat, sw.lon), L.latLng(ne.lat, ne.lon)), { padding: [40, 40] });
      } catch (e) {
        map.setView([initialLat, initialLon], 15);
      }
    } else if (initialLat != null && initialLon != null) {
      map.setView([initialLat, initialLon], 15);
    } else {
      map.setView([0, 0], 2);
    }

    const updateTransform = () => {
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
      } catch (err) {
        // map may not be ready yet; ignore and wait for move/zoom or view set in other effect
      }
    };

    updateTransform();

    map.on("move", updateTransform);
    map.on("zoom", updateTransform);

    // click handler to detect clusters via CanvasView's hit tester
    const onMapClick = (ev: L.LeafletMouseEvent) => {
      const pt = map.latLngToContainerPoint(ev.latlng);
      const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
      if (hit && hit.items && hit.items.length > 0) {
        if (hit.items.length === 1) {
          const devKey = hit.items[0]!.device;
          const devNum = Number(devKey);
          if (Number.isFinite(devNum)) onSelectDevice?.(devNum);
          closeClusterPopupAnimated();
        } else {
          onSelectDevice?.(null);
          const clusterPoint = map.containerPointToLatLng(L.point(hit.x, hit.y));
          // Center the map on the clicked cluster with a smooth flight
          try {
            if (map.stop) map.stop();
            const center = map.getCenter();
            const dist = L.latLng(center.lat, center.lng).distanceTo(L.latLng(clusterPoint.lat, clusterPoint.lng));
            if (dist >= MIN_FLY_METERS) {
              const dur = flyDurationForMeters(dist);
              map.flyTo([clusterPoint.lat, clusterPoint.lng], map.getZoom(), { animate: true, duration: dur, easeLinearity: 0.25 });
            }
          } catch (e) {}
          openClusterPopupAnimated({ lat: clusterPoint.lat, lng: clusterPoint.lng, items: hit.items as ComponentUI[] });
        }
      } else {
        closeClusterPopupAnimated();
      }
    };

    // change pointer when hovering over a device or cluster
    const onMapMove = (ev: L.LeafletMouseEvent) => {
      const pt = map.latLngToContainerPoint(ev.latlng);
      const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
      const container = map.getContainer();
      container.style.cursor = (hit && hit.items && hit.items.length > 0) ? "pointer" : "";
    };

    const container = map.getContainer();
    const onMouseLeave = () => {
      container.style.cursor = "";
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
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update view when refLat/refLon/worldBounds change (only when NO device is selected)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // When a device is selected we DON'T auto-fit the world bounds — selection controls the view
    if (selectedDeviceId != null) return;

    // If we recently deselected a device, skip a single auto-fit to avoid jumping the view
    if (skipNextAutoFitRef.current) {
      skipNextAutoFitRef.current = false;
      return;
    }

    if (worldBounds && refLat != null && refLon != null) {
      const sw = metersToDegrees(worldBounds.minX, worldBounds.minY, refLat, refLon);
      const ne = metersToDegrees(worldBounds.maxX, worldBounds.maxY, refLat, refLon);
      try {
        map.fitBounds(L.latLngBounds(L.latLng(sw.lat, sw.lon), L.latLng(ne.lat, ne.lon)), { padding: [40, 40] });
      } catch (e) {
        map.setView([refLat, refLon], 15);
      }
    } else if (refLat != null && refLon != null) {
      map.setView([refLat, refLon], 15);
    } else {
      map.setView([0, 0], 2);
    }

    // Force update of local transform
    const center = map.getCenter();
    const zoom = map.getZoom();
    const mpp = 156543.03392804097 * Math.cos((center.lat * Math.PI) / 180) / Math.pow(2, zoom);
    const ppm = 1 / mpp;
    setPixelsPerMeter(ppm);
    if (refLat != null && refLon != null) {
      const cm = degreesToMeters(center.lat, center.lng, refLat, refLon);
      setCenterMeters(cm);
    } else {
      setCenterMeters({ x: 0, y: 0 });
    }
  }, [refLat, refLon, worldBounds, selectedDeviceId]);

  // When a device is selected, center and zoom to it and keep following as components update
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (selectedDeviceId == null) return;

    const sel = components.find((c) => Number(c.device) === Number(selectedDeviceId));
    if (!sel || !sel.mean || refLat == null || refLon == null)
      return;

    const deg = metersToDegrees(sel.mean[0], sel.mean[1], refLat, refLon);

    try {
      const ZOOM_FOR_SELECTED = 16;
      const PAN_DISTANCE_METERS = 20; // minimum distance to trigger a pan

      const center = map.getCenter();
      const centerLatLng = L.latLng(center.lat, center.lng);
      const targetLatLng = L.latLng(deg.lat, deg.lon);
      const distMeters = centerLatLng.distanceTo(targetLatLng);

      // If this is the first update since selection, perform an initial zoom+center
      if (!selectedZoomedRef.current) {
        // stop any in-flight animations before starting a new zoom
        if (map.stop) map.stop();
        const targetZoom = Math.max(map.getZoom() || ZOOM_FOR_SELECTED, ZOOM_FOR_SELECTED);
        const dist = centerLatLng.distanceTo(L.latLng(deg.lat, deg.lon));
        if (dist < MIN_FLY_METERS) {
          // too close to bother flying — just adjust zoom (no center movement)
          map.setZoom(targetZoom, { animate: true });
        } else {
          const dur = flyDurationForMeters(dist);
          // use flyTo for a smoother curved flight
          map.flyTo([deg.lat, deg.lon], targetZoom, { animate: true, duration: dur, easeLinearity: 0.25 });
        }
        selectedZoomedRef.current = true;
      } else {
        // After initial zoom: only pan (no zoom unless user changes it) and only when necessary
        if (distMeters > PAN_DISTANCE_METERS) {
          if (map.stop) map.stop();
          const dur = flyDurationForMeters(distMeters);
          map.flyTo([deg.lat, deg.lon], map.getZoom(), { animate: true, duration: dur, easeLinearity: 0.25 });
        }
      }
    } catch (e) { }
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

  const openClusterPoint = clusterPopup && mapRef.current ? (() => {
    const p = mapRef.current.latLngToContainerPoint(L.latLng(clusterPopup.lat, clusterPopup.lng));
    return { x: p.x, y: p.y };
  })() : null;

  let clusterChooser: React.ReactNode = null;
  if (clusterPopup && mapRef.current) {
    const map = mapRef.current;
    const p = map.latLngToContainerPoint(L.latLng(clusterPopup.lat, clusterPopup.lng));

    // backdrop (invisible click-catcher)
    const backdropStyle: React.CSSProperties = {
      position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
      background: 'transparent',
      transition: `opacity ${CLUSTER_ANIM_MS}ms ${clusterAnimation === 'exiting' ? 'ease-in' : 'cubic-bezier(0.16,1,0.3,1)'}`,
    };

    const anchorScale = clusterAnimation === 'entering' ? 0.6 : 1;
    const anchorStyle: React.CSSProperties = {
      position: 'absolute', left: `${p.x}px`, top: `${p.y}px`,
      width: 14, height: 14, borderRadius: 9999, background: 'rgba(0,0,0,0.06)',
      opacity: clusterAnimation === 'entering' ? 0 : (clusterAnimation === 'visible' ? 1 : 0),
      transformOrigin: 'center', transition: `transform ${CLUSTER_ANIM_MS}ms cubic-bezier(0.2,1.1,0.22,1), opacity ${CLUSTER_ANIM_MS}ms ease`,
      transform: `translate(-50%, -50%) scale(${anchorScale})`
    };

    const baseStyle: React.CSSProperties = {
      position: 'absolute', left: `${p.x}px`, top: `${p.y}px`, transform: 'translate(-50%, -56%)', opacity: 1,
      transition: `opacity ${CLUSTER_ANIM_MS}ms ease, transform ${CLUSTER_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1)`
    };
    if (clusterAnimation === 'entering') {
      baseStyle.opacity = 0;
      baseStyle.transform = 'translate(-50%, -46%) scale(0.98)';
    } else if (clusterAnimation === 'exiting') {
      baseStyle.opacity = 0;
      baseStyle.transform = 'translate(-50%, -66%) scale(0.98)';
      baseStyle.transition = `opacity ${CLUSTER_ANIM_MS}ms ease-in, transform ${CLUSTER_ANIM_MS}ms ease-in`;
    }

    clusterChooser = (
      <>
        <div className="pointer-events-auto z-[1001]" style={backdropStyle} onClick={() => closeClusterPopupAnimated()} />
        <div style={anchorStyle} className="pointer-events-none z-[1002]" />

        <div
          className="pointer-events-auto z-[1002]"
          style={baseStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ position: 'relative', width: 0, height: 0 }}>
            {clusterPopup.items.filter(Boolean).map((it, i) => {
              const n = clusterPopup.items.length;
              const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top
              const radius = Math.max(40, 22 + n * 6);
              const left = Math.round(radius * Math.cos(angle));
              const top = Math.round(radius * Math.sin(angle));

              const idx = components.findIndex((c) => Number(c.device) === Number(it.device));
              const col: [number, number, number] = (idx >= 0 ? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length] : undefined) ?? [0, 0, 0];
              const colorStr = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;

              const enterDelay = i * 20;
              const exitDelay = (n - i - 1) * 15;
              let itemOpacity = 1;
              let itemScale = 1;
              let delay = 200;
              if (clusterAnimation === 'entering') { itemOpacity = 0; itemScale = 0.6; delay = enterDelay; }
              else if (clusterAnimation === 'visible') { itemOpacity = 1; itemScale = 1; delay = 30 + enterDelay; }
              else if (clusterAnimation === 'exiting') { itemOpacity = 0; itemScale = 0.85; delay = exitDelay; }

              const innerStyle: React.CSSProperties = {
                transform: `scale(${itemScale})`,
                opacity: itemOpacity,
                transition: `transform 360ms cubic-bezier(0.2,1.1,0.22,1) ${delay}ms, opacity 220ms ease ${delay}ms`,
                willChange: 'transform, opacity'
              };

              return (
                <div key={`${it.device}-${i}`} style={{ position: 'absolute', left: `${left}px`, top: `${top}px`, transform: 'translate(-50%, -50%)' }}>
                  <div
                    className="w-10 h-10 rounded-full bg-white shadow flex items-center justify-center cursor-pointer hover:scale-110"
                    style={innerStyle}
                    onClick={(e) => { e.stopPropagation(); onSelectDevice?.(it.device); closeClusterPopupAnimated(); }}
                    title={String(it.device)}
                  >
                    <span className="material-symbols-outlined text-lg select-none" style={{ color: colorStr, WebkitUserSelect: 'none', MozUserSelect: 'none', msUserSelect: 'none' }}>{it.emoji}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: typeof height === "number" ? `${height}px` : height }}>
      <div ref={mapDivRef} className="absolute inset-0 z-0" />
      <div className="absolute inset-0 pointer-events-none z-[1000]">
        <CanvasView
          ref={canvasApiRef}
          components={components}
          width={size.width}
          height={size.height}
          zoom={pixelsPerMeter}
          refMeters={centerMeters}
          fitToBounds={false}
          worldBounds={null}
          selectedDeviceId={selectedDeviceId}
          openClusterPoint={openClusterPoint}
        />
      </div>

      {/* cluster chooser: radial device icon layout (anchored to clicked map point) */}
      {clusterChooser}

      {/* Floating overlay (top-right on desktop, bottom full-width on mobile) */}
      {overlay && (
        <div className="absolute z-[1001] left-4 right-4 bottom-4 sm:right-4 sm:left-auto sm:top-4 sm:bottom-auto pointer-events-auto">
          <div className="w-full sm:w-80 bg-white/70 backdrop-blur-sm rounded p-3 shadow-md max-h-[60vh] overflow-auto">
            {overlay}
          </div>
        </div>
      )}

      {/* Floating overlay (top-right on desktop, bottom full-width on mobile) */}
      {overlay && (
        <div className="absolute z-[1001] left-4 right-4 bottom-4 sm:right-4 sm:left-auto sm:top-4 sm:bottom-auto pointer-events-auto">
          <div className="w-full sm:w-80 bg-white/70 backdrop-blur-sm rounded p-3 shadow-md max-h-[60vh] overflow-auto">
            {overlay}
          </div>
        </div>
      )}
    </div>
  );
};

export default MapView;
