import { formatDuration } from '@/util/appUtils';
import { fromWebMercator } from '@/util/webMercator';
import { haversineDistance, computeBearing } from '@/util/geo';
import { MapPin, Activity, Copy, Check } from 'lucide-react';
import React, { useMemo } from 'react';
import type { Engine } from '@/engine/engine';
import type { EngineEvent, StationaryEvent, MotionEvent } from '@/types';

export type TimelineEvent = {
    id: string;
    item: EngineEvent;
};

type Props = {
    selectedDeviceId: number | null;
    enginesRef: Map<number, Engine>;
    engineSnapshot?: unknown; // Used as a trigger to re-evaluate when engines mutate
    eventsByDevice: Record<number, EngineEvent[]>;
    onSelectEvent: (event: TimelineEvent) => void;
    selectedEventId: string | null;
};

const Sparkline = ({ event }: { event: MotionEvent }) => {
    if (event.path.length < 2) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of event.path) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const size = Math.max(dx, dy, 0.0001);

    // Add 10% padding
    const padding = size * 0.1;
    const vbMinX = minX - padding;
    const vbMinY = minY - padding;
    const vbW = size + padding * 2;
    const vbH = size + padding * 2;

    const flipY = (y: number) => minY + maxY - y;
    const pointsStr = event.path.map(p => `${p[0]},${flipY(p[1])}`).join(' ');

    return (
        <svg
            viewBox={`${vbMinX} ${vbMinY} ${vbW} ${vbH}`}
            className="w-full h-12 mt-2 opacity-60 rounded bg-background/30"
            preserveAspectRatio="xMidYMid meet"
        >
            <polyline
                points={pointsStr}
                fill="none"
                stroke="currentColor"
                strokeWidth={vbW * 0.05}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx={event.path[0]?.[0] ?? 0} cy={flipY(event.path[0]?.[1] ?? 0)} r={vbW * 0.08} fill="currentColor" opacity={0.6} />
            <circle cx={event.path[event.path.length - 1]?.[0] ?? 0} cy={flipY(event.path[event.path.length - 1]?.[1] ?? 0)} r={vbW * 0.08} fill="currentColor" />
        </svg>
    );
};

