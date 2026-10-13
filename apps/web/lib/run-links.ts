/**
 * Pure link-builder for the RunFollowCard's context row (spec 0059 / ADR-022
 * phase 4d — "Hangar deep-links"). Given a run's identity + a little live
 * state, it derives the small, honest set of contextual anchors that put the
 * run's context ONE CLICK from where the human acts on it: the spec detail
 * page, the GitHub PR (when past a gate park), and EXACTLY ONE Hangar link
 * (the tenant host card, or the app root for a self/code run).
 *
 * Client-bundle-safety (the same hard constraint as `lib/run-follow-card.ts`,
 * whose doc comment is the precedent): this module is imported DIRECTLY as a
 * VALUE by the "use client" `RunFollowCard.tsx`, so it must NEVER value-import
 * `lib/pipeline.ts` or the `@launchpad/pipeline` barrel — a value import would
 * drag `@temporalio/client` into the browser bundle and break `next build`.
 * Every import here is `import type` (fully erased by TypeScript), exactly
 * like `gate-actions.ts`. No I/O, no fetch, no React — compiles under
 * `tsconfig.test.json` and runs under `node --test`.
 *
 * See spec 0059 "How it works" §2 for the full derivation rules.
 */
import type { PullRequestRef, PipelineTarget } from "@launchpad/pipeline";
import type { PipelineGate } from "./pipeline";

/** One contextual anchor rendered on the RunFollowCard's context row.
 * `external: true` ⇒ rendered as `<a target="_blank" rel="noreferrer">` (the
 * existing PR-link pattern); `false` ⇒ an internal `next/link` `Link`. */
export interface RunContextLink {
  key: "spec" | "pr" | "hangar-host" | "hangar-self";
  label: string;
  href: string;
  external: boolean;
}

/**
 * Derive the run's context links (spec 0059 increment B). TOTAL — never
 * throws; the set is always `{spec, [pr], (hangar-host | hangar-self)}`:
 * the spec link plus exactly one Hangar link, plus the PR link when a real
 * PR exists and the run is past its gate park. See "How it works" §2.
 */
export function deriveRunContextLinks(input: {
  specId: string;
  pr?: PullRequestRef;
  gate?: PipelineGate;
  target?: PipelineTarget;
}): RunContextLink[] {
  const links: RunContextLink[] = [
    {
      key: "spec",
      label: `Spec ${input.specId}`,
      href: `/forge/specs/${input.specId}`,
      external: false,
    },
  ];

  if (input.pr && input.pr.number > 0 && !input.gate) {
    links.push({
      key: "pr",
      label: `PR #${input.pr.number}`,
      href: input.pr.url,
      external: true,
    });
  }

  // Exactly one Hangar link — STRICT `=== "tenant"`; every other case
  // (a "self" target, a legacy in-flight `{kind:"launchpad"}` target, or an
  // absent target on a degraded view) falls through to `hangar-self`.
  if (input.target?.kind === "tenant") {
    links.push({
      key: "hangar-host",
      label: `${input.target.tenantId} · VPS #${input.target.vpsId} — ver el host en Hangar`,
      href: `/#vps-${input.target.vpsId}`,
      external: false,
    });
  } else {
    links.push({
      key: "hangar-self",
      label: "Abrir Hangar",
      href: "/",
      external: false,
    });
  }

  return links;
}
