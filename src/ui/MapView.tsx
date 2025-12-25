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
  onSelectDevice?: (id: number) => void;
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
  const [clusterPopup, setClusterPopup] = useState<{ x: number; y: number; items: ComponentUI[] } | null>(null);

  // keep latest refLat/refLon in refs to avoid stale closures
  const refLatRef = useRef<number | null>(refLat);
  const refLonRef = useRef<number | null>(refLon);
  useEffect(() => {
    refLatRef.current = refLat;
  }, [refLat]);
  useEffect(() => {
    refLonRef.current = refLon;
  }, [refLon]);

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

    // close any open cluster chooser when the map view starts moving/zooming
    const closeClusterPopup = () => setClusterPopup(null);
    map.on("movestart", closeClusterPopup);
    map.on("zoomstart", closeClusterPopup);

    // click handler to detect clusters via CanvasView's hit tester
    const onMapClick = (ev: L.LeafletMouseEvent) => {
      try {
        const pt = map.latLngToContainerPoint(ev.latlng);
        const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
        if (hit && hit.items && hit.items.length > 0) {
          if (hit.items.length === 1) {
            // auto-select single item (parse device id as number when possible)
            const devKey = hit.items[0]!.device;
            const devNum = Number(devKey);
            if (Number.isFinite(devNum)) onSelectDevice?.(devNum);
            setClusterPopup(null);
          } else {
            // multiple — show chooser anchored at the cluster center returned by the canvas
            setClusterPopup({ x: hit.x, y: hit.y, items: hit.items as ComponentUI[] });
          }
        } else {
          setClusterPopup(null);
        }
      } catch (e) {
        // ignore
      }
    };

    // change pointer when hovering over a device or cluster
    const onMapMove = (ev: L.LeafletMouseEvent) => {
      try {
        const pt = map.latLngToContainerPoint(ev.latlng);
        const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
        const container = map.getContainer();
        if (hit && hit.items && hit.items.length > 0) {
          container.style.cursor = "pointer";
        } else {
          container.style.cursor = "";
        }
      } catch (e) {
        // ignore
      }
    };

    const container = map.getContainer();
    const onMouseLeave = () => {
      try {
        container.style.cursor = "";
      } catch (e) { }
    };

    map.on("click", onMapClick);
    map.on("mousemove", onMapMove);
    container.addEventListener("mouseleave", onMouseLeave);

    mapRef.current = map;

    return () => {
      map.off("move", updateTransform);
      map.off("zoom", updateTransform);
      map.off("movestart", closeClusterPopup);
      map.off("zoomstart", closeClusterPopup);
      map.off("click", onMapClick);
      map.off("mousemove", onMapMove);
      container.removeEventListener("mouseleave", onMouseLeave);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update view when refLat/refLon/worldBounds change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
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
  }, [refLat, refLon, worldBounds]);

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
          openClusterPoint={clusterPopup ? { x: clusterPopup.x, y: clusterPopup.y } : null}
        />
      </div>

      {/* cluster chooser: radial device icon layout (anchored to clicked map point) */}
      {clusterPopup && (
        <div
          className="pointer-events-auto z-[1002]"
          style={{ position: "absolute", left: `${clusterPopup.x}px`, top: `${clusterPopup.y}px`, transform: "translate(-50%, -50%)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ position: "relative", width: 0, height: 0 }}>
            {clusterPopup.items.filter(Boolean).map((it, i) => {
              const n = clusterPopup.items.length;
              const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top
              const radius = Math.max(40, 22 + n * 6);
              const left = Math.round(radius * Math.cos(angle));
              const top = Math.round(radius * Math.sin(angle));

              // determine color by finding component index and using the shared palette
              const idx = components.findIndex((c) => Number(c.device) === Number(it.device));
              const col: [number, number, number] = (idx >= 0 ? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length] : undefined) ?? [0, 0, 0];
              const colorStr = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;

              return (
                <div key={`${it.device}-${i}`} style={{ position: "absolute", left: `${left}px`, top: `${top}px`, transform: "translate(-50%, -50%)" }}>
                  <div
                    className="w-10 h-10 rounded-full bg-white shadow flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"
                    onClick={(e) => { e.stopPropagation(); onSelectDevice?.(it.device); setClusterPopup(null); }}
                    title={String(it.device)}
                  >
                    <span className="material-symbols-outlined text-lg" style={{ color: colorStr }}>{it.emoji}</span>
                  </div>
                </div>
              );
            })}
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
