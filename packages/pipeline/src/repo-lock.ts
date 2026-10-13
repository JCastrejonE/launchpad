/**
 * Serialize the activities that mutate a shared checkout (spec 0115, concurrency A).
 *
 * ## The measured problem
 *
 * `draftSpec`, `mergePullRequest`, `teardownEnv` and the commit helpers all operate on
 * the SAME primary checkout, and nothing coordinated them. Reproduced 3/3 by running
 * two `git.commit`-shaped operations concurrently on one temp repo:
 *
 *   draft 0: rejected — fatal: Unable to create '.git/index.lock': File exists
 *   draft 1: fulfilled
 *   tree dirty after: "?? specs/0900-x.md"
 *
 * ## What it is NOT
 *
 * **Not silent corruption.** Git's own `index.lock` serializes the index, so one side
 * fails loudly and the repository stays consistent. Earlier notes in this repo
 * (including spec 0115's first draft) said concurrent runs "corrupt `main` silently";
 * that was overstated and is corrected here.
 *
 * ## What it actually costs, which is still worth fixing
 *
 *  1. **A run fails on a cryptic git error** it did nothing to deserve. Temporal may
 *     retry it into success, so the failure is intermittent — the worst kind to debug.
 *  2. **The loser leaves the tree dirty** (`?? specs/…`). That dirt then trips
 *     `assertCleanTree` in *other* activities and lands in
 *     `commitDraftIfUncommitted`'s "unrelated pre-existing dirt" warning path, so one
 *     run's collision degrades an unrelated run.
 *
 * With v0's three concurrent users this stops being a race you might lose and becomes
 * the normal case. Serializing turns a random failure into a short wait.
 *
 * ## Scope, stated plainly
 *
 * **In-process only.** `scripts/preflight.sh` refuses to start a second worker
 * (pidfile + pgrep), so one worker means one process means this covers every
 * activity-vs-activity collision — the whole problem described above.
 *
 * It does **not** cover a different process touching the same checkout: `supervise.mjs`
 * running git, or a human in a shell. That gap is real and known — spec 0108 was
 * exactly such a collision (the auto-polish agent versus a human editing the same
 * tree), and it was closed by turning auto-polish off rather than by locking. A
 * filesystem lock would be the answer if the gap ever bites again, but building one
 * now would be speculative: nothing else currently mutates that checkout unattended.
 */

/**
 * One promise chain per repo path. A key is a filesystem path, so the map is bounded
 * by the number of checkouts a worker serves — never cleaned up on purpose, because
 * deleting a key mid-flight would let a new caller start a parallel chain.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `repo` among callers in this process. Queues
 * behind any in-flight holder and resolves/rejects with `fn`'s own outcome.
 *
 * A failing holder must not block the queue, and must not leak its rejection into the
 * next caller — hence `then(fn, fn)` (run regardless of how the predecessor ended) and
 * the swallowed `.catch` on the stored chain. The rejection still reaches the caller
 * that owns it, via the returned promise.
 */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(repo) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  chains.set(
    repo,
    result.catch(() => undefined),
  );
  return result;
}

/** How many repos currently have a chain — for tests and diagnostics only. */
export function trackedRepoCount(): number {
  return chains.size;
}
