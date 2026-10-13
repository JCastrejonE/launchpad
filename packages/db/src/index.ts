export {
  agentRuns,
  auditLog,
  forgeMessages,
  forgeThreads,
  health,
  pendingQuestions,
  projectBranches,
  projectKind,
  projects,
  secrets,
  specFiles,
  userRole,
  users,
  vps,
} from "./schema.js";
export { createDb, createPool, type Db } from "./client.js";
export { hashPassword, verifyPassword } from "./password.js";
// NOTE: ./migrate.js is deliberately NOT re-exported. Its
// `new URL("../drizzle", import.meta.url)` is correct in plain node (the
// migrate CLI) but webpack treats it as a bundle asset and fails `next build`
// the moment apps/web imports anything from this package root. Migrations run
// via `pnpm --filter @launchpad/db migrate`; workers import "./migrate.js"
// inside this package, never through the root.
export {
  ownerSeedValues,
  seedOwner,
  seedUser,
  userSeedValues,
  type OwnerSeed,
  type SeedRole,
  type UserSeed,
} from "./seed-owner.js";
export { findUserByEmail, linkGithubIdentity, type UserRow } from "./users.js";
export {
  PLATFORM_PROJECT,
  listProjects,
  createProject,
  DuplicateProjectSlugError,
  isValidProjectSlug,
  PRODUCTION_KINDS,
  projectById,
  projectBySlug,
  projectCounts,
  projectForTarget,
  projectIdBySlug,
  seedPlatformProject,
  setProjectRepoRoot,
  setProjectRepo,
  setProjectVpsId,
  upsertProject,
  type ProductionKind,
  type ProjectCounts,
  type ProjectCreate,
  type ProjectKind,
  type ProjectRow,
  type ProjectSeed,
} from "./projects.js";
// Spec 0128 A: project membership — the axis that makes a project belong to
// people, separate from users.role.
export {
  listProjectMembers,
  listProjectsFor,
  membershipFor,
  putProjectMember,
  removeProjectMember,
  userIdsByEmail,
  type ProjectMemberRole,
  type ProjectMemberRow,
} from "./project-members.js";
// Spec 0133 A: branches as a first-class thing — the odoo.sh model's registry.
export {
  branchByName,
  clearBranchStaging,
  createProjectBranch,
  DuplicateBranchError,
  listBranchesForProject,
  markBranchMerged,
  rollUpPromotedSpecs,
  setBranchPr,
  setBranchStaging,
  type BranchStagingStatus,
  type ProjectBranchRow,
} from "./project-branches.js";
// Spec 0129 A: the durable record of a spec whose file is excluded from the
// customer's repository.
export {
  listSpecFilesForProject,
  specFileByName,
  specFileBySpecId,
  upsertSpecFile,
  type SpecFileRow,
  type SpecFileUpsert,
} from "./spec-files.js";
export { auditEntryValues, insertAuditLog, type AuditEntry } from "./audit.js";
export {
  DEFAULT_KEY_ID,
  SECRET_MASTER_KEY_ENV,
  SecretConfigError,
  dbSecretStore,
  decryptSecret,
  encryptSecret,
  envSecretStore,
  getSecret,
  loadSecretMasterKey,
  putSecret,
  type SecretCipherParts,
  type SecretStore,
} from "./secret-store.js";
export {
  agentRunValues,
  listAgentRuns,
  upsertAgentRun,
  recordedWorkflowIdForSpec,
  type AgentRunRow,
  type AgentRunUpsert,
} from "./agent-runs.js";
export {
  recordAgentSession,
  sessionsForWorkflow,
  sessionRollup,
  type AgentSessionRecord,
  type AgentSessionRow,
  type SessionRollupRow,
} from "./agent-sessions.js";
export {
  listUnresolvedPendingQuestions,
  openPendingQuestion,
  resolvePendingQuestion,
  type PendingQuestionOpen,
  type PendingQuestionRow,
  type QuestionResolution,
} from "./pending-questions.js";
export { repoIdentityFor, githubSlugFor } from "./repo-identity.js";

export * from "./spec-counters.js";
export * from "./releases.js";
