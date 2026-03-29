import { Button } from '@/components/ui/button';
import { humanDurationSince, useTimeAgo } from '@/util/time';
import { X, Clock, MapPin, Activity } from 'lucide-react';
import React, { useEffect, useMemo } from 'react';
import type { TimelineEvent } from './TimelinePanel';

const ICON_CLOCK = <Clock className="w-5 h-5 opacity-80" />;
const ICON_MAP_PIN = <MapPin className="w-4 h-4" />;
const ICON_ACTIVITY = <Activity className="w-4 h-4" />;
const ICON_CLOSE = <X className="w-4 h-4" />;

type Props = {
  event: TimelineEvent;
  onClose: () => void;
};

export const HistoryObservationBar: React.FC<Props> = ({ event, onClose }) => {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);

    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const item = event.item;
  const startTime = item.start;
  const startTimeStr = useMemo(() => new Date(startTime).toLocaleString(), [startTime]);

  const isDraft = event.id.startsWith('draft-');
  const draftDurationStr = useTimeAgo(startTime, false, isDraft);
  const nonDraftDurationStr = useMemo(() => humanDurationSince(startTime, item.end), [startTime, item.end]);
  const durationStr = isDraft ? draftDurationStr : nonDraftDurationStr;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-6 py-3 rounded-full bg-background/90 text-foreground shadow-2xl backdrop-blur-md border border-border animate-in slide-in-from-top-4 font-medium pointer-events-auto transition-colors duration-500">
      <div className="flex items-center gap-2">
        {ICON_CLOCK}
        <span>Observing History</span>
        <span className="opacity-70 px-2">•</span>
        <span>{startTimeStr}</span>
      </div>
      <div className="w-px h-6 bg-primary-foreground/20 mx-1" />
      <div className="flex flex-col gap-0.5 max-w-[200px] truncate text-sm">
        {item.type === 'stationary' ? (
          <span className="flex items-center gap-1.5">
            {ICON_MAP_PIN}
            Stationary for {durationStr}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {ICON_ACTIVITY}
            Moved {Math.round(item.distance)}m ({durationStr})
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="ml-2 hover:bg-accent hover:text-accent-foreground text-foreground/70 rounded-full h-8 w-8"
        onClick={onClose}
      >
        {ICON_CLOSE}
      </Button>
    </div>
  );
};
