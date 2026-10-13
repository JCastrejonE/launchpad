/**
 * The platform deploy's claim (spec 0219 B).
 *
 * Its own module, with no `server-only`, for one reason: the acceptance test
 * for this is a RACE between real processes, and a `server-only` module cannot
 * be imported outside a React server context — so the test would have had to
 * re-implement the primitive and prove nothing about the code that ships.
 */
import { writeFileSync } from "node:fs";

/** Where a pending deploy's parameters wait for `deploy-here.sh` to claim them. */
export const DEPLOY_REQUEST_PATH = "/tmp/launchpad-deploy-request";

/**
 * Take the request path, or lose it — atomically.
 *
 * `O_EXCL` is the whole mechanism: the kernel lets exactly ONE of two racing
 * writers create the file. Checking `systemctl is-active` and then writing is
 * NOT this — there is a window between the check and the write, and the deploy
 * that reads the loser's commit would still mark the winner's release row as
 * shipped. Returns false if someone already holds it.
 */
export function claimDeployRequest(payload: string, requestPath = DEPLOY_REQUEST_PATH): boolean {
  try {
    writeFileSync(requestPath, payload, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
