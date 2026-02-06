# Motion Detection Roadmap

## Near-term: Basic Motion Detection
- Add motion profiles: person (default), car
- Store profile in Traccar device attributes (e.g., attributes.motionProfile)
- Use per-profile score thresholds to determine when to create/promote candidates
- Maintain an outlier buffer of non-anchor points since last anchor-confirming report
- Clear outlier buffer on anchor-confirming report (Mahalanobis^2 within threshold)
- Score outliers by distance, accuracy, and time since last anchor-confirming report
- Promote motion when summed score crosses profile threshold, with coherence bonus
- Prevent anchor switching unless motion state is entered and later ended
- End motion when points settle into a consistent proximity cluster and outliers diminish
- Track motion start time by backtracking to earliest coherent outlier
- Expose debug decisions: noise-weak-update, coherent-motion, candidate-created/updated, motion-start, motion-end

### Concrete Plan (Implementation Details)
1) Data and profile storage
   - Add profile values: person, car
   - Read profile from Traccar device attributes (attributes.motionProfile)
   - Default to person when missing

2) Motion scoring inputs
   - Compute distance from active anchor
   - Use reported accuracy as noise estimate
   - Use dt since last anchor-confirming report
   - Score formula:
      score = (distance / (accuracy + k)) * log1p(dtMinutes)
   - Add coherence bonus when outliers align in direction from anchor
   - Car profile uses higher single-point threshold to avoid single-report motion

3) Outlier buffer (time-ordered)
   - Store non-anchor points since last anchor confirmation
   - Insert by timestamp to handle late reports
   - Recompute buffer scores and coherence on insert

4) Motion promotion
   - Allow single point to trigger motion if score >= profile threshold
   - Otherwise trigger when summed buffer score crosses profile threshold
   - Do not switch anchors unless motion is active

5) Motion end
   - Detect a settling cluster near a stable location
   - End motion when cluster persists and outliers diminish
   - Snap anchor to cluster and clear outlier buffer

6) Debug visibility
   - Emit debug frame decisions for noise, coherence, motion start/end
   - Display current profile and motion state in debug panel

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
