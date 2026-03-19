import { humanDurationSince, useTimeAgo } from '@/util/time';
import { List, useDynamicRowHeight } from 'react-window';
import { MapPin, Activity, Check, Copy } from 'lucide-react';
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { EngineEvent, MotionEvent } from '@/types';
import type { RowComponentProps } from 'react-window';

const ICON_MAP_PIN = <MapPin className="w-4 h-4 text-blue-500" />;
const ICON_ACTIVITY = <Activity className="w-4 h-4 text-green-500" />;
const ICON_CHECK = <Check className="w-3 h-3 text-green-500" />;
const ICON_COPY = <Copy className="w-3 h-3" />;

export type TimelineEvent = {
  id: string;
  item: EngineEvent;
};

type TimelineRowEvent = TimelineEvent & {
  isNewDay: boolean;
  dayLabel: string;
};

type Props = {
  selectedDeviceId: number | null;
  selectedEventId: string | null;
  eventsByDevice: Record<number, EngineEvent[]>;
  onSelectEvent: (event: TimelineEvent) => void;
};

const TimelineEventRow = React.memo(
  ({
    ev,
    isSelected,
    durationStr,
    copiedId,
    onSelectEvent,
    onCopy,
  }: {
    ev: TimelineRowEvent;
    isSelected: boolean;
    durationStr: string;
    copiedId: string | null;
    onSelectEvent: (event: TimelineEvent) => void;
    onCopy: (e: React.MouseEvent, ev: TimelineEvent) => void;
  }) => {
    const { item, isNewDay, dayLabel, id } = ev;
    const isMotion = item.type === 'motion';
    const isDraft = id.startsWith('draft-');
    const startTime = new Date(item.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endTime = isDraft
      ? 'Present'
      : new Date(item.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const rowClass = `flex flex-col p-2 rounded-md border transition-all cursor-pointer ${isSelected
      ? 'bg-primary/2 border-primary shadow-sm'
      : 'bg-background/50 border-border/50 hover:bg-background/80 hover:border-border'
      }`;

    const handleSelect = useCallback(() => onSelectEvent({ id, item }), [id, item, onSelectEvent]);
    const handleCopyClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onCopy(e, { id, item });
      },
      [id, item, onCopy],
    );

    return (
      <>
        {isNewDay && (
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-3 mb-1 first:mt-0 flex items-center gap-2">
            {dayLabel}
            <div className="h-px bg-border/50 flex-1" />
          </div>
        )}
        <div
          onClick={handleSelect}
          className={rowClass}
        >
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 font-medium text-sm">
              {item.type === 'stationary' ? (
                <>{ICON_MAP_PIN} Stationary</>
              ) : (
                <>{ICON_ACTIVITY} Moving</>
              )}
            </div>
            <div className="text-xs text-muted-foreground font-medium flex items-center gap-2">
              {durationStr}
              <button
                onClick={handleCopyClick}
                className="p-1 hover:bg-primary/20 rounded-sm transition-colors"
                title="Copy event with internal state"
              >
                {copiedId === ev.id ? ICON_CHECK : ICON_COPY}
              </button>
            </div>
          </div>

          <div className="text-xs text-muted-foreground flex justify-between items-center">
            <span>{startTime} - {endTime}</span>
            {isMotion && (
              <span className="font-medium text-foreground/80">{Math.round(item.distance)}m</span>
            )}
          </div>

          {isMotion && (
            <Sparkline event={item} />
          )}
        </div>
      </>
    );
  },
  (prev, next) =>
    prev.ev === next.ev &&
    prev.isSelected === next.isSelected &&
    prev.durationStr === next.durationStr &&
    prev.copiedId === next.copiedId,
);

type TimelineRowProps = {
  events: TimelineRowEvent[];
  selectedEventId: string | null;
  copiedId: string | null;
  onSelectEvent: (event: TimelineEvent) => void;
  onCopy: (e: React.MouseEvent, ev: TimelineEvent) => void;
};

type RowProps = RowComponentProps<TimelineRowProps> & {
  dynamicRowHeight: ReturnType<typeof useDynamicRowHeight>;
};

const Row = ({ index, style, dynamicRowHeight, ...props }: RowProps): React.ReactElement | null => {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    dynamicRowHeight.observeRowElements([ref.current]);
  }, [dynamicRowHeight]);

  const ev = props.events[index];
  if (!ev) return null;

  const isSelected = props.selectedEventId === ev.id;
  const isCurrent = ev.id.startsWith('draft-');
  const draftDuration = useTimeAgo(ev.item.start, false, isCurrent);
  const durationStr = isCurrent ? draftDuration : humanDurationSince(ev.item.start, ev.item.end);

  return (
    <div ref={ref} style={style} className="px-1 py-1">
      <TimelineEventRow
        ev={ev}
        isSelected={isSelected}
        durationStr={durationStr}
        copiedId={props.copiedId}
        onSelectEvent={props.onSelectEvent}
        onCopy={props.onCopy}
      />
    </div>
  );
};

