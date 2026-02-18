# Retrospective Motion Analysis Plan

## Problem Statement

The real-time motion detection is reactive by design - it needs evidence before detecting motion. This creates lag in identifying when motion actually started and ended.

**Example:**
- Position A: Device at location X, stable anchor at X
- Position B: Device at location Y, anchor still showing X (but raw position already at Y)
- Position C: Anchor finally detects the change, starts moving toward Y
- Position D: Anchor settles at Y

**Real-time motion segment:** B → D (wrong - this is just the settling period after arrival)

**Desired (with hindsight):**
- Motion is the **transition** from X to Y
- Start: A (last stable point before the jump)
- End: B (first point at new location where anchor jumps)
- Duration: time between A and B

## Solution Overview

Run batch analysis over all positions to detect motion boundaries from anchor trajectory. This produces corrected anchors and motion segments that override the real-time engine's results when viewing history.

## Implementation Details

### 1. Retrospective Analyzer (`src/engine/retrospective.ts`)

```typescript
interface AnchorState {
  timestamp: number;
  position: [number, number]; // lat, lon
  variance: number;
  isStable: boolean;
  isMotionStart: boolean;
}

interface RetrospectiveResult {
  anchorTimeline: AnchorState[];
  motionSegments: RetrospectiveMotionSegment[];
}

// Core algorithm: O(n) single pass
function analyzeMotion(positions: NormalizedPosition[], refLat: number, refLon: number): RetrospectiveResult
```

#### Simplified Algorithm (Clean & Efficient):

The key insight: **motion = anchor transition**. We don't need complex outlier detection.

1. **Track anchor changes sequentially**
   - Maintain current anchor estimate (simplified Kalman)
   - On each position, compute distance from current anchor
   - If distance > threshold → anchor is transitioning → in motion

2. **Identify motion boundaries**
   - Motion starts when: position differs from stable anchor by > threshold
   - Motion ends when: anchor becomes stable at new location (low variance, positions cluster)
   - The motion segment is: last stable point → first point at new stable location

3. **Why this is efficient**
   - Single pass O(n)
   - No need for complex outlier scoring
   - Direct from anchor trajectory
   - Handles your example perfectly: A → B is the transition

#### Key Differences from Real-Time Engine:
- More aggressive: can detect motion from single outlier
- Retrospective: can look forward to confirm motion is sustained
- Settling-aware: trims end to exclude stable settling points

### 2. Data Structures

```typescript
interface RetrospectiveMotionSegment {
  startTime: number;
  endTime: number;
  startPosition: [number, number];
  endPosition: [number, number];
  path: [number, number][]; // all points in segment
  confidence: number; // based on outlier scores
}

interface RetrospectiveAnchor {
  timestamp: number;
  mean: [number, number];
  variance: number;
  type: 'stable' | 'moving' | 'settling';
}
```

### 3. Integration with Processing Pipeline (`src/store/processors.ts`)

#### On Initial Load (Eager):
```
1. All positions loaded
2. For each device:
   a. Run retrospective analysis on all positions
   b. Store result in: state.retrospectiveByDevice[deviceId]
3. Use retrospective data for timeline view
```

#### On New Positions (Incremental):
```
1. New positions arrive
2. Add to engine (real-time) for current state
3. After motion ends OR every N positions:
   a. Run quick retrospective on recent window (e.g., last 5 min)
   b. If boundaries changed, update state.retrospectiveByDevice[deviceId]
```

### 4. Timeline Integration

#### Current Timeline (`src/ui/TimelineSlider.tsx`):
- Uses `snapshots: DevicePoint[]` for positions
- Shows motion segments from engine

#### Updated Timeline:
- Accepts optional `retrospectiveAnchors` and `retrospectiveSegments`
- When available, use retrospective data for display
- Falls back to engine data for "now" / very recent

```typescript
interface TimelineProps {
  snapshots: DevicePoint[];
  retrospectiveAnchors?: RetrospectiveAnchor[];    // NEW
  retrospectiveSegments?: RetrospectiveMotionSegment[]; // NEW
  time: number;
  onChange: (time: number) => void;
}
```

### 5. Rendering Changes

#### Map View (`src/ui/MapView.tsx`):
- When showing historical time, use retrospective anchors
- Motion segments from retrospective when available

#### Motion Segment Display:
- Show "corrected" indicator when different from real-time
- Display original detection time vs retrospective

### 6. Storage Structure

```typescript
interface StoreState {
  // ... existing fields
  retrospective: {
    byDevice: Map<number, RetrospectiveResult>;
    lastUpdate: number; // timestamp of last analysis
    isAnalyzing: boolean;
  };
}
```

## Performance Considerations

### Initial Analysis
- **Time**: O(n) where n = total positions per device
- **Memory**: O(n) for anchor timeline + O(m) for segments
- **Estimation**: 100k positions ~ 100ms (single pass, simplified Kalman)

### Incremental Updates
- **Trigger**: After motion ends OR every 100 new positions
- **Window**: Last 5 minutes of positions
- **Time**: O(window_size) very fast
- **Merge**: Compare with existing, update only changed boundaries

### Caching Strategy
- Store full retrospective result after initial analysis
- Invalidate on large gaps (> 1 hour) - re-run analysis
- Keep incremental updates lightweight

## File Changes Summary

| File | Change |
|------|--------|
| `src/engine/retrospective.ts` | NEW - main analysis logic |
| `src/store/processors.ts` | Add retrospective analysis call |
| `src/store/types.ts` | Add retrospective state types |
| `src/store/index.ts` | Add retrospective actions |
| `src/types/index.ts` | Add RetrospectiveMotionSegment type |
| `src/ui/MapView.tsx` | Accept retrospective props |
| `src/ui/TimelineSlider.tsx` | Accept retrospective props |
| `src/util/appUtils.ts` | Build snapshots with retrospective data |

## Simplified Approach Summary

The algorithm is much simpler than initially conceived:

1. **Single pass** through all positions
2. **Track anchor** - maintain estimate, update with each position
3. **Detect motion** - when position differs from anchor by > threshold → in transition
4. **Mark boundaries** - last stable point before transition → first point at new stable location

This directly captures:
- Your example: A (last stable at X) → B (first at Y where anchor jumps) = motion
- No complex outlier detection needed
- O(n) time, O(1) extra space (besides output)

## Success Criteria

- [ ] Motion correctly identified as A → B (the transition/jump)
- [ ] Duration is time between A and B, not the settling period
- [ ] Initial analysis < 500ms for typical data
- [ ] Incremental updates < 50ms
- [ ] Timeline scrubbing shows corrected data
- [ ] Real-time (current) still uses engine state
