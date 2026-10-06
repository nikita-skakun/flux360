import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { LabelSchema } from "./types";
import type { Label } from "./types";

const SUFFIX = ".jsonl";

function labelDir(): string {
  return process.env["FLUX360_LABEL_DIR"] ?? "data/labels";
}

function filePath(deviceId: number): string {
  return `${labelDir()}/${deviceId}${SUFFIX}`;
}

/**
 * Labels are one JSONL file per entity under a gitignored directory. A file rather
 * than database rows because labels are hand-authored ground truth: they must survive
 * schema migrations and must never be rewritten by the engine.
 */
export function readLabels(deviceId: number): Label[] {
  const path = filePath(deviceId);
  if (!existsSync(path)) return [];

  const labels: Label[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = LabelSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) labels.push(parsed.data);
      else console.error(`[labels] discarding malformed label for entity ${deviceId}`, parsed.error);
    } catch {
      console.error(`[labels] discarding unparseable line for entity ${deviceId}`);
    }
  }
  return labels;
}

function writeLabels(deviceId: number, labels: Label[]) {
  mkdirSync(labelDir(), { recursive: true });
  const path = filePath(deviceId);
  const temporary = `${path}.tmp`;
  const body = labels.map(label => JSON.stringify(label)).join("\n");
  writeFileSync(temporary, labels.length > 0 ? `${body}\n` : "");
  renameSync(temporary, path);
}

export function addLabel(label: Label): Label {
  const labels = readLabels(label.deviceId);
  labels.push(label);
  writeLabels(label.deviceId, labels);
  return label;
}

export function upsertLabel(label: Label): void {
  const labels = readLabels(label.deviceId);
  const index = labels.findIndex(existing => existing.id === label.id);
  if (index === -1) labels.push(label);
  else labels[index] = label;
  writeLabels(label.deviceId, labels);
}

export function updateLabel(label: Label): boolean {
  const labels = readLabels(label.deviceId);
  const index = labels.findIndex(existing => existing.id === label.id);
  if (index === -1) return false;
  labels[index] = label;
  writeLabels(label.deviceId, labels);
  return true;
}

export function removeLabel(deviceId: number, id: string): boolean {
  const labels = readLabels(deviceId);
  const kept = labels.filter(label => label.id !== id);
  if (kept.length === labels.length) return false;
  writeLabels(deviceId, kept);
  return true;
}

export function listLabeledEntityIds(): number[] {
  const dir = labelDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(SUFFIX))
    .map(name => Number(name.slice(0, -SUFFIX.length)))
    .filter(id => Number.isFinite(id));
}

/** Total labelled span per entity, for coverage display so work is not repeated. */
export function labeledCoverageMs(deviceId: number): number {
  return readLabels(deviceId).reduce((total, label) => total + Math.max(0, label.end - label.start), 0);
}
