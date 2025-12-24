import { test, expect } from "bun:test";
import { computeNextTimelineTime } from "../src/lib/timeline";

test("advances when at previous latest and new latest is newer", () => {
  const prevLatest = 1000;
  const newLatest = 2000;
  const cutoff = 0;
  const current = 1000;
  const out = computeNextTimelineTime(current, prevLatest, newLatest, cutoff);
  expect(out).toBe(2000);
});

test("does not advance when user is not at latest", () => {
  const prevLatest = 1000;
  const newLatest = 2000;
  const cutoff = 0;
  const current = 1500; // user moved slider back
  const out = computeNextTimelineTime(current, prevLatest, newLatest, cutoff);
  expect(out).toBe(1500);
});

test("advances when timeline is unset (null)", () => {
  const out = computeNextTimelineTime(null, null, 2000, 0);
  expect(out).toBe(2000);
});

test("advances when current is before cutoff (expired)", () => {
  const prevLatest = 2000;
  const newLatest = 3000;
  const cutoff = 2500;
  const current = 1000;
  const out = computeNextTimelineTime(current, prevLatest, newLatest, cutoff);
  expect(out).toBe(3000);
});

test("does nothing when there is no new latest", () => {
  const prevLatest = 1000;
  const newLatest = null;
  const cutoff = 0;
  const current = 1000;
  const out = computeNextTimelineTime(current, prevLatest, newLatest, cutoff);
  expect(out).toBe(1000);
});


