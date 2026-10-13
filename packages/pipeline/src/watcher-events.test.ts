/**
 * Tests for spec 0052 item A — the pure watcher-event vocabulary
 * (serialize/parse round-trip, tolerant parsing, one-line guarantee, path
 * helper).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WATCHER_EVENT_TYPES,
  parseWatcherEvents,
  serializeWatcherEvent,
  watcherEventsPath,
  type WatcherEvent,
  type WatcherGate,
} from "./watcher-events.js";

const GATES: WatcherGate[] = [1, 2, 3, "deploy"];

const SAMPLES: WatcherEvent[] = [
  { type: "start", ts: "2026-07-15T00:00:00.000Z", pid: 12345, flags: ["--no-start", "--events"] },
  ...GATES.map((gate): WatcherEvent => ({ type: "cue", ts: "2026-07-15T00:01:00.000Z", gate, msg: `gate ${gate} cue` })),
  { type: "review", ts: "2026-07-15T00:02:00.000Z", lines: ["mechanical review OK", "CI: green"] },
  { type: "exception", ts: "2026-07-15T00:03:00.000Z", code: 41, msg: "no spec file" },
  { type: "polish", ts: "2026-07-15T00:04:00.000Z", msg: "hands-on polish pass needed" },
  { type: "closeout", ts: "2026-07-15T00:05:00.000Z", msg: "Handoff commit + push + worker restart" },
  { type: "done", ts: "2026-07-15T00:06:00.000Z", benign: false, msg: "promoted + COMPLETED" },
  { type: "done", ts: "2026-07-15T00:07:00.000Z", benign: true, msg: "benign poll-cap gate-park exit" },
];

test("serializeWatcherEvent round-trips every WatcherEvent variant through parseWatcherEvents", () => {
  for (const event of SAMPLES) {
    const line = serializeWatcherEvent(event);
    const parsed = parseWatcherEvents(line);
    assert.deepEqual(parsed, [event], `round-trip failed for ${JSON.stringify(event)}`);
  }
});

test("parseWatcherEvents parses a full NDJSON file of every variant in order", () => {
  const text = SAMPLES.map(serializeWatcherEvent).join("\n");
  assert.deepEqual(parseWatcherEvents(text), SAMPLES);
});

test("serializeWatcherEvent emits exactly one line — no embedded or trailing newline", () => {
  for (const event of SAMPLES) {
    const line = serializeWatcherEvent(event);
    assert.equal(line.includes("\n"), false, `serialized line embeds a newline: ${line}`);
  }
});

const SAMPLE_START = SAMPLES[0]!;
const SAMPLE_CUE_1 = SAMPLES[1]!;
const SAMPLE_REVIEW = SAMPLES[5]!;

test("parseWatcherEvents tolerates blank lines", () => {
  const text = [
    serializeWatcherEvent(SAMPLE_START),
    "",
    "   ",
    serializeWatcherEvent(SAMPLE_CUE_1),
  ].join("\n");
  assert.deepEqual(parseWatcherEvents(text), [SAMPLE_START, SAMPLE_CUE_1]);
});

test("parseWatcherEvents tolerates non-JSON garbage lines", () => {
  const text = [
    serializeWatcherEvent(SAMPLE_START),
    "this is not json {{{",
    serializeWatcherEvent(SAMPLE_CUE_1),
  ].join("\n");
  assert.deepEqual(parseWatcherEvents(text), [SAMPLE_START, SAMPLE_CUE_1]);
});

test("parseWatcherEvents tolerates a truncated final line (mid-write tail)", () => {
  const full = serializeWatcherEvent(SAMPLE_REVIEW);
  const truncated = full.slice(0, Math.floor(full.length / 2));
  const text = [serializeWatcherEvent(SAMPLE_START), truncated].join("\n");
  assert.deepEqual(parseWatcherEvents(text), [SAMPLE_START]);
});

test("parseWatcherEvents tolerates unknown `type` values", () => {
  const unknown = JSON.stringify({ type: "mystery", ts: "2026-07-15T00:00:00.000Z", msg: "?" });
  const text = [serializeWatcherEvent(SAMPLE_START), unknown].join("\n");
  assert.deepEqual(parseWatcherEvents(text), [SAMPLE_START]);
});

test("parseWatcherEvents tolerates a record missing required fields for its type", () => {
  const malformed = JSON.stringify({ type: "cue", ts: "2026-07-15T00:00:00.000Z" }); // missing gate/msg
  const text = [serializeWatcherEvent(SAMPLE_START), malformed].join("\n");
  assert.deepEqual(parseWatcherEvents(text), [SAMPLE_START]);
});

test("parseWatcherEvents never throws on garbage input", () => {
  assert.doesNotThrow(() => parseWatcherEvents("not json at all\n{broken\n[]\nnull\n42"));
  assert.deepEqual(parseWatcherEvents("not json at all\n{broken\n[]\nnull\n42"), []);
});

test("watcherEventsPath builds <repo>/.preflight/supervise-<id>.events.ndjson", () => {
  assert.equal(
    watcherEventsPath("/repo/launchpad", "0052"),
    "/repo/launchpad/.preflight/supervise-0052.events.ndjson",
  );
});

test("WATCHER_EVENT_TYPES enumerates every discriminant", () => {
  assert.deepEqual(
    [...WATCHER_EVENT_TYPES].sort(),
    ["cue", "done", "exception", "polish", "review", "start", "closeout"].sort(),
  );
});
