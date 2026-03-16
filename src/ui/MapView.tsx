import "@maptiler/sdk/dist/maptiler-sdk.css";
import { CLUSTER_DISTANCE_PX, computeClusters } from "@/util/clustering";
import { ClusterPopup } from "./map/ClusterPopup";
import { distance, getRadiusFromVariance } from "@/util/geo";
import { drawPin, PIN_R } from "@/util/rendering";
import { fromWebMercator } from "@/util/webMercator";
import { GeoJSONSource, Map as MaptilerMap, MapStyle, config, MapMouseEvent } from "@maptiler/sdk";
import { getColorForDevice } from "@/util/color";
import { smoothPath, simplifyPath } from "@/util/pathSmoothing";
import { z } from "zod";
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppDevice, DevicePoint, Vec2, EngineEvent } from "@/types";
import type { Color } from "@/util/color";
import type { DrawItem } from "@/util/clustering";
import type { Feature, Point, Polygon, LineString } from "geojson";

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
  flyToBounds: (bounds: [Vec2, Vec2]) => void;
};

type Props = {
  activePoints: DevicePoint[];
  entities: Record<number, AppDevice>;
  overlay: React.ReactNode;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number) => void;
  maptilerApiKey: string | null;
  darkMode: boolean;
  pulsingDeviceIds: number[];
  selectedHistoryItem: EngineEvent | null;
  smoothingIterations: number;
  simplifyEpsilon: number;
};

