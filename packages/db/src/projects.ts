/**
 * Project mapping + seed (spec 0079, SPEC §5 / SPEC-ALIGNMENT B.4). Bridges
 * the pipeline's runtime `target` (self / tenant) to the SPEC's first-class
 * `Project`. The mapping is PURE and typed structurally — it does NOT import
 * `@launchpad/pipeline`'s `PipelineTarget`, so `@launchpad/db` stays a leaf
 * dependency. Additive: nothing consumes this until Phase D wires the pipeline
 * `target` to a `Project.id`.
 */
import { count, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns, forgeThreads, projects } from "./schema.js";

export type ProjectKind = (typeof projects.kind.enumValues)[number];

/** The required (non-defaulted) `projects` columns a seed must supply. */
export interface ProjectSeed {
  slug: string;
  name: string;
  kind: ProjectKind;
  client: string;
}

/** The self / dogfood target as a Project: the launchpad (Hangar + Forge)
 * control plane itself (SPEC-ALIGNMENT §2 — `kind: platform`). */
export const PLATFORM_PROJECT: ProjectSeed = {
  slug: "platform",
  name: "Launchpad — Hangar + Forge",
  kind: "platform",
  client: "Example Co",
};

/**
 * Map a pipeline target to its `Project` seed. Structural input (not
 * `PipelineTarget`) to avoid a package dependency. `self` and the legacy
 * `launchpad` literal (the spec-0036 wire-compat, same rule as
 * `isSelfTarget`) both map to the platform project; a `tenant` maps to an
 * `odoo` project keyed by its tenantId.
 */
export function projectForTarget(target: { kind: string; tenantId?: string }): ProjectSeed {
  if (target.kind === "self" || target.kind === "launchpad") return PLATFORM_PROJECT;
  if (target.kind === "tenant") {
    const tenantId = target.tenantId?.trim();
    if (!tenantId) throw new Error("tenant target requires a tenantId to map to a Project");
    return { slug: tenantId, name: tenantId, kind: "odoo", client: tenantId };
  }
  throw new Error(`unknown target kind ${JSON.stringify(target.kind)}`);
}

/** Idempotent upsert by `slug`; returns the row id. Re-running never
 * duplicates — it refreshes name/kind/client for that slug. */
export async function upsertProject(db: Db, seed: ProjectSeed): Promise<string> {
  const rows = await db
    .insert(projects)
    .values(seed)
    .onConflictDoUpdate({
      target: projects.slug,
      set: { name: seed.name, kind: seed.kind, client: seed.client },
    })
    .returning({ id: projects.id });
  const row = rows[0];
  if (!row) throw new Error(`upsert of project ${JSON.stringify(seed.slug)} returned no row`);
  return row.id;
}

/** Seed the singleton platform project (the self/dogfood target). */
export async function seedPlatformProject(db: Db): Promise<string> {
  return upsertProject(db, PLATFORM_PROJECT);
}

/** Where a project's production lives (spec 0126). See `projects.productionKind`. */
export type ProductionKind = "odoosh" | "fleet" | "none";

export const PRODUCTION_KINDS: readonly ProductionKind[] = ["odoosh", "fleet", "none"];

/**
 * The one legal slug shape (spec 0126). A slug reaches a URL path, a Traefik
 * router rule and a tenant database name, so it is lowercase alphanumeric with
 * internal hyphens, 2–40 chars, and may not start or end with a hyphen.
 *
 * Validated, never sanitised: silently rewriting what someone typed hands them a
 * project addressed by a name they did not choose. Refusing costs one keystroke.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

export function isValidProjectSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Everything `createProject` accepts. Repo + production target are optional —
 * a project may legitimately have neither yet. */
export interface ProjectCreate extends ProjectSeed {
  domain?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repoRoot?: string | null;
  productionKind?: ProductionKind | null;
  productionHost?: string | null;
  /** Spec 0191: the five `/new` answers, verbatim, keyed by the wizard's own
   * question ids. Absent for every non-wizard caller, which is why it defaults
   * to `{}` in the column rather than being required here. */
  intake?: Record<string, string> | null;
  /** Odoo series this project runs, as the customer chose it (spec 0205) —
   * `"18"` / `"19"`. Before 0205 the column was NULL for every project and
   * `odooVersionForProject` fell back to 18, so a NULL meaning "18" and a NULL
   * meaning "nobody was asked" were indistinguishable. New projects always carry
   * one. */
  version?: string | null;
}

/** Raised when the slug is already taken, so a caller can say which field is
 * wrong instead of surfacing a Postgres error string. */
export class DuplicateProjectSlugError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`a project with slug ${JSON.stringify(slug)} already exists`);
    this.name = "DuplicateProjectSlugError";
    this.slug = slug;
  }
}

/**
 * Create a project. **Insert-only, and that is the whole point**: unlike
 * `upsertProject` — which is `onConflictDoUpdate` by slug and correct for a
 * re-runnable seed — a user typing a slug that already exists must get an error,
 * not a silent rewrite of somebody else's project name, kind and client.
 *
 * Returns the new row's id. Throws {@link DuplicateProjectSlugError} on a taken
 * slug and a plain Error on an invalid one.
 */
