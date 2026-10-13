export * from "./spec.js";
export * from "./phase.js";
export * from "./pr-query.js";
export * from "./promote-attestation.js";
export * from "./branch-promote.js";
export * from "./target-query.js";
export * from "./branch-query.js";
export * from "./branch-name.js";
export * from "./staging-query.js";
// Pure odoo.sh build-state reader (spec 0115). @temporalio-free, so apps/web can
// import it directly for the staging/promote panels.
export * from "./odoosh-status.js";
// Pure recovery-decision core for `supervise.mjs --recover` (spec 0051). The
// script imports the built helpers directly from `dist/recover.js`; re-exported
// here for package-surface discoverability alongside the other pure cores.
export * from "./recover.js";
// Pure watcher-event vocabulary for supervisor-in-UI phase 3 (spec 0052 item
// A). `supervise.mjs` requires the built `dist/watcher-events.js` for the
// `--events` append; apps/web imports `parseWatcherEvents` from here.
export * from "./watcher-events.js";
// Pure exception PLAYBOOK for supervisor-in-UI phase 4a (spec 0054). apps/web
// VALUE-imports `describeWatcherExitCode` from here into the RunFollowCard;
// `@temporalio`-free by construction (see the module doc comment).
export * from "./watcher-playbook.js";
// Pure touches-web / already-polished / manual spawn-decision for the
// auto-polish point (spec 0064 part 2). `supervise.mjs` requires the built
// `dist/polish-decision.js`; re-exported here for the same discoverability
// reason as recover.js/watcher-events.js above.
export * from "./polish-decision.js";
export * from "./workflow.js";
// Spec 0161: the odoo-next provisioning phase model (pure, @temporalio-free) so
// apps/web can import PROVISION_PROJECT_WORKFLOW / PROVISIONING_PHASE_QUERY /
// ProvisioningPhase for the start action and the progress view.
export * from "./provisioning-phase.js";
export * from "./task-queue.js";
// Spec 0122: the spec-file frontmatter readers/writers. Server-only (they use
// node:fs) — the same constraint the `activities` namespace below already carries,
// so a "use client" file must not import from here (see lib/gate-actions.ts for the
// pattern that keeps the client bundle clean).
export * from "./store.js";
export * as activities from "./activities.js";
// `PullRequestRef` is re-exported directly (not just via the `activities`
// namespace) so apps/web can type the `pipelinePr` query's result without
// importing the whole activities surface — spec 0015 item 8.
export type { PullRequestRef } from "./activities.js";
// Spec 0129 B: `checkoutPathFor` is PURE (path math on a slug), so apps/web may
// name the checkout a run will use without importing the activities that create it.
export {
  checkoutPathFor,
  checkoutsRoot,
  CHECKOUTS_ROOT_ENV,
  projectSpecsDir,
  specsRoot,
  SPECS_ROOT_ENV,
} from "./checkout.js";
export * from "./hosts.js";
export * from "./release.js";
export * from "./release-smoke.js";
export * from "./release-deploy.js";
export * from "./release-workflow.js";

// Spec 0228: the status context both the publisher and the promote decision key
// on. One constant, so the two cannot drift — a publisher writing `ci/launchpad`
// while promote looked for something else would read as "no CI ever ran".
export { CI_STATUS_CONTEXT } from "./ci-gate-activity.js";
export { CI_GATE_WORKFLOW, ciGateWorkflowId } from "./ci-gate-workflow.js";
