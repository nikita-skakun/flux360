import { degreesToMeters, metersToDegrees } from "../util/geo";
import CanvasView, { type CanvasViewHandle } from "./CanvasView";
import L from "leaflet";
import React, { useEffect, useRef, useState } from "react";
import type { ComponentUI } from "@/ui/types";

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

    // click handler to detect clusters via CanvasView's hit tester
    const onMapClick = (ev: L.LeafletMouseEvent) => {
      try {
        const pt = map.latLngToContainerPoint(ev.latlng);
        const hit = canvasApiRef.current?.hitTestPoint(pt.x, pt.y) ?? null;
        if (hit && hit.items && hit.items.length > 0) {
          if (hit.items.length === 1) {
            // auto-select single item (parse device id as number when possible)
            const devKey = (hit.items[0] as any)?.device;
            const devNum = Number(devKey);
            if (Number.isFinite(devNum)) onSelectDevice?.(devNum);
            setClusterPopup(null);
          } else {
            // multiple — show chooser
            setClusterPopup({ x: pt.x, y: pt.y, items: hit.items as ComponentUI[] });
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
        />
      </div>

      {/* cluster chooser popup (anchored to the clicked map point) */}
      {clusterPopup && (
        <div
          className="pointer-events-auto z-[1002]"
          style={{ position: "absolute", left: `${clusterPopup.x}px`, top: `${clusterPopup.y}px`, transform: "translate(-50%, -110%)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-white rounded shadow p-2 min-w-[160px]">
            {clusterPopup.items.map((it, i) => {
              const deviceName = (it as any).deviceName ?? (it as any).device ?? `device ${i}`;
              const accuracy = (it as any).accuracyMeters ?? (it as any).accuracy ?? "";
              const speed = typeof (it as any).speed === "number" ? `${Math.round((it as any).speed * 3.6)} km/h` : "";
              return (
                <div key={`${deviceName}-${i}`} className="p-1 hover:bg-gray-100 rounded cursor-pointer" onClick={() => { const did = Number((it as any).device); if (Number.isFinite(did)) onSelectDevice?.(did); setClusterPopup(null); }}>
                  <div className="text-sm">{deviceName}</div>
                  <div className="text-xs text-muted">{accuracy ? `${accuracy}m` : null}{accuracy && speed ? " • " : null}{speed}</div>
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