const Sparkline = React.memo(
  ({ event }: { event: MotionEvent }) => {
    if (event.path.length < 2) return null;

    const data = useMemo(() => {
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

      const raw = event.path.map(p => p.geo);
      const first = raw[0]!;
      const last = raw[raw.length - 1]!;

      const maxPoints = 30;
      const sampled = raw.length <= maxPoints ? raw : (() => {
        const out: Array<[number, number]> = [];
        const step = (raw.length - 1) / (maxPoints - 1);
        for (let i = 0; i < maxPoints; i++) {
          const idx = Math.min(raw.length - 1, Math.round(i * step));
          if (!raw[idx]) continue;
          out.push(raw[idx]);
        }
        return out;
      })();

      const pointsStr = sampled.map(p => `${p[0]},${flipY(p[1])}`).join(' ');

      return { vbMinX, vbMinY, vbW, vbH, pointsStr, first, last, flipY };
    }, [event]);

    const { vbMinX, vbMinY, vbW, vbH, pointsStr, first, last, flipY } = data;

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
        <circle cx={first[0]} cy={flipY(first[1])} r={vbW * 0.08} fill="currentColor" opacity={0.6} />
        <circle cx={last[0]} cy={flipY(last[1])} r={vbW * 0.08} fill="currentColor" />
      </svg>
    );
  },
  (prev, next) => prev.event === next.event,
);

export const TimelinePanel: React.FC<Props> = ({
  selectedDeviceId,
  eventsByDevice,
  onSelectEvent,
  selectedEventId,
}) => {
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [cutoff, setCutoff] = React.useState(() => Date.now() - 48 * 60 * 60 * 1000);
  const [dayBucket, setDayBucket] = React.useState(() => Math.floor(Date.now() / 86400000));

  const handleCopy = useCallback(
    (e: React.MouseEvent, ev: TimelineEvent) => {
      e.stopPropagation();
      if (selectedDeviceId == null) return;

      const round = (val: unknown): unknown => {
        if (typeof val === 'number') return Math.round(val * 100) / 100;
        if (Array.isArray(val)) return val.map(round);
        if (val && typeof val === 'object') {
          const out: Record<string, unknown> = {};
          const obj = val as Record<string, unknown>;
          for (const k in obj) {
            if (!Object.hasOwn(obj, k)) continue;
            out[k] = round(obj[k]);
          }
          return out;
        }
        return val;
      };
      const exportData = {
        id: selectedDeviceId,
        ev: round(ev.item),
        at: new Date().toISOString(),
      };

      if (navigator?.clipboard) {
        void navigator.clipboard.writeText(JSON.stringify(exportData, null, 2)).catch(() => { });
      }
      setCopiedId(ev.id);
      setTimeout(() => setCopiedId(null), 2000);
    },
    [selectedDeviceId],
  );

  const dynamicRowHeight = useDynamicRowHeight({ defaultRowHeight: 96, key: selectedDeviceId ?? 'none' });

  React.useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCutoff(now - 48 * 60 * 60 * 1000);
      setDayBucket(Math.floor(now / 86400000));
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const todayStr = useMemo(() => new Date(dayBucket * 86400000).toDateString(), [dayBucket]);
  const yesterdayStr = useMemo(() => new Date(dayBucket * 86400000 - 86400000).toDateString(), [dayBucket]);

  const events = useMemo(() => {
    if (selectedDeviceId == null) return [];

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
          dayLabel,
        };
      });
  }, [selectedDeviceId, eventsByDevice, cutoff, todayStr, yesterdayStr]);

  if (selectedDeviceId == null) return null;

  return (
    <div className="flex flex-col p-2 rounded-lg bg-muted/90 text-foreground backdrop-blur-sm border border-border transition-colors duration-300 max-h-[350px] overflow-hidden flex-shrink-0">
      <h3 className="text-sm font-medium mb-2 px-1">Past 48 Hours</h3>
      {events.length === 0 ? (
        <div className="text-xs text-muted-foreground p-4 text-center">
          No events found in the last 48 hours.
        </div>
      ) : (
        <List
          rowCount={events.length}
          rowHeight={dynamicRowHeight}
          rowComponent={Row}
          rowProps={{
            events,
            selectedEventId,
            copiedId,
            onSelectEvent,
            onCopy: handleCopy,
            dynamicRowHeight,
          }}
          overscanCount={0}
          className="scrollbar-thin"
        />
      )}
    </div>
  );
};
