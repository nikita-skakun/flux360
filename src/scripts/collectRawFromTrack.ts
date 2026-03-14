import { readFile, writeFile } from "fs/promises";
import { TraccarAdminClient } from "@/server/traccarClient";
import path from "path";
import type { NormalizedPosition, TraccarDevice } from "@/types";

function usage(): string {
    return `Usage: bun src/scripts/collectRawFromTrack.ts --track <path> --device <id> [options]

Options:
  --track <path>       Path to a clean track file (GPX).
  --device <id>        Traccar device ID or group ID.
  --pad <seconds>      Time padding before/after track range (default 30).
  --out <path>         Output file path (default: stdout as JSON).
  --help               Show this help.
`;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a?.startsWith("--")) continue;
        const key = a.slice(2);
        if (key === "help") {
            out["help"] = "true";
            continue;
        }
        const next = args[i + 1];
        if (!next || next.startsWith("--")) {
            out[key] = "";
            continue;
        }
        out[key] = next;
        i++;
    }
    return out;
}

function findTimeRangeFromGpx(xml: string): { min: number; max: number } {
    const timeMatches = [...xml.matchAll(/<time>([^<]+)<\/time>/gi)];
    const times: number[] = [];
    for (const m of timeMatches) {
        const candidate = m[1];
        if (!candidate) continue;
        const ts = Date.parse(candidate);
        if (!Number.isNaN(ts)) times.push(ts);
    }
    if (times.length === 0) throw new Error("No <time> elements found in GPX file.");
    return { min: Math.min(...times), max: Math.max(...times) };
}

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
    const args = parseArgs();
    if (args["help"]) {
        console.log(usage());
        return;
    }

    const trackPath = args["track"];
    if (!trackPath) throw new Error("Missing --track <path>");

    const deviceId = args["device"] ? Number(args["device"]) : undefined;
    if (!deviceId) throw new Error("Missing --device <id>.");

    const padSeconds = args["pad"] ? Number(args["pad"]) : 30;
    const paddingMs = Math.max(0, padSeconds) * 1000;

    const sampleConfigPath = path.resolve("config.json");
    const rawCfg = await readFile(sampleConfigPath, "utf-8");
    const cfg = JSON.parse(rawCfg) as { traccarBaseUrl: string; traccarSecure: boolean; traccarApiToken: string };

    const baseUrl = cfg.traccarBaseUrl;
    const token = cfg.traccarApiToken;
    const secure = cfg.traccarSecure;

    if (!baseUrl || !token) {
        throw new Error("Missing traccarBaseUrl or traccarApiToken in config.json.");
    }

    const absoluteTrackPath = path.resolve(trackPath);
    const data = await readFile(absoluteTrackPath, "utf-8");

    if (!trackPath.toLowerCase().endsWith(".gpx")) {
        throw new Error("Only GPX tracks are supported; please provide a .gpx file.");
    }

    const range = findTimeRangeFromGpx(data);

    const from = range.min - paddingMs;
    const to = range.max + paddingMs;

    const client = new TraccarAdminClient(baseUrl, secure, token, {
        onPositionsReceived: () => undefined,
        onDevicesReceived: () => undefined,
    });

    const devices = await client.fetchDevices();
    const ids = (() => {
        const memberIds = groupMemberIds(devices, deviceId);
        return memberIds.length > 0 ? memberIds : [deviceId];
    })();

    const results: Record<number, NormalizedPosition[]> = {};
    for (const id of ids) {
        results[id] = await client.fetchHistory(id, from, to);
    }

    const outPath = args["out"];
    const output = JSON.stringify({ from, to, ids, data: results }, null, 2);

    if (outPath) {
        await writeFile(outPath, output, "utf-8");
        console.log(`Wrote ${Object.values(results).reduce((sum, arr) => sum + arr.length, 0)} points to ${outPath}`);
    } else {
        console.log(output);
    }
}

main().catch(err => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
