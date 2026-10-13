/**
 * Control-plane schema (SPEC.md §5). The Phase-A security backbone (users,
 * audit_log, secrets — specs 0072/0075/0076) plus the Phase-B Project model
 * (projects, vps, spec_files, agent_runs — spec 0077). Migrations are
 * append-only in `drizzle/`: 0000 = Phase-A baseline, 0001 = the Project model.
 *
 * `chat-store.ts`'s forge_threads/forge_messages stay raw-`pg` until spec 0078
 * folds them in (SPEC-ALIGNMENT §4: one DB layer, transitional overlap
 * accepted). `Integration`/`ProjectConnection`/`Branch` (SPEC §5) are deferred
 * to Phase E (connectors) — not scaffolded early (§7).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** SPEC §5 / §13 roles. Destructive actions are OWNER-only (0074 gates on it). */
export const userRole = pgEnum("user_role", ["OWNER", "MEMBER", "VIEWER"]);

/**
 * Auth users (SPEC §5 `User` + `password_hash` for the credentials provider
 * chosen for spec 0073). `password_hash` is nullable: a future OAuth/passkey
 * user has none. Presence of a row IS the sign-in allowlist — there is no
 * self-registration path.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: userRole("role").notNull().default("MEMBER"),
  /** scrypt format from ./password.ts — never a plaintext or reversible value.
   * Retired as a LOGIN mechanism by spec 0128 (GitHub OAuth is the only sign-in);
   * the column stays until that cutover is complete and proven. */
  passwordHash: text("password_hash"),
  /**
   * The GitHub identity that claimed this row (spec 0128 B). NULL until the user
   * signs in with GitHub for the first time.
   *
   * Recorded EXPLICITLY rather than re-derived from email on every sign-in: a
   * GitHub account's profile email can change, and a row that is already claimed
   * must not become claimable by a different account later (decision 3c).
   * `githubId` is the immutable numeric id — a login can be renamed, and after a
   * rename the id is the only thing that still says "the same person".
   */
  githubLogin: text("github_login"),
  githubId: text("github_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * SPEC §5 `AuditLog`: one row per effectful action, human or agent
 * (`actor` = session email or agent role; `action` = dotted verb like
 * "gate.promote", "pipeline.start"; `target` = spec id / tenant id / thread
 * id). Append-only by convention — nothing in this package updates or
 * deletes rows.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_created_at_idx").on(t.createdAt)],
);

/**
 * Minimal secret store (SPEC §13; spec 0076 adds the crypto + I/O). One row
 * per named secret; `key_id` names the master key that encrypted it (rotation
 * seam); iv/ciphertext/tag are base64 AES-256-GCM parts. Values are NEVER
 * stored or logged in clear.
 */
