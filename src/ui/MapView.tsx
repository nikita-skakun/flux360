import "@maptiler/sdk/dist/maptiler-sdk.css";
import { GeoJSONSource, Map as MaptilerMap, MapStyle, config } from "@maptiler/sdk";
import React, { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { DevicePoint } from "@/types";

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
};

function createPinImage(icon: string, color: string, darkMode: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = 48;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const PIN_R = 14;
  const tipX = size / 2;
  const tipY = 36;
  const bodyHeight = PIN_R * 1.5;
  const headY = tipY - bodyHeight;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tipX - PIN_R, headY);
  ctx.arc(tipX, headY, PIN_R, Math.PI, 0);
  ctx.bezierCurveTo(tipX + PIN_R, headY + PIN_R * 0.9, tipX + PIN_R * 0.35, headY + bodyHeight * 0.65, tipX, tipY);
  ctx.bezierCurveTo(tipX - PIN_R * 0.35, headY + bodyHeight * 0.65, tipX - PIN_R, headY + PIN_R * 0.9, tipX - PIN_R, headY);
  ctx.closePath();

  ctx.fillStyle = darkMode ? "rgb(40,40,40)" : "rgb(255,255,255)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1.0;

  if (icon) {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${PIN_R}px 'Material Symbols Outlined', 'Material Icons', -apple-system, system-ui, Arial`;
    ctx.fillText(String(icon), tipX, headY + 1);
  }

  ctx.restore();
  return canvas;
}

type Props = {
  components: DevicePoint[];
  deviceNames: Record<number, string>;
  deviceIcons: Record<number, string>;
  deviceColors: Record<number, string>;
  refLat: number | null;
  refLon: number | null;
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  height: number | string;
  overlay?: React.ReactNode;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  maptilerApiKey?: string;
  darkMode: boolean;
};

const MapView = React.forwardRef<MapViewHandle, Props>(({
  components,
  deviceNames,
  deviceIcons,
  deviceColors,
  refLat,
  refLon,
  worldBounds,
  height,
  overlay,
  selectedDeviceId,
  onSelectDevice,
  maptilerApiKey,
  darkMode,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaptilerMap | null>(null);
  const componentsRef = useRef<DevicePoint[]>(components);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  const onSelectDeviceRef = useRef(onSelectDevice);

  useEffect(() => {
    componentsRef.current = components;
  }, [components]);

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  useEffect(() => {
    onSelectDeviceRef.current = onSelectDevice;
  }, [onSelectDevice]);

  const flyToDevice = useCallback((id: number) => {
    const map = mapRef.current;
    if (!map) return;

    const device = components.find(c => c.device === id);
    if (!device) return;

    map.easeTo({
      center: [device.lon, device.lat],
      zoom: 18,
      duration: 1000,
    });
  }, [components]);

  useImperativeHandle(ref, () => ({
    flyToDevice,
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerApiKey) return;

    config.apiKey = maptilerApiKey;

    let initialCenter: [number, number] = [0, 0];
    let initialZoom = 2;

    if (worldBounds && refLat != null && refLon != null) {
      initialCenter = [refLon, refLat];
      initialZoom = 15;
    } else if (refLat != null && refLon != null) {
      initialCenter = [refLon, refLat];
      initialZoom = 15;
    }

    const map = new MaptilerMap({
      container,
      center: initialCenter,
      zoom: initialZoom,
      style: darkMode ? MapStyle.DATAVIZ.DARK : MapStyle.DATAVIZ,
      navigationControl: false,
      geolocateControl: false,
      scaleControl: false,
      fullscreenControl: false,
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [maptilerApiKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !maptilerApiKey) return;
    map.setStyle(darkMode ? MapStyle.DATAVIZ.DARK : MapStyle.DATAVIZ);
  }, [maptilerApiKey, darkMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || components.length === 0) return;

    const keyToIconColor = new Map<string, { icon: string, color: string }>();
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];

    for (const c of components) {
      const icon = deviceIcons[c.device] ?? "?";
      const color = deviceColors[c.device] ?? "#3b82f6";
      const key = `${icon}-${color}-${darkMode ? 'dark' : 'light'}`;
      keyToIconColor.set(key, { icon, color });

      features.push({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [c.lon, c.lat] as [number, number],
        },
        properties: {
          id: c.device,
          name: deviceNames[c.device] ?? String(c.device),
          icon,
          color,
          accuracy: c.accuracy,
          imageKey: key,
        },
      });
    }

    const geojson: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: "FeatureCollection", features };

    const ensureMapLayers = () => {
      // Ensure source exists
      let source = map.getSource("devices") as GeoJSONSource | undefined;
      if (!source) {
        map.addSource("devices", { type: "geojson", data: geojson });
      } else {
        source.setData(geojson);
      }

      // Add missing images
      for (const [key, { icon, color }] of keyToIconColor) {
        if (!map.hasImage(key)) {
          const pinCanvas = createPinImage(icon, color, darkMode);
          const ctx = pinCanvas.getContext("2d");
          const imageData = ctx?.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
          if (imageData) {
            map.addImage(key, imageData);
          }
        }
      }

      // Add layer if not exists
      if (!map.getLayer("devices")) {
        map.addLayer({
          id: "devices",
          type: "symbol",
          source: "devices",
          layout: {
            "icon-image": ["get", "imageKey"],
            "icon-size": 1,
            "icon-anchor": "bottom",
            "icon-allow-overlap": true,
          },
        });

        map.on("click", "devices", (e) => {
          const features = e.features;
          if (features?.[0]?.properties) {
            const props = features[0].properties;
            const id = props["id"];
            if (typeof id === "number") {
              onSelectDeviceRef.current(id);
              flyToDevice(id);
            }
          }
        });

        map.on("mouseenter", "devices", () => {
          map.getCanvas().style.cursor = "pointer";
        });

        map.on("mouseleave", "devices", () => {
          map.getCanvas().style.cursor = "";
        });
      }
    };

    if (map.loaded()) {
      ensureMapLayers();
    } else {
      map.on("load", ensureMapLayers);
    }

    return () => {
      map.off("load", ensureMapLayers);
    };
  }, [components, deviceNames, deviceIcons, deviceColors, darkMode, onSelectDevice]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !worldBounds || refLat == null || refLon == null) return;

    const c = componentsRef.current;
    const sw = { lat: refLat - 0.01, lon: refLon - 0.01 };
    const ne = { lat: refLat + 0.01, lon: refLon + 0.01 };

    if (c.length > 0) {
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (const comp of c) {
        minLat = Math.min(minLat, comp.lat);
        minLon = Math.min(minLon, comp.lon);
        maxLat = Math.max(maxLat, comp.lat);
        maxLon = Math.max(maxLon, comp.lon);
      }
      const padding = 0.005;
      sw.lat = minLat - padding;
      sw.lon = minLon - padding;
      ne.lat = maxLat + padding;
      ne.lon = maxLon + padding;
    }

    map.fitBounds(
      [sw.lon, sw.lat, ne.lon, ne.lat],
      { padding: 40, maxZoom: 18, duration: 0 }
    );
  }, [worldBounds, refLat, refLon]);

  return (
    <div style={{ height: typeof height === "number" ? `${height}px` : height, position: "relative", width: "100%" }}>
      <style>{`.maplibregl-ctrl-attrib{display:none}`}</style>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {overlay && <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>{overlay}</div>}
    </div>
  );
});

export default React.memo(MapView);
