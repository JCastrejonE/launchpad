/**
 * Per-session timing record + formatter (spec 0007). Every agent-session
 * activity (draftSpec/runInitializer/runCoder) logs one of these lines to the
 * worker log so future speed work has real data — the SessionResult already
 * carries model/turns/costUsd; the activity measures wall-clock `seconds`.
 *
 * Pure formatter, unit-tested — the activities just measure and log.
 */
import type { AgentRole } from "./session.js";

export interface SessionTiming {
  role: AgentRole;
  /**
   * Spec id this session ran for (spec 0018 loud/attributable failures) —
   * `formatSessionTiming` emits `spec=NNNN` so `[session]` cost/time lines are
   * attributable per spec. Optional here so foundations compile before every
   * call site passes it; the acceptance criteria require every real call site
   * (draftSpec/runInitializer/runCoder/runRepair) to pass it.
   */
  spec?: string;
  /** Model that actually ran (SessionResult.model). */
  model?: string;
  /** Wall-clock seconds the session took (measured by the activity). */
  seconds: number;
  /** SDK turns (SessionResult.numTurns). */
  turns?: number;
  /** API-key-mode cost (SessionResult.costUsd); absent in subscription mode. */
  costUsd?: number;
}

/**
 * Render a SessionTiming as one stable, greppable worker-log line, e.g.
 * `[session] role=coder model=claude-sonnet-5 seconds=42 turns=7 costUsd=0.03`.
 * Optional fields (model/turns/costUsd) are omitted entirely when absent.
 */
export function formatSessionTiming(timing: SessionTiming): string {
  const parts = [`role=${timing.role}`];
  if (timing.spec !== undefined) parts.push(`spec=${timing.spec}`);
  if (timing.model !== undefined) parts.push(`model=${timing.model}`);
  parts.push(`seconds=${timing.seconds}`);
  if (timing.turns !== undefined) parts.push(`turns=${timing.turns}`);
  if (timing.costUsd !== undefined) parts.push(`costUsd=${timing.costUsd}`);
  return `[session] ${parts.join(" ")}`;
}
