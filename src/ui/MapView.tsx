import React, { useEffect, useRef, useState } from "react";
import type { ComponentUI } from "@/ui/types";
import CanvasView from "./CanvasView";
import { degreesToMeters, metersToDegrees } from "../util/geo";
import L from "leaflet";

type Props = {
  components: ComponentUI[];
  refLat: number | null;
  refLon: number | null;
  worldBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  height?: number | string;
  overlay?: React.ReactNode;
};

const MapView: React.FC<Props> = ({ components, refLat, refLon, worldBounds = null, height = 600, overlay }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [centerMeters, setCenterMeters] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | undefined>(undefined);

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

    const map = L.map(mapContainer, { attributionControl: false, zoomControl: true });

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

    mapRef.current = map;

    return () => {
      map.off("move", updateTransform);
      map.off("zoom", updateTransform);
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
          components={components}
          width={size.width}
          height={size.height}
          zoom={pixelsPerMeter}
          refMeters={centerMeters}
          fitToBounds={false}
          worldBounds={null}
        />
      </div>

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
