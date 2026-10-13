/**
 * The run's staging environment, as apps/web reads it (spec 0119).
 *
 * Same split as `target-query.ts`/`pr-query.ts`: the query NAME and its result
 * TYPE live in a tiny `@temporalio`-free module so the `defineQuery` in
 * workflow.ts and the `handle.query(...)` in apps/web cannot drift apart, and so
 * the web app can type the result without importing the activities surface.
 *
 * `StagingState` has three cases rather than an optional ref because a failed
 * create and a run that never had staging are DIFFERENT things a reviewer needs
 * to tell apart — a missing environment with no explanation reads as "not built
 * yet" when it may mean "the box refused". It mirrors `Gate2PollState`'s shape
 * for that reason (spec 0016's precedent), rather than inventing a new one.
 *
 * Bootstrap note (cf. `pipelineTarget`): this is workflow code, so it only
 * answers on runs started after the worker picks up this build. A run on an
 * older snapshot has no handler; callers must treat the query as unavailable and
 * render nothing, never crash.
 */
export const PIPELINE_STAGING_QUERY = "pipelineStaging";

/** A live staging environment, as the deploy reported it. */
export interface StagingRef {
  /** Four-digit spec id the stack is named after. */
  specId: string;
  /** `spec-NNNN` — the compose project, DB name and remote dir all derive from it. */
  stack: string;
  /**
   * Host the Traefik router answers on.
   *
   * NOT necessarily reachable: while the tenant domain is `.test` (an RFC 6761
   * reserved TLD), no name resolves and this is an SSH-side fact only. Spec
   * 0119's open DNS item. A caller rendering this must not imply a working link
   * — see `stagingHostIsResolvable`.
   */
  host: string;
  /** Addon module names installed into the fresh database. */
  addons: string[];
  /** Containers reported healthy by the deploy. */
  healthy: boolean;
  /** Odoo answered HTTP **on the VPS** — not proof a customer can reach it. */
  odooHttpOk: boolean;
  /**
   * Spec 0180: the branch's FRONT, when the project has one.
   *
   * Additive and optional, like every field 0119 added: a plain-Odoo project and
   * every run recorded before this carry none, and behave exactly as they did.
   * `failed` says the front could not come up — reported, because a gate-2 card
   * that says "listo" about a stack where only the backend moved is the
   * true-but-misleading sentence this spec exists to remove.
   */
  front?: { stack: string; host: string; failed?: string };
  /**
   * Spec 0226 E: this environment is a NEUTRALIZED copy of production, and the
   * marker was proven (`database.is_neutralized`, read back from the branch
   * database — never inferred from a command's exit code).
   *
   * Additive and optional like every 0119/0180 field before it: absent means a
   * clean Odoo, which is what every environment created before this was. Absent
   * must never be rendered as "probably neutralized".
   */
  neutralized?: boolean;
}

export type StagingState =
  /** No staging environment for this run — a dogfood target, or gate 2 not reached. */
  | { status: "none" }
  | { status: "ready"; ref: StagingRef }
  /** The create failed. The run continues: the change is still reviewable on the
   * PR, and losing a whole run because a staging box hiccupped is worse than
   * reviewing without an environment. The reason is carried so the UI can say
   * WHY rather than showing an unexplained absence. */
  | { status: "failed"; error: string };

/**
 * Whether a staging host can resolve publicly at all.
 *
 * `.test` can never resolve (RFC 6761), so a UI must render such a host as text,
 * not as a link. Pure and exported so the web app and the tests agree on the
 * rule instead of each re-deriving it from the string.
 */
export function stagingHostIsResolvable(host: string): boolean {
  return host.length > 0 && !host.endsWith(".test") && !host.endsWith(".localhost");
}
