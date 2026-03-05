# Flux360

A real-time GPS tracking visualization tool that connects to Traccar servers for live device monitoring. It uses advanced anchoring algorithms to smooth position data, detect stationary vs. moving states, and provide accurate location estimates even in noisy GPS environments.

## Features

- **Real-time Data Ingestion**: WebSocket connection to Traccar for streaming position updates, with automatic fallback to historical API fetches.
- **Anchoring Engine**: Processes GPS measurements through Kalman filtering to create stable position anchors, handling outliers and providing confidence scores.
- **Motion Detection**: Supports configurable motion profiles (e.g., pedestrian or vehicle) to adapt tracking behavior based on device type.
- **Settling Logic**: Automatically detects when motion has ceased by analyzing a sliding window of recent position points. If points are spatially consistent (clustered) and movement directions appear random (indicating noise rather than directed travel), the engine establishes a new stable anchor at the centroid of the windowed points, smoothing transitions in noisy GPS environments.
- **Device Grouping**: Aggregate multiple devices into virtual groups for combined tracking (e.g., family or fleet views).
- **Timeline Panel**: Visualizes the past 24 hours of stationary and moving events for a selected device, allowing users to replay and observe historical map paths.
- **Interactive Mapping**: MapTiler SDK-based map with visual overlays for accuracy circles, device icons, history observation bounds, and clustering.
- **Debug Mode**: Inspect processing frames, anchor history, and motion decisions for troubleshooting.
- **Settings UI**: In-app configuration for server connection, authentication, and device management.

## Future Ideas

- **Route Inference**: Integrate with routing data (e.g., OSM) to infer likely paths and constrain predictions based on road networks.
- **Enhanced Visualization**: Expand map options for better performance with large datasets.
- **Advanced Analytics**: Add route optimization, geofencing, and alert systems for fleet management.
- **Push Notifications**: Alert users when a device enters or leaves a defined geofence, or when it has been stationary past a configurable threshold.

## Usage

Copy `config.sample.json` to `config.json`:

| Field | Description |
|---|---|
| `traccarBaseUrl` | Hostname of your [Traccar](https://www.traccar.org) server |
| `traccarSecure` | `true` for HTTPS/WSS, `false` for HTTP/WS |
| `maptilerApiKey` | [MapTiler](https://www.maptiler.com) API key |


Run the server:
```bash
bun run dev # runs on port 3000
```

