import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";
import { Component } from "./component";

export type ComponentSnapshot = {
  mean: Vec2;
  cov: Cov2;
  consistency: number;
  weight: number;
  action?: "moving" | "still";
  spawnedDuringMovement?: boolean;
  createdAt?: number;
};

export class Mixture {
  components: Component[] = [];

  // thresholds (mah dist squared)
  highThresh = 4; // within ~2-sigma
  medThresh = 9; // within ~3-sigma
  overlapThresh = 25; // within ~5-sigma

  // update amounts (tuned slightly for faster adaptation)
  highConsistencyInc = 0.14; // increased from 0.08
  medConsistencyInc = 0.04; // increased from 0.02
  decayFactor = 0.88; // quicker decay of non-matching components (was 0.92)

  spawnInitialConsistency = 0.22; // slightly higher spawn weight (was 0.16)
  spawnCovScale = 2.5; // spawn with somewhat inflated covariance

  // fast adapt tuning (when the device indicates motion or fast movement)
  // increased thresholds and consecutive checks to reduce false positives
  fastModeSpeedThreshold = 0.5; // m/s threshold to consider measurements 'moving' (was 0.3)
  fastSpawnInitialConsistency = 0.6; // strong spawn when moving
  fastDecayFactor = 0.65; // aggressively reduce old components when moving
  quickAdaptConsec = 2; // number of consecutive mismatches required to force a strong spawn

  // displacement / consecutive detection to avoid reacting to single noisy reports
  minDisplacementMeters = 4; // small absolute floor; dynamic threshold will usually dominate

  displacementConsecNeeded = 2; // require this many consecutive displaced reports
  consecDispCount = 0;

  // movement detection smoothing and confidence
  speedEma = 0; // exponential moving average for derived speeds
  speedEmaAlpha = 0.35; // smoothing factor (0..1)
  measurementConfidenceMultiplier = 3; // multiplier for single-point confidence (disp/uncertainty)
  movementConfidenceThreshold = 0.55; // threshold (0..1) to consider device likely moving

  // stationarity detection
  consecStationaryCount = 0;
  stationaryConsecNeeded = 2;
  stationarySpeedThreshold = 0.25; // m/s
  stationaryDispThreshold = 1; // meters

  // fading/pruning for movement spawn artifacts
  stableConsistencyThreshold = 0.8; // when a component reaches this it's considered stable
  movementSpawnFadeFactor = 0.25; // multiply spawned-during-move components by this when fading
  movementSpawnMaxAgeMs = 2 * 60 * 1000; // age after which movement-spawn comps can be aggressively faded

  // retirement of old stable positions once a new stable location is determined
  retireDistanceMeters = 50; // absolute distance threshold to consider an old component 'far away'
  oldPositionFadeFactor = 0.02; // strong fade factor applied to old distant components (smaller -> faster fade)
  // when a confident new location is observed, hard-retire old components beyond retireDistanceMeters
  stableRetentionThreshold = 0.90; // if dominant >= this, remove distant components immediately (was 0.95)

  // immediate movement adaptation tuning
  // make immediate spawns more decisive (higher initial confidence and stronger suppression)
  immediateSpawnInitialConsistency = 0.98; // spawn very confident candidate when movement is clear (raised)
  immediateDecayOtherFactor = 0.02; // aggressively suppress previous components when immediate spawn occurs (smaller -> stronger suppression)

  pruneBelow = 0.03; // remove components below this consistency

  // store last measurement for derived speed/displacement checks
  lastMeasurement?: DevicePoint;
  // last movement confidence at time of last update
  lastLikelyMoving = false;

  constructor(initial?: Component) {
    if (initial) this.components.push(initial.clone());
  }

  // helper to compute weights === consistency clamped to [0,1]
  normalizeWeights(): void {
    for (const c of this.components) {
      c.consistency = Math.max(0, Math.min(1, c.consistency));
    }
  }

  // Create a spawned candidate component (centralizes createdAt and flags)
  private createSpawnedComponent(m: DevicePoint, covMultiplier: number, initialConsistency: number, spawnedDuringMovement: boolean): Component {
    const spawnCov: Cov2 = [m.cov[0] * covMultiplier, m.cov[1], m.cov[2] * covMultiplier];
    const spawned = new Component([m.mean[0], m.mean[1]], spawnCov, initialConsistency);
    spawned.spawnedDuringMovement = spawnedDuringMovement;
    spawned.createdAt = m.timestamp ?? Date.now();
    return spawned;
  }