export const secrets = pgTable("secrets", {
  name: text("name").primaryKey(),
  keyId: text("key_id").notNull(),
  iv: text("iv").notNull(),
  ciphertext: text("ciphertext").notNull(),
  tag: text("tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Phase B: the Project model (spec 0077, SPEC §5) ------------------------
// Additive and unconsumed for now — the DB is a projection; Temporal stays the
// source of truth (SPEC §8). Wiring comes in Phase C (UI) / Phase D (pipeline).

/** SPEC §5 `Kind`: the type of governed project. `platform` is Hangar/Forge
 * itself (the self-dogfood target); `odoo`/`odoo_next`/`custom` are clients. */
export const projectKind = pgEnum("project_kind", ["odoo", "odoo_next", "custom", "platform"]);

/** Shared health status for a `Project` and a `Vps` (SPEC §5 `Health`). */
export const health = pgEnum("health", ["operational", "degraded", "down", "building"]);

/**
 * SPEC §5 `Project`: the central abstraction — one governed unit (an Odoo, an
 * Odoo+Next, a custom system, or the platform itself). Formalizes the
 * mockup's `lib/mock-data.ts` `PROJECTS` shape. `vpsId` is a loose text
 * pointer (SPEC models it nullable; a hard FK would be circular with
 * `vps.assignedTo`).
 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: projectKind("kind").notNull(),
  client: text("client").notNull(),
  domain: text("domain"),
  health: health("health").notNull().default("operational"),
  description: text("description").notNull().default(""),
  accent: text("accent").notNull().default(""),
  stack: text("stack").array().notNull().default([]),
  region: text("region").notNull().default(""),
  version: text("version").notNull().default(""),
  vpsId: text("vps_id"),
  /**
   * GitHub repo identity (spec 0116). NULLABLE on purpose: rows created before
   * this — and any project that simply has no repo — fall back to
   * `LAUNCHPAD_REPO_ROOT` via `repoIdentityFor`. A NOT NULL default would mean
   * inventing a repo for projects that do not have one.
   *
   * `repoRoot` is the worker-local checkout the pipeline cuts worktrees from;
   * `repoOwner`/`repoName` are the GitHub coordinates the PR and merge calls use.
   * They are stored rather than derived from the checkout's `origin` because a
   * project must be addressable before anything is cloned.
   */
  repoOwner: text("repo_owner"),
  repoName: text("repo_name"),
  repoRoot: text("repo_root"),
  /**
   * Where this project's production lives (spec 0126). `'odoosh' | 'fleet' |
   * 'none'`, guarded by a CHECK constraint in migration 0005 rather than a
   * pgEnum — the vocabulary is young and a CHECK is the cheaper thing to change.
   *
   * NULLABLE, like the repo identity above and for the same reason: every row
   * predates this, and writing `'none'` into them would claim a decision nobody
   * made. `productionHost` is the odoo.sh SSH host and is for DIAGNOSIS only —
   * we never deploy to odoo.sh (it deploys itself when `main` moves), so the
   * confirmation path is `readOdooShBuild` reading the `ci/odoo.sh` commit
   * status. For `'fleet'` the address is the existing `vpsId`.
   */
  productionKind: text("production_kind"),
  productionHost: text("production_host"),
  /**
   * The five answers `/new` asks about the business (spec 0191): giro, how many
   * people, which processes, CFDI, brand.
   *
   * Until this column they were collected, rendered on the confirm step, and
   * dropped on submit — so the owner's decision that they are *"recorded only, context
   * for a human"* was not true of the shipped code. Stored verbatim, as given: no
   * derived fields, no interpretation, so a human reading them later sees what
   * the customer actually said.
   *
   * Consumed by exactly one thing, the project's own landing page. It is NOT an
   * input to provisioning — no module selection is derived from it (the owner, decision
   * 5 of 2026-08-12).
   */
  intake: jsonb("intake").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who may see and act on a project (spec 0128).
 *
 * Until this table existed, `listProjects` was unscoped: every signed-in user saw
 * every project. Membership is the axis that makes a project belong to people,
 * and it is deliberately SEPARATE from `users.role` — the control-plane role says
 * what kind of account this is, membership says which projects it reaches. A user
 * needs both.
 *
 * `role` is `owner | member` and is NOT the same vocabulary as `users.role`
 * (OWNER/MEMBER/VIEWER). Reusing that enum would have implied a VIEWER membership
 * and a promote permission this table does not grant: since spec 0128 decision 2,
 * a promotion is authorised by GitHub itself at merge time, using the promoting
 * person's own credential — so `owner` here means "may manage this project's
 * members", not "may deploy".
 *
 * `addedBy` is an email rather than a user id on purpose: it is an audit fact
 * about who granted access, and it must survive that account being deleted.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    addedBy: text("added_by").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One membership per person per project — a second row would make "what is
    // their role here?" ambiguous, which is the kind of question authorization
    // must never have two answers to.
    uniqueIndex("project_members_project_user_key").on(t.projectId, t.userId),
    index("project_members_user_idx").on(t.userId),
    check("project_members_role_check", sql`${t.role} IN ('owner', 'member')`),
  ],
);

/**
 * Spec 0133: a branch as a first-class thing (the odoo.sh model) — a branch =
 * a staging environment = the unit of promotion.
 *
 * Stores ONLY what cannot be re-asked: identity, `createdBy`, terminal state
 * (`mergedAt`/`mergedBy`), the literal staging stack name (teardown and the
 * sweep need the exact string), and the promote attestation — `stagingSha`
 * (what staging actually ran) + `stagingBaseSha` (the main content inside the
 * tested tree), recorded at deploy time because that is the only moment they
 * are true. A branch accumulates over N runs; by promote time the last run's
 * workflow may be long closed, so workflow state cannot carry these facts to
 * the merge (spec 0136) — a row can.
 *
 * `prNumber`/`stagingHost`/`stagingStatus` are UI caches; the truth is GitHub
 * and the box, and promote re-derives the PR by head when the cache is stale.
 * Branch head SHA and PR/checks state are derived live, never stored.
 */
export const projectBranches = pgTable(
  "project_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull().default(""),
    prNumber: integer("pr_number"),
    stagingStack: text("staging_stack"),
    stagingHost: text("staging_host"),
    stagingStatus: text("staging_status").notNull().default("none"),
    /** Spec 0195 B: why the last staging op failed, in words a reviewer can act
     * on. '' when the environment is healthy — cleared on success and on
     * destroy, because a stale reason under a working stack is its own lie. */
    stagingNote: text("staging_note").notNull().default(""),
    stagingSha: text("staging_sha"),
    stagingBaseSha: text("staging_base_sha"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedBy: text("merged_by").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per (project, name): "which branch is this?" must never have
    // two answers — the same reasoning as project_members' unique pair.
    uniqueIndex("project_branches_project_name_key").on(t.projectId, t.name),
    check(
      "project_branches_staging_status_check",
      sql`${t.stagingStatus} IN ('none', 'deploying', 'ready', 'failed', 'destroying')`,
    ),
  ],
);

/** SPEC §5 `Vps`: a fleet host. `assignedTo` is a loose text pointer to a
 * `Project` (same circular-FK reasoning as `projects.vpsId`). `externalId` is
 * the id in Hostinger. */
export const vps = pgTable("vps", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  provider: text("provider").notNull().default("hostinger"),
  externalId: text("external_id").notNull(),
  plan: text("plan").notNull().default(""),
  ip: text("ip").notNull().default(""),
  region: text("region").notNull().default(""),
  os: text("os").notNull().default(""),
  docker: boolean("docker").notNull().default(false),
  status: health("status").notNull().default("operational"),
  assignedTo: text("assigned_to"),
});

