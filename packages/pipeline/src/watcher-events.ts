/**
 * watcher-events.ts — pure watcher-event vocabulary for supervisor-in-UI
 * phase 3 (spec 0052 / ADR-022 §6, item A). The additive `--events` flag on
 * `scripts/supervise.mjs` appends NDJSON records to
 * `.preflight/supervise-<specId>.events.ndjson` (gitignored, sibling of the
 * existing `.out`/`.flag`/`.review` files); apps/web's run-follow route reads
 * and parses that file to render the watcher's judgment moments (gate cues,
 * mechanical-review verdict, exceptions, polish-pause, close-out, done).
 *
 * PURE, no I/O — the same pure-core / thin-IO split as `recover.ts`:
 *  - `serializeWatcherEvent` / `parseWatcherEvents` / `watcherEventsPath` live
 *    here and are unit-tested here (`watcher-events.test.ts`);
 *  - `supervise.mjs` requires the BUILT `dist/watcher-events.js` and does the
 *    actual file append (the same createRequire / dist-import pattern it uses
 *    for `task-queue.js` and `recover.js`);
 *  - apps/web imports `parseWatcherEvents` from `@launchpad/pipeline`.
 *
 * The parser is TOLERANT by contract: the file is append-only and may be read
 * mid-write, so a malformed / truncated / unknown-`type` line is SKIPPED, never
 * thrown on. `serializeWatcherEvent` emits exactly one NDJSON line (no trailing
 * newline — the caller joins with `\n`).
 */

/** The gate a `cue`/`done` refers to: the three human gates (1 spec / 2 PR /
 * 3 promote) plus the tenant-deploy single gate. */
export type WatcherGate = 1 | 2 | 3 | "deploy";

/** Fields carried by every {@link WatcherEvent}. `ts` is an ISO-8601 timestamp
 * stamped by the emitter (the script), never derived in this pure module. */
export interface WatcherEventBase {
  /** ISO-8601 emission timestamp (stamped by `supervise.mjs`). */
  ts: string;
}

/**
 * The watcher's judgment-moment vocabulary — a discriminated union on `type`.
 * Each variant maps to one emission point in `supervise.mjs` (item B):
 *  - `start`     — watcher startup (its pid + the flags it was spawned with);
 *  - `cue`       — a gate cue (gates 1/2/3 and the tenant deploy cue);
 *  - `review`    — the gate-2 mechanical-review summary lines;
 *  - `exception` — `fail(code, msg)` (an exit that needs the agent);
 *  - `polish`    — `polishPause(msg)` (the apps/web hands-on polish pause);
 *  - `closeout`  — `closeOut(msg)` (Handoff commit + push + worker restart);
 *  - `done`      — normal completion (`benign:false`) OR the benign poll-cap
 *                  gate-park exit (`benign:true`).
 */
export type WatcherEvent =
  | (WatcherEventBase & { type: "start"; pid: number; flags: string[] })
  | (WatcherEventBase & { type: "cue"; gate: WatcherGate; msg: string })
  | (WatcherEventBase & { type: "review"; lines: string[] })
  | (WatcherEventBase & { type: "exception"; code: number; msg: string })
  | (WatcherEventBase & { type: "polish"; msg: string })
  | (WatcherEventBase & { type: "closeout"; msg: string })
  | (WatcherEventBase & { type: "done"; benign: boolean; msg: string });

/** Every `type` discriminant the parser recognizes — an unknown `type` is
 * skipped by {@link parseWatcherEvents} (tolerant-by-contract). */
export const WATCHER_EVENT_TYPES = [
  "start",
  "cue",
  "review",
  "exception",
  "polish",
  "closeout",
  "done",
] as const;

/**
 * Serialize one event to a single NDJSON line (no trailing newline — the
 * caller joins with `\n`). `JSON.stringify` never embeds a raw newline (it
 * escapes `\n` within string fields as `\\n`), so the one-line guarantee holds
 * for every variant without extra work here.
 */
export function serializeWatcherEvent(event: WatcherEvent): string {
  return JSON.stringify(event);
}

/**
 * Parse the NDJSON events file text into events, TOLERANTLY: skip any line
 * that is blank, non-JSON, missing a known/well-typed `type`, or truncated
 * (mid-write tail). Never throws — the file is append-only and may be read
 * mid-write, so a malformed trailing line is simply dropped, not a crash.
 */
export function parseWatcherEvents(text: string): WatcherEvent[] {
  const events: WatcherEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // non-JSON garbage or a truncated mid-write tail
    }
    if (!isWatcherEvent(parsed)) continue;
    events.push(parsed);
  }
  return events;
}

/** Narrow an arbitrary parsed JSON value to a well-formed {@link WatcherEvent}
 * (known `type` discriminant + `ts` + the fields that type requires). Any
 * mismatch (unknown type, missing field, wrong shape) ⇒ not a WatcherEvent —
 * the tolerant parser skips it rather than passing through a malformed record. */
function isWatcherEvent(value: unknown): value is WatcherEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.ts !== "string") return false;
  if (typeof v.type !== "string" || !(WATCHER_EVENT_TYPES as readonly string[]).includes(v.type)) return false;
  switch (v.type as WatcherEvent["type"]) {
    case "start":
      return typeof v.pid === "number" && Array.isArray(v.flags) && v.flags.every((f) => typeof f === "string");
    case "cue":
      return (v.gate === 1 || v.gate === 2 || v.gate === 3 || v.gate === "deploy") && typeof v.msg === "string";
    case "review":
      return Array.isArray(v.lines) && v.lines.every((l) => typeof l === "string");
    case "exception":
      return typeof v.code === "number" && typeof v.msg === "string";
    case "polish":
      return typeof v.msg === "string";
    case "closeout":
      return typeof v.msg === "string";
    case "done":
      return typeof v.benign === "boolean" && typeof v.msg === "string";
    default:
      return false;
  }
}

/**
 * Absolute path of the events file for a spec's watcher:
 * `<repo>/.preflight/supervise-<specId>.events.ndjson` — the same
 * `${REPO}/.preflight/supervise-${specId}.<ext>` shape as the script's
 * existing `.out`/`.flag`/`.review` files.
 */
export function watcherEventsPath(repo: string, specId: string): string {
  return `${repo}/.preflight/supervise-${specId}.events.ndjson`;
}
