import "@maptiler/sdk/dist/maptiler-sdk.css";
import { GeoJSONSource, Map as MaptilerMap, MapStyle, config, MapMouseEvent } from "@maptiler/sdk";
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DevicePoint, Vec2 } from "@/types";
import type { Feature, Point } from "geojson";
import { CLUSTER_DISTANCE_PX, computeClusters, type DrawItem } from "@/util/clustering";
import { getColorForDevice } from "./color";
import { ClusterPopup } from "./map/ClusterPopup";

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
};

function createPinImage(icon: string, color: string, darkMode: boolean, badgeText?: string): HTMLCanvasElement {
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

  // small badge (bottom-right) for cluster size
  if (badgeText) {
    const badgeRadius = 10;
    const bx = tipX + PIN_R * 0.75;
    const by = headY + PIN_R * 0.6;
    ctx.beginPath();
    // Badge background: light gray in light mode, dark gray in dark mode
    ctx.fillStyle = darkMode ? "rgb(30,30,30)" : "rgb(230, 230, 230)";
    ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
    ctx.fill();
    // Badge text: black in light mode, white in dark mode
    ctx.fillStyle = darkMode ? "rgb(255,255,255)" : "rgb(0,0,0)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(badgeRadius)}px -apple-system, system-ui, Arial`;
    ctx.fillText(String(badgeText), bx, by);
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
  overlay: React.ReactNode;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  maptilerApiKey: string | null;
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
  const hasFittedInitially = useRef(false);

  const [clusterPopup, setClusterPopup] = useState<{ x: number, y: number, items: DevicePoint[] } | null>(null);
  const updateLayersTimeout = useRef<number | null>(null);
  const lastFeatureState = useRef<string>("");

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

    const device = componentsRef.current.find(c => c.device === id);
    if (!device) return;

    const target = [device.lon, device.lat] as Vec2;

    const center = map.getCenter();
    let duration = 800;
    if (center) {
      const dLat = target[1] - center.lat;
      const dLon = target[0] - center.lng;
      const distanceDeg = Math.sqrt(dLat * dLat + dLon * dLon);

      const minDuration = 300;
      const maxDuration = 2500;
      const maxDistanceDeg = 0.045; // ~0.045 degrees ≈ 5km in latitude
      const t = Math.min(1, distanceDeg / maxDistanceDeg);
      duration = Math.round(minDuration + t * (maxDuration - minDuration));
    }

    map.flyTo({ center: target, zoom: 18, duration });
  }, []);

  useImperativeHandle(ref, () => ({
    flyToDevice,
  }));

  const updateLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    // Determine if a cluster popup is open and which devices it shows
    const hiddenClusterDeviceIds = clusterPopup
      ? new Set(clusterPopup.items.map(item => item.device))
      : null;

    // Project components to screen coords
    const drawItems: (DrawItem & { colorHex: string })[] = components.map((c, idx) => {
      const pt = map.project([c.lon, c.lat]);
      const colorHex = deviceColors[c.device] ?? '#3b82f6';
      const colorRgb = getColorForDevice(c.device, colorHex);
      return {
        idx,
        device: c.device,
        x: pt.x,
        y: pt.y,
        r: 0,
        iconText: deviceIcons[c.device] ?? String(c.device).charAt(0).toUpperCase(),
        timestamp: c.timestamp,
        color: colorRgb,
        colorHex,
      };
    });

    // Compute clusters
    let clusters = computeClusters(drawItems, CLUSTER_DISTANCE_PX);

    // Handle selected device: reposition cluster to selected device's location
    if (selectedDeviceId != null) {
      clusters = clusters.map(cl => {
        const sel = cl.items.find(it => it.device === selectedDeviceId);
        return sel ? { ...cl, x: sel.x, y: sel.y } : cl;
      });
    }

    // Build clustered indices set
    const clusteredIdxs = new Set<number>();
    clusters.forEach(cl => {
      if (cl.size > 1) cl.items.forEach(it => clusteredIdxs.add(it.idx));
    });

    // Build GeoJSON features
    const dotsFeatures: Feature<Point>[] = [];
    const individualsFeatures: Feature<Point>[] = [];
    const clustersFeatures: Feature<Point>[] = [];

    // Dots: for clustered devices
    for (let i = 0; i < drawItems.length; i++) {
      if (clusteredIdxs.has(i)) {
        const c = components[i]!;
        const item = drawItems[i]!;
        dotsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` },
        });
      }
    }

    // Individuals: non-clustered devices
    for (let i = 0; i < drawItems.length; i++) {
      if (!clusteredIdxs.has(i)) {
        const c = components[i]!;
        const item = drawItems[i]!;
        const imageKey = `${item.iconText}-${item.colorHex}-${darkMode ? 'dark' : 'light'}`;
        if (!map.hasImage(imageKey)) {
          const pinCanvas = createPinImage(item.iconText, item.colorHex, darkMode);
          const ctx = pinCanvas.getContext("2d");
          const imageData = ctx?.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
          if (imageData) map.addImage(imageKey, imageData);
        }
        individualsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: { imageKey, device: item.device },
        });
      }
    }

    // Clusters: size > 1
    for (const cl of clusters) {
      if (cl.size <= 1) continue;

      // Skip the cluster that is currently shown in the popup
      if (hiddenClusterDeviceIds) {
        const thisClusterIds = new Set(cl.items.map(it => it.device));
        if (thisClusterIds.size === hiddenClusterDeviceIds.size &&
          [...thisClusterIds].every(id => hiddenClusterDeviceIds.has(id))) {
          continue;
        }
      }

      // Representative: selected device if in cluster, else most recent
      const repItem = cl.items.find(it => it.device === selectedDeviceId) ??
        cl.items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      const repIdx = drawItems.findIndex(di => di.device === repItem.device);
      const rep = drawItems[repIdx];
      if (!rep) continue;

      // Convert cluster center to lng/lat
      const centerLng = cl.items.reduce((sum, item) => sum + (components[item.idx]?.lon || 0), 0) / cl.size;
      const centerLat = cl.items.reduce((sum, item) => sum + (components[item.idx]?.lat || 0), 0) / cl.size;

      const clusterKey = `cluster-${rep.iconText}-${rep.colorHex}-${cl.size}-${darkMode ? 'dark' : 'light'}`;
      if (!map.hasImage(clusterKey)) {
        const pinCanvas = createPinImage(rep.iconText, rep.colorHex, darkMode, String(cl.size));
        const ctx = pinCanvas.getContext("2d");
        const imageData = ctx?.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
        if (imageData) map.addImage(clusterKey, imageData);
      }

      clustersFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [centerLng, centerLat] },
        properties: {
          clusterIconKey: clusterKey,
          members: cl.items.map(it => it.device),
        },
      });
    }

    // Check if anything fundamentally visually changed
    const featureStateStr = JSON.stringify({
      d: dotsFeatures,
      i: individualsFeatures,
      c: clustersFeatures
    });

    try {
      const hasLayers = !!map.getSource('dots-source');
      if (hasLayers && lastFeatureState.current === featureStateStr) {
        return; // Suppress redundant worker calls on MapLibre during pan/zooming
      }
      lastFeatureState.current = featureStateStr;

      // Update sources & layers
      const dotsData = { type: 'FeatureCollection' as const, features: dotsFeatures };
      if (!map.getSource('dots-source')) {
        map.addSource('dots-source', { type: 'geojson', data: dotsData });
        map.addLayer({
          id: 'dots-layer',
          type: 'circle',
          source: 'dots-source',
          paint: { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': 1 },
        });
      } else {
        (map.getSource('dots-source') as GeoJSONSource).setData(dotsData);
      }

      const indData = { type: 'FeatureCollection' as const, features: individualsFeatures };
      if (!map.getSource('individuals-source')) {
        map.addSource('individuals-source', { type: 'geojson', data: indData });
        map.addLayer({
          id: 'individuals-layer',
          type: 'symbol',
          source: 'individuals-source',
          layout: {
            'icon-image': ['get', 'imageKey'],
            'icon-size': 1,
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
          },
        });
      } else {
        (map.getSource('individuals-source') as GeoJSONSource).setData(indData);
      }

      const clData = { type: 'FeatureCollection' as const, features: clustersFeatures };
      if (!map.getSource('clusters-source')) {
        map.addSource('clusters-source', { type: 'geojson', data: clData });
        map.addLayer({
          id: 'clusters-layer',
          type: 'symbol',
          source: 'clusters-source',
          layout: {
            'icon-image': ['get', 'clusterIconKey'],
            'icon-size': 1,
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
          },
        });
      } else {
        (map.getSource('clusters-source') as GeoJSONSource).setData(clData);
      }
    } catch (e: any) {
      if (e?.message?.includes("Style is not done loading")) return;
      throw e;
    }
  }, [components, deviceIcons, deviceColors, darkMode, selectedDeviceId, clusterPopup]);

  const listenersAttached = useRef(false);

  // Map initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerApiKey) return;

    config.apiKey = maptilerApiKey;

    let initialCenter: Vec2 = [0, 0];
    let initialZoom = 2;

    if (refLat != null && refLon != null) {
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
    listenersAttached.current = false;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [maptilerApiKey]);

  // Style update
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !maptilerApiKey) return;
    map.setStyle(darkMode ? MapStyle.DATAVIZ.DARK : MapStyle.DATAVIZ);
  }, [maptilerApiKey, darkMode]);

  // Ref to hold updateLayers to avoid stale closure in event listeners
  const updateLayersRef = useRef(updateLayers);
  useEffect(() => { updateLayersRef.current = updateLayers; }, [updateLayers]);

  // Listeners setup
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMove = () => {
      if (updateLayersTimeout.current) window.cancelAnimationFrame(updateLayersTimeout.current);
      updateLayersTimeout.current = window.requestAnimationFrame(() => {
        updateLayersRef.current();
        updateLayersTimeout.current = null;
      });
    };

    const onIndividualClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const features = (e as unknown as { features: Feature<Point>[] }).features;
      const props = features?.[0]?.properties;
      const device: unknown = props ? props['device'] : undefined;
      if (typeof device === 'number') {
        onSelectDeviceRef.current(device);
        flyToDevice(device);
      }
    };

    const onClusterClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const features = (e as unknown as { features: Feature<Point>[] }).features;
      const props = features?.[0]?.properties;
      const membersProp: unknown = props ? props['members'] : undefined;

      let memberIds: number[] = [];
      if (typeof membersProp === 'string') {
        try {
          const parsed: unknown = JSON.parse(membersProp);
          if (Array.isArray(parsed)) memberIds = parsed as number[];
        } catch { /* ignore */ }
      } else if (Array.isArray(membersProp)) {
        memberIds = membersProp as number[];
      }

      const coords = features?.[0]?.geometry as Point;
      if (memberIds && memberIds.length > 0 && coords) {
        const screen = map.project(coords.coordinates as [number, number]);
        const items: DevicePoint[] = memberIds.map(deviceId => {
          const comp = componentsRef.current.find(c => c.device === deviceId);
          if (comp) return { ...comp };
          return { device: deviceId, mean: [0, 0] as Vec2, variance: 100, lat: 0, lon: 0, timestamp: 0, accuracy: 0, anchorAgeMs: 0, confidence: 0 };
        });
        setClusterPopup({ x: screen.x, y: screen.y, items });
      }
    };

    const onMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['individuals-layer', 'clusters-layer'] });
      if (!features.length) {
        setClusterPopup(null);
      }
    };

    if (!listenersAttached.current) {
      map.on('move', onMove);
      map.on('moveend', onMove);
      map.on('zoom', onMove);
      map.on('click', 'individuals-layer', onIndividualClick);
      map.on('click', 'clusters-layer', onClusterClick);
      map.on('click', onMapClick);

      map.on("mouseenter", "individuals-layer", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "individuals-layer", () => { map.getCanvas().style.cursor = ""; });
      map.on("mouseenter", "clusters-layer", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "clusters-layer", () => { map.getCanvas().style.cursor = ""; });

      listenersAttached.current = true;
    }
  }, [maptilerApiKey]);

  // Style data listener to restore layers after style change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onStyleData = () => {
      updateLayersRef.current();
    };

    map.on('styledata', onStyleData);
    return () => { map?.off('styledata', onStyleData); };
  }, [maptilerApiKey]);

  // Data update effect
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    updateLayers();
  }, [components, deviceNames, deviceIcons, deviceColors, darkMode, selectedDeviceId, updateLayers]);

  // Initial fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !worldBounds || refLat == null || refLon == null || hasFittedInitially.current) return;

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

    hasFittedInitially.current = true;
  }, [worldBounds, refLat, refLon]);

  return (
    <div style={{ height: "100vh", position: "relative", width: "100%" }}>
      <style>{`.maplibregl-ctrl-attrib{display:none} .maplibregl-ctrl-bottom-left{display:none}`}</style>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>{overlay}</div>
      {clusterPopup && (
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
          <ClusterPopup
            x={clusterPopup.x}
            y={clusterPopup.y}
            items={clusterPopup.items}
            animationState="visible"
            onClose={() => setClusterPopup(null)}
            onSelectDevice={(id) => {
              onSelectDevice(id);
              setClusterPopup(null);
            }}
            darkMode={darkMode}
            deviceColors={deviceColors}
            deviceIcons={deviceIcons}
            deviceNames={deviceNames}
          />
        </div>
      )}
    </div>
  );
});

export default React.memo(MapView);
