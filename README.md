# Flux360

A real-time GPS tracking visualization tool that connects to Traccar servers for live device monitoring. It uses advanced anchoring algorithms to smooth position data, detect stationary vs. moving states, and provide accurate location estimates even in noisy GPS environments.

## Features

- **Real-time Data Ingestion**: WebSocket connection to Traccar for streaming position updates, with automatic fallback to historical API fetches.
- **Anchoring Engine**: Processes GPS measurements through Kalman filtering to create stable position anchors, handling outliers and providing confidence scores.
- **Motion Detection**: Supports configurable motion profiles (e.g., pedestrian or vehicle) to adapt tracking behavior based on device type.
- **Device Grouping**: Aggregate multiple devices into virtual groups for combined tracking (e.g., family or fleet views).
- **Interactive Mapping**: Leaflet-based map with visual overlays for accuracy circles, device icons, and clustering.
- **Debug Mode**: Inspect processing frames, anchor history, and motion decisions for troubleshooting.
- **Settings UI**: In-app configuration for server connection, authentication, and device management.

## Future Ideas

- **Motion History and Playback**: Persist and visualize historical motion segments with scrub-through controls.
- **Route Inference**: Integrate with routing data (e.g., OSM) to infer likely paths and constrain predictions based on road networks.
- **Enhanced Visualization**: Expand map options for better performance with large datasets, such as vector tiles.
- **Advanced Analytics**: Add route optimization, geofencing, and alert systems for fleet management.

## Setup

To install dependencies:

```bash
bun install
```

To start a development server (default port 3000):

```bash
bun dev
```

## Usage

Configure the connection in the in-app **Settings** panel: enter the Traccar WebSocket URL and optional token. These settings are saved locally and used automatically.

The app displays live device positions on an interactive map, with smooth anchoring to reduce GPS noise during stationary periods. Use debug mode to analyze processing details.

## Development

See [AGENTS.md](AGENTS.md) for development guidelines and coding conventions.

---

Built with Bun, React, TypeScript, Tailwind CSS, and Leaflet.