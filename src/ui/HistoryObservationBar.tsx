import React, { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, Clock, MapPin, Activity } from 'lucide-react';
import type { TimelineEvent } from './TimelinePanel';

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
        return () => window.removeEventListener('keydown', handleEsc);
    }, [onClose]);

    const item = event.item;
    const startTime = item.start;
    let detailsNode = null;

    if (item.type === 'stationary') {
        detailsNode = (
            <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                Stationary for {Math.round((item.end - item.start) / 60000)}m
            </span>
        );
    } else {
        detailsNode = (
            <span className="flex items-center gap-1.5">
                <Activity className="w-4 h-4" />
                Moved {Math.round(item.distance)}m
            </span>
        );
    }

    return (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-6 py-3 rounded-full bg-primary text-primary-foreground shadow-2xl backdrop-blur-md animate-in slide-in-from-top-4 font-medium pointer-events-auto">
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
                className="ml-2 hover:bg-primary-foreground/10 text-primary-foreground rounded-full h-8 w-8"
                onClick={onClose}
            >
                <X className="w-4 h-4" />
            </Button>
        </div>
    );
};
