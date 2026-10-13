/**
 * What a branch's row is allowed to claim after a staging deploy (spec 0192 B).
 *
 * `project_branches.staging_sha` is an ATTESTATION: it says "this commit ran on
 * that server, and somebody could look at it". Spec 0136's promote guard and
 * spec 0187 A's gate-2 freshness notice are both built on it — and in A/B run 4
 * both were satisfied by a record nobody had earned. The branch's front had
 * failed to build (spec 0173 A1 records that as `front.failed` rather than
 * throwing, so a healthy Odoo is not destroyed over a front), and the deploy
 * wrote `status = ready` with `staging_sha = <branch head>` anyway. The reviewer
 * was offered **Approve PR** over a staging URL still serving the page from
 * before the change.
 *
 * One function, two call sites — the gate-2 refresh and the explicit
 * create/redeploy — because the same rule written twice is the shape that has
 * already cost this repo four defects (docs/VERIFICATION.md #12).
 */

/** The part of a `deployBranchStagingStack` result this decision reads. */
export interface StagingDeployOutcome {
  stack: string;
  host: string;
  front?: { failed?: string | undefined } | undefined;
}

/** Exactly the union `setBranchStaging` accepts — the attestation is only
 * expressible together with `ready`, which is what makes this rule structural
 * rather than a convention two call sites have to remember. */
export type StagingRowUpdate =
  | { status: "failed"; stack: string; host: string; note: string }
  | { status: "ready"; stack: string; host: string; sha: string; baseSha: string };

/**
 * `ready` + the attestation when the whole environment came up; `failed` and NO
 * attestation when the branch has a front that did not build.
 *
 * The environment is still up and Odoo is still serving — 0173 A1's posture is
 * untouched. What changes is that nothing claims this commit was validated, so
 * promote refuses with the message it already has and the gate-2 notice says
 * what staging really holds. The panel then shows "staging falló" with
 * "Reintentar staging" instead of a link to the previous page.
 */
/**
 * The failure, shortened for a page (spec 0195 B).
 *
 * Docker's build output is thousands of characters and buildkit prints the
 * reason LAST (spec 0192 C), so the tail is the informative end — the same
 * reasoning as `buildFailureTail`, one more level down. 300 characters is about
 * what fits under a row without becoming a wall.
 */
export function frontFailureNote(failed: string, limit = 300): string {
  const text = failed.trim().replace(/\s+/g, " ");
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function stagingRowUpdate(
  result: StagingDeployOutcome,
  sha: string,
  baseSha: string,
): StagingRowUpdate {
  if (result.front?.failed) {
    // Spec 0195 B: carry the REASON, not merely the verdict. 0192 B stopped the
    // row from lying; a reviewer still had only "failed" and a retry button,
    // with the cause in a worker journal they cannot read. Trimmed because this
    // renders in a table cell — the full text stays in the log.
    return {
      status: "failed",
      stack: result.stack,
      host: result.host,
      note: frontFailureNote(result.front.failed),
    };
  }
  return { status: "ready", stack: result.stack, host: result.host, sha, baseSha };
}