export const TimelinePanel: React.FC<Props> = ({
    selectedDeviceId,
    enginesRef,
    engineSnapshot,
    eventsByDevice,
    onSelectEvent,
    selectedEventId,
}) => {
    const [now, setNow] = React.useState(Date.now());
    const [copiedId, setCopiedId] = React.useState<string | null>(null);

    const handleCopy = (e: React.MouseEvent, ev: TimelineEvent) => {
        e.stopPropagation();
        if (selectedDeviceId == null) return;
        const engine = enginesRef.get(selectedDeviceId);
        if (!engine) return;

        const allFrames = engine.getDebugFrames();
        // Filter frames that occurred during this event's time range
        // We add a small buffer (5s) to capture context around the edges
        const buffer = 5000;
        const relevantFrames = allFrames.filter(f =>
            f.timestamp >= ev.item.start - buffer &&
            f.timestamp <= ev.item.end + buffer
        );

        // Smart sampling for large events (e.g. 24h stationary)
        let sampledFrames = relevantFrames;
        if (relevantFrames.length > 30) {
            const startFrames = relevantFrames.slice(0, 10);
            const endFrames = relevantFrames.slice(-10);
            const middleCount = 10;
            const middleSlice = relevantFrames.slice(10, -10);
            const step = Math.floor(middleSlice.length / middleCount);
            const middleFrames = [];
            for (let i = 0; i < middleCount; i++) {
                middleFrames.push(middleSlice[i * step]);
            }
            sampledFrames = [...startFrames, ...middleFrames, ...endFrames].filter(Boolean) as typeof relevantFrames;
        }

        const round = (val: unknown): unknown => {
            if (typeof val === 'number') return Math.round(val * 100) / 100;
            if (Array.isArray(val)) return val.map(round);
            if (val && typeof val === 'object') {
                const res: Record<string, unknown> = {};
                const obj = val as Record<string, unknown>;
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        const v = obj[key];
                        if (v != null) res[key] = round(v);
                    }
                }
                return res;
            }
            return val;
        };

        const compressedFrames = sampledFrames.map((f, i) => {
            const prev = i > 0 ? sampledFrames[i - 1] : null;
            let dist = 0;
            let bearing = 0;
            if (prev?.point && f.point) {
                const geoFrom = fromWebMercator(prev.point);
                const geoTo = fromWebMercator(f.point);
                dist = haversineDistance(geoFrom, geoTo);
                bearing = computeBearing(geoFrom, geoTo);
            }
            return round({
                t: f.timestamp - ev.item.start,
                d: f.decision,
                p: f.point,
                m: f.mean,
                v: f.variance,
                m2: f.mahalanobis2,
                n: f.pendingCount,
                dt: dist,
                az: bearing
            });
        });

        const exportData = round({
            id: selectedDeviceId,
            ev: ev.item,
            draft: ev.id.startsWith('draft-'),
            frames: compressedFrames,
            total: relevantFrames.length,
            sampled: relevantFrames.length > 30,
            prof: engine.motionProfile,
            at: new Date().toISOString()
        });

        if (navigator?.clipboard) {
            void navigator.clipboard.writeText(JSON.stringify(exportData, null, 2)).catch(() => { });
        }
        setCopiedId(ev.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    React.useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(interval);
    }, []);

    const events = useMemo(() => {
        if (selectedDeviceId == null || !engineSnapshot) return [];

        const engine = enginesRef.get(selectedDeviceId);
        if (!engine) return [];

        const closed = eventsByDevice[selectedDeviceId] ?? [];
        const draft = engine.draft;

        const cutoff = now - 48 * 60 * 60 * 1000; // Sliding 48h window

        const items: TimelineEvent[] = [];

        // Add closed events
        for (const ev of closed) {
            if (ev.end < cutoff) continue;
            items.push({
                id: `${ev.type}-${ev.start}`,
                item: ev,
            });
        }

        // Add current draft (always show, even if it started before the cutoff)
        if (draft) {
            // Convert draft to event for rendering
            if (draft.type === 'stationary') {
                const stats = engine.computeStats(draft.recent);
                items.push({
                    id: `draft-stationary-${draft.start}`,
                    item: {
                        type: 'stationary',
                        start: draft.start,
                        end: now,
                        mean: stats.mean,
                        variance: stats.variance
                    } as StationaryEvent
                });
            } else {
                // Motion Draft: Also include its predecessor (which is stationary but not yet closed)
                const predStats = engine.computeStats(draft.predecessor.recent);
                items.push({
                    id: `pred-stationary-${draft.predecessor.start}`,
                    item: {
                        type: 'stationary',
                        start: draft.predecessor.start,
                        end: draft.start,
                        mean: predStats.mean,
                        variance: predStats.variance
                    } as StationaryEvent
                });

                items.push({
                    id: `draft-motion-${draft.start}`,
                    item: {
                        type: 'motion',
                        start: draft.start,
                        end: now,
                        startAnchor: draft.startAnchor,
                        endAnchor: draft.path[draft.path.length - 1]!.mean,
                        path: draft.path.map(p => p.mean),
                        distance: engine.computePathLength(draft.path)
                    } as MotionEvent
                });
            }
        }

        // Sort newest first
        items.sort((a, b) => b.item.start - a.item.start);

        return items;
    }, [selectedDeviceId, enginesRef, engineSnapshot, eventsByDevice, now]);

    if (selectedDeviceId == null || events.length === 0) return null;

    return (
        <div className="flex flex-col p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300 max-h-[350px] overflow-hidden flex-shrink-0">
            <h3 className="text-sm font-medium mb-2 px-1">Past 48 Hours</h3>
            <div className="flex flex-col gap-2 overflow-y-auto pr-1 pb-1 scrollbar-thin">
                {events.map((ev, i) => {
                    const isSelected = selectedEventId === ev.id;
                    const item = ev.item;
                    const type = item.type;
                    const startTime = item.start;
                    const endTime = item.end;
                    const duration = endTime - startTime;
                    const isCurrent = ev.id.startsWith('draft-');

                    const currDate = new Date(startTime).toDateString();
                    const prevDate = i > 0 ? new Date(events[i - 1]!.item.start).toDateString() : null;
                    const isNewDay = currDate !== prevDate;

                    let dayLabel = currDate;
                    if (isNewDay) {
                        const nowObj = new Date(now);
                        const todayStr = nowObj.toDateString();
                        const yesterdayObj = new Date(now);
                        yesterdayObj.setDate(yesterdayObj.getDate() - 1);
                        const yesterdayStr = yesterdayObj.toDateString();

                        if (currDate === todayStr) {
                            dayLabel = 'Today';
                        } else if (currDate === yesterdayStr) {
                            dayLabel = 'Yesterday';
                        } else {
                            dayLabel = new Date(startTime).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
                        }
                    }

                    return (
                        <React.Fragment key={ev.id}>
                            {isNewDay && (
                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-3 mb-1 first:mt-0 flex items-center gap-2">
                                    {dayLabel}
                                    <div className="h-px bg-border/50 flex-1" />
                                </div>
                            )}
                            <div
                                onClick={() => onSelectEvent(ev)}
                                className={`flex flex-col p-2 rounded-md border transition-all cursor-pointer ${isSelected
                                    ? 'bg-primary/2 border-primary shadow-sm'
                                    : 'bg-background/50 border-border/50 hover:bg-background/80 hover:border-border'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-1.5 font-medium text-sm">
                                        {type === 'stationary' ? (
                                            <><MapPin className="w-4 h-4 text-blue-500" /> Stationary</>
                                        ) : (
                                            <><Activity className="w-4 h-4 text-green-500" /> Moving</>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground font-medium flex items-center gap-2">
                                        {formatDuration(duration)}
                                        <button
                                            onClick={(e) => handleCopy(e, ev)}
                                            className="p-1 hover:bg-primary/20 rounded-sm transition-colors"
                                            title="Copy event with internal state"
                                        >
                                            {copiedId === ev.id ? (
                                                <Check className="w-3 h-3 text-green-500" />
                                            ) : (
                                                <Copy className="w-3 h-3" />
                                            )}
                                        </button>
                                    </div>
                                </div>

                                <div className="text-xs text-muted-foreground flex justify-between items-center">
                                    <span>{new Date(startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {isCurrent ? 'Present' : new Date(endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                    {type === 'motion' && (
                                        <span className="font-medium text-foreground/80">{Math.round(item.distance)}m</span>
                                    )}
                                </div>

                                {type === 'motion' && (
                                    <Sparkline event={item} />
                                )}
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
};
