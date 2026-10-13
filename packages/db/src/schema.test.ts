import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  agentRuns,
  auditLog,
  health,
  projectKind,
  projects,
  secrets,
  specFiles,
  userRole,
  users,
  vps,
} from "./schema.js";

test("users table shape (SPEC §5 User + password_hash)", () => {
  assert.equal(getTableName(users), "users");
  const cols = getTableColumns(users);
  assert.deepEqual(
    Object.keys(cols).sort(),
    // githubLogin/githubId added by spec 0128 B — the identity that claimed the row.
    ["createdAt", "email", "githubId", "githubLogin", "id", "name", "passwordHash", "role"],
  );
  assert.equal(cols.email.notNull, true);
  assert.equal(cols.passwordHash.notNull, false, "password_hash must stay nullable (OAuth/passkey users)");
  assert.equal(cols.role.default, "MEMBER");
  // Spec 0128 B: NULL until first GitHub sign-in, so every password-authenticated
  // row keeps working while both providers coexist.
  assert.equal(cols.githubLogin.notNull, false);
  assert.equal(cols.githubId.notNull, false);
});

test("user_role enum carries the SPEC §13 roles", () => {
  assert.deepEqual([...userRole.enumValues], ["OWNER", "MEMBER", "VIEWER"]);
});

test("audit_log table shape (SPEC §5 AuditLog)", () => {
  assert.equal(getTableName(auditLog), "audit_log");
  const cols = getTableColumns(auditLog);
  assert.deepEqual(
    Object.keys(cols).sort(),
    ["action", "actor", "createdAt", "id", "metadata", "target"],
  );
  for (const key of ["actor", "action", "target", "metadata"] as const) {
    assert.equal(cols[key].notNull, true, `${key} must be NOT NULL`);
  }
});

test("secrets table shape (SPEC §13 minimal store; crypto in 0076)", () => {
  assert.equal(getTableName(secrets), "secrets");
  const cols = getTableColumns(secrets);
  assert.deepEqual(
    Object.keys(cols).sort(),
    ["ciphertext", "createdAt", "iv", "keyId", "name", "tag", "updatedAt"],
  );
  assert.equal(cols.name.primary, true);
});

// --- Phase B: Project model (spec 0077, SPEC §5) ---------------------------

test("project_kind + health enums carry the SPEC §5 values", () => {
  assert.deepEqual([...projectKind.enumValues], ["odoo", "odoo_next", "custom", "platform"]);
  assert.deepEqual([...health.enumValues], ["operational", "degraded", "down", "building"]);
});

test("projects table shape (SPEC §5 Project)", () => {
  assert.equal(getTableName(projects), "projects");
  const cols = getTableColumns(projects);
  assert.deepEqual(
    Object.keys(cols).sort(),
    // repoOwner/repoName/repoRoot added by spec 0116 — a Project addresses its own
    // GitHub repository, so one Launchpad can serve a customer's two repos.
    // productionKind/productionHost added by spec 0126 — where it ships to.
    // intake added by spec 0191 — the five wizard answers, which until then were
    // collected and dropped on submit.
    ["accent", "client", "createdAt", "description", "domain", "health", "id", "intake", "kind", "name", "productionHost", "productionKind", "region", "repoName", "repoOwner", "repoRoot", "slug", "stack", "version", "vpsId"],
  );
  // Spec 0126: nullable for the same reason as the repo columns — a pre-0126 row
  // has no RECORDED target, which is not the same claim as `'none'`.
  assert.equal(cols.productionKind.notNull, false);
  assert.equal(cols.productionHost.notNull, false);
  assert.equal(cols.slug.isUnique, true, "slug must be unique");
  assert.equal(cols.kind.notNull, true);
  assert.equal(cols.health.default, "operational");
  assert.equal(cols.domain.notNull, false, "domain is optional (SPEC §5)");
  // Spec 0191: NOT NULL with a `{}` default — a project with no answers has an
  // empty intake, which is a different thing from an unknown one.
  assert.equal(cols.intake.notNull, true);
  // Spec 0116: nullable on purpose. Every pre-0116 row has no repo, and the platform
  // project's repo genuinely IS `LAUNCHPAD_REPO_ROOT` — so the fallback in
  // `repoIdentityFor` is the permanent answer for it, not a migration shim.
  for (const c of ["repoOwner", "repoName", "repoRoot"] as const) {
    assert.equal(cols[c].notNull, false, `${c} must stay optional`);
  }
});

test("vps table shape (SPEC §5 Vps)", () => {
  assert.equal(getTableName(vps), "vps");
  const cols = getTableColumns(vps);
  assert.deepEqual(
    Object.keys(cols).sort(),
    ["assignedTo", "docker", "externalId", "id", "ip", "label", "os", "plan", "provider", "region", "status"],
  );
  assert.equal(cols.provider.default, "hostinger");
  assert.equal(cols.docker.default, false);
});

test("spec_files projection (SPEC §5 SpecFile; status is free text)", () => {
  assert.equal(getTableName(specFiles), "spec_files");
  const cols = getTableColumns(specFiles);
  assert.deepEqual(
    Object.keys(cols).sort(),
    ["author", "body", "chatId", "id", "name", "projectId", "status", "updatedAt", "version"],
  );
  assert.equal(cols.projectId.notNull, true);
  assert.equal(cols.chatId.notNull, false);
});

test("agent_runs projection (SPEC §5 AgentRun / §8 Temporal projection)", () => {
  assert.equal(getTableName(agentRuns), "agent_runs");
  const cols = getTableColumns(agentRuns);
  assert.deepEqual(
    Object.keys(cols).sort(),
    // repoRoot added by spec 0131 C (migration 0010) — which checkout the run
    // worked in, the fact that tells a fallback apart from a platform run.
    // branch added by spec 0133 (migration 0011) — which branch the run's
    // commits landed on; '' for per-spec runs.
    ["agent", "branch", "id", "phase", "projectId", "repoRoot", "startedAt", "status", "step", "task", "totalSteps", "workflowId"],
  );
  assert.equal(cols.projectId.notNull, true);
  assert.equal(cols.workflowId.notNull, true);
  assert.equal(cols.repoRoot.notNull, true);
  assert.equal(cols.branch.notNull, true);
});
