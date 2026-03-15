import type { Vec2 } from "@/types";

export interface GpxPoint {
  timestamp: number;
  geo: Vec2;
}

export function parseGpx(xml: string): GpxPoint[] {
  const entries: GpxPoint[] = [];
  const trkptRegex = /<trkpt\s+[^>]*lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match: RegExpExecArray | null;

  while ((match = trkptRegex.exec(xml))) {
    const ts = Date.parse(/<time>([^<]+)<\/time>/i.exec(match[3] ?? "")?.[1] ?? "");
    if (Number.isNaN(ts)) continue;

    entries.push({ timestamp: ts, geo: [Number(match[2]), Number(match[1])] });
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}