  // Add a spawned component and optionally suppress other components. If hardReplace is true,
  // replace the component set with only the spawned one.
  private addSpawned(spawned: Component, suppressFactor: number, hardReplace = false): void {
    if (hardReplace) {
      this.components = [spawned];
      return;
    }
    this.components.push(spawned);
    this.components.forEach((c) => {
      if (c !== spawned) c.consistency *= suppressFactor;
    });
  }

  // Convenience: decay other components by factor (optionally excluding an index)
  private decayOthers(factor: number, excludeIdx?: number): void {
    if (factor === 1 || this.components.length === 0) return;
    for (let i = 0; i < this.components.length; i++) {
      if (excludeIdx !== undefined && i === excludeIdx) continue;
      this.components[i]!.consistency *= factor;
    }
  }

  // Spawn helper to centralize creation, suppression and counter resets
  private spawnAndApply(
    m: DevicePoint,
    covScale: number,
    initialConsistency: number,
    suppressFactor: number,
    hardReplace = false,
    spawnedDuringMovement = true,
    resetCounters = true
  ): void {
    const spawned = this.createSpawnedComponent(m, covScale, initialConsistency, spawnedDuringMovement);
    this.addSpawned(spawned, suppressFactor, hardReplace);
    if (resetCounters) this.consecDispCount = 0;
  }

  // Compute jitter/dispersion related metrics for the incoming measurement
  private computeJitterMetrics(m: DevicePoint) {
    const prevM = this.lastMeasurement;

    // derived speed: compute over last measurement
    let derivedSpeed: number | undefined;
    if (prevM) {
      const dt = (m.timestamp - prevM.timestamp) / 1000;
      if (dt > 0) {
        const dx = m.mean[0] - prevM.mean[0];
        const dy = m.mean[1] - prevM.mean[1];
        derivedSpeed = Math.sqrt(dx * dx + dy * dy) / dt;
      }
    }

    // update smoothed speed (EMA) for robustness against noisy single-step estimates
    if (derivedSpeed !== undefined) {
      const alpha = Math.max(0.01, Math.min(1, this.speedEmaAlpha));
      this.speedEma = alpha * derivedSpeed + (1 - alpha) * (this.speedEma ?? 0);
    }

    const recentDisp = prevM ? Math.hypot(m.mean[0] - prevM.mean[0], m.mean[1] - prevM.mean[1]) : 0;

    // uncertainty via covariance diagonals (fallback to reported accuracy)
    let measurementUncertainty = 0;
    try {
      const diagMax = Math.max(m.cov[0], m.cov[2]);
      measurementUncertainty = Math.sqrt(Math.max(1e-6, diagMax));
    } catch (e) {
      measurementUncertainty = m.accuracy;
    }

    // scaled scores (0..1)
    const speedScore = Math.min(1, (this.speedEma || 0) / Math.max(1e-3, this.fastModeSpeedThreshold));
    const dispScore = Math.min(1, recentDisp / Math.max(1, measurementUncertainty) / Math.max(1, this.measurementConfidenceMultiplier));

    // moving confidence is the max of speed and displacement
    const movingConfidence = Math.max(speedScore, dispScore);

    // simplified booleans derived from smoothed metrics
    const displacementSignificant = recentDisp > Math.max(this.minDisplacementMeters, measurementUncertainty * 1.0);
    const isDerivedFast = (this.speedEma || 0) > this.fastModeSpeedThreshold;
    const singlePointConfident = dispScore >= 1;

    // detect a stationary candidate: low smoothed speed, small displacement, and no motion hint
    const stationaryCandidate = (this.speedEma || 0) < this.stationarySpeedThreshold && recentDisp < Math.max(this.stationaryDispThreshold, measurementUncertainty * 0.5);

    return {
      derivedSpeed,
      smoothedSpeed: this.speedEma,
      recentDisp,
      displacementSignificant,
      isDerivedFast,
      measurementUncertainty,
      singlePointConfident,
      movingConfidence,
      stationaryCandidate,
    };
  }

  // choose the current dominant component (by consistency)
  private getDominantComponent(): Component | null {
    let dominant: Component | null = null;
    for (const c of this.components) {
      if (!dominant || c.consistency > dominant.consistency) dominant = c;
    }
    return dominant;
  }

  snapshot(): ComponentSnapshot[] {
    // return deep copy for UI consumption, include recent movement confidence as action
    const action = this.lastLikelyMoving ? "moving" : "still";
    return this.components.map((c) => ({ mean: [c.mean[0], c.mean[1]], cov: [c.cov[0], c.cov[1], c.cov[2]], consistency: c.consistency, weight: c.consistency, action, spawnedDuringMovement: c.spawnedDuringMovement, createdAt: c.createdAt }));
  }

