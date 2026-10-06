import "@maptiler/sdk/dist/maptiler-sdk.css";
import { CLUSTER_DISTANCE_PX, computeClusters } from "@/util/clustering";
import { ClusterPopup } from "./ClusterPopup";
import { colorForDeltaSeconds, getColorForDevice } from "@/util/color";
import { LABEL_COLORS, cssColor } from "@/labels/palette";
import { fixAtPoint, kindsAtFixes, mergeAccuracyCircles } from "@/labels/fixes";
import { computeBestFitMotionPath } from "@/util/motionBestFit";
import { MIN_LABEL_CIRCLE_RADIUS_PX, labelCirclePaint, metresPerPixel } from "./labeling/labelLayers";
import { buildAccuracyCircleCoords, getRadiusFromVariance } from "@/util/geo";
import { drawPin, PIN_R } from "@/util/rendering";
import { distance } from "@/util/vec2";
import { fromWebMercator, toWebMercator } from "@/util/webMercator";
import { GeoJSONSource, Map as MaptilerMap, config, MapMouseEvent } from "@maptiler/sdk";
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppDevice, DevicePoint, Vec2, EngineEvent } from "@/types";
import type { Label, LabelKind, StripFix } from "@/labels/types";
import type { Color } from "@/util/color";
import type { DrawItem } from "@/util/clustering";
import type { Feature, Point, Polygon } from "geojson";

/**
 * Merged into neighbourhoods before they reach the map. Drawing one feature per fix
 * makes a parked cluster accumulate into a solid disc, because the map composites each
 * feature separately.
 */
function accuracyCircles(fixes: StripFix[], color: string): Feature<Point>[] {
  return mergeAccuracyCircles(fixes).map(blob => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: blob.geo },
    properties: { radiusMeters: blob.radiusMeters, lat: blob.geo[1], color },
  }));
}

export type MapViewHandle = {
  flyToDevice: (id: number) => void;
  flyToBounds: (bounds: [Vec2, Vec2]) => void;
  focusFixes: (fixes: StripFix[]) => void;
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
  labelFixes: StripFix[];
  labels: Label[];
  labelHoveredFix: StripFix | null;
  labelSelectedFixes: StripFix[];
  onPickFix: (fix: StripFix) => void;
};
const STYLE_LIGHT = "dataviz";
const STYLE_DARK = "019d01fb-0333-7f54-9107-395c4e551160";

