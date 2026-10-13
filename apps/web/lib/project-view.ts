/**
 * Spec 0084 (C.4a) — the Appendix-A adapter: a real `projects` row becomes the
 * display shape the imported mockup components already render, so no component
 * markup has to change as data becomes real.
 *
 * **The rule this file exists to enforce: never invent what we cannot observe.**
 * Columns that exist pass through; everything the control plane cannot answer
 * yet resolves to an empty collection or an em dash, never to a plausible
 * number. The mockup shipped `99.4% uptime`, `12 deploys`, branch lists and
 * metric tiles as literals — those read as live state, and carrying them into a
 * real-data surface would be a lie the UI tells convincingly.
 *
 * What is still empty here, and what fills it:
 *   branches / metrics          → Phase F (Grafana) + Phase E (repo indexing)
 *   integrations                → Phase E (`ProjectConnection`)
 *   chats / specs               → C.4c (the spec inbox re-home); the chats TAB
 *                                 is already real (spec 0081) — this array is
 *                                 only the mockup's inline preview list
 *   vps / lastDeploy            → C.4b (fleet re-home)
 *   activeAgents                → Phase D (the `agent_runs` projection writer)
 *
 * Pure and framework-free so it compiles under `tsconfig.test.json`.
 */
import type { ProjectCounts, ProjectRow } from "@launchpad/db";
import type { Project } from "./mock-data";

/** Shown wherever the control plane has no value yet — visibly "unknown"
 * rather than a confident-looking zero. */
export const UNKNOWN = "—";

/** A project as the UI renders it: the mockup's display shape plus the real
 * `Project.id` (the UUID) the mockup had no concept of, and — since spec 0137
 * — the repo identity the Repositorio tab links to (null when unlinked). */
export type ProjectView = Project & {
  projectId: string;
  repoOwner: string | null;
  repoName: string | null;
};

/** Card accents are presentation, not data. Seeded rows carry `accent: ""`, so
 * derive a stable colour from the slug: the same project always gets the same
 * one (no flicker across renders, no random). Colours are the mockup palette's
 * CSS variables. */
const ACCENT_PALETTE = [
  "var(--color-brand)",
  "var(--color-cyan)",
  "var(--color-purple)",
  "var(--color-amber)",
  "var(--color-blue)",
  "var(--color-orange)",
];

export function accentForSlug(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return ACCENT_PALETTE[hash % ACCENT_PALETTE.length]!;
}

/** The one genuine vocabulary difference between the two sides: the Postgres
 * enum spells it `odoo_next` (spec 0077 — underscores, as SQL enums prefer),
 * the mockup's `ProjectKind` spells it `odoo-next`. Translating here is exactly
 * why the adapter exists; neither side has to change to match the other.
 * (`health` needs no mapping — the DB's four values are a strict subset of the
 * UI's five; only the UI's `sleeping` has no DB counterpart, which is a Vps
 * state anyway.) */
export function toUiKind(kind: ProjectRow["kind"]): Project["kind"] {
  return kind === "odoo_next" ? "odoo-next" : kind;
}

/**
 * The same translation the other way, for the two wizards that COLLECT a kind.
 *
 * It existed only as an inline ternary in `/new`'s submit handler, so `/connect`
 * — written later — sent the UI spelling straight to `createProject`, whose
 * `KINDS` list holds the DB spelling. Every "Odoo + Front" connect was refused
 * with "Tipo de proyecto no reconocido." Third instance today of one shape: a
 * rule present at the first call site and absent at the second
 * (docs/VERIFICATION.md #11, #12). A comment is not a control, so it is a
 * function, at the second caller, used by both.
 */
export function fromUiKind(kind: Project["kind"]): ProjectRow["kind"] {
  return kind === "odoo-next" ? "odoo_next" : kind;
}

/**
 * Map one row (+ its live counts) to the display shape.
 *
 * `id` is the **slug**, not the UUID: it is what the mockup components put in
 * `/projects/[id]` links, so slugs stay the human-facing URL. The UUID is
 * carried separately as `projectId` for the callers that need it (the Chats
 * tab scopes threads by it).
 */
export function toProjectView(
  row: ProjectRow,
  counts?: ProjectCounts,
): ProjectView {
  return {
    projectId: row.id,
    id: row.slug,
    // Spec 0137: the REAL repo identity — the tab renders a working "Abrir en
    // GitHub" from it, or says the project is unlinked. Never string-built.
    repoOwner: row.repoOwner ?? null,
    repoName: row.repoName ?? null,
    name: row.name,
    kind: toUiKind(row.kind),
    client: row.client,
    // Spec 0178: the host the project is actually SERVED at, which is what the
    // header's globe should open. Was `<slug>.<domain>`, treating the column as
    // a DNS ZONE. That composition is wrong for both real cases and had never
    // run: every row's `domain` was null until `/connect` shipped, and the first
    // connected project rendered `taqueria-sol-conectada.taqueria-sol.example.com`
    // — our slug glued to their host. A connected tenant's host is THEIRS and is
    // not derivable from our slug; a customer who brings `client-d.example` is
    // served at `client-d.example`, not at `<slug>.client-d.example`.
    //
    // So the column is the HOST, used verbatim. The fallback is unchanged and is
    // what makes this safe: every fleet tenant is served at `<slug>.example.com`
    // (verified against the live Traefik rules), and all eleven pre-existing rows
    // are null, so they keep resolving exactly as before.
    domain: row.domain ?? `${row.slug}.example.com`,
    health: row.health,
    description: row.description,
    accent: row.accent || accentForSlug(row.slug),
    stack: row.stack,
    region: row.region,
    version: row.version,
    // Not observable yet — see the header. Empty, never invented.
    vps: undefined,
    lastDeploy: UNKNOWN,
    openChats: counts?.openChats ?? 0,
    activeAgents: counts?.activeAgents ?? 0,
    branches: [],
    integrations: [],
    metrics: [],
    chats: [],
    specs: [],
  };
}

export function toProjectViews(
  rows: ProjectRow[],
  counts: Map<string, ProjectCounts>,
): ProjectView[] {
  return rows.map((row) => toProjectView(row, counts.get(row.id)));
}
