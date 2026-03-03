import React, { useMemo } from 'react';
import { MapPin, Activity } from 'lucide-react';
import type { Engine } from '@/engine/engine';
import type { MotionSegment } from '@/types';
import { formatDuration } from '@/util/appUtils';
import type { Anchor } from '@/engine/anchor';

export type TimelineEvent = {
    id: string;
    item: Anchor | MotionSegment;
};

type Props = {
    selectedDeviceId: number | null;
    enginesRef: Map<number, Engine>;
    engineSnapshot?: unknown; // Used as a trigger to re-evaluate when engines mutate
    onSelectEvent: (event: TimelineEvent) => void;
    selectedEventId: string | null;
};

const Sparkline = ({ segment }: { segment: MotionSegment }) => {
    if (segment.path.length < 2) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of segment.path) {
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

    const pointsStr = segment.path.map(p => `${p[0]},${p[1]}`).join(' ');

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
            <circle cx={segment.path[0]?.[0] ?? 0} cy={segment.path[0]?.[1] ?? 0} r={vbW * 0.08} fill="currentColor" opacity={0.6} />
            <circle cx={segment.path[segment.path.length - 1]?.[0] ?? 0} cy={segment.path[segment.path.length - 1]?.[1] ?? 0} r={vbW * 0.08} fill="currentColor" />
        </svg>
    );
};

export const TimelinePanel: React.FC<Props> = ({
    selectedDeviceId,
    enginesRef,
    engineSnapshot,
    onSelectEvent,
    selectedEventId,
}) => {
    const events = useMemo(() => {
        if (selectedDeviceId == null || !engineSnapshot) return [];

        let maxTimestamp = 0;
        const engine = enginesRef.get(selectedDeviceId);
        const anchors = engine ? engine.closedAnchors : [];
        const segments = engine ? engine.motionSegments : [];

        const updateMax = (ts: number) => {
            if (ts > maxTimestamp) maxTimestamp = ts;
        };

        for (const a of anchors) updateMax(a.endTimestamp ?? a.startTimestamp);
        for (const s of segments) updateMax(s.endTime ?? s.startTime);
        if (engine?.activeAnchor) updateMax(engine.activeAnchor.endTimestamp ?? engine.activeAnchor.startTimestamp);
        if (engine?.currentMotionSegment) updateMax(engine.currentMotionSegment.endTime ?? engine.currentMotionSegment.startTime);

        const now = maxTimestamp || Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000; // Sliding 24h window relative to latest data

        const items: TimelineEvent[] = [];

        // Add closed anchors
        for (const a of anchors) {
            if ((a.endTimestamp ?? now) < cutoff) continue;
            items.push({
                id: `anchor-${a.startTimestamp}`,
                item: a,
            });
        }

        // Add active anchor if it exists
        const a = engine?.activeAnchor;
        if (a && (a.endTimestamp ?? now) >= cutoff) {
            items.push({
                id: `anchor-${a.startTimestamp}`,
                item: a,
            });
        }

        // Add motion segments
        for (const s of segments) {
            if ((s.endTime ?? now) < cutoff) continue;
            items.push({
                id: `segment-${s.startTime}`,
                item: s,
            });
        }

        // If there is a current motion segment not yet closed
        const currentS = engine?.currentMotionSegment;
        if (currentS && (currentS.endTime ?? now) >= cutoff) {
            items.push({
                id: `segment-${currentS.startTime}`,
                item: currentS,
            });
        }

        // Sort newest first
        items.sort((aItem, bItem) => {
            const aStart = 'startTimestamp' in aItem.item ? aItem.item.startTimestamp : aItem.item.startTime;
            const bStart = 'startTimestamp' in bItem.item ? bItem.item.startTimestamp : bItem.item.startTime;
            return bStart - aStart;
        });

        return items;
    }, [selectedDeviceId, enginesRef, engineSnapshot]);

    if (selectedDeviceId == null || events.length === 0) return null;

    return (
        <div className="flex flex-col p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300 mt-2 max-h-[350px] overflow-hidden flex-shrink-0">
            <h3 className="text-sm font-medium mb-2 px-1">Past 24 Hours</h3>
            <div className="flex flex-col gap-2 overflow-y-auto pr-1 pb-1 scrollbar-thin">
                {events.map((ev) => {
                    const isSelected = selectedEventId === ev.id;
                    let type = '';
                    let startTime = 0;
                    let endTime = 0;
                    let duration = 0;
                    let distance: number | undefined = undefined;
                    let sparklineSegment: MotionSegment | null = null;
                    let isCurrent = false;

                    if ('startTimestamp' in ev.item) {
                        type = 'stationary';
                        startTime = ev.item.startTimestamp;
                        if (ev.item.endTimestamp == null) isCurrent = true;
                        endTime = ev.item.endTimestamp ?? Date.now();
                        duration = endTime - startTime;
                    } else {
                        type = 'moving';
                        startTime = ev.item.startTime;
                        if (ev.item.endTime == null) isCurrent = true;
                        endTime = ev.item.endTime ?? Date.now();
                        duration = endTime - startTime;
                        distance = ev.item.distance;
                        sparklineSegment = ev.item;
                    }

                    return (
                        <div
                            key={ev.id}
                            onClick={() => onSelectEvent(ev)}
                            className={`flex flex-col p-2 rounded-md border transition-all cursor-pointer ${isSelected
                                ? 'bg-primary/20 border-primary shadow-sm'
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
                                <div className="text-xs text-muted-foreground font-medium">
                                    {formatDuration(duration)}
                                </div>
                            </div>

                            <div className="text-xs text-muted-foreground flex justify-between items-center">
                                <span>{new Date(startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {isCurrent ? 'Present' : new Date(endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                {type === 'moving' && distance !== undefined && (
                                    <span className="font-medium text-foreground/80">{Math.round(distance)}m</span>
                                )}
                            </div>

                            {sparklineSegment && (
                                <Sparkline segment={sparklineSegment} />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