const MapViewComponent = React.forwardRef<MapViewHandle, Props>(({
  activePoints,
  entities,
  overlay,
  selectedDeviceId,
  onSelectDevice,
  maptilerApiKey,
  darkMode,
  pulsingDeviceIds = [],
  selectedHistoryItem = null,
  smoothingIterations,
  simplifyEpsilon,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaptilerMap | null>(null);
  const activePointsRef = useRef<DevicePoint[]>(activePoints);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  const onSelectDeviceRef = useRef(onSelectDevice);
  const hasFittedInitially = useRef(false);

  const [clusterPopup, setClusterPopup] = useState<{ x: number, y: number, items: DevicePoint[] } | null>(null);

  useEffect(() => {
    activePointsRef.current = activePoints;
  }, [activePoints]);

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  useEffect(() => {
    onSelectDeviceRef.current = onSelectDevice;
  }, [onSelectDevice]);

  const flyToDevice = useCallback((id: number) => {
    const map = mapRef.current;
    if (!map) return;

    const device = activePointsRef.current.find(c => c.device === id);
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

  const flyToBounds = useCallback((bounds: [Vec2, Vec2]) => {
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 1000 });
  }, []);

  useImperativeHandle(ref, () => ({
    flyToDevice,
    flyToBounds,
  }));

  const motionPathCacheRef = useRef<Map<string, Vec2[]>>(new Map());

  // Reset cached smoothed paths when smoothing configuration changes
  useEffect(() => {
    motionPathCacheRef.current.clear();
  }, [smoothingIterations, simplifyEpsilon]);

  const updateLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    // Determine if a cluster popup is open and which devices it shows
    const hiddenClusterDeviceIds = clusterPopup
      ? new Set(clusterPopup.items.map(item => item.device))
      : null;

    // Project active points to screen coords
    const drawItems: (DrawItem & { colorHex: string })[] = activePoints.map((c, idx) => {
      const pt = map.project(c.geo);
      const entity = entities[c.device];
      const colorHex = entity?.color ?? '#3b82f6';
      const colorRgb = getColorForDevice(c.device, colorHex);
      return {
        idx,
        device: c.device,
        x: pt.x,
        y: pt.y,
        r: 0,
        iconText: entity?.emoji ?? String(c.device).charAt(0).toUpperCase(),
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
    const clusteredIdxs = new Set(
      clusters.filter(cl => cl.size > 1).flatMap(cl => cl.items.map(it => it.idx))
    );

    // Build GeoJSON features
    const dotsFeatures: Feature<Point>[] = [];
    const individualsFeatures: Feature<Point>[] = [];
    const clustersFeatures: Feature<Point>[] = [];
    const accuracyFeatures: Feature<Polygon>[] = [];

    drawItems.forEach((item, i) => {
      const c = activePoints[i]!;
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
        const [cx, cy] = c.mean;
        const pts = 64;
        const coords = Array.from({ length: pts + 1 }, (_, j) => {
          const angle = (j * 2 * Math.PI) / pts;
          return fromWebMercator([cx + c.accuracy * Math.cos(angle), cy + c.accuracy * Math.sin(angle)]);
        });
        accuracyFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` }
        });
      }
    });

    // Process clusters (separate pass after all devices are evaluated)
    clusters.filter(cl => cl.size > 1).forEach(cl => {
      if (hiddenClusterDeviceIds) {
        const thisClusterIds = new Set(cl.items.map(it => it.device));
        if (thisClusterIds.size === hiddenClusterDeviceIds.size &&
          [...thisClusterIds].every(id => hiddenClusterDeviceIds.has(id))) {
          return;
        }
      }

      const repItem = cl.items.find(it => it.device === selectedDeviceId) ??
        cl.items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      const rep = drawItems.find(di => di.device === repItem.device);
      if (!rep) return;

      const selItem = selectedDeviceId != null ? cl.items.find(it => it.device === selectedDeviceId) : null;
      const selComp = selItem ? activePoints[selItem.idx] : null;
      const markerLng = selComp ? selComp.geo[0] : cl.items.reduce((sum, it) => sum + (activePoints[it.idx]?.geo[0] ?? 0), 0) / cl.size;
      const markerLat = selComp ? selComp.geo[1] : cl.items.reduce((sum, it) => sum + (activePoints[it.idx]?.geo[1] ?? 0), 0) / cl.size;

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
    });

    // Pulsing device points (drawn under pins)
    const pulsingPointFeatures: Feature<Point>[] = [];
    for (const comp of activePoints) {
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

    // Process history item
    const historyFeatures: Feature<Polygon | LineString>[] = [];
    if (selectedHistoryItem) {
      if (selectedHistoryItem.type === 'stationary') {
        const a = selectedHistoryItem;
        const radius = getRadiusFromVariance(a.variance);
        const pts = 64;
        const coords: Vec2[] = [];
        for (let j = 0; j <= pts; j++) {
          const angle = (j * 2 * Math.PI) / pts;
          coords.push(fromWebMercator([a.mean[0] + radius * Math.cos(angle), a.mean[1] + radius * Math.sin(angle)]));
        }
        historyFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: { isAnchor: true },
        });
      } else {
        const s = selectedHistoryItem;
        if (s.path && s.path.length > 1) {
          const key = `motion-${s.start}-${s.end}-${s.path.length}-${s.path[0]?.timestamp ?? 0}-${s.path[s.path.length - 1]?.timestamp ?? 0}-it${smoothingIterations}-sp${simplifyEpsilon}`;
          const cached = motionPathCacheRef.current.get(key);
          const smoothedOrCached = cached ?? (smoothingIterations > 0 ? smoothPath(s.path, smoothingIterations) : s.path.map(p => p.geo));
          const smoothed = simplifyEpsilon > 0 ? simplifyPath(smoothedOrCached, simplifyEpsilon) : smoothedOrCached;

          if (!cached && !s.isDraft) {
            motionPathCacheRef.current.set(key, smoothed);
          }

          historyFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: smoothed.map(fromWebMercator) },
            properties: { isAnchor: false },
          });
        }
      }
    }

    try {
      if (!map.getSource('history-source')) {
        map.addSource('history-source', { type: 'geojson', data: { type: 'FeatureCollection', features: historyFeatures as unknown as Feature[] } });
        map.addLayer({
          id: 'history-anchor-layer',
          type: 'fill',
          source: 'history-source',
          filter: ['==', 'isAnchor', true],
          paint: {
            'fill-color': '#eab308',
            'fill-opacity': 0.3,
          }
        }, 'dots-layer');
        map.addLayer({
          id: 'history-anchor-stroke-layer',
          type: 'line',
          source: 'history-source',
          filter: ['==', 'isAnchor', true],
          paint: {
            'line-color': '#eab308',
            'line-width': 2,
          }
        }, 'individuals-layer');
        map.addLayer({
          id: 'history-path-layer',
          type: 'line',
          source: 'history-source',
          filter: ['==', 'isAnchor', false],
          paint: {
            'line-color': '#eab308',
            'line-width': 4,
            'line-dasharray': [2, 2],
          }
        }, 'individuals-layer');
      } else {
        (map.getSource('history-source') as GeoJSONSource).setData({ type: 'FeatureCollection', features: historyFeatures as unknown as Feature[] });
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Style is not done loading")) return;
      throw e;
    }
  }, [activePoints, entities, darkMode, selectedDeviceId, clusterPopup, pulsingDeviceIds, selectedHistoryItem, smoothingIterations, simplifyEpsilon]);

  const listenersAttached = useRef(false);

  // Map initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerApiKey) return;

    config.apiKey = maptilerApiKey;

    let initialCenter: Vec2 = [0, 0];
    let initialZoom = 2;

    const firstComp = activePointsRef.current[0];
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

  // Animate motion segment path (marching ants effect)
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('history-path-layer')) return;

    const isMotionSegment = selectedHistoryItem?.type === 'motion';
    if (!isMotionSegment) {
      map.setPaintProperty('history-path-layer', 'line-dasharray', [2, 2]);
      return;
    }

    const dashArraySequence = [
      [0, 4, 3],
      [0.5, 4, 2.5],
      [1, 4, 2],
      [1.5, 4, 1.5],
      [2, 4, 1],
      [2.5, 4, 0.5],
      [3, 4, 0],
      [0, 0.5, 3, 3.5],
      [0, 1, 3, 3],
      [0, 1.5, 3, 2.5],
      [0, 2, 3, 2],
      [0, 2.5, 3, 1.5],
      [0, 3, 3, 1],
      [0, 3.5, 3, 0.5],
    ];

    let running = true;
    let lastStep = -1;
    const tick = () => {
      const map = mapRef.current;
      const step = Math.floor(Date.now() / 50) % dashArraySequence.length;
      if (running && map?.getLayer('history-path-layer') && map.getStyle() && step !== lastStep) {
        lastStep = step;
        map.setPaintProperty('history-path-layer', 'line-dasharray', dashArraySequence[step] as [number, number, number]);
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    return () => { running = false; };
  }, [selectedHistoryItem]);

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
      const features = map.queryRenderedFeatures(e.point, { layers: ['individuals-layer'] });
      const props = features[0]?.properties;
      const device: unknown = props?.['device'];
      if (typeof device === 'number') {
        onSelectDeviceRef.current(device);
        flyToDevice(device);
      }
    };

    const onClusterClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters-layer'] });
      const props = features[0]?.properties;
      const members: unknown = props?.['members'];
      let memberIds: number[] = [];
      try {
        const source = typeof members === 'string' ? JSON.parse(members) as unknown : members;
        memberIds = z.coerce.number().array().parse(source);
      } catch { /* ignore malformed data */ }

      const geo = features[0]?.geometry;
      if (memberIds.length > 0 && geo?.type === 'Point') {
        const screen = map.project(geo.coordinates as Vec2);
        const items: DevicePoint[] = memberIds
          .map(deviceId => activePointsRef.current.find(c => c.device === deviceId))
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
  }, [activePoints, entities, darkMode, selectedDeviceId, updateLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasFittedInitially.current) return;

    const c = activePointsRef.current;
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
            entities={entities}
          />
        </div>
      )}    </div>
  );
});

export const MapView = React.memo(MapViewComponent);
