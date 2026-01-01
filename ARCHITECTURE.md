# ARCHITECTURE

This document describes the initial structure and tasks for a proof of concept that reads tracker data from a Traccar server and visualizes probability clouds in a React application. The repository starts as the default Bun + React template and can be reorganized freely.

## Goal

Build a minimal pipeline that:

1. Connects to a Traccar server.
2. Pulls a fixed time window of positions for one device.
3. Converts those positions into internal measurement objects.
4. Runs them through a small Gaussian anchor engine.
5. Renders the resulting probability clouds frame by frame inside a browser.

## Directory Layout

The repo can be reorganized into the following structure:

```
/
  src/
    api/
      traccarClient.ts
    engine/
      cov_utils.ts
      anchor.ts
    ui/
      App.tsx
      CanvasView.tsx
      TimelineSlider.tsx
    util/
      geo.ts
  public/
  index.html
  bun.toml
```

This layout splits concerns into: data/api, model/engine, UI, and small utilities.

## Data Flow

1. **Traccar Fetch**: A client module calls the Traccar positions API for a chosen device within a fixed timestamp range. The module normalizes the response into records with latitude, longitude, accuracy and timestamp.
2. **Measurement Conversion**: Each record is converted to a measurement with a mean and covariance. Accuracy becomes measurement noise. Device tags determine weight scaling.
3. **Anchor Engine**: A small engine step runs for each measurement:

   * Update the active anchor with Kalman filter.
   * If measurement is far, close the current anchor and start a new one.
   * Keep closed anchors for history.
4. **Rendering**: A React canvas component draws ellipses for the active anchor and closed anchors. Ellipse alpha scales with recency.
5. **Timeline Control**: A slider allows stepping through the stored snapshots.

## Engine Components

### anchor.ts

Manages active and closed anchors:

* Kalman update for active anchor.
* Close and spawn new anchor when measurement is outlier.
* Keep history of closed anchors.

Keep the anchor implementation small and unit-testable; we only need the basic Kalman logic for the POC.

### cov_utils.ts

Math utilities for covariance matrices.

## UI Components

### CanvasView.tsx

* Converts lat/lon into canvas coordinates
* Draws each Gaussian as an ellipse
* Handles transparency blending

Canvas tips:

* Use the canvas 2D API to draw ellipses and set the globalAlpha based on component weight
* Provide panning/zoom hooks later if needed

### TimelineSlider.tsx

* Controls the current timeline index
* Triggers redraw

The slider should accept the timeline length and current index, and call a callback when changed.

### App.tsx

* On mount, fetches the data from Traccar
* Runs the mixture engine
* Renders the canvas and slider

Keep `App` lean: it wires the data source, runs the engine and holds the timeline and selected index state.

## Util

### geo.ts

* Convert WGS84 lat/lon to projected coordinates for canvas rendering (e.g. using Web Mercator or a simple equirectangular approximation for small area POC).
* Be explicit about lat/lon units (degrees) vs meters in the engine.

---

## Implementation Notes / Heavy Hints

* Keep the engine deterministic and unit-testable — we will iterate and expand rules later.
* The measurement model converts reported `accuracy` into a diagonal covariance (accuracy in meters along both axes, or a more careful transformation for lat/lon to meters).
* Prediction steps add process noise (a small isotropic covariance) to avoid singularities.
* Use Mahalanobis distance to decide if measurement fits the active anchor; if not, close it and start new.
* Kalman update for position and covariance.

## Timeline / Runtime Behaviour

* The engine will run over a single, fixed dataset collected from Traccar in a known time window initially.
* Each measurement advances the engine by a step; the engine outputs a snapshot (active anchor and closed anchors) at each step.
* The timeline will keep an indexable, fixed-length recent buffer for playback.

## UI / Visual Behaviour

* Each snapshot is rendered as a frame.
* A slider selects the timeline index; the canvas animates between frames if required.
* Ellipses are drawn with alpha proportional to weight and color-coded by their origin.

---

## Next Steps

1. Implement `src/api/traccarClient.ts` to fetch positions for a device and range and convert them to normalized records.
2. Implement `src/engine/gaussian.ts` and related math utilities.
3. Implement `src/engine/anchor.ts` with basic Kalman update and anchor management.
4. Implement `src/engine/cov_utils.ts` for math utilities.
5. Implement `src/ui/CanvasView.tsx`, `src/ui/TimelineSlider.tsx` and update `src/App.tsx` to wire everything up.

## After this MVP works

* Add tile-based mapping
* Expand mixture rules
* Add device selection
* Add live updates

---

## Development idioms and testing

* Keep the engine pure and free of DOM/React dependencies for easy testing.
* Add unit tests for `cov_utils.ts` and `anchor.ts` to ensure correctness.
* Create a very small dataset for deterministic playback and debugging.