const MapViewComponent = React.forwardRef<MapViewHandle, Props>(({
  activePoints,
  entities,
  overlay,
  selectedDeviceId,
  onSelectDevice,
  maptilerApiKey,
  darkMode,
  pulsingDeviceIds,
  selectedHistoryItem,
  labelFixes,
  labels,
  labelHoveredFix,
  labelSelectedFixes,
  onPickFix,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaptilerMap | null>(null);
  const hasFittedInitially = useRef(false);
  const activePointsRef = useRef<DevicePoint[]>(activePoints);
  const lastHistoryKeyRef = useRef<string | null>(null);
  const flyToDeviceRef = useRef<(id: number) => void>(() => undefined);
  const onSelectDeviceRef = useRef<(id: number) => void>(() => undefined);

  type ClusterPopupState = {
    x: number;
    y: number;
    items: DevicePoint[];
    animationState: 'entering' | 'visible' | 'exiting';
  };

  const [clusterPopup, setClusterPopup] = useState<ClusterPopupState | null>(null);

  const closeClusterPopup = useCallback(() => {
    setClusterPopup((prev) => (prev ? { ...prev, animationState: 'exiting' } : null));
  }, []);

  useEffect(() => {
    if (clusterPopup?.animationState !== 'entering') return;
    const timer = window.setTimeout(() => {
      setClusterPopup((prev) => (prev?.animationState === 'entering' ? { ...prev, animationState: 'visible' } : prev));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [clusterPopup]);

  useEffect(() => {
    if (clusterPopup?.animationState !== 'exiting') return;
    const timer = window.setTimeout(() => setClusterPopup(null), 150);
    return () => window.clearTimeout(timer);
  }, [clusterPopup]);

  const flyToDevice = useCallback((id: number) => {
    const map = mapRef.current;
    if (!map) return;

    const device = activePoints.find(c => c.device === id);
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
  }, [activePoints]);

  const flyToBounds = useCallback((bounds: [Vec2, Vec2]) => {
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 1000 });
  }, []);

  /**
   * Frames whatever is selected. One fix frames that fix at a zoom chosen from its
   * accuracy; several fixes frame the whole group, because framing only the last
   * clicked one hides the rest of the selection.
   */
  const focusFixes = useCallback((fixes: StripFix[]) => {
    const map = mapRef.current;
    const only = fixes.length === 1 ? fixes[0] : undefined;
    if (!map) return;
    if (only) {
      map.flyTo({ center: only.geo, zoom: only.accuracy > 40 ? 16 : 17, duration: 800 });
      return;
    }
    if (fixes.length < 2) return;

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const fix of fixes) {
      const [lng, lat] = fix.geo;
      const pad = fix.accuracy / 111_320;
      if (lng - pad < west) west = lng - pad;
      if (lng + pad > east) east = lng + pad;
      if (lat - pad < south) south = lat - pad;
      if (lat + pad > north) north = lat + pad;
    }
    map.fitBounds([[west, south], [east, north]], { padding: 80, maxZoom: 18, duration: 800 });
  }, []);

  useImperativeHandle(ref, () => ({
    flyToDevice,
    flyToBounds,
    focusFixes,
  }));

  useEffect(() => {
    activePointsRef.current = activePoints;
  }, [activePoints]);

  useEffect(() => {
    flyToDeviceRef.current = flyToDevice;
  }, [flyToDevice]);

  useEffect(() => {
    onSelectDeviceRef.current = onSelectDevice;
  }, [onSelectDevice]);

  const renderPinImage = (imageKey: string, iconText: string, color: Color, label?: string) => {
    const map = mapRef.current;
    if (!map || map.hasImage(imageKey)) return;

    const pinCanvas = document.createElement("canvas");
    pinCanvas.width = 48;
    pinCanvas.height = 48;
    const pctx = pinCanvas.getContext("2d");
    if (pctx) {
      drawPin(pctx, 24, 36, PIN_R, iconText, color, darkMode, label);
      const imageData = pctx.getImageData(0, 0, pinCanvas.width, pinCanvas.height);
      if (imageData) map.addImage(imageKey, imageData);
    }
  };

  /**
   * The hovered fix is held in a ref as well as a prop. updateLayers reads the ref so
   * that a hover change does not appear in its dependency list; otherwise every pixel
   * of cursor movement would rebuild every cluster and pin on the map.
   */
  const labelHoveredFixRef = useRef<StripFix | null>(labelHoveredFix);
  useEffect(() => {
    labelHoveredFixRef.current = labelHoveredFix;
  }, [labelHoveredFix]);

  const labelFixesRef = useRef<StripFix[]>(labelFixes);
  useEffect(() => {
    labelFixesRef.current = labelFixes;
  }, [labelFixes]);

  const onPickFixRef = useRef(onPickFix);
  useEffect(() => {
    onPickFixRef.current = onPickFix;
  }, [onPickFix]);

  const buildLabelHoverData = useCallback((fix: StripFix | null) => ({
    type: 'FeatureCollection' as const,
    features: fix
      ? [{
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: fix.geo },
        properties: { radiusMeters: fix.accuracy, lat: fix.geo[1] },
      }]
      : [],
  }), []);

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
        iconText: entity?.icon ?? String(c.device).charAt(0).toUpperCase(),
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
      const c = activePoints[i];
      if (!c) return;

      if (clusteredIdxs.has(i)) {
        dotsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.geo },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` },
        });
      } else {
        const imageKey = `${item.iconText}-${item.colorHex}-${darkMode ? 'dark' : 'light'}`;
        renderPinImage(imageKey, item.iconText, item.color);
        individualsFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.geo },
          properties: { imageKey, device: item.device },
        });
      }

      // Always draw accuracy circle for selected device regardless of cluster state
      if (c.device === selectedDeviceId) {
        accuracyFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [buildAccuracyCircleCoords(c.mean, c.accuracy)] },
          properties: { color: `rgb(${item.color[0]}, ${item.color[1]}, ${item.color[2]})` }
        });
      }
    });

    // Deliberately neutral for an unlabelled fix. These mark raw fixes rather than
    // findings, and an accent colour competes with the device colours already on the map.
    const labelBaseColor = darkMode ? '#cbd5e1' : '#334155';
    const labelHoverColor = darkMode ? '#ffffff' : '#0f172a';
    const colorForKind = (kind: LabelKind | null) => kind === null ? labelBaseColor : cssColor(LABEL_COLORS[kind]);

    // Grouped by colour before merging, so a circle never mixes two labels into one
    // shade that means neither of them.
    const byColor = new Map<string, StripFix[]>();
    const kinds = kindsAtFixes(labelFixes, labels);
    labelFixes.forEach((fix, index) => {
      const color = colorForKind(kinds[index] ?? null);
      const group = byColor.get(color);
      if (group) group.push(fix);
      else byColor.set(color, [fix]);
    });

    const labelSelectedFeatures = accuracyCircles(labelSelectedFixes, '#22d3ee');

    // Raw fixes loaded for the labelling strip. These are history, not engine output,
    // so they are drawn independently of activePoints.
    const labelAccuracyFeatures = [...byColor].flatMap(([color, group]) => accuracyCircles(group, color));


    // Process clusters (separate pass after all devices are evaluated)
    clusters.filter(cl => cl.size > 1).forEach(cl => {
      if (hiddenClusterDeviceIds) {
        const thisClusterIds = new Set(cl.items.map(it => it.device));
        if (thisClusterIds.size === hiddenClusterDeviceIds.size &&
          [...thisClusterIds].every(id => hiddenClusterDeviceIds.has(id))) return;
      }

      const repItem = cl.items.find(it => it.device === selectedDeviceId) ??
        cl.items.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      const rep = drawItems.find(di => di.device === repItem.device);
      if (!rep) return;

      const selItem = selectedDeviceId != null ? cl.items.find(it => it.device === selectedDeviceId) : undefined;
      const selComp = selItem ? activePoints[selItem.idx] : undefined;
      const clusterSum = cl.items.reduce((acc: Vec2, it) => {
        const pt = activePoints[it.idx];
        return [acc[0] + (pt?.geo[0] ?? 0), acc[1] + (pt?.geo[1] ?? 0)] as Vec2;
      }, [0, 0] as Vec2);
      const [markerLng, markerLat] = selComp?.geo ?? [clusterSum[0] / cl.size, clusterSum[1] / cl.size];

      const clusterKey = `cluster-${rep.iconText}-${rep.colorHex}-${cl.size}-${darkMode ? 'dark' : 'light'}`;
      renderPinImage(clusterKey, rep.iconText, rep.color, String(cl.size));

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
    const pulsingPointFeatures: Feature<Point>[] = activePoints
      .filter(comp => pulsingDeviceIds.includes(comp.device))
      .map(comp => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: comp.geo },
        properties: {},
      }));

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

      const labelData = { type: 'FeatureCollection' as const, features: labelAccuracyFeatures };
      if (!map.getSource('label-accuracy-source')) {
        map.addSource('label-accuracy-source', { type: 'geojson', data: labelData });
        map.addLayer({
          id: 'label-accuracy-layer',
          type: 'circle',
          source: 'label-accuracy-source',
          paint: labelCirclePaint({ color: ['get', 'color'], fillOpacity: 0.10, strokeWidth: 1, strokeOpacity: 0.35 }),
        }, 'dots-layer');
      } else {
        (map.getSource('label-accuracy-source') as GeoJSONSource).setData(labelData);
      }

      const labelSelectedData = { type: 'FeatureCollection' as const, features: labelSelectedFeatures };
      if (!map.getSource('label-selected-source')) {
        map.addSource('label-selected-source', { type: 'geojson', data: labelSelectedData });
        map.addLayer({
          id: 'label-selected-layer',
          type: 'circle',
          source: 'label-selected-source',
          paint: labelCirclePaint({ color: '#22d3ee', fillOpacity: 0.16, strokeWidth: 1.5, strokeOpacity: 0.9 }),
        }, 'dots-layer');
      } else {
        (map.getSource('label-selected-source') as GeoJSONSource).setData(labelSelectedData);
      }

      const labelHoverData = buildLabelHoverData(labelHoveredFixRef.current);
      if (!map.getSource('label-hover-source')) {
        map.addSource('label-hover-source', { type: 'geojson', data: labelHoverData });
        map.addLayer({
          id: 'label-hover-layer',
          type: 'circle',
          source: 'label-hover-source',
          paint: labelCirclePaint({ color: labelHoverColor, fillOpacity: 0.20, strokeWidth: 2, strokeOpacity: 0.9 }),
        }, 'dots-layer');
      } else {
        (map.getSource('label-hover-source') as GeoJSONSource).setData(labelHoverData);
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

    const historyKey = selectedHistoryItem
      ? (selectedHistoryItem.isDraft && selectedHistoryItem.type === 'motion'
        ? `draft-${selectedHistoryItem.start}-${selectedHistoryItem.path.length}`
        : `${selectedHistoryItem.type}-${selectedHistoryItem.start}-${selectedHistoryItem.end}`)
      : 'none';
    if (historyKey === lastHistoryKeyRef.current) return;
    lastHistoryKeyRef.current = historyKey;

    if (!selectedHistoryItem) {
      const historySource = map.getSource('history-source');
      if (historySource)
        (historySource as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const historyFeatures: Feature[] = [];
    if (selectedHistoryItem.type === 'stationary') {
      const s = selectedHistoryItem;
      historyFeatures.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [buildAccuracyCircleCoords(s.mean, getRadiusFromVariance(s.variance))] },
        properties: { isAnchor: true },
      });
    } else {
      const m = selectedHistoryItem;
      if (m.path.length > 1) {
        historyFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: m.path.map(p => fromWebMercator(p.geo)) },
          properties: { isAnchor: false, pathKind: 'raw' },
        });

        historyFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: computeBestFitMotionPath(m.path).map(fromWebMercator) },
          properties: { isAnchor: false, pathKind: 'bestfit' },
        });

        // Add accuracy circles for each point in motion path, colorized by delta to next point.
        for (let i = 0; i < m.path.length; i++) {
          const p = m.path[i]!;
          const next = m.path[i + 1];
          const deltaColor = colorForDeltaSeconds(next ? Math.max(0, (next.timestamp - p.timestamp) / 1000) : 0);
          historyFeatures.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [buildAccuracyCircleCoords(p.geo, p.accuracy)] },
            properties: { isAnchor: false, pathKind: 'accuracy', color: deltaColor },
          });
        }

        m.outliers.forEach(p => historyFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [buildAccuracyCircleCoords(p.geo, p.accuracy)] },
          properties: { isAnchor: false, pathKind: 'accuracy', color: '#9e9e9e' },
        }));
      }
    }

    try {
      if (map.getSource('history-source')) {
        (map.getSource('history-source') as GeoJSONSource).setData({ type: 'FeatureCollection', features: historyFeatures });
        return;
      }

      map.addSource('history-source', { type: 'geojson', data: { type: 'FeatureCollection', features: historyFeatures } });
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
        id: 'history-raw-path-layer',
        type: 'line',
        source: 'history-source',
        filter: ['all', ['==', 'isAnchor', false], ['==', 'pathKind', 'raw']],
        paint: {
          'line-color': '#94a3b8',
          'line-width': 3,
          'line-opacity': 0.95,
          'line-dasharray': [2, 2],
        }
      }, 'individuals-layer');
      map.addLayer({
        id: 'history-bestfit-path-layer',
        type: 'line',
        source: 'history-source',
        filter: ['all', ['==', 'isAnchor', false], ['==', 'pathKind', 'bestfit']],
        paint: {
          'line-color': '#eab308',
          'line-width': 4,
          'line-opacity': 0.95,
        }
      }, 'individuals-layer');
      map.addLayer({
        id: 'history-accuracy-circles-layer',
        type: 'fill',
        source: 'history-source',
        filter: ['all', ['==', 'isAnchor', false], ['==', 'pathKind', 'accuracy']],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.1,
        }
      }, 'individuals-layer');
      map.addLayer({
        id: 'history-accuracy-circles-stroke-layer',
        type: 'line',
        source: 'history-source',
        filter: ['all', ['==', 'isAnchor', false], ['==', 'pathKind', 'accuracy']],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1,
          'line-opacity': 0.3,
        }
      }, 'individuals-layer');
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Style is not done loading")) return;
      throw e;
    }
  }, [activePoints, entities, darkMode, selectedDeviceId, clusterPopup, pulsingDeviceIds, selectedHistoryItem, labelFixes, labels, labelSelectedFixes, buildLabelHoverData]);

  // Hover only touches the one source it owns.
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource('label-hover-source');
    if (!map || !source) return;
    (source as GeoJSONSource).setData(buildLabelHoverData(labelHoveredFix));
  }, [labelHoveredFix, buildLabelHoverData]);

  const listenersAttached = useRef(false);
  const currentStyleRef = useRef<string>(darkMode ? STYLE_DARK : STYLE_LIGHT);

  // Map initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerApiKey) return;

    config.apiKey = maptilerApiKey;

    let initialCenter: Vec2 = [0, 0];
    let initialZoom = 2;

    const firstComp = activePoints[0];
    if (firstComp) {
      initialCenter = firstComp.geo;
      initialZoom = 15;
    }

    const map = new MaptilerMap({
      container,
      center: initialCenter,
      zoom: initialZoom,
      style: currentStyleRef.current,
      navigationControl: false,
      geolocateControl: false,
      scaleControl: false,
      fullscreenControl: false,
      dragRotate: false,
      boxZoom: false,
    });

    mapRef.current = map;
    listenersAttached.current = false;
    lastHistoryKeyRef.current = null;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [maptilerApiKey]);

  // Style update
  useEffect(() => {
    const map = mapRef.current;
    const desiredStyle = darkMode ? STYLE_DARK : STYLE_LIGHT;
    if (!map || !maptilerApiKey) return;

    if (currentStyleRef.current !== desiredStyle) {
      map.setStyle(desiredStyle);
      currentStyleRef.current = desiredStyle;
    }
  }, [maptilerApiKey, darkMode]);

  // Ref to hold updateLayers to avoid stale closure in event listeners
  const updateLayersRef = useRef(updateLayers);
  useEffect(() => { updateLayersRef.current = updateLayers; }, [updateLayers]);

  // rAF animation loop: update pulsing-layer paint properties each frame
  useEffect(() => {
    if (pulsingDeviceIds.length <= 0) return;
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
    if (!map?.getLayer('history-raw-path-layer')) return;

    if (selectedHistoryItem?.type !== 'motion') {
      map.setPaintProperty('history-raw-path-layer', 'line-dasharray', [2, 2]);
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
    let rafId = 0;
    const tick = () => {
      const map = mapRef.current;
      const step = Math.floor(Date.now() / 50) % dashArraySequence.length;
      if (running && map?.getLayer('history-raw-path-layer') && step !== lastStep) {
        lastStep = step;
        map.setPaintProperty('history-raw-path-layer', 'line-dasharray', dashArraySequence[step]);
      }
      if (running) rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      running = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [selectedHistoryItem]);

  // Listeners setup
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let rafPending = false;
    const onMove = () => {
      if (rafPending) return;
      rafPending = true;
      window.requestAnimationFrame(() => {
        updateLayersRef.current();
        rafPending = false;
      });
    };

    const onIndividualClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const features = map.queryRenderedFeatures(e.point, { layers: ['individuals-layer'] });
      const device: unknown = features[0]?.properties?.['device'];
      if (typeof device !== 'number') return;
      onSelectDeviceRef.current(device);
      flyToDeviceRef.current(device);
    };

    const onClusterClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters-layer'] });
      const rawMembers: unknown = features[0]?.properties?.['members'];

      if (typeof rawMembers !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMembers);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;

      const memberIds = parsed.map((id: unknown) => Number(id)).filter((id) => Number.isFinite(id));
      if (!memberIds.length) return;

      const geo = features[0]?.geometry;
      if (geo?.type !== 'Point') return;

      const items: DevicePoint[] = memberIds
        .map((deviceId) => activePointsRef.current.find((c) => c.device === deviceId))
        .filter((c): c is DevicePoint => !!c);
      if (!items.length) return;

      const screen = map.project(geo.coordinates as Vec2);
      setClusterPopup({ x: screen.x, y: screen.y, items, animationState: 'entering' });
    };

    const onMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['individuals-layer', 'clusters-layer'] });
      if (!features.length) closeClusterPopup();
    };

    if (!listenersAttached.current) {
      map.on('move', onMove);
      map.on('moveend', onMove);
      map.on('zoom', onMove);

      map.on('click', 'individuals-layer', onIndividualClick);
      map.on('click', 'clusters-layer', onClusterClick);
      map.on('click', onMapClick);

      // Registered last so a device dot under the cursor wins and sets defaultPrevented.
      map.on('click', (event: MapMouseEvent) => {
        if (event.defaultPrevented) return;
        const fixes = labelFixesRef.current;
        if (fixes.length === 0) return;
        const minReach = MIN_LABEL_CIRCLE_RADIUS_PX * metresPerPixel(map.getZoom(), event.lngLat.lat);
        const picked = fixAtPoint(fixes, toWebMercator([event.lngLat.lng, event.lngLat.lat]), minReach);
        if (!picked) return;
        event.preventDefault();
        onPickFixRef.current(picked);
      });

      ['individuals-layer', 'clusters-layer'].forEach(layer => {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      });

      listenersAttached.current = true;
    }
  }, [maptilerApiKey, onSelectDevice, activePoints, flyToDevice]);

  // Style data listener to restore layers after style change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onStyleData = () => {
      lastHistoryKeyRef.current = null;
      updateLayersRef.current();
    };

    map.on('styledata', onStyleData);
    return () => { map?.off('styledata', onStyleData); };
  }, [maptilerApiKey]);

  // Data update effect
  useEffect(() => {
    if (mapRef.current) updateLayers();
  }, [activePoints, entities, darkMode, selectedDeviceId, labelFixes, updateLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasFittedInitially.current || activePoints.length <= 0) return;

    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const comp of activePoints) {
      minLat = Math.min(minLat, comp.geo[1]);
      minLon = Math.min(minLon, comp.geo[0]);
      maxLat = Math.max(maxLat, comp.geo[1]);
      maxLon = Math.max(maxLon, comp.geo[0]);
    }

    const padding = 0.005;
    let sw: Vec2 = [minLon - padding, minLat - padding];
    let ne: Vec2 = [maxLon + padding, maxLat + padding];

    map.fitBounds([sw[0], sw[1], ne[0], ne[1]], { padding: 40, maxZoom: 18, duration: 0 });
    hasFittedInitially.current = true;
  }, [activePoints]);

  return (
    <div style={{ height: "100vh", position: "relative", width: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>{overlay}</div>
      {clusterPopup && (
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
          <ClusterPopup
            x={clusterPopup.x}
            y={clusterPopup.y}
            items={clusterPopup.items}
            animationState={clusterPopup.animationState}
            onClose={closeClusterPopup}
            onSelectDevice={(id) => {
              onSelectDevice(id);
              closeClusterPopup();
            }}
            darkMode={darkMode}
            entities={entities}
          />
        </div>
      )}
    </div>
  );
});

export const MapView = React.memo(MapViewComponent);
