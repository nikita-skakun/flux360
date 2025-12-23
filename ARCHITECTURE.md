# ARCHITECTURE

This document describes the initial structure and tasks for a proof of concept that reads tracker data from a Traccar server and visualizes probability clouds in a React application. The repository starts as the default Bun + React template and can be reorganized freely.

## Goal

Build a minimal pipeline that:

1. Connects to a Traccar server.
2. Pulls a fixed time window of positions for one device.
3. Converts those positions into internal measurement objects.
4. Runs them through a small Gaussian mixture engine.
5. Renders the resulting probability clouds frame by frame inside a browser.

## Directory Layout

The repo can be reorganized into the following structure:

```
/
  src/
    api/
      traccarClient.ts
    engine/
      gaussian.ts
      mixture.ts
      timeline.ts
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

1. **Traccar Fetch**: A client module calls the Traccar positions API for a chosen device within a fixed timestamp range. The module normalizes the response into records with latitude, longitude, accuracy, timestamp and source.
2. **Measurement Conversion**: Each record is converted to a measurement with a mean and covariance. Accuracy becomes measurement noise. Device or source tags determine weight scaling.
3. **Mixture Engine**: A small engine step runs for each measurement:

   * Predict all live components.
   * Update components based on likelihood.
   * Adjust consistency and weight.
   * Spawn weak components when overlap allows it.
   * Prune components with low weight or large covariance.
   * Save the resulting component list into a timeline.
4. **Rendering**: A React canvas component draws ellipses for all components in the selected timeline slice. Ellipse alpha scales with component weight.
5. **Timeline Control**: A slider allows stepping through the stored slices.

## Engine Components

### gaussian.ts

Implements 2D Gaussian operations:

* Mean and covariance storage
* Mahalanobis distance
* Covariance prediction step
* Measurement update step

Cherry-pick relevant linear algebra utilities here so everything is contained and well-typed.

### mixture.ts

Manages a list of components:

* Predict step for all components
* Likelihood checks
* Consistency scoring
* Weight adjustment
* Spawning and pruning

Keep the mixture implementation small and unit-testable; we only need the basic gating and merging logic for the POC.

### timeline.ts

Stores snapshots:

* Append snapshot after each mixture update
* Keep a fixed number of recent steps
* Provide access by index

The timeline is your immutable history: each entry contains a timestamp + an array of mixture components (means, covariance, weight, metadata).

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
* Use Mahalanobis distances and likelihoods to map measurements to components; measurements inconsistent with a component should decrease its weight.
* Spawning new components is conservative: don't spawn unless the measurement is consistently not explained and the area isn't already covered.
* Prune a component when weight < threshold (e.g., 1e-6) or covariance uncertainties exceed a safe limit.

## Timeline / Runtime Behaviour

* The engine will run over a single, fixed dataset collected from Traccar in a known time window initially.
* Each measurement advances the engine by a step; the engine outputs a snapshot (array of components) at each step.
* The timeline will keep an indexable, fixed-length recent buffer for playback.

## UI / Visual Behaviour

* Each snapshot is rendered as a frame.
* A slider selects the timeline index; the canvas animates between frames if required.
* Ellipses are drawn with alpha proportional to weight and color-coded by their origin.

---

## Next Steps

1. Implement `src/api/traccarClient.ts` to fetch positions for a device and range and convert them to normalized records.
2. Implement `src/engine/gaussian.ts` and related math utilities.
3. Implement `src/engine/mixture.ts` with basic prediction, update, spawn and pruning logic.
4. Implement `src/engine/timeline.ts` to store snapshots and expose them to the UI.
5. Implement `src/ui/CanvasView.tsx`, `src/ui/TimelineSlider.tsx` and update `src/App.tsx` to wire everything up.

## After this MVP works

* Add tile-based mapping
* Expand mixture rules
* Add device selection
* Add live updates

---

## Development idioms and testing

* Keep the engine pure and free of DOM/React dependencies for easy testing.
* Add unit tests for `gaussian.ts` and `mixture.ts` to ensure correctness.
* Create a very small dataset for deterministic playback and debugging.


> Note: This document is a minimal scaffold for the POC. The code layout and implementation details are intentionally kept small and iterative so we can validate assumptions quickly and iterate on the engine and UI.
