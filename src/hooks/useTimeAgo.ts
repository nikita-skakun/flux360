import { useState, useEffect, useMemo } from "react";
import type { Timestamp } from "@/types";

function humanDurationSince(ts: Timestamp, now: Timestamp = Date.now() as Timestamp): string {
  const sec = Math.round((now - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function getUpdateInterval(ts: Timestamp): number {
  const sec = (Date.now() - ts) / 1000;
  if (sec < 60) return 1000;
  if (sec < 3600) return 60000;
  if (sec < 86400) return 3600000;
  return 86400000;
}

export function useTimeAgo(ts: Timestamp): string {
  const [, setTick] = useState(0);

  const interval = useMemo(() => getUpdateInterval(ts), [ts]);

  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1);
    }, interval);

    return () => clearInterval(id);
  }, [ts, interval]);

  return humanDurationSince(ts) + " ago";
}
