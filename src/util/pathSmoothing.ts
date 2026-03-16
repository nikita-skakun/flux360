import { pointLineDistance } from "@/util/geo";
import type { NormalizedPosition, Vec2 } from "@/types";

export function smoothPath(points: NormalizedPosition[], iterations = 3): Vec2[] {
    if (points.length <= 2) return points.map(p => p.geo);

    let result: Vec2[] = points.map(p => [...p.geo] as Vec2);
    const radii = points.map(p => p.accuracy);
    const centers = points.map(p => p.geo);

    for (let iter = 0; iter < iterations; iter++) {
        result = result.map((curr, i, arr) => {
            if (i === 0 || i === arr.length - 1) return curr;

            const prev = arr[i - 1];
            const next = arr[i + 1];
            const center = centers[i];
            const r = radii[i];
            const pt = points[i];
            const prevPt = points[i - 1];
            const nextPt = points[i + 1];

            if (!prev || !next || !center || r === undefined || !pt || !prevPt || !nextPt) return curr;

            const dtPrev = pt.timestamp - prevPt.timestamp;
            const dtTotal = nextPt.timestamp - prevPt.timestamp;

            const ratio = dtTotal <= 0 ? 0.5 : Math.max(0, Math.min(1, dtPrev / dtTotal));
            const ideal: Vec2 = [
                prev[0] + (next[0] - prev[0]) * ratio,
                prev[1] + (next[1] - prev[1]) * ratio
            ];

            const straightLineConfidence = Math.max(0, Math.min(1, 60000 / Math.max(1, dtTotal)));
            const effectiveRadius = r * straightLineConfidence;

            const dPrevCenter = Math.hypot(center[0] - prev[0], center[1] - prev[1]);
            const dCenterNext = Math.hypot(next[0] - center[0], next[1] - center[1]);
            const dPrevNext = Math.hypot(next[0] - prev[0], next[1] - prev[1]);

            const detourRatio = (dPrevCenter + dCenterNext) / Math.max(0.1, dPrevNext);
            const detourMultiplier = Math.pow(Math.max(1, detourRatio), 2);
            const allowedPull = effectiveRadius * detourMultiplier;

            const dx = ideal[0] - center[0];
            const dy = ideal[1] - center[1];
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= allowedPull) return ideal;
            return [
                center[0] + (dx / dist) * allowedPull,
                center[1] + (dy / dist) * allowedPull
            ] as Vec2;
        });
    }

    return result;
}

export function simplifyPath(points: Vec2[], epsilon: number): Vec2[] {
    if (points.length < 3) return points;

    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;

    function simplifySegment(start: number, end: number): void {
        let maxDist = 0;
        let index = -1;
        const startPt = points[start];
        const endPt = points[end];
        if (!startPt || !endPt) return;

        for (let i = start + 1; i < end; i++) {
            const pt = points[i];
            if (!pt) continue;
            const d = pointLineDistance(pt, startPt, endPt);
            if (d > maxDist) {
                maxDist = d;
                index = i;
            }
        }

        if (maxDist > epsilon && index !== -1) {
            keep[index] = true;
            simplifySegment(start, index);
            simplifySegment(index, end);
        }
    }

    simplifySegment(0, points.length - 1);
    return points.filter((_, idx) => keep[idx]);
}
