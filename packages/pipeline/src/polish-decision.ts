/**
 * polish-decision.ts — pure spawn-decision core for the auto-polish point in
 * `supervise.mjs` (spec 0064 part 2). Pure, no I/O — same pure-core/thin-IO
 * split as recover.ts/watcher-events.ts: `supervise.mjs` requires the BUILT
 * `dist/polish-decision.js` and does the actual spawn/push/re-check side
 * effects; this module only decides WHICH of those to do.
 */

export type PolishAction = "skip" | "manual-pause" | "auto-spawn";

export interface PolishDecisionInput {
  /** Did the merged batch touch apps/web/? Non-web (and tenant) runs never polish. */
  touchesWeb: boolean;
  /** Already polished — either `--polished` (manual relaunch) or a prior
   * successful auto-spawn earlier in this same process. */
  polished: boolean;
  /**
   * `--auto-polish`: OPT IN to spawning the uiux-coder unattended.
   *
   * Spec 0108 inverted this default. It used to be on unless you passed
   * `--manual-polish`, which meant an unattended agent committed to `main` and
   * auto-pushed on every apps/web run. That collided with a human working in the
   * primary checkout (the polish pass has no worktree of its own), and the fence's
   * remediation reset the branch — discarding two commits it had never examined.
   * Work survived only because they had already been pushed.
   *
   * It also sat badly against the point of the gates: nothing should reach `main`
   * unreviewed. So polish now PAUSES for a human by default, and auto-spawn is an
   * explicit choice.
   */
  autoPolish: boolean;
}

/**
 * The touches-web / already-polished / opt-in decision at the polish point:
 * "skip" (nothing to do), "manual-pause" (**the default** — cue a human), or
 * "auto-spawn" (spawn the uiux-coder in-process, only when explicitly asked).
 */
export function decidePolishAction(input: PolishDecisionInput): PolishAction {
  if (!input.touchesWeb || input.polished) return "skip";
  return input.autoPolish ? "auto-spawn" : "manual-pause";
}
