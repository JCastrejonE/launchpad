/**
 * The local-CI promote-gate artifact (spec 0058 / ADR-024).
 *
 * GitHub Actions is retired as this account's CI source, so the gate-3 promote
 * guard no longer reads `getCommitChecksConclusion(mergeSha)` from GitHub.
 * Instead the supervisor watcher's `postMerge()` (scripts/supervise.mjs) runs
 * the full local CI on merged `main` and writes a result artifact keyed by the
 * PR's merge-commit SHA:
 *
 *   .preflight/promote-ci-<mergeSha>.json
 *
 * `getPromoteCiState` (lib/pipeline.ts) reads that file server-side and derives
 * the promote decision from it. There is no local `"pending"`: the artifact's
 * ABSENCE is the pending/not-yet-reported state (allow-with-note at the gate),
 * and `conclusion` is strictly `"success" | "failure"`.
 *
 * This module holds the SHARED CONTRACT between the writer and the reader —
 * the on-disk shape, the path key, and a pure, never-throws parser/validator —
 * so the two sides can never drift. It has NO I/O of its own: the fs read is a
 * seam injected into `GetPromoteCiStateDeps`, and the write is a plain
 * `JSON.stringify` of a `PromoteCiArtifact` in the (JS) watcher. Kept pure so
 * the mapping rules below are unit-tested without touching the filesystem.
 *
 * Foundation note (spec 0058 initializer): this file + its test scaffold are
 * the landing place for Plan item 2 (the artifact read/validation in
 * `getPromoteCiState`). Item 1's watcher writes JSON matching `PromoteCiArtifact`
 * at `promoteCiArtifactPath(...)`. Wiring both sides is the coder's work.
 */

/** Current artifact schema version. A file whose `schema` differs is treated
 * as absent by {@link parsePromoteCiArtifact} — a forward/backward-incompatible
 * writer must bump this and the reader together. */
export const PROMOTE_CI_ARTIFACT_SCHEMA = 1 as const;

/** The CI steps `postMerge()` records. `web-smoke` is present only on runs
 * where web-smoke actually ran (batch touches apps/web/, or the changed-file
 * list is unknown) — see spec 0058 Scope A. */
export type PromoteCiStepName = "build" | "typecheck" | "test" | "web-smoke";

/** A single recorded CI step's outcome + wall-clock cost. */
export interface PromoteCiStep {
  name: PromoteCiStepName;
  ok: boolean;
  ms: number;
}

/** The local CI's verdict for a merge commit. Strictly binary — there is no
 * local `"pending"` (absence of the artifact IS the pending state). */
export type PromoteCiConclusion = "success" | "failure";

/** The on-disk artifact shape written by `postMerge()` and read by the gate. */
export interface PromoteCiArtifact {
  schema: typeof PROMOTE_CI_ARTIFACT_SCHEMA;
  /** The spec id whose run produced this artifact (informational). */
  specId: string;
  /** The PR branch (informational, e.g. `spec/0058`). */
  branch: string;
  /** The PR's merge-commit SHA — the artifact's KEY; must equal the gate's
   * `getPrState(pr.number).mergeCommitSha` lookup. */
  mergeSha: string;
  /** The `origin/main` tip the CI steps actually ran on. On a red→green re-run
   * the fix lands on `main` (the merge SHA never changes) and this advances to
   * the current tip. */
  evaluatedSha: string;
  conclusion: PromoteCiConclusion;
  /** ISO-8601 timestamp of when the steps ran. */
  ranAt: string;
  steps: PromoteCiStep[];
}

/** The `.preflight/promote-ci-<mergeSha>.json` path for a given repo root +
 * merge SHA — the single source of the artifact key, shared by writer + reader
 * so they can never key on different paths. */
export function promoteCiArtifactPath(repoRoot: string, mergeSha: string): string {
  return `${repoRoot}/.preflight/promote-ci-${mergeSha}.json`;
}

/**
 * Pure, NEVER-throws parse + validate of a promote-CI artifact's raw file
 * contents: everything except the `mergeSha` key check, which the two public
 * parsers below apply differently (one by requested SHA, one not at all —
 * spec 0063 Scope B selects by `specId`/`evaluatedSha` instead). Collapses
 * every "treat as absent" case to `null`:
 *  - malformed / non-object JSON
 *  - `schema` !== {@link PROMOTE_CI_ARTIFACT_SCHEMA}
 *  - `conclusion` not strictly `"success" | "failure"`
 */
function parseArtifactShape(raw: string): PromoteCiArtifact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["schema"] !== PROMOTE_CI_ARTIFACT_SCHEMA) return null;
  if (obj["conclusion"] !== "success" && obj["conclusion"] !== "failure") return null;
  return obj as unknown as PromoteCiArtifact;
}

/**
 * Pure, NEVER-throws parse + validate of a promote-CI artifact's raw file
 * contents against the SHA the gate is asking about.
 *
 * Returns the typed artifact only when it is genuinely usable; every "treat as
 * absent" case from spec 0058 Scope B collapses to `null` so the caller maps it
 * to the same allow-with-note `no_local_ci` state as a missing file:
 *  - malformed / non-object JSON
 *  - `schema` !== {@link PROMOTE_CI_ARTIFACT_SCHEMA}
 *  - `mergeSha` field != the requested `expectedSha` (a stale/mis-keyed file)
 *  - `conclusion` not strictly `"success" | "failure"`
 */
export function parsePromoteCiArtifact(
  raw: string,
  expectedSha: string,
): PromoteCiArtifact | null {
  const artifact = parseArtifactShape(raw);
  if (artifact === null) return null;
  if (artifact.mergeSha !== expectedSha) return null;
  return artifact;
}

/**
 * Pure, NEVER-throws selection of the usable promote-CI artifact for a spec's
 * gate-3 read, token-lessly (spec 0063 Scope B). Given the raw contents of
 * every `.preflight/promote-ci-*.json` candidate, keep only those that parse,
 * match `specId`, and whose `evaluatedSha === currentOriginMainSha` (the
 * STRONGER staleness guard — an artifact from a superseded/pre-polish merge
 * fails the tip check no matter what its filename says), and return the one
 * with the latest `ranAt` (else `null`, mapped to allow-with-note upstream).
 */
export function selectPromoteCiArtifact(
  raws: string[],
  specId: string,
  currentOriginMainSha: string,
): PromoteCiArtifact | null {
  let best: PromoteCiArtifact | null = null;
  for (const raw of raws) {
    const artifact = parseArtifactShape(raw);
    if (artifact === null) continue;
    if (artifact.specId !== specId) continue;
    if (artifact.evaluatedSha !== currentOriginMainSha) continue;
    if (best === null || new Date(artifact.ranAt) > new Date(best.ranAt)) {
      best = artifact;
    }
  }
  return best;
}
