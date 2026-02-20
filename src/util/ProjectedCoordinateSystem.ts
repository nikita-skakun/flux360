import type { Vec2 } from "@/types";

/**
 * Manages coordinate transformations between geographic (lat/lon) and projected (x/y) space.
 * Uses a local meter-based coordinate system centered at a reference point.
 */
export class ProjectedCoordinateSystem {
  private refLat: number;
  private refLon: number;
  private R: number;

  constructor(refLat: number, refLon: number, earthRadius: number = 6371000) {
    this.refLat = refLat;
    this.refLon = refLon;
    this.R = earthRadius;
  }

  /**
   * Update the reference point for the coordinate system
   */
  setReference(refLat: number, refLon: number): void {
    this.refLat = refLat;
    this.refLon = refLon;
  }

  /**
   * Convert lat/lon to local meter coordinates (x, y) relative to reference point
   */
  project(lat: number, lon: number): Vec2 {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [0, 0];

    const dLat = (lat - this.refLat) * (Math.PI / 180);
    const dLon = (lon - this.refLon) * (Math.PI / 180);
    const meanLat = ((lat + this.refLat) / 2) * (Math.PI / 180);
    const x = dLon * this.R * Math.cos(meanLat);
    const y = dLat * this.R;
    return [x, y];
  }

  /**
   * Convert local meter coordinates to lat/lon
   */
  unproject(x: number, y: number): { lat: number; lon: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { lat: this.refLat, lon: this.refLon };
    }

    const dLat = y / this.R;
    const meanLat = this.refLat * (Math.PI / 180);
    const dLon = x / (this.R * Math.cos(meanLat));
    const lat = this.refLat + (dLat * 180) / Math.PI;
    const lon = this.refLon + (dLon * 180) / Math.PI;

    return {
      lat: Number.isFinite(lat) ? lat : this.refLat,
      lon: Number.isFinite(lon) ? lon : this.refLon
    };
  }

  /**
   * Calculate Euclidean distance in meters between two projected points
   */
  distance(a: Vec2, b: Vec2): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.hypot(dx, dy);
  }

  /**
   * Calculate unit vector direction from one projected point to another
   */
  direction(from: Vec2, to: Vec2): Vec2 {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const mag = Math.hypot(dx, dy);
    if (mag === 0) return [0, 0];
    return [dx / mag, dy / mag];
  }

  /**
   * Compute centroid of multiple projected points
   */
  centroid(points: Vec2[]): Vec2 {
    if (points.length === 0) return [0, 0];
    let sumX = 0, sumY = 0;
    for (const p of points) {
      sumX += p[0];
      sumY += p[1];
    }
    return [sumX / points.length, sumY / points.length];
  }

  /**
   * Get current reference coordinates
   */
  getReference(): { lat: number; lon: number } {
    return { lat: this.refLat, lon: this.refLon };
  }

  /**
   * Check if the coordinate system is properly initialized with valid reference
   */
  isValid(): boolean {
    return Number.isFinite(this.refLat) && Number.isFinite(this.refLon);
  }
}