export async function createProject(db: Db, input: ProjectCreate): Promise<string> {
  if (!isValidProjectSlug(input.slug)) {
    throw new Error(`invalid project slug ${JSON.stringify(input.slug)}`);
  }
  const rows = await db
    .insert(projects)
    .values({
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      client: input.client,
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.repoOwner === undefined ? {} : { repoOwner: input.repoOwner }),
      ...(input.repoName === undefined ? {} : { repoName: input.repoName }),
      ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
      ...(input.productionKind === undefined ? {} : { productionKind: input.productionKind }),
      ...(input.productionHost === undefined ? {} : { productionHost: input.productionHost }),
      ...(input.intake === undefined || input.intake === null ? {} : { intake: input.intake }),
      // Null is "not applicable" (a `custom` project runs no Odoo), which the
      // column's own `''` default already says — same shape as `intake`.
      ...(input.version === undefined || input.version === null ? {} : { version: input.version }),
    })
    // Distinguish "taken" from every other failure without a pre-flight SELECT,
    // which would race two concurrent creates of the same slug.
    .onConflictDoNothing({ target: projects.slug })
    .returning({ id: projects.id });
  const row = rows[0];
  if (!row) throw new DuplicateProjectSlugError(input.slug);
  return row.id;
}

/** Look up a project id by slug (null if absent) — the read Phase D uses to
 * resolve a target to a `Project.id`. */
export async function projectIdBySlug(db: Db, slug: string): Promise<string | null> {
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.id ?? null;
}

// ── spec 0084 (C.4a): the reads the Launchpad + workspace render from ────────

/** A full `projects` row, as the UI adapter (`apps/web/lib/project-view.ts`)
 * consumes it. */
export type ProjectRow = typeof projects.$inferSelect;

/** Every project, ordered by slug so the grid is stable across renders. */
export async function listProjects(db: Db): Promise<ProjectRow[]> {
  return db.select().from(projects).orderBy(projects.slug);
}

/** One project by slug, or null. (`projectIdBySlug` stays for callers that
 * only need the id — Phase D's target resolution.) */
export async function projectBySlug(db: Db, slug: string): Promise<ProjectRow | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** By primary key — what a `forge_threads.project_id` holder resolves with
 * (spec 0135: the supervisor routes scope access by the thread's project). */
export async function projectById(db: Db, id: string): Promise<ProjectRow | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Live per-project counts the cards show, keyed by project id.
 *
 * `openChats` reads the `forge_threads.project_id` link spec 0081 started
 * writing. `activeAgents` counts running `agent_runs` — which is **0 for every
 * project until Phase D lands the projection writer** (nothing inserts into
 * that table yet). That zero is the truth, not a placeholder: the UI must not
 * invent activity it cannot observe.
 */
export interface ProjectCounts {
  openChats: number;
  activeAgents: number;
}

export async function projectCounts(db: Db): Promise<Map<string, ProjectCounts>> {
  const [chatRows, agentRows] = await Promise.all([
    db
      .select({ projectId: forgeThreads.projectId, n: count() })
      .from(forgeThreads)
      .where(isNotNull(forgeThreads.projectId))
      .groupBy(forgeThreads.projectId),
    db
      .select({ projectId: agentRuns.projectId, n: count() })
      .from(agentRuns)
      .where(inArray(agentRuns.status, RUNNING_AGENT_STATUSES))
      .groupBy(agentRuns.projectId),
  ]);

  const counts = new Map<string, ProjectCounts>();
  const bump = (id: string | null, key: keyof ProjectCounts, n: number) => {
    if (!id) return;
    const entry = counts.get(id) ?? { openChats: 0, activeAgents: 0 };
    entry[key] = n;
    counts.set(id, entry);
  };
  for (const row of chatRows) bump(row.projectId, "openChats", Number(row.n));
  for (const row of agentRows) bump(row.projectId, "activeAgents", Number(row.n));
  return counts;
}

/** What counts as an agent "working now" for the card badge. Matches the
 * mockup's `AgentRun.status` vocabulary (SPEC §5). */
const RUNNING_AGENT_STATUSES = ["running", "waiting-approval"];

/** Record where a project's checkout lives (spec 0129 B). Written after a clone so
 * the next run reuses it instead of cloning again. */
export async function setProjectRepoRoot(db: Db, slug: string, repoRoot: string): Promise<void> {
  await db.update(projects).set({ repoRoot }).where(eq(projects.slug, slug));
}

/**
 * Record which VPS a project's production actually runs on (spec 0171).
 *
 * Written by `provisionOdoo` AFTER its deploy returns, never before: a `vps_id`
 * that records an intention rather than a deploy reads true and is not. Without
 * it the Versiones button (spec 0170) refuses "no tiene VPS asignada" about a
 * project whose Odoo is running on exactly one known box.
 */
export async function setProjectVpsId(db: Db, slug: string, vpsId: string): Promise<void> {
  await db.update(projects).set({ vpsId }).where(eq(projects.slug, slug));
}

/**
 * Link a GitHub repository to an existing project (spec 0151).
 *
 * `createProject` could set this at creation and nothing could set it afterwards,
 * so a project created without a repo was stuck: every run start refused with
 * "no tiene repositorio vinculado" and the UI's only advice was to link it while
 * creating the project — which had already happened.
 *
 * Owner/name only, never a URL: that is what the API client takes, and it is the
 * one shape `parseRepoRef` normalises the three clone-URL forms into.
 */
export async function setProjectRepo(
  db: Db,
  slug: string,
  repoOwner: string,
  repoName: string,
): Promise<void> {
  await db.update(projects).set({ repoOwner, repoName }).where(eq(projects.slug, slug));
}
