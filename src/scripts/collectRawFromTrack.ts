import { parseArgs } from "util";
import { parseGpx } from "@/util/gpx";
import { readFile, writeFile } from "fs/promises";
import { loadConfig } from "@/util/config";
import { TraccarAdminClient } from "@/server/traccarClient";
import path from "path";
import type { NormalizedPosition, TraccarDevice } from "@/types";

function groupMemberIds(devices: TraccarDevice[], groupId: number): number[] {
    const device = devices.find(d => d.id === groupId);
    if (!device) throw new Error(`Device ID ${groupId} not found`);

    const raw = device.attributes?.["memberDeviceIds"];
    if (typeof raw !== "string") return [];

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.map(v => Number(v)).filter(v => Number.isFinite(v));
    } catch {
        return [];
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            track: { type: "string" },
            device: { type: "string" },
            pad: { type: "string", default: "30" },
            out: { type: "string" },
        }
    });

    if (!values.track) throw new Error("Missing --track <path>");
    if (!values.device) throw new Error("Missing --device <id>");
    if (!values.track.toLowerCase().endsWith(".gpx")) {
        throw new Error("Only GPX tracks are supported; please provide a .gpx file.");
    }

    const data = await readFile(path.resolve(values.track), "utf-8");
    const gpxPoints = parseGpx(data);
    if (gpxPoints.length === 0) throw new Error("No points found in GPX file.");

    const firstPoint = gpxPoints[0];
    const lastPoint = gpxPoints[gpxPoints.length - 1];
    if (!firstPoint || !lastPoint) throw new Error("No points found in GPX file.");

    const paddingMs = Math.max(0, Number(values.pad)) * 1000;
    const from = firstPoint.timestamp - paddingMs;
    const to = lastPoint.timestamp + paddingMs;

    const cfg = await loadConfig();
    const client = new TraccarAdminClient(cfg.traccarBaseUrl, cfg.traccarSecure, cfg.traccarApiToken, {
        onPositionsReceived: () => undefined,
        onDevicesReceived: () => undefined,
    });

    const devices = await client.fetchDevices();
    const ids = (() => {
        const memberIds = groupMemberIds(devices, Number(values.device));
        return memberIds.length > 0 ? memberIds : [Number(values.device)];
    })();

    const results: Record<number, NormalizedPosition[]> = {};
    for (const id of ids) {
        results[id] = await client.fetchHistory(id, from, to);
    }

    const output = JSON.stringify({ from, to, ids, data: results }, null, 2);

    if (values.out) {
        await writeFile(values.out, output, "utf-8");
        console.log(`Wrote ${Object.values(results).reduce((sum, arr) => sum + arr.length, 0)} points to ${values.out}`);
    } else {
        console.log(output);
    }
}

main().catch(err => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
