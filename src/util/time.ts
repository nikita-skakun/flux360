import { useState, useEffect, useMemo } from "react";

export function humanDurationSince(ts: number, end: number = Date.now()): string {
  const sec = Math.round((end - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function getUpdateInterval(ts: number): number {
  const sec = (Date.now() - ts) / 1000;
  if (sec < 60) return 1000;
  if (sec < 3600) return 60000;
  if (sec < 86400) return 3600000;
  return 86400000;
}

export function useTimeAgo(ts: number, addSuffix: boolean = true): string {
  const [, setTick] = useState(0);

  const interval = useMemo(() => getUpdateInterval(ts), [ts]);

  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1);
    }, interval);

    return () => clearInterval(id);
  }, [ts, interval]);

  return humanDurationSince(ts) + (addSuffix ? " ago" : "");
}
