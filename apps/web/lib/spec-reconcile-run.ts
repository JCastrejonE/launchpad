/**
 * The reconciler's IO half (spec 0165) — gather evidence, apply the decision.
 *
 * `spec-reconcile.ts` decides; this collects what it decides from and writes the
 * result. Kept apart so every combination stays testable without git or a
 * filesystem, and so the risky part (writing to spec files) is one small surface.
 *
 * Cost discipline, because this runs on a panel load: it only looks at specs whose
 * status is NOT already terminal. On the platform that is a handful out of ~165,
 * so the git work is bounded by "specs somebody left unfinished", not by the size
 * of the repo.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setStatusInDir } from "@launchpad/pipeline";
import { allNonHumanItemsChecked, decideSpecStatusRepair } from "./spec-reconcile";
import { commitSpecFile } from "./spec-commit";

const exec = promisify(execFile);

export interface ReconcilableSpec {
  id: string;
  filename: string;
  status: string;
  track?: 1 | 2;
}

export interface SpecRepair {
  id: string;
  from: string;
  to: "promoted" | "completed";
}

/**
 * Has `spec/<id>` been merged into `origin/main`?
 *
 * A local git question — `merge-base --is-ancestor` — so this costs no GitHub API
 * call and cannot be true unless the code really shipped.
 *
 * Returns `undefined`, never `false`, when git cannot answer (no such branch, not
 * a repo, git missing). The decision treats `undefined` as "do nothing", which is
 * the direction that cannot mark unshipped code as shipped.
 */
export async function branchMergedIntoMain(
  repoRoot: string,
  specId: string,
): Promise<boolean | undefined> {
  const branch = `spec/${specId}`;
  try {
    // `--verify` first: a missing branch is "unknown", not "unmerged". A spec
    // whose branch was pruned after merging must not be re-decided as pending.
    await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoRoot });
  } catch {
    return undefined;
  }
  try {
    await exec("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: repoRoot });
    return true;
  } catch (err) {
    // Exit 1 is git's honest "no". Anything else (128 = bad object, no such ref)
    // is a broken question, and a broken question is not an answer.
    const code = (err as { code?: number }).code;
    return code === 1 ? false : undefined;
  }
}

/**
 * Repair every spec whose recorded status disagrees with what shipped.
 *
 * Writes the frontmatter AND commits it (spec 0160): the platform's specs are
 * git-tracked, and an uncommitted edit in the shared checkout is what broke a
 * merge — this reconciler exists to clean up after incidents, not to cause one.
 *
 * Never throws. It runs during a page render, and a panel that 500s because a
 * bookkeeping sweep failed would be a worse bug than the stale field it fixes.
 */
export async function reconcileSpecStatuses(
  specs: readonly ReconcilableSpec[],
  opts: { specsDir: string; repoRoot?: string; commit: boolean },
): Promise<SpecRepair[]> {
  const repairs: SpecRepair[] = [];
  for (const spec of specs) {
    try {
      const track = spec.track ?? 1;
      const merged =
        track === 2 && opts.repoRoot
          ? await branchMergedIntoMain(opts.repoRoot, spec.id)
          : undefined;
      // Read the body here rather than threading it through the panel: this
      // module already owns the directory, and the panel's summaries do not
      // carry markdown.
      const body = await readFile(path.join(opts.specsDir, spec.filename), "utf8");
      const decided = decideSpecStatusRepair({
        ...(spec.track ? { track: spec.track } : {}),
        status: spec.status,
        ...(merged === undefined ? {} : { merged }),
        allWorkDone: allNonHumanItemsChecked(progressSection(body)),
      });
      if (!decided) continue;
      await setStatusInDir(opts.specsDir, spec.id, decided);
      if (opts.commit) {
        await commitSpecFile(
          path.dirname(opts.specsDir),
          path.join(opts.specsDir, spec.filename),
          `chore(spec-${spec.id}): status -> ${decided} (reconciled)`,
        );
      }
      repairs.push({ id: spec.id, from: spec.status, to: decided });
    } catch {
      // One unreadable spec must not stop the rest. The stale status survives to
      // the next load, which is exactly as bad as it was a moment ago.
    }
  }
  return repairs;
}

/** The `## Progress` block, or "" — the only region the checklist rule reads. */
export function progressSection(body: string): string {
  const start = body.search(/^## Progress\s*$/m);
  if (start === -1) return "";
  const rest = body.slice(start).replace(/^## Progress\s*$/m, "");
  const next = rest.match(/^## /m);
  return next ? rest.slice(0, next.index) : rest;
}