  update(m: DevicePoint): void {
    if (this.components.length === 0) {
      // initialize with a wide component to reflect initial uncertainty
      const init = new Component([m.mean[0], m.mean[1]], [m.cov[0] * 4, m.cov[1], m.cov[2] * 4], 1);
      init.spawnedDuringMovement = false;
      init.createdAt = m.timestamp ?? Date.now();
      this.components.push(init);
      return;
    }

    // find best matching component (by Mahalanobis squared distance)
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < this.components.length; i++) {
      const comp = this.components[i]!;
      const d2 = comp.mahalanobis2(m);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }

    // decide action
    if (bestIdx === -1) return;
    const best = this.components[bestIdx]!;

    // compute local metrics (speed, displacement, uncertainty)
    const jitter = this.computeJitterMetrics(m);

    // update consecutive displacement counter
    if (jitter.displacementSignificant) this.consecDispCount++;
    else this.consecDispCount = Math.max(0, this.consecDispCount - 1);

    // update consecutive stationary counter
    if (jitter.stationaryCandidate) this.consecStationaryCount++;
    else this.consecStationaryCount = Math.max(0, this.consecStationaryCount - 1);

    // if we observe consecutive stationary reports, consider movement ended and quickly decay smoothed speed
    let stationarityForced = false;
    if (this.consecStationaryCount >= this.stationaryConsecNeeded) {
      this.consecDispCount = 0;
      this.speedEma = 0; // aggressively reset
      stationarityForced = true;
      // fade any transient movement-spawned components so they don't linger
      for (const c of this.components) {
        if (c.spawnedDuringMovement) c.consistency *= this.movementSpawnFadeFactor;
      }
      // clear the counter so we don't repeatedly trigger
      this.consecStationaryCount = 0;
    }

    const isLikelyMoving = jitter.movingConfidence >= this.movementConfidenceThreshold || this.consecDispCount >= this.displacementConsecNeeded;

    // store last movement confidence for snapshots
    this.lastLikelyMoving = isLikelyMoving;

    // immediate spawn: require either a highly confident single-point, or derived speed, or
    // multiple consecutive displaced reports; avoid spawning on a single displacement driven
    // only by the movingConfidence score to reduce false positives.
    let shouldImmediateSpawn =
      jitter.singlePointConfident ||
      (jitter.isDerivedFast && this.consecDispCount >= 1) ||
      (this.consecDispCount >= this.displacementConsecNeeded && jitter.displacementSignificant);

    // suppress immediate spawn when we've just forced stationarity
    if (stationarityForced) shouldImmediateSpawn = false;



