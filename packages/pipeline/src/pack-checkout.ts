/**
 * Packing a checkout as a front's build context (spec 0172).
 *
 * Lifted out of `provisioning-activities.ts` when a second and third caller
 * appeared — a branch's staging front and a release's production front. It
 * cannot simply be imported from there: `activities.ts` re-exports that module
 * (`export *`), so importing back would be a load cycle (the note on
 * `PROVISION_VPS_ID_ENV` says the same thing about its constants).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

const execFileP = promisify(execFile);

/** Injectable pack seam. Tests inject a stub so the archive CONTENTS are not
 * what is under test (the `packAddonsWithTar` posture). */
export type PackCheckout = (repoRoot: string) => Promise<string>;

/**
 * Whole-checkout excludes: `.git` (history is not build context), `node_modules`
 * and `.next` (a fresh clone has neither, but the gate-2 refresh packs the RUN's
 * worktree, where `runCi` has just executed `pnpm install` and `next build` — so
 * the worker's own host/arch output would ride into the image and sit under the
 * `next build` that runs there). That is docs/VERIFICATION.md #7 exactly: a
 * production `.next` left in place made `next dev` serve mismatched vendor
 * chunks and 500 one route while the rest looked fine (0123).
 *
 * Bare patterns, so they match at any depth.
 */
export const CHECKOUT_PACK_EXCLUDES = [".git", "node_modules", ".next", ".DS_Store"];

/**
 * Top-level symlinks whose target lies OUTSIDE `repoRoot`, as `./name` patterns
 * ready for `tar --exclude` (the exact form tar stores them under `-C root .`).
 *
 * Spec 0192 A, and it cost a run. A project checkout carries `specs` as a
 * symlink to `/srv/launchpad/specs/<slug>` — spec 0141, so a customer's repo
 * never holds our specs. On the worker that link resolves perfectly; packed into
 * a build context it points at nothing, and `next build` stats it and dies:
 * `[Error: ENOENT: no such file or directory, stat '/app/specs']`. The front
 * never rebuilt, and run 4's reviewer was shown the pre-change page by a staging
 * environment whose row said `ready`.
 *
 * Excluding by TARGET rather than by name is what makes the next unforeseen
 * link harmless, and it leaves a customer's own `specs/` directory — or any
 * symlink that stays inside the tree — packed exactly as before.
 *
 * Only the top level is scanned: that is where a checkout's helper links live,
 * and walking the whole tree to pack it would cost more than it saves. A
 * directory that cannot be read yields no excludes — packing must never be
 * blocked by a diagnostic.
 */
export async function escapingSymlinkExcludes(repoRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(repoRoot, { withFileTypes: true });
    const root = await realpath(repoRoot);
    const escaping: string[] = [];
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      try {
        const target = await realpath(path.join(repoRoot, entry.name));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
          escaping.push(`./${entry.name}`);
        }
      } catch {
        escaping.push(`./${entry.name}`); // dangling on the worker too
      }
    }
    return escaping;
  } catch {
    return [];
  }
}

/** Tar the checkout root into a base64 `tar.gz`. `-C repoRoot .` stores paths
 * relative to the root so `deployFrontStack`'s extract lands `build.context: .`
 * at the repo root. argv (no shell): a path cannot become a command. */
export const packCheckoutWithTar: PackCheckout = async (repoRoot) => {
  const args = ["-czf", "-"];
  for (const pattern of [...CHECKOUT_PACK_EXCLUDES, ...(await escapingSymlinkExcludes(repoRoot))]) {
    args.push("--exclude", pattern);
  }
  args.push("-C", repoRoot, ".");
  const { stdout } = await execFileP("tar", args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return (stdout as unknown as Buffer).toString("base64");
};
