# Flux360

A real-time GPS tracking visualization tool that connects to Traccar servers for live device monitoring. It uses advanced position filtering and motion detection algorithms to provide stable, filtered results even in noisy GPS environments.

## Screenshots

### Event History View
<img width="1920" height="1080" alt="Event History View" src="https://github.com/user-attachments/assets/efb4fcf0-e22f-494e-a539-1547d32def58" />

### Cluster Menu and Device Panel
<img width="1920" height="1080" alt="Devices Panel" src="https://github.com/user-attachments/assets/212fda4e-8eec-43f9-a88a-bce242e6ecdf" />

## Features

- **Real-time Data Ingestion**: Provides a unified WebSocket stream, handles secure authentication, and manages persistent state via a local SQLite database.
- **Position Filtering Engine**: Processes GPS measurements through Kalman filtering to create stable position estimates, handling outliers and providing confidence scores.
- **Motion Detection**: Adapts tracking behavior based on configurable motion profiles (e.g., pedestrian or vehicle).
- **Movement Smoothing**: Real-time filtering of movement events reduces jitter and path deviations, providing a continuous and accurate trajectory.
- **Settling Logic**: Automatically detects when motion has ceased by analyzing recent position points. If points are clustered and movement appears random (noise), the engine establishes a stable stationary position at the centroid, smoothing transitions in noisy environments.
- **Device Sharing**: Securely share access to specific devices with other users.
- **Persistent History & Backfilling**: Automatically backfills missing historical data from Traccar on startup, maintaining a rolling window of high-resolution position snapshots.
- **Device Grouping**: Aggregate multiple devices into virtual groups for combined tracking (e.g., family or fleet views).
- **Timeline Panel**: Visualizes the past 24 hours of stationary and moving events, allowing users to replay historical map paths.
- **Interactive Mapping**: MapTiler SDK-based map with visual overlays for accuracy circles, device icons, history observation bounds, and clustering.
- **Debug Mode**: Inspect background processing frames, settled position history, and motion decisions for troubleshooting.
- **Settings UI**: In-app configuration for device metadata, motion profiles, and sharing permissions.

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

Install dependancies:
```bash
bun run i
```

Run the server:
```bash
bun run dev # runs on port 3000
```

