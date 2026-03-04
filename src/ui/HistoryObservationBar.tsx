import { Button } from '@/components/ui/button';
import { formatDuration } from '@/util/appUtils';
import { X, Clock, MapPin, Activity } from 'lucide-react';
import React, { useEffect } from 'react';
import type { TimelineEvent } from './TimelinePanel';

type Props = {
    event: TimelineEvent;
    onClose: () => void;
};

export const HistoryObservationBar: React.FC<Props> = ({ event, onClose }) => {
    const [now, setNow] = React.useState(Date.now());

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleEsc);

        const interval = setInterval(() => setNow(Date.now()), 10000);

        return () => {
            window.removeEventListener('keydown', handleEsc);
            clearInterval(interval);
        };
    }, [onClose]);

    const item = event.item;
    const startTime = item.start;
    let detailsNode = null;

    const isDraft = event.id.startsWith('draft-');
    const endTime = isDraft ? now : item.end;

    if (item.type === 'stationary') {
        detailsNode = (
            <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                Stationary for {formatDuration(endTime - item.start)}
            </span>
        );
    } else {
        detailsNode = (
            <span className="flex items-center gap-1.5">
                <Activity className="w-4 h-4" />
                Moved {Math.round(item.distance)}m ({formatDuration(endTime - item.start)})
            </span>
        );
    }

    return (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-6 py-3 rounded-full bg-background/90 text-foreground shadow-2xl backdrop-blur-md border border-border animate-in slide-in-from-top-4 font-medium pointer-events-auto transition-colors duration-500">
            <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 opacity-80" />
                <span>Observing History</span>
                <span className="opacity-70 px-2">•</span>
                <span>{new Date(startTime).toLocaleString()}</span>
            </div>
            <div className="w-px h-6 bg-primary-foreground/20 mx-1" />
            <div className="flex flex-col gap-0.5 max-w-[200px] truncate text-sm">
                {detailsNode}
            </div>
            <Button
                variant="ghost"
                size="icon"
                className="ml-2 hover:bg-accent hover:text-accent-foreground text-foreground/70 rounded-full h-8 w-8"
                onClick={onClose}
            >
                <X className="w-4 h-4" />
            </Button>
        </div>
    );
};
