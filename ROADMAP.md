# Motion Detection Roadmap

## Near-term: ECEF Conversion and Elevation Integration

- Switch all internal math to ECEF, meaning Vec3, Cov3, and the rest of the math
- Convert ECEF to lon/lat for Leaflet visualization
- Use elevation if available in ECEF, otherwise use topo provider for ground height (no API, easily pluggable)
- Update motion scoring to use 3D distances in ECEF
- Modify outlier buffer to store 3D points and directions
- Update anchor and candidate management for 3D coordinates
- Convert debug visualization to show both ECEF and geographic coordinates

## Mid-term: Motion History and Playback

- Persist motion segments (start/end, heading, confidence)
- Show motion history on timeline and map
- Allow scrub-through of motion segments with debug overlays

## Long-term: Route Inference and Prediction

- Integrate OSM routing to infer plausible paths between points
- Use road network constraints for direction and speed estimates
- Predict likely current location based on last segment

## Mapping + Visualization

- Evaluate 3D map options (Cesium, deck.gl) for motion playback
- Consider vector tiles for scalable historic playback
