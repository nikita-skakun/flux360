import { humanDurationSince } from '@/util/time';
import { MapPin, Activity, Check, Copy } from 'lucide-react';
import React, { useMemo } from 'react';
import type { EngineEvent, MotionEvent } from '@/types';

export type TimelineEvent = {
    id: string;
    item: EngineEvent;
};

type Props = {
    selectedDeviceId: number | null;
    eventsByDevice: Record<number, EngineEvent[]>;
    onSelectEvent: (event: TimelineEvent) => void;
    selectedEventId: string | null;
};

const Sparkline = ({ event }: { event: MotionEvent }) => {
    if (event.path.length < 2) return null;

    const { bounds } = event;

    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const size = Math.max(dx, dy, 0.0001);

    // Add 10% padding
    const padding = size * 0.1;
    const vbMinX = bounds.minX - padding;
    const vbMinY = bounds.minY - padding;
    const vbW = size + padding * 2;
    const vbH = size + padding * 2;

    const flipY = (y: number) => bounds.minY + bounds.maxY - y;
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
    eventsByDevice,
    onSelectEvent,
    selectedEventId,
}) => {
    const [now, setNow] = React.useState(Date.now());
    const [copiedId, setCopiedId] = React.useState<string | null>(null);

    const handleCopy = (e: React.MouseEvent, ev: TimelineEvent) => {
        e.stopPropagation();
        if (selectedDeviceId == null) return;

        const round = (val: unknown): unknown => {
            if (typeof val === 'number') return Math.round(val * 100) / 100;
            if (Array.isArray(val)) return val.map(round);
            if (val && typeof val === 'object') {
                return Object.fromEntries(
                    Object.entries(val).map(([k, v]) => [k, round(v)])
                );
            }
            return val;
        };

        const exportData = round({
            id: selectedDeviceId,
            ev: ev.item,
            at: new Date().toISOString()
        });

        if (navigator?.clipboard) {
            void navigator.clipboard.writeText(JSON.stringify(exportData, null, 2)).catch(() => { });
        }
        setCopiedId(ev.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    React.useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, []);

    const events = useMemo(() => {
        if (selectedDeviceId == null) return [];

        const cutoff = now - 48 * 60 * 60 * 1000;
        const nowObj = new Date(now);
        const todayStr = nowObj.toDateString();
        const yesterdayObj = new Date(now);
        yesterdayObj.setDate(yesterdayObj.getDate() - 1);
        const yesterdayStr = yesterdayObj.toDateString();

        const rawEvents = eventsByDevice[selectedDeviceId] ?? [];

        return rawEvents
            .filter(ev => ev.isDraft || ev.end >= cutoff)
            .map((ev, i, arr) => {
                const startDate = new Date(ev.start);
                const currDateStr = startDate.toDateString();
                const prevDateStr = i > 0 ? new Date(arr[i - 1]!.start).toDateString() : null;
                const isNewDay = currDateStr !== prevDateStr;

                let dayLabel = currDateStr;
                if (isNewDay) {
                    if (currDateStr === todayStr) dayLabel = 'Today';
                    else if (currDateStr === yesterdayStr) dayLabel = 'Yesterday';
                    else dayLabel = startDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
                }

                return {
                    id: ev.isDraft ? `draft-${ev.type}-${ev.start}` : `${ev.type}-${ev.start}`,
                    item: ev,
                    isNewDay,
                    dayLabel
                };
            });
    }, [selectedDeviceId, eventsByDevice, now]);

    if (selectedDeviceId == null) return null;

    return (
        <div className="flex flex-col p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300 max-h-[350px] overflow-hidden flex-shrink-0">
            <h3 className="text-sm font-medium mb-2 px-1">Past 48 Hours</h3>
            <div className="flex flex-col gap-2 overflow-y-auto pr-1 pb-1 scrollbar-thin">
                {events.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-4 text-center">
                        No events found in the last 48 hours.
                    </div>
                ) : events.map((ev) => {
                    const isSelected = selectedEventId === ev.id;
                    const { item, isNewDay, dayLabel } = ev;
                    const isCurrent = ev.id.startsWith('draft-');
                    const durationStr = humanDurationSince(item.start, (isCurrent ? now : item.end) as import('@/types').Timestamp);

                    return (
                        <React.Fragment key={ev.id}>
                            {isNewDay && (
                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-3 mb-1 first:mt-0 flex items-center gap-2">
                                    {dayLabel}
                                    <div className="h-px bg-border/50 flex-1" />
                                </div>
                            )}
                            <div
                                onClick={() => onSelectEvent({ id: ev.id, item })}
                                className={`flex flex-col p-2 rounded-md border transition-all cursor-pointer ${isSelected
                                    ? 'bg-primary/2 border-primary shadow-sm'
                                    : 'bg-background/50 border-border/50 hover:bg-background/80 hover:border-border'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-1.5 font-medium text-sm">
                                        {item.type === 'stationary' ? (
                                            <><MapPin className="w-4 h-4 text-blue-500" /> Stationary</>
                                        ) : (
                                            <><Activity className="w-4 h-4 text-green-500" /> Moving</>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground font-medium flex items-center gap-2">
                                        {durationStr}
                                        <button
                                            onClick={(e) => handleCopy(e, { id: ev.id, item })}
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
                                    <span>{new Date(item.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {isCurrent ? 'Present' : new Date(item.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                    {item.type === 'motion' && (
                                        <span className="font-medium text-foreground/80">{Math.round(item.distance)}m</span>
                                    )}
                                </div>

                                {item.type === 'motion' && (
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
