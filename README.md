# Flux360

A real-time GPS tracking visualization tool that connects to Traccar servers for live device monitoring. It uses advanced position filtering and motion detection algorithms to provide stable, filtered results even in noisy GPS environments.

## Screenshots

### Event History View

![Event History View](https://github.com/user-attachments/assets/efb4fcf0-e22f-494e-a539-1547d32def58)

### Cluster Menu and Device Panel

![Cluster Menu and Device Panel](https://github.com/user-attachments/assets/212fda4e-8eec-43f9-a88a-bce242e6ecdf)

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
- **Settings UI**: In-app configuration for device metadata, motion profiles, and sharing permissions.

## Future Ideas

- **Route Inference**: Integrate with routing data (e.g., OSM) to infer likely paths and constrain predictions based on road networks.
- **Enhanced Visualization**: Expand map options for better performance with large datasets.
- **Advanced Analytics**: Add route optimization, geofencing, and alert systems for fleet management.
- **Push Notifications**: Alert users when a device enters or leaves a defined geofence, or when it has been stationary past a configurable threshold.

## Usage

Copy `.env.example` to `.env` and configure the environment variables:

| Environment Variable | Description |
|---|---|
| `TRACCAR_BASE_URL` | Hostname of your [Traccar](https://www.traccar.org) server |
| `TRACCAR_SECURE` | `true` for HTTPS/WSS, `false` for HTTP/WS |
| `MAPTILER_API_KEY` | [MapTiler](https://www.maptiler.com) API key |
| `TRACCAR_API_TOKEN` | Admin token for the Traccar server |
| `HISTORY_DAYS` | Number of days of historical tracking data to retain |

Install dependencies:
```bash
bun install
```

Run the development server:
```bash
bun run dev # runs on port 6474
```

## Docker Deployment

To build and run the application inside a Docker container:

1. Build and start the container using Docker Compose:
   ```bash
   docker compose up -d --build
   ```

2. The container mounts a local persistent volume at `/root/flux360` to store the SQLite database at `/app/data/flux360.sqlite`.
3. The server runs and exposes port `6474` (bound locally to `127.0.0.1:6474` by default).