/**
 * SPEC §5 `SpecFile`: a product-facing projection of a spec (the source of
 * truth stays the markdown file in `specs/`). `status` is free text per SPEC
 * (`draft | approved | implemented | superseded`) — deliberately a different
 * vocabulary from the pipeline's `SpecStatus` state machine.
 */
export const specFiles = pgTable("spec_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  chatId: uuid("chat_id"),
  name: text("name").notNull(),
  status: text("status").notNull(),
  version: text("version").notNull().default(""),
  author: text("author").notNull().default(""),
  body: text("body").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Spec 0164: the per-project spec-id allocator.
 *
 * Ids used to come from `max(files) + 1` computed in the web process, which is a
 * read-then-write race: two chats drafting in one project both saw `0004` and both
 * wrote `0005-*`. The `(project_id, name)` unique index does not catch it, because
 * the slugs differ. One row per project, claimed by a single atomic statement.
 */
export const specCounters = pgTable("spec_counters", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Highest id handed out. Seeded lazily from the caller's filesystem floor. */
  lastId: integer("last_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * SPEC §5 `AgentRun`: a fast-listing **projection** of a Temporal workflow
 * (SPEC §8 — the truth is in Temporal). Created here; the projection writer
 * that upserts these from live workflows lands in Phase D.
 */
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  task: text("task").notNull().default(""),
  /** The Temporal workflow this row projects. UNIQUE (spec 0088, migration
   * 0003) so the pipeline can upsert the same row at every phase transition —
   * one advancing row per run, never a duplicate per phase. */
  workflowId: text("workflow_id").notNull().unique(),
  status: text("status").notNull(),
  phase: text("phase").notNull().default(""),
  step: integer("step").notNull().default(0),
  totalSteps: integer("total_steps").notNull().default(0),
  /** The checkout this run worked in (spec 0131 C, migration 0010). A run on the
   * launchpad's own repo with no project link is indistinguishable from a real
   * platform run, which is why a wrong-repo run stayed invisible for an hour —
   * this is the field that tells them apart. `''` for rows written before it. */
  repoRoot: text("repo_root").notNull().default(""),
  /** The branch this run landed its commits on (spec 0133, migration 0011).
   * `''` for per-spec runs and rows written before the column — the promote
   * roll-up (spec 0136) uses it to find which specs rode a branch. */
  branch: text("branch").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per SPAWNED AGENT SESSION (spec 0194, migration 0015).
 *
 * `agentRuns` above is one row per WORKFLOW — it answers "where is this run",
 * never "what did it cost". So the question that decides whether the
 * initializer/coder split earns its keep (`docs/DECISIONS.md`, 2026-08-13)
 * could not be answered from our own database: `select workflow_id, agent,
 * count(*) from agent_runs` returns 1 for every run, by construction.
 *
 * Arithmetic only — no prompts, no handoff text, no content. Spec 0075's rule
 * for `audit_log` metadata applies here for the same reason, and every question
 * this exists for is a count or a duration.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NOT unique, unlike `agentRuns.workflowId` — many sessions per run is the
     * entire point of the table. */
    workflowId: text("workflow_id").notNull(),
    specId: text("spec_id").notNull().default(""),
    /** Null for platform runs, which have no project row. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    model: text("model").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
    seconds: integer("seconds").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    /** `undefined` on a subscription plan — the SDK only reports it in api-key
     * mode. Recorded because it is reported; never displayed as a bill. */
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
  },
  (t) => [index("agent_sessions_workflow_idx").on(t.workflowId, t.startedAt)],
);

// --- Phase B: chat tables folded in from apps/web chat-store (spec 0078) ----
// Physical names kept (`forge_threads`/`forge_messages` = SPEC §5
// `ChatThread`/`ChatMessage`). These were created by chat-store's bootstrap
// DDL (spec 0067); spec 0078 brings them under Drizzle + adds the SPEC §5
// `project_id` link (nullable now; populated in Phase C). See the idempotent
// `0002` migration, which ADOPTS the pre-existing tables rather than recreating.

/** SPEC §5 `ChatThread` (physical `forge_threads`). `sdkSessionId` pins the
 * Agent-SDK session for turn continuity; `projectId` is the SPEC link, null
 * until Phase C scopes threads to a project. */
export const forgeThreads = pgTable("forge_threads", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  sdkSessionId: text("sdk_session_id"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  /** The branch this thread operates over (spec 0133 migration / spec 0135
   * binding). Null for platform threads, which have no branch. */
  branch: text("branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** SPEC §5 `ChatMessage` (physical `forge_messages`). A `user` row stores its
 * prompt in `content`; an `assistant` row stores the ordered
 * `SupervisorEvent[]` in `events` (replay → card mapping). */
export const forgeMessages = pgTable(
  "forge_messages",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => forgeThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    events: jsonb("events"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("forge_messages_role_check", sql`${t.role} IN ('user', 'assistant')`)],
);

/**
 * One agent event, stored the moment it happens (spec 0127).
 *
 * `forge_messages.events` above holds a COMPLETED turn's event log, written once
 * in the route's `finally`. That gives a turn two states on disk — absent or
 * complete — so a browser that reconnects mid-turn has nothing to rejoin, and a
 * turn killed halfway leaves nothing at all. This table is the "in progress"
 * state: the run appends here as events arrive, and the client tails it.
 *
 * `(runId, seq)` is unique so a resumed tail is exact rather than
 * approximate — `sinceSeq` replays precisely what the client has not seen, with
 * no reliance on timestamps, which collide when tokens arrive in the same
 * millisecond.
 *
 * Deliberately NOT a second `forge_runs` table: whether a run is finished is
 * already implied by a terminal event (`result` / `error`) being present, and a
 * run that is neither terminal nor live in the process registry is exactly the
 * "interrupted by a restart" case the UI should report. One table, no
 * cross-table truth to keep in sync.
 */
export const forgeEvents = pgTable(
  "forge_events",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => forgeThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The tail's exactness guarantee, enforced by the database rather than by
    // the appending code being careful.
    uniqueIndex("forge_events_run_seq_key").on(t.runId, t.seq),
    // The tail's query shape: one run's events in order.
    index("forge_events_thread_run_seq_idx").on(t.threadId, t.runId, t.seq),
  ],
);

/**
 * A release: a version you can point at (spec 0170).
 *
 * Merging accepts a change into the trunk; shipping moves a VERSION of that
 * trunk onto a customer's live system. Only the first had a name, so gate 3
 * asked "promote?" with nothing to name — and every answer was a shrug.
 *
 * A merge to main creates a `candidate` automatically; deploying is a separate,
 * refusable decision about a NAMED version.
 */
export const projectReleases = pgTable(
  "project_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** "1.4.2" — three components. The Odoo series prefix (`18.0.`) is added at
     * render time from the project's own version, never stored. */
    version: text("version").notNull(),
    /** What the release IS. Immutable — a release that could later point
     * elsewhere makes "what is in production" unanswerable again. */
    commitSha: text("commit_sha").notNull(),
    notes: text("notes").notNull().default(""),
    /** candidate | deployed | superseded | failed */
    status: text("status").notNull().default("candidate"),
    createdBy: text("created_by").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deployedBy: text("deployed_by").notNull().default(""),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    /** Whatever the target returns to identify the deploy — an odoo.sh build id,
     * a stack name. Free text: each target names things its own way. */
    deployRef: text("deploy_ref").notNull().default(""),
  },
  (t) => [
    uniqueIndex("project_releases_project_version_uniq").on(t.projectId, t.version),
    // One candidate per commit: a replayed merge, or two merges landing the same
    // tree, must not produce two releases of the same thing.
    uniqueIndex("project_releases_project_sha_uniq").on(t.projectId, t.commitSha),
    index("project_releases_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

/**
 * A pending `AskUserQuestion` (spec 0220).
 *
 * The question used to live only in the Next process's `pendingQuestions` map,
 * so nothing outside the thread could say a run was waiting on a person — and
 * when the 15-minute timeout fired, nothing distinguished "the agent proceeded
 * alone" from "a human answered". This row is that fact, and its `resolution`
 * is the ending: a question has exactly four, and each exit path writes one.
 *
 * Never the answers or the option list — only a short summary of what was
 * asked (spec 0075's metadata rule).
 */
export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => forgeThreads.id, { onDelete: "cascade" }),
    /** Null for a platform thread, which has no project row. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** The signed-in email the turn was started by. Null where no path knows an
     * actor — the signal then shows to everyone on the project, never to
     * nobody (spec 0220 §4: fail visible). */
    askedOf: text("asked_of"),
    /** The question's header/text. NEVER the answers. */
    summary: text("summary").notNull().default(""),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** answered | expired | superseded | run_stopped — null while pending. */
    resolution: text("resolution"),
  },
  (t) => [
    // One PENDING question per thread — the invariant run-registry's map already
    // enforces in memory. Partial, not plain: a plain unique index would force
    // the next question to overwrite the row, erasing the `superseded` ending
    // that the very same insert creates.
    uniqueIndex("pending_questions_thread_pending_key")
      .on(t.threadId)
      .where(sql`${t.resolvedAt} IS NULL`),
    check(
      "pending_questions_resolution_check",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('answered', 'expired', 'superseded', 'run_stopped')`,
    ),
  ],
);
