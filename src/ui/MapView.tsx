import "@maptiler/sdk/dist/maptiler-sdk.css";
import { CLUSTER_DISTANCE_PX, computeClusters, type DrawItem } from "@/util/clustering";
import { ClusterPopup } from "./map/ClusterPopup";
import { GeoJSONSource, Map as MaptilerMap, MapStyle, config, MapMouseEvent } from "@maptiler/sdk";
import { getColorForDevice, type Color } from "@/util/color";
import { toWebMercator, fromWebMercator } from "@/util/webMercator";
import { distance, getRadiusFromVariance } from "@/util/geo";
import { drawPin, PIN_R } from "@/util/rendering";
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DevicePoint, Vec2, DebugAnchor, DebugFrameView, Timestamp } from "@/types";
import type { Feature, Point, Polygon } from "geojson";

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
};

type Props = {
  components: DevicePoint[];
  deviceNames: Record<number, string>;
  deviceIcons: Record<number, string>;
  deviceColors: Record<number, string>;
  overlay: React.ReactNode;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  maptilerApiKey: string | null;
  darkMode: boolean;
  debugAnchors: DebugAnchor[];
  debugFrame: DebugFrameView | null;
  pulsingDeviceIds: number[];
};

const MapView = React.forwardRef<MapViewHandle, Props>(({
  components,
  deviceNames,
  deviceIcons,
  deviceColors,
  overlay,
  selectedDeviceId,
  onSelectDevice,
  maptilerApiKey,
  darkMode,
  debugAnchors = [],
  debugFrame = null,
  pulsingDeviceIds = [],
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaptilerMap | null>(null);
  const componentsRef = useRef<DevicePoint[]>(components);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  const onSelectDeviceRef = useRef(onSelectDevice);
  const hasFittedInitially = useRef(false);

  type AnchorTooltip = { x: number; y: number; anchor: DebugAnchor };
  const [clusterPopup, setClusterPopup] = useState<{ x: number, y: number, items: DevicePoint[] } | null>(null);
  const [anchorTooltip, setAnchorTooltip] = useState<AnchorTooltip | null>(null);
  const debugAnchorsRef = useRef<DebugAnchor[]>(debugAnchors);
  useEffect(() => { debugAnchorsRef.current = debugAnchors; }, [debugAnchors]);

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

    const center = map.getCenter();
    let duration = 800;
    if (center) {
      const distanceDeg = distance(device.geo, [center.lng, center.lat]);

      const minDuration = 300;
      const maxDuration = 2500;
      const maxDistanceDeg = 0.045; // ~0.045 degrees ≈ 5km in latitude
      const t = Math.min(1, distanceDeg / maxDistanceDeg);
      duration = Math.round(minDuration + t * (maxDuration - minDuration));
    }

    map.flyTo({ center: device.geo, zoom: 18, duration });
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
      const pt = map.project(c.geo);
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
    const accuracyFeatures: Feature<Polygon>[] = [];

    // Track clustered vs individual indices in one pass
    for (let i = 0; i < drawItems.length; i++) {
      const c = components[i]!;
      const item = drawItems[i]!;
      const isClustered = clusteredIdxs.has(i);

      if (isClustered) {
        dotsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.geo },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` },
        });
      } else {
        const imageKey = `${item.iconText}-${item.colorHex}-${darkMode ? 'dark' : 'light'}`;
        if (!map.hasImage(imageKey)) {
          const pinCanvas = document.createElement("canvas");
          pinCanvas.width = 48; pinCanvas.height = 48;
          const pctx = pinCanvas.getContext("2d")!;
          drawPin(pctx, 24, 36, PIN_R, item.iconText, item.color as Color, darkMode);
          const imageData = pctx.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
          if (imageData) map.addImage(imageKey, imageData);
        }
        individualsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.geo },
          properties: { imageKey, device: item.device },
        });
      }

      // Always draw accuracy circle for selected device regardless of cluster state
      if (c.device === selectedDeviceId && c.accuracy > 0) {
        const [cx, cy] = toWebMercator(c.geo);
        const pts = 64;
        const coords: Vec2[] = [];
        for (let j = 0; j <= pts; j++) {
          const angle = (j * 2 * Math.PI) / pts;
          coords.push(fromWebMercator([cx + c.accuracy * Math.cos(angle), cy + c.accuracy * Math.sin(angle)]));
        }
        accuracyFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` }
        });
      }
    } // end per-device for loop

    // Debug frame circles (measurement + anchor at selected frame)
    type FrameFeature = Feature<Polygon> | Feature<{ type: 'LineString'; coordinates: Vec2[] }>;
    const debugFrameFeatures: FrameFeature[] = [];
    if (debugFrame) {
      const makeCircle = (center: Vec2, radiusM: number, kind: string): Feature<Polygon> => {
        const pts = 64;
        const coords: Vec2[] = [];
        for (let j = 0; j <= pts; j++) {
          const angle = (j * 2 * Math.PI) / pts;
          coords.push(fromWebMercator([center[0] + radiusM * Math.cos(angle), center[1] + radiusM * Math.sin(angle)]));
        }
        return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { kind } };
      };
      if (debugFrame.measurement.accuracy > 0)
        debugFrameFeatures.push(makeCircle(debugFrame.measurement.mean, debugFrame.measurement.accuracy, 'measurement'));
      if (debugFrame.anchor) {
        debugFrameFeatures.push(makeCircle(debugFrame.anchor.mean, getRadiusFromVariance(debugFrame.anchor.variance), 'anchor'));
        // Red line connecting measurement center to anchor center
        debugFrameFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [debugFrame.measurement.geo, fromWebMercator(debugFrame.anchor.mean)] },
          properties: { kind: 'link' },
        } as FrameFeature);
      }
    }

    // Debug anchor circles
    const ANCHOR_COLORS: Record<DebugAnchor['type'], string> = {
      active: '#00bcd4',   // teal
      closed: '#9e9e9e',   // gray
      candidate: '#ff9800', // orange
      frame: '#2196f3',    // blue
    };
    const anchorCircleFeatures: Feature<Polygon>[] = [];
    for (let ai = 0; ai < debugAnchors.length; ai++) {
      const a = debugAnchors[ai]!;
      const radius = getRadiusFromVariance(a.variance);
      const pts = 64;
      const coords: Vec2[] = [];
      for (let j = 0; j <= pts; j++) {
        const angle = (j * 2 * Math.PI) / pts;
        coords.push(fromWebMercator([a.mean[0] + radius * Math.cos(angle), a.mean[1] + radius * Math.sin(angle)]));
      }
      anchorCircleFeatures.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {
          color: ANCHOR_COLORS[a.type],
          anchorIndex: ai,
        },
      });
    }

    // Process clusters (separate pass after all devices are evaluated)
    for (const cl of clusters) {
      if (cl.size <= 1) continue;

      if (hiddenClusterDeviceIds) {
        const thisClusterIds = new Set(cl.items.map(it => it.device));
        if (thisClusterIds.size === hiddenClusterDeviceIds.size &&
          [...thisClusterIds].every(id => hiddenClusterDeviceIds.has(id))) {
          continue;
        }
      }

      const repItem = cl.items.find(it => it.device === selectedDeviceId) ??
        cl.items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      const repIdx = drawItems.findIndex(di => di.device === repItem.device);
      const rep = drawItems[repIdx];
      if (!rep) continue;

      const selItem = selectedDeviceId != null ? cl.items.find(it => it.device === selectedDeviceId) : null;
      const selComp = selItem ? components[selItem.idx] : null;
      const markerLng = selComp ? selComp.geo[0] : cl.items.reduce((sum, it) => sum + (components[it.idx]?.geo[0] ?? 0), 0) / cl.size;
      const markerLat = selComp ? selComp.geo[1] : cl.items.reduce((sum, it) => sum + (components[it.idx]?.geo[1] ?? 0), 0) / cl.size;

      const clusterKey = `cluster-${rep.iconText}-${rep.colorHex}-${cl.size}-${darkMode ? 'dark' : 'light'}`;
      if (!map.hasImage(clusterKey)) {
        const pinCanvas = document.createElement("canvas");
        pinCanvas.width = 48; pinCanvas.height = 48;
        const pctx = pinCanvas.getContext("2d")!;
        drawPin(pctx, 24, 36, PIN_R, rep.iconText, rep.color as Color, darkMode, false, String(cl.size));
        const imageData = pctx.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
        if (imageData) map.addImage(clusterKey, imageData);
      }

      clustersFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [markerLng, markerLat] },
        properties: {
          clusterIconKey: clusterKey,
          members: cl.items.map(it => it.device),
        },
      });
    }

    // Pulsing device points (drawn under pins)
    const pulsingPointFeatures: Feature<Point>[] = [];
    for (const comp of components) {
      if (pulsingDeviceIds.includes(comp.device)) {
        pulsingPointFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: comp.geo },
          properties: {},
        });
      }
    }

    try {
      // Update sources & layers - initialize on first call, setData on subsequent
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

      const pulsingData = { type: 'FeatureCollection' as const, features: pulsingPointFeatures };
      if (!map.getSource('pulsing-source')) {
        map.addSource('pulsing-source', { type: 'geojson', data: pulsingData });
        map.addLayer({
          id: 'pulsing-layer',
          type: 'circle',
          source: 'pulsing-source',
          paint: {
            'circle-radius': 8,
            'circle-color': 'transparent',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#2196f3',
            'circle-stroke-opacity': 0,
            'circle-pitch-alignment': 'map',
            'circle-radius-transition': { duration: 0, delay: 0 },
            'circle-stroke-opacity-transition': { duration: 0, delay: 0 },
          },
        }, 'dots-layer');
      } else {
        (map.getSource('pulsing-source') as GeoJSONSource).setData(pulsingData);
      }

      const accData = { type: 'FeatureCollection' as const, features: accuracyFeatures };
      if (!map.getSource('accuracy-source')) {
        map.addSource('accuracy-source', { type: 'geojson', data: accData });
        map.addLayer({
          id: 'accuracy-fill-layer',
          type: 'fill',
          source: 'accuracy-source',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
        });
        map.addLayer({
          id: 'accuracy-stroke-layer',
          type: 'line',
          source: 'accuracy-source',
          paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.6 },
        });
      } else {
        (map.getSource('accuracy-source') as GeoJSONSource).setData(accData);
      }

      const anchorData = { type: 'FeatureCollection' as const, features: anchorCircleFeatures };
      if (!map.getSource('debug-anchors-source')) {
        map.addSource('debug-anchors-source', { type: 'geojson', data: anchorData });
        // Invisible fill for interior hover hit-testing
        map.addLayer({
          id: 'debug-anchors-fill-layer',
          type: 'fill',
          source: 'debug-anchors-source',
          paint: { 'fill-opacity': 0 },
        });
        // Solid outline — no dasharray so it stays visually consistent across zoom levels
        map.addLayer({
          id: 'debug-anchors-layer',
          type: 'line',
          source: 'debug-anchors-source',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.5,
            'line-opacity': 0.85,
          },
        });
      } else {
        (map.getSource('debug-anchors-source') as GeoJSONSource).setData(anchorData);
      }

      const frameData = { type: 'FeatureCollection' as const, features: debugFrameFeatures };
      if (!map.getSource('debug-frame-source')) {
        map.addSource('debug-frame-source', { type: 'geojson', data: frameData as never });
        // Light red fill for measurement circle (no outline)
        map.addLayer({
          id: 'debug-frame-fill-layer',
          type: 'fill',
          source: 'debug-frame-source',
          filter: ['==', ['get', 'kind'], 'measurement'],
          paint: { 'fill-color': '#f44336', 'fill-opacity': 0.25 },
        });
        // Blue outline for anchor-at-frame circle
        map.addLayer({
          id: 'debug-frame-anchor-layer',
          type: 'line',
          source: 'debug-frame-source',
          filter: ['==', ['get', 'kind'], 'anchor'],
          paint: { 'line-color': '#2196f3', 'line-width': 1.5, 'line-opacity': 0.9 },
        });
        // Red line linking measurement center to anchor center
        map.addLayer({
          id: 'debug-frame-link-layer',
          type: 'line',
          source: 'debug-frame-source',
          filter: ['==', ['get', 'kind'], 'link'],
          paint: { 'line-color': '#f44336', 'line-width': 1.5, 'line-opacity': 0.8 },
        });
      } else {
        (map.getSource('debug-frame-source') as GeoJSONSource).setData(frameData as never);
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
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Style is not done loading")) return;
      throw e;
    }
  }, [components, deviceIcons, deviceColors, darkMode, selectedDeviceId, clusterPopup, debugAnchors, debugFrame, pulsingDeviceIds]);

  const listenersAttached = useRef(false);

  // Map initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerApiKey) return;

    config.apiKey = maptilerApiKey;

    let initialCenter: Vec2 = [0, 0];
    let initialZoom = 2;

    const firstComp = componentsRef.current[0];
    if (firstComp) {
      initialCenter = firstComp.geo;
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

  // rAF animation loop: update pulsing-layer paint properties each frame
  useEffect(() => {
    if (pulsingDeviceIds.length === 0) {
      // Clear the layer if no devices pulsing
      const map = mapRef.current;
      if (map?.getLayer('pulsing-layer')) {
        map.setPaintProperty('pulsing-layer', 'circle-radius', 8);
        map.setPaintProperty('pulsing-layer', 'circle-stroke-opacity', 0);
      }
      return;
    }
    const PERIOD = 1200; // ms per ping
    const MAX_RADIUS = 60;
    let running = true;
    const tick = () => {
      const map = mapRef.current;
      if (map?.getLayer('pulsing-layer')) {
        const t = (Date.now() % PERIOD) / PERIOD;
        map.setPaintProperty('pulsing-layer', 'circle-radius', 8 + t * MAX_RADIUS);
        map.setPaintProperty('pulsing-layer', 'circle-stroke-opacity', 1 - t);
      }
      if (running) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    return () => { running = false; };
  }, [pulsingDeviceIds]);

  // Listeners setup
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let rafPending = false;
    const onMove = () => {
      if (!rafPending) {
        rafPending = true;
        window.requestAnimationFrame(() => {
          updateLayersRef.current();
          rafPending = false;
        });
      }
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
          const parsed: unknown = JSON.parse(membersProp) as unknown;
          if (Array.isArray(parsed)) memberIds = parsed as number[];
        } catch { /* ignore */ }
      } else if (Array.isArray(membersProp)) {
        memberIds = membersProp as number[];
      }

      const coords = features?.[0]?.geometry as Point;
      if (memberIds && memberIds.length > 0 && coords) {
        const screen = map.project(coords.coordinates as Vec2);
        const items: DevicePoint[] = memberIds
          .map(deviceId => componentsRef.current.find(c => c.device === deviceId))
          .filter((c): c is DevicePoint => !!c);
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

      // Debug anchor hover — listen on fill layer so tooltip fires anywhere inside the circle
      map.on("mousemove", "debug-anchors-fill-layer", (e: MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['debug-anchors-fill-layer'] });
        let best: DebugAnchor | null = null;
        for (const f of features) {
          const idx: unknown = f.properties?.['anchorIndex'];
          if (typeof idx !== 'number') continue;
          const anchor = debugAnchorsRef.current[idx];
          if (anchor && (best === null || anchor.variance < best.variance)) best = anchor;
        }
        if (best) {
          setAnchorTooltip({ x: e.point.x, y: e.point.y, anchor: best });
          map.getCanvas().style.cursor = 'crosshair';
        }
      });
      map.on("mouseleave", "debug-anchors-fill-layer", () => {
        setAnchorTooltip(null);
        map.getCanvas().style.cursor = '';
      });

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasFittedInitially.current) return;

    const c = componentsRef.current;
    if (c.length === 0) return;

    let sw: Vec2, ne: Vec2;

    if (c.length > 0) {
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (const comp of c) {
        minLat = Math.min(minLat, comp.geo[1]);
        minLon = Math.min(minLon, comp.geo[0]);
        maxLat = Math.max(maxLat, comp.geo[1]);
        maxLon = Math.max(maxLon, comp.geo[0]);
      }
      const padding = 0.005;
      sw = [minLon - padding, minLat - padding];
      ne = [maxLon + padding, maxLat + padding];
    } else {
      return;
    }

    map.fitBounds(
      [sw[0], sw[1], ne[0], ne[1]],
      { padding: 40, maxZoom: 18, duration: 0 }
    );

    hasFittedInitially.current = true;
  }, []);

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
      {anchorTooltip && (() => {
        const a = anchorTooltip.anchor;
        const fmt = (ts: Timestamp) => { const d = new Date(ts); const t = new Date(); return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate() ? d.toLocaleTimeString() : d.toLocaleString(); };
        const radius = Math.round(getRadiusFromVariance(a.variance));
        return (
          <div style={{
            position: 'absolute',
            left: anchorTooltip.x + 12,
            top: anchorTooltip.y + 12,
            zIndex: 30,
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.75)',
            color: '#fff',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            borderLeft: `3px solid ${a.type === 'active' ? '#00bcd4' : '#9e9e9e'}`,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{a.type === 'active' ? '● Active anchor' : '○ Closed anchor'}</div>
            <div>Radius: {radius} m</div>
            <div>Confidence: {(a.confidence * 100).toFixed(0)}%</div>
            <div>Started: {fmt(a.startTimestamp)}</div>
            {a.endTimestamp && <div>Ended: {fmt(a.endTimestamp)}</div>}
          </div>
        );
      })()}
    </div>
  );
});

export default React.memo(MapView);