    if (bestD2 <= this.highThresh) {
      // high likelihood: normally we do a full Kalman update, but be conservative for
      // single, significant displaced reports (likely outliers) when we don't see
      // supporting movement evidence (no derived speed and insufficient consecutive displacement).
      if (jitter.displacementSignificant && !jitter.isDerivedFast && this.consecDispCount < this.displacementConsecNeeded) {
        // Treat as a suspected single outlier: apply a mild update and do NOT reset the displacement counter
        best.kalmanUpdate(m, 0.25);
        const inc = this.medConsistencyInc; // smaller increment than high-confidence updates
        best.consistency = Math.min(1, best.consistency + inc);
        this.decayOthers(this.decayFactor, bestIdx);
      } else {
        // full update when we have confidence or sustained displacement
        best.kalmanUpdate(m, 1.0);
        const inc = this.highConsistencyInc * (jitter.isDerivedFast ? 2.0 : 1.0);
        best.consistency = Math.min(1, best.consistency + inc);
        const otherDecay = jitter.isDerivedFast ? this.fastDecayFactor : this.decayFactor;
        this.decayOthers(otherDecay, bestIdx);
        this.consecDispCount = 0;
      }
    } else if (bestD2 <= this.medThresh) {
      // medium likelihood: if measurements suggest movement after consecutive reports, be aggressive; otherwise conservative
      if (isLikelyMoving) {
        // aggressive update toward the new measurement
        const gain = 0.85;
        best.kalmanUpdate(m, gain);
        const inc = this.medConsistencyInc * (jitter.isDerivedFast ? 2.5 : 1.5);
        best.consistency = Math.min(1, best.consistency + inc);
        this.decayOthers(this.fastDecayFactor, bestIdx);
        if (shouldImmediateSpawn) {
          const hardReplace = jitter.isDerivedFast && jitter.recentDisp > this.retireDistanceMeters * 0.5;
          this.spawnAndApply(m, 0.3, this.immediateSpawnInitialConsistency, this.immediateDecayOtherFactor, hardReplace, true, true);
        } else if (jitter.isDerivedFast || this.consecDispCount >= this.displacementConsecNeeded) {
          this.spawnAndApply(m, 0.4, Math.max(this.fastSpawnInitialConsistency, 0.8), this.fastDecayFactor, false, true, true);
        } else {
          this.consecDispCount++;
        }
      } else {
        // not moving: mild update
        best.kalmanUpdate(m, 0.35);
        const inc = this.medConsistencyInc;
        best.consistency = Math.min(1, best.consistency + inc);
        this.decayOthers(this.decayFactor, bestIdx);
        // reduce displacement counter slowly
        this.consecDispCount = Math.max(0, this.consecDispCount - 1);
      }
    } else if (bestD2 <= this.overlapThresh) {
      // low but overlapping: spawn a component representing the measurement
      if (shouldImmediateSpawn) {
        this.spawnAndApply(m, this.spawnCovScale * 0.3, this.immediateSpawnInitialConsistency, this.immediateDecayOtherFactor, false, true, true);
      } else if (isLikelyMoving) {
        this.spawnAndApply(m, this.spawnCovScale * 0.4, Math.max(this.fastSpawnInitialConsistency, 0.8), this.fastDecayFactor, false, true, true);
      } else {
        this.spawnAndApply(m, this.spawnCovScale, this.spawnInitialConsistency, this.decayFactor, false, false, false);
        this.consecDispCount = Math.max(0, this.consecDispCount - 1);
      }
      // if we see repeated displaced reports and moving, we'll spawn decisively in other branches
    } else {
      // very unlikely: measurement is far from any component
      if (isLikelyMoving) {
        if (shouldImmediateSpawn) {
          this.spawnAndApply(m, this.spawnCovScale * 1.2, this.immediateSpawnInitialConsistency, this.immediateDecayOtherFactor, false, true, true);
        } else {
          this.consecDispCount++;
          if (this.consecDispCount >= this.quickAdaptConsec) {
            this.spawnAndApply(m, this.spawnCovScale * 1.5, this.fastSpawnInitialConsistency, this.fastDecayFactor, false, true, true);
            this.consecDispCount = 0;
          } else {
            this.decayOthers(this.fastDecayFactor);
          }
        }
      } else {
        this.decayOthers(this.decayFactor);
        // reduce displacement counter slowly when seeing non-moving outliers
        this.consecDispCount = Math.max(0, this.consecDispCount - 1);
      }
    }

    // store last measurement for next update
    this.lastMeasurement = m;

    // If a stable dominant estimate exists, aggressively fade movement-spawned components so they don't linger
    try {
      const dominant = this.getDominantComponent();
      const nowTs = m.timestamp ?? Date.now();
      if (dominant && dominant.consistency >= this.stableConsistencyThreshold) {
        // Treat the dominant component as established (it may have been spawned during movement)
        dominant.consistency = Math.max(dominant.consistency, 0.9);
        dominant.spawnedDuringMovement = false;

        // Fade transient components
        for (const c of this.components) {
          if (c !== dominant && c.spawnedDuringMovement) c.consistency *= this.movementSpawnFadeFactor;
        }

        // Retire old distant components relative to the dominant
        try {
          const diagMax = Math.max((dominant.cov?.[0] ?? 0), (dominant.cov?.[2] ?? 0));
          const dominantRadius = Math.sqrt(Math.max(1e-6, diagMax));
          const retireDistance = Math.max(this.retireDistanceMeters, dominantRadius * 4);

          for (const c of this.components) {
            if (c === dominant) continue;
            const dx = c.mean[0] - dominant.mean[0];
            const dy = c.mean[1] - dominant.mean[1];
            const d = Math.hypot(dx, dy);
            if (d > retireDistance) {
              if (dominant.consistency >= this.stableRetentionThreshold || (!this.lastLikelyMoving && dominant.consistency >= this.stableConsistencyThreshold)) {
                c.consistency = 0;
              } else {
                c.consistency *= this.oldPositionFadeFactor;
              }
              c.spawnedDuringMovement = true;
            }
          }
        } catch (e) {
          // ignore decomposition errors and continue
        }
      }

      // Also expire very old movement-spawned components if movement has settled
      if (!this.lastLikelyMoving) {
        for (const c of this.components) {
          if (c.spawnedDuringMovement && c.createdAt && nowTs - c.createdAt > this.movementSpawnMaxAgeMs) c.consistency *= this.movementSpawnFadeFactor;
        }
      }
    } catch (e) {
      // guard against any unexpected errors in cleanup logic
    }

    // prune very small components
    this.components = this.components.filter((c) => c.consistency > this.pruneBelow);

    // enforce normalized or clamped consistencies
    this.normalizeWeights();
  }
}
