import type { Vec2 } from "@/types";

type PathPoint = {
    point: Vec2;
    accuracy: number;
    timestamp: number;
};

// Returns the closest point on segment AB to point P.
function closestPointOnSegment(a: Vec2, b: Vec2, p: Vec2): Vec2 {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return a;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    return [a[0] + t * dx, a[1] + t * dy];
}

export function smoothPath(points: PathPoint[], iterations = 3): Vec2[] {
    if (points.length <= 2) return points.map(p => p.point);

    const result: Vec2[] = points.map(p => [p.point[0], p.point[1]] as Vec2);
    const radii = points.map(p => p.accuracy);
    const centers = points.map(p => p.point);

    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 1; i < result.length - 1; i++) {
            const prev = result[i - 1]!;
            const center = centers[i]!;
            const next = result[i + 1]!;
            const r = radii[i]!;

            const dtPrev = points[i]!.timestamp - points[i - 1]!.timestamp;
            const dtTotal = points[i + 1]!.timestamp - points[i - 1]!.timestamp;

            let ideal: Vec2;
            if (dtTotal <= 0) {
                ideal = closestPointOnSegment(prev, next, center);
            } else {
                // Time-weighted expected position
                const ratio = Math.max(0, Math.min(1, dtPrev / dtTotal));
                ideal = [
                    prev[0] + (next[0] - prev[0]) * ratio,
                    prev[1] + (next[1] - prev[1]) * ratio
                ];
            }

            // Shrink allowed pull if the time gap is extremely large (> 60s)
            const straightLineConfidence = Math.max(0, Math.min(1, 60000 / Math.max(1, dtTotal)));
            const effectiveRadius = r * straightLineConfidence;

            // Amplify allowed pull if the point forms a massive geometric detour
            const dPrevCenter = Math.hypot(center[0] - prev[0], center[1] - prev[1]);
            const dCenterNext = Math.hypot(next[0] - center[0], next[1] - center[1]);
            const dPrevNext = Math.hypot(next[0] - prev[0], next[1] - prev[1]);

            const detourRatio = (dPrevCenter + dCenterNext) / Math.max(0.1, dPrevNext);
            const detourMultiplier = Math.pow(Math.max(1, detourRatio), 2);

            const allowedPull = effectiveRadius * detourMultiplier;

            // Pull point towards ideal
            const dx = ideal[0] - center[0];
            const dy = ideal[1] - center[1];
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= allowedPull) {
                result[i] = ideal;
            } else {
                result[i] = [
                    center[0] + (dx / dist) * allowedPull,
                    center[1] + (dy / dist) * allowedPull
                ];
            }
        }
    }

    return result;
}
