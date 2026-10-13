/**
 * GitHub REST API client for the launchpad's OWN repo (spec 0015 / ADR-012).
 *
 * This is the launchpad-repo dev path: authenticated with a fine-grained
 * Personal Access Token (`GITHUB_TOKEN`, contents + pull-requests read/write),
 * not the GitHub App/installation flow — that stays Phase 4 for client repos
 * (see the App stubs in index.ts). Same discipline as the Hostinger client
 * (fleet-hostinger/client.ts): an injectable `fetch` so contract tests run with
 * zero network, shapes verified against the current GitHub REST docs, and the
 * token is set ONLY in the Authorization header and never placed in a thrown
 * message or fixture.
 *
 * Docs: https://docs.github.com/en/rest/pulls and .../rest/checks/runs.
 * Endpoints used (verified against current docs):
 *  - POST   /repos/{owner}/{repo}/pulls                 (openPr)
 *  - GET    /repos/{owner}/{repo}/pulls/{n}             (getPrState: state/merged/mergeable/head sha)
 *  - GET    /repos/{owner}/{repo}/pulls/{n}/reviews     (getPrState: review decision + approver)
 *  - GET    /repos/{owner}/{repo}/commits/{sha}/check-runs  (getPrState: checks conclusion)
 *  - PUT    /repos/{owner}/{repo}/pulls/{n}/merge       (mergePr, merge-commit method)
 *  - PATCH  /repos/{owner}/{repo}/pulls/{n}             (closePr: state=closed)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { classifyHttpStatus, GithubApiError } from "./errors.js";
import { interpretRepoAccess, REPO_ABSENT, type RawRepo, type RepoAccess } from "./repo-access.js";
import {
  COLLABORATOR_UNKNOWN,
  interpretCollaboratorPermission,
  type CollaboratorAccess,
  type RawCollaboratorPermission,
} from "./collaborator.js";

/**
 * Injectable fetch, so contract tests run with zero network access. Defaults to
 * the global `fetch` in production. A subset of the WHATWG fetch signature —
 * identical to the Hostinger client's `FetchFn` for consistency.
 */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** The default GitHub REST API base URL. */
export const DEFAULT_BASE_URL = "https://api.github.com";
/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default retry bound for retryable failures (429/5xx/network/timeout). */
export const DEFAULT_MAX_RETRIES = 3;
/** Default base backoff delay (ms) between retries (doubles each attempt). */
export const DEFAULT_RETRY_BASE_DELAY_MS = 200;

export interface GithubConfig {
  /** Fine-grained PAT from GITHUB_TOKEN. Never logged or thrown. */
  token: string;
  owner: string;
  repo: string;
  /** Default https://api.github.com. */
  baseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: FetchFn;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

/** Request to open a pull request (`spec/NNNN` → `main`). */
export interface OpenPrRequest {
  /** Head branch, e.g. `spec/0016`. */
  head: string;
  /** Base branch, e.g. `main`. */
  base: string;
  title: string;
  /** Rendered PR body (spec 0006: stall note + human-pending checklist). */
  body: string;
  /**
   * Open it as a DRAFT (spec 0142). A branch PR accumulates work over many
   * runs, and in the branch model merging it IS the promote — so a ready PR
   * leaves a live merge button in GitHub that bypasses our promote gate
   * entirely: no attestation, no staging-freshness check, no roll-up, no audit
   * row. GitHub disables merge on a draft, so `promote` marks it ready and
   * then merges. Absent/false keeps the per-spec model's ready PR.
   */
  draft?: boolean;
}

/** A pull request the launchpad opened. */
export interface GithubPrRef {
  number: number;
  /** `html_url` — the human-facing PR page. */
  url: string;
}

/**
 * GitHub's PR review decision, as surfaced to gate 2. `approved` is the
 * gate-2-satisfying value; `null` means no decisive review yet.
 */
export type PrReviewDecision = "approved" | "changes_requested" | "review_required" | null;

/**
 * Aggregate CI conclusion for the PR head SHA. `success` (all required checks
 * green) is the gate-2-satisfying value; `pending` while Actions still runs.
 */
export type PrChecksConclusion = "success" | "failure" | "pending";

/**
 * One GitHub **commit status** (spec 0115).
 *
 * A different API from the Checks/Actions runs `aggregateChecks` reads:
 * `getCommitChecksConclusion` asks `actions/runs`, which only ever sees GitHub
 * Actions. odoo.sh is an external service and reports through the older Status
 * API, one entry per `context` — `ci/odoo.sh` for its builds. Reading the wrong
 * endpoint would report "pending" forever on a repo where odoo.sh is working
 * perfectly, because no Actions run exists.
 */
export interface CommitStatus {
  /** GitHub's four states. `error` is distinct from `failure` in the API; both
   * mean the build did not succeed, and the caller decides whether it cares. */
  state: "success" | "pending" | "failure" | "error";
  context: string;
  /** odoo.sh puts human text here (e.g. the build phase). Absent is normal. */
  description: string | null;
  /** Link to the build, when the reporter supplies one. */
  targetUrl: string | null;
}

interface RawCommitStatus {
  state?: string;
  context?: string;
  description?: string | null;
  target_url?: string | null;
}

/**
 * The CURRENT status for one context, or `null` when that context has never
 * reported on this commit.
 *
 * `GET /commits/{ref}/statuses` returns entries newest-first, so the first match
 * for a context is the live one — a commit that went pending → success has two
 * entries and only the newest is true. Pure and exported so that rule is testable
 * without a request.
 *
 * `null` is a first-class answer, NOT an error and NOT "pending": for odoo.sh,
 * absent means it has not reported at all (repo not connected, build not created
 * yet), which is a different fact from "a build is running". Conflating them is
 * how a UI ends up claiming a build exists when none does.
 */
export function latestStatusForContext(
  statuses: readonly CommitStatus[],
  context: string,
): CommitStatus | null {
  return statuses.find((s) => s.context === context) ?? null;
}

/**
 * The gate-2 view of a PR, read by the pipeline's `awaitPrApproval` poll.
 * `merged`/`state` distinguish the rejection path (closed WITHOUT merge) from a
 * successful merge.
 */
export interface PrState {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  /** GitHub's mergeability flag; `null` while it is still being computed. */
  mergeable: boolean | null;
  reviewDecision: PrReviewDecision;
  checks: PrChecksConclusion;
  /** Login of the reviewer whose approving review satisfies gate 2, else null. */
  approvedBy: string | null;
  /**
   * Login from the pull's `merged_by` (ADR-016 / spec 0019): on a solo repo the
   * human merging the PR is the gate-2 approval act, so this names who merged.
   * `null` when the PR isn't merged (or GitHub omits `merged_by`).
   */
  mergedBy: string | null;
  /**
   * The merge commit's SHA on the base branch (spec 0043): populated once the
   * PR is merged, `null` beforehand (or if GitHub omits the field) — mirrors
   * `mergedBy`'s absent-vs-null handling. This is the commit gate 3's promote
   * guard checks CI against (the thing actually being promoted), not the PR
   * branch's head SHA used by gate 2's `checks` above.
   */
  mergeCommitSha: string | null;
}

/** Raw shape (subset) of `GET/PATCH /repos/{owner}/{repo}/pulls/{n}` and the `POST` create response. */
interface RawPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  /**
   * Present (non-null) once the PR is merged; absent/null otherwise. GitHub
   * omits the key entirely on some responses, so `mergedBy` mapping treats
   * "absent" and "explicit null" the same (ADR-016 / spec 0019).
   */
  merged_by?: { login: string } | null;
  /**
   * Present (non-null) once the PR is merged; absent/null otherwise — same
   * absent-vs-null treatment as `merged_by` (spec 0043).
   */
  merge_commit_sha?: string | null;
  head: { sha: string };
}

/** Raw shape (subset) of one entry in `GET .../pulls/{n}/reviews`. */
interface RawReview {
  user: { login: string } | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at: string | null;
}

/**
 * Raw shape (subset) of `GET /repos/{owner}/{repo}/actions/runs?head_sha=...`
 * (List workflow runs for a repository, filtered to the PR head SHA).
 * ADR-014 hand-fix: fine-grained PATs CANNOT read Actions-produced
 * check-runs (`GET /commits/{sha}/check-runs` → 403 "Resource not
 * accessible by personal access token"), so the CI conclusion is read from
 * the Actions runs API instead — readable with the PAT's Actions:read
 * permission. Verified against the current GitHub REST docs (status:
 * queued/in_progress/completed and more; anything not "completed" is
 * treated as still running).
 */
interface RawWorkflowRunsResponse {
  total_count: number;
  workflow_runs: Array<{
    id: number;
    workflow_id: number;
    status: string;
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "startup_failure"
      | "stale"
      | null;
  }>;
}

/** Raw shape (subset) of `PUT .../pulls/{n}/merge`. */
interface RawMergeResult {
  merged: boolean;
  message: string;
  /** The merge commit. Spec 0170 needs it: a release candidate points at the
   * commit main moved TO, and reading it back from the merge response beats
   * re-querying the branch head, which may already have moved again. */
  sha?: string;
}

/** Raw shape (subset) of `GET .../git/ref/heads/{branch}` and the `POST .../git/refs` response. */
interface RawGitRef {
  object?: { sha?: string };
}

/**
 * Request to create a repo inside an org — spec 0148 phase A.
 *
 * Gate-1 (open question 2) measured `example-org` and found NO template repo
 * (`is_template: false` on all seven), so this is the plain
 * `POST /orgs/{org}/repos` create, NOT `POST /repos/{template}/generate`.
 */
export interface CreateRepoInOrgRequest {
  org: string;
  name: string;
  /** Spec 0148 provisions PRIVATE repos; pass explicitly rather than defaulting. */
  private: boolean;
  description?: string;
}

/**
 * The created repo, mapped from GitHub's OWN response body (VERIFICATION #1:
 * the test must assert what the API returned, not the payload we sent). These
 * are the fields phase A needs downstream: `fullName` = `<org>/<name>` for the
 * `projects` row, `cloneUrl`/`sshUrl` for the worker clone.
 */
export interface CreatedRepo {
  id: number;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  defaultBranch: string;
}

/** Raw shape (subset) of `POST /orgs/{org}/repos` — GitHub's `Repository`. */
interface RawCreatedRepo {
  id?: number;
  full_name?: string;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
  private?: boolean;
  default_branch?: string;
}

/**
 * Request to commit ONE file into an arbitrary repo — spec 0148 phase E
 * (branding upload). Explicit `owner`/`name` because the target is the project's
 * front repo (created in phase A), not the launchpad repo this client's `cfg`
 * points at — same posture as `createRepoInOrg`/`getRepoAccess`.
 */
export interface CommitFileToRepoRequest {
  owner: string;
  name: string;
  /** Repo-relative path, e.g. `public/logo.png`. `/` stays path structure. */
  path: string;
  /** File bytes, base64-encoded — what the Contents API expects as `content`. */
  contentBase64: string;
  message: string;
  /** Target branch; omit for the repo's default branch. */
  branch?: string;
}

/**
 * The commit that landed the file, mapped from GitHub's RESPONSE — never the
 * payload we sent (VERIFICATION #1: phase E asserts the commit in the repo, not
 * the upload response). `commitSha` is the commit actually created.
 */
export interface CommittedFile {
  commitSha: string;
  /** `commit.html_url` — the human-facing commit page (for audit/progress UI). */
  commitUrl: string;
}

/** Raw shape (subset) of `PUT /repos/{owner}/{repo}/contents/{path}`. */
interface RawContentsWrite {
  commit?: { sha?: string; html_url?: string } | null;
}

/**
 * Reduces the reviews list to a gate-2 decision: the most recent
 * APPROVED/CHANGES_REQUESTED review per user wins (COMMENTED/DISMISSED/PENDING
 * are not decisive and are ignored), then:
 *  - any latest CHANGES_REQUESTED  -> "changes_requested"
 *  - else any latest APPROVED      -> "approved" (approvedBy = that reviewer)
 *  - else                          -> null (no decisive review yet)
 * This mirrors GitHub's own reviewDecision semantics closely enough for a
 * single-required-reviewer repo; `"review_required"` is reserved for a future
 * branch-protection-aware check and is never produced here.
 */
function reduceReviewDecision(reviews: RawReview[]): {
  reviewDecision: PrReviewDecision;
  approvedBy: string | null;
} {
  const decisive = reviews.filter(
    (r): r is RawReview & { user: { login: string } } =>
      r.user !== null && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"),
  );
  // Stable-sort ascending by submission time so the LAST entry per login (via
  // the Map below) is that reviewer's most recent decisive review.
  const sorted = [...decisive].sort((a, b) => {
    const ta = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const tb = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return ta - tb;
  });
  const latestByLogin = new Map<string, RawReview & { user: { login: string } }>();
  for (const review of sorted) {
    latestByLogin.set(review.user.login, review);
  }
  const latest = [...latestByLogin.values()];

  if (latest.some((r) => r.state === "CHANGES_REQUESTED")) {
    return { reviewDecision: "changes_requested", approvedBy: null };
  }
  const approvals = latest.filter((r) => r.state === "APPROVED");
  if (approvals.length > 0) {
    // Most recently-submitted approval decides who satisfied gate 2.
    const mostRecent = approvals.reduce((a, b) =>
      (a.submitted_at ? Date.parse(a.submitted_at) : 0) >=
      (b.submitted_at ? Date.parse(b.submitted_at) : 0)
        ? a
        : b,
    );
    return { reviewDecision: "approved", approvedBy: mostRecent.user.login };
  }
  return { reviewDecision: null, approvedBy: null };
}

/**
 * Aggregates Actions workflow runs for the PR head SHA into the gate-2
 * checks conclusion — SAME semantics as the previous check-runs
 * aggregation: no runs at all (Actions hasn't reported yet) → "pending";
 * any run not yet completed → "pending"; success only if every completed
 * run's conclusion is success/neutral/skipped; else "failure".
 * The launchpad repo has a single CI workflow, so all runs returned for
 * the head_sha are aggregated directly (no latest-per-workflow_id
 * dedupe); if a workflow is re-run, GitHub returns the re-run with the
 * same head_sha and the aggregate still reflects reality. Revisit if a
 * second workflow is ever added.
 */
function aggregateChecks(
  workflowRuns: RawWorkflowRunsResponse["workflow_runs"],
): PrChecksConclusion {
  if (workflowRuns.length === 0) return "pending";
  if (workflowRuns.some((r) => r.status !== "completed")) return "pending";
  const allGreen = workflowRuns.every(
    (r) => r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped",
  );
  return allGreen ? "success" : "failure";
}

/**
 * True when a failed `POST /orgs/{org}/repos` is a NAME COLLISION rather than
 * any other 422. GitHub's top-level `message` is generic ("Repository creation
 * failed."); the distinguishing detail is an `errors[]` entry on the `name`
 * field whose message says the name already exists. Reading only the top-level
 * message would conflate a collision with a blank/invalid name (spec 0148 A).
 */
function isRepoNameTaken(err: GithubApiError): boolean {
  if (err.status !== 422) return false;
  const body = err.body;
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    if (!e || typeof e !== "object") return false;
    const field = (e as { field?: unknown }).field;
    const message = (e as { message?: unknown }).message;
    return field === "name" && typeof message === "string" && /already exists/i.test(message);
  });
}

export class GithubClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly cfg: GithubConfig) {
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = cfg.fetch ?? (globalThis.fetch as FetchFn);
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = cfg.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  /**
   * Bounded retry/backoff around a single `attemptRequest`. Retries only
   * failures classified as retryable (429/5xx/network/timeout — see
   * errors.ts), up to `maxRetries` additional attempts, with exponential
   * backoff (`retryBaseDelayMs * 2^attempt`). Non-retryable failures (other
   * 4xx, auth, not_found) throw on the first attempt. Every method routes
   * through here.
   */
  private async request<T>(
    method: string,
    pathname: string,
    init?: { body?: unknown },
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attemptRequest<T>(method, pathname, init);
      } catch (err) {
        const canRetry = err instanceof GithubApiError && err.retryable && attempt < this.maxRetries;
        if (!canRetry) throw err;
        await this.delay(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return sleep(ms);
  }

  /**
   * Single request attempt: Bearer auth, JSON parse, timeout via
   * AbortController, status→typed-error mapping (see errors.ts). The token is
   * set only in the Authorization header and must never be placed in a thrown
   * message. `request` above wraps this in bounded retry/backoff.
   */
  private async attemptRequest<T>(
    method: string,
    pathname: string,
    init?: { body?: unknown },
  ): Promise<T> {
    const url = `${this.baseUrl}/${pathname.replace(/^\//, "")}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "AbortError";
      if (isAbort) {
        throw new GithubApiError(
          "timeout",
          `GitHub API request timed out after ${this.timeoutMs}ms`,
          { retryable: true, cause },
        );
      }
      throw new GithubApiError("network", "GitHub API request failed (network error)", {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined; // non-JSON body (e.g. an upstream gateway error page)
      }
    }

    if (response.ok) {
      return parsed as T;
    }

    const { kind, retryable } = classifyHttpStatus(response.status);
    let message = `GitHub API request failed with status ${response.status}`;
    if (parsed && typeof parsed === "object") {
      const candidate = (parsed as { message?: unknown }).message;
      if (typeof candidate === "string") message = candidate;
    }
    throw new GithubApiError(kind, message, { status: response.status, retryable, body: parsed });
  }

  /** POST /repos/{owner}/{repo}/pulls — open spec/NNNN → base. */
  async openPr(req: OpenPrRequest): Promise<GithubPrRef> {
    const pull = await this.request<RawPull>(
      "POST",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls`,
      {
        body: {
          title: req.title,
          head: req.head,
          base: req.base,
          body: req.body,
          // Only send the field when asked: some repo types reject `draft` and
          // the per-spec model must keep opening ready PRs.
          ...(req.draft ? { draft: true } : {}),
        },
      },
    );
    return { number: pull.number, url: pull.html_url };
  }

  /**
   * Take a draft PR out of draft so it can be merged (spec 0142).
   *
   * GitHub exposes this only through GraphQL (`markPullRequestReadyForReview`);
   * the REST `PATCH .../pulls/{n}` silently ignores a `draft` field, which is
   * the failure mode this comment exists to prevent — a promote that "succeeded"
   * against a PR still marked draft, then failed to merge for no visible reason.
   */
  async markPrReadyForReview(number: number): Promise<void> {
    const pull = await this.request<RawPull & { node_id?: string }>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${number}`,
    );
    const nodeId = pull.node_id;
    if (!nodeId) throw new Error(`PR #${number}: no node_id, cannot mark ready for review`);
    await this.request<unknown>("POST", "graphql", {
      body: {
        query:
          "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}",
        variables: { id: nodeId },
      },
    });
  }

  /**
   * Reads the gate-2 view of a PR: PR state/merged/mergeable, the review
   * decision + approver login, and the head SHA's aggregate check conclusion.
   */
  async getPrState(number: number): Promise<PrState> {
    const pull = await this.request<RawPull>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${number}`,
    );
    const reviews = await this.request<RawReview[]>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${number}/reviews`,
    );
    const workflowRuns = await this.request<RawWorkflowRunsResponse>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/actions/runs?head_sha=${pull.head.sha}`,
    );
    const { reviewDecision, approvedBy } = reduceReviewDecision(reviews);
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      mergeable: pull.mergeable,
      reviewDecision,
      checks: aggregateChecks(workflowRuns.workflow_runs),
      approvedBy,
      mergedBy: pull.merged_by?.login ?? null,
      mergeCommitSha: pull.merge_commit_sha ?? null,
    };
  }

  /**
   * Reads the gate-3 promote-guard signal (spec 0043): the aggregate CI
   * conclusion for a given commit SHA — the merge commit on `main`, i.e. the
   * commit actually being promoted, NOT the PR branch head `getPrState`
   * checks for gate 2. Reuses the EXISTING `aggregateChecks` (do not modify —
   * gate 2 depends on its current semantics): notably, an empty
   * `workflow_runs` array (client.ts:239) reads "pending", never a vacuous
   * "success" — so a merge commit whose main-push run has not been created
   * yet correctly blocks promotion instead of falsely allowing it.
   */
  async getCommitChecksConclusion(sha: string): Promise<PrChecksConclusion> {
    const workflowRuns = await this.request<RawWorkflowRunsResponse>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/actions/runs?head_sha=${sha}`,
    );
    return aggregateChecks(workflowRuns.workflow_runs);
  }

  /**
   * Does this repo define ANY Actions workflow at all? (spec 0167)
   *
   * `GET /repos/{owner}/{repo}/actions/workflows` — a property of the REPO, not
   * of a commit, which is the whole point. `aggregateChecks` answers "pending"
   * both when a repo has no CI and when its runs merely have not appeared yet,
   * and gate 2 waits for `success`, so a customer repo with no `.github/workflows`
   * can never satisfy the gate: approving its PR does nothing and the run polls
   * forever. Asking the repo separates the two cases definitively — a repo WITH
   * workflows reports `total_count > 0` even before any run for this SHA exists,
   * so this cannot be fooled by a reviewer who approves faster than Actions
   * registers.
   */
  async hasAnyWorkflows(): Promise<boolean> {
    const res = await this.request<{ total_count: number }>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/actions/workflows`,
    );
    return res.total_count > 0;
  }

  /**
   * Paths in the tree at `ref` (spec 0170).
   *
   * Used to find every `__manifest__.py` at a specific COMMIT, which is what a
   * release's version is read from. Asking GitHub rather than a local checkout is
   * deliberate: the checkout's state is whatever the last operation left, while
   * the question is "what did the manifest say at this commit".
   *
   * `truncated` is surfaced rather than ignored — a repo big enough to truncate
   * would silently lose addons, and a release version read from a partial tree
   * would be wrong in the one way that matters.
   */
  async listTreePaths(ref: string): Promise<{ paths: string[]; truncated: boolean }> {
    const raw = await this.request<{
      tree?: { path?: string; type?: string }[];
      truncated?: boolean;
    }>("GET", `repos/${this.cfg.owner}/${this.cfg.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const paths = (raw.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path as string);
    return { paths, truncated: raw.truncated === true };
  }

  /** UTF-8 contents of one file at `ref`, or null when it is not there. */
  async getFileText(path: string, ref: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const raw = await this.request<{ content?: string; encoding?: string }>(
        "GET",
        `repos/${this.cfg.owner}/${this.cfg.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      );
      if (!raw.content) return null;
      return Buffer.from(raw.content, (raw.encoding as BufferEncoding) ?? "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GithubApiError && err.kind === "not_found") return null;
      throw err;
    }
  }

  /** PUT /repos/{owner}/{repo}/pulls/{n}/merge — merge-commit (preserves --no-ff history). */
  /** Merges, and returns the merge commit sha (`""` when GitHub omits it). */
  async mergePr(number: number): Promise<string> {
    const result = await this.request<RawMergeResult>(
      "PUT",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${number}/merge`,
      { body: { merge_method: "merge" } },
    );
    if (!result.merged) {
      throw new GithubApiError("client", `GitHub declined to merge PR #${number}: ${result.message}`, {
        retryable: false,
      });
    }
    return result.sha ?? "";
  }

  /**
   * GET /repos/{owner}/{repo}/commits/{sha}/statuses — every commit status on a
   * SHA, newest first (spec 0115).
   *
   * Thin on purpose: it maps the raw payload and nothing else. Which context
   * matters, and what a state means for a deploy, are decisions for
   * `latestStatusForContext` and the pipeline's odoo.sh reader — this package
   * stays generic about who is reporting.
   *
   * An unknown `state` string is preserved rather than coerced: GitHub adding a
   * fifth state should surface as "we do not recognise this", not silently become
   * a success.
   */
  async getCommitStatuses(sha: string): Promise<CommitStatus[]> {
    const raw = await this.request<RawCommitStatus[]>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/commits/${sha}/statuses`,
    );
    return (raw ?? []).map((s) => ({
      state: (s.state ?? "pending") as CommitStatus["state"],
      context: s.context ?? "",
      description: s.description ?? null,
      targetUrl: s.target_url ?? null,
    }));
  }

  /**
   * GET /repos/{owner}/{repo} for an ARBITRARY repo — spec 0126 B, project
   * linking. Explicit owner/name rather than `this.cfg`, because the question is
   * about a repo the launchpad does not own yet.
   *
   * A 404 is an ANSWER, not a failure: GitHub 404s a private repo the token
   * cannot see rather than admitting it exists, and "I cannot use this repo" is
   * exactly what the caller asked. Every other error still throws — a rate limit
   * or a network timeout must not be reported to a user as "that repo does not
   * exist".
   */
  async getRepoAccess(owner: string, name: string): Promise<RepoAccess> {
    try {
      const raw = await this.request<RawRepo>("GET", `repos/${owner}/${name}`);
      return interpretRepoAccess(raw ?? {});
    } catch (err) {
      if (err instanceof GithubApiError && err.kind === "not_found") return REPO_ABSENT;
      throw err;
    }
  }

  /**
   * POST /orgs/{org}/repos — create a private repo in an org (spec 0148 A).
   *
   * Maps GitHub's RESPONSE body into `CreatedRepo` — never the payload we sent
   * (VERIFICATION #1). `POST /orgs/{org}/repos` never overwrites: a name that is
   * already taken comes back as a 422 whose `errors[]` says so, which is
   * re-thrown as a DISTINCT `name_taken` error the wizard can tell apart from
   * other body-validation 422s (a blank name, etc.).
   */
  async createRepoInOrg(req: CreateRepoInOrgRequest): Promise<CreatedRepo> {
    let raw: RawCreatedRepo;
    try {
      raw = await this.request<RawCreatedRepo>("POST", `orgs/${req.org}/repos`, {
        body: {
          name: req.name,
          private: req.private,
          ...(req.description !== undefined ? { description: req.description } : {}),
        },
      });
    } catch (err) {
      if (err instanceof GithubApiError && isRepoNameTaken(err)) {
        throw new GithubApiError(
          "name_taken",
          `A repository named "${req.name}" already exists in "${req.org}"`,
          { status: err.status, retryable: false },
        );
      }
      throw err;
    }
    return {
      id: raw.id ?? 0,
      fullName: raw.full_name ?? "",
      htmlUrl: raw.html_url ?? "",
      cloneUrl: raw.clone_url ?? "",
      sshUrl: raw.ssh_url ?? "",
      private: raw.private ?? false,
      defaultBranch: raw.default_branch ?? "",
    };
  }

  /**
   * PUT /repos/{owner}/{repo}/contents/{path} — commit ONE file into an
   * arbitrary repo (spec 0148 phase E, branding upload). The Contents API is the
   * single-call path (no blob/tree/ref dance) — right for one logo.
   *
   * Returns the commit mapped from GitHub's RESPONSE (`commit.sha`), never the
   * payload we sent (VERIFICATION #1). Creates the file; an update that omits the
   * existing blob `sha` fails with a 422, which surfaces as a plain client error
   * rather than being papered over — a re-upload is out of phase E's scope.
   *
   * Path segments are encoded individually so a filename's own characters are
   * escaped while `/` stays path structure (same as `getBranchHeadSha`).
   */
  async commitFileToRepo(req: CommitFileToRepoRequest): Promise<CommittedFile> {
    const path = req.path.split("/").map(encodeURIComponent).join("/");
    const raw = await this.request<RawContentsWrite>(
      "PUT",
      `repos/${req.owner}/${req.name}/contents/${path}`,
      {
        body: {
          message: req.message,
          content: req.contentBase64,
          ...(req.branch !== undefined ? { branch: req.branch } : {}),
        },
      },
    );
    return {
      commitSha: raw.commit?.sha ?? "",
      commitUrl: raw.commit?.html_url ?? "",
    };
  }

  /**
   * What permission `username` holds on a repo — spec 0128 C, asked with THIS
   * client's (server) token rather than the user's, so user tokens never need the
   * `repo` scope. See collaborator.ts for why that matters.
   *
   * A 404 means the server token cannot see the repo (or the user is not a
   * collaborator at all) and is returned as UNKNOWN, never as "no access":
   * telling someone they lack permission when we could not check would send them
   * to argue with a repo owner about a problem that is ours.
   */
  async getCollaboratorPermission(
    owner: string,
    name: string,
    username: string,
  ): Promise<CollaboratorAccess> {
    try {
      const raw = await this.request<RawCollaboratorPermission>(
        "GET",
        `repos/${owner}/${name}/collaborators/${username}/permission`,
      );
      return interpretCollaboratorPermission(raw ?? {}, username);
    } catch (err) {
      if (err instanceof GithubApiError && (err.kind === "not_found" || err.kind === "auth")) {
        return COLLABORATOR_UNKNOWN;
      }
      throw err;
    }
  }

  /** PATCH /repos/{owner}/{repo}/pulls/{n} with state=closed — the rejection path. */
  /**
   * POST /repos/{owner}/{repo}/statuses/{sha} — publish a commit status
   * (spec 0228 A).
   *
   * This is how CI reports here. We do not use GitHub Actions: the account's
   * Actions billing is locked, and a self-hosted runner does not bypass that —
   * but a probe on 2026-08-19 showed the Status API answers 201 under the same
   * lock, which is why this path exists at all. The gate runs on our own
   * infrastructure and reports through here.
   *
   * `description` is truncated at GitHub's 140-character limit rather than
   * letting the API reject the whole call: a red gate must still be reportable
   * when the failing step's name is long, and losing the tail of a sentence
   * beats losing the status.
   *
   * Needs the token's `statuses: write` permission. Without it the API answers
   * 403 "Resource not accessible by personal access token" — which is a
   * PERMISSION failure and reads nothing like a billing one, a distinction that
   * cost an evening to establish.
   */
  async createCommitStatus(req: {
    sha: string;
    state: "success" | "failure" | "pending" | "error";
    context: string;
    description?: string;
    targetUrl?: string;
  }): Promise<void> {
    await this.request<unknown>(
      "POST",
      `repos/${this.cfg.owner}/${this.cfg.repo}/statuses/${encodeURIComponent(req.sha)}`,
      {
        body: {
          state: req.state,
          context: req.context,
          ...(req.description ? { description: req.description.slice(0, 140) } : {}),
          ...(req.targetUrl ? { target_url: req.targetUrl } : {}),
        },
      },
    );
  }

  async closePr(number: number): Promise<void> {
    await this.request<RawPull>(
      "PATCH",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${number}`,
      { body: { state: "closed" } },
    );
  }

  /**
   * GET /repos/{owner}/{repo}/git/ref/heads/{branch} — the branch's head SHA,
   * or null when the ref does not exist (spec 0133). A 404 is an ANSWER ("no
   * such branch"), same posture as `getRepoAccess`; everything else throws.
   *
   * Segments are encoded individually so a branch's own `/` separators survive
   * as path structure while any other reserved character cannot escape it.
   */
  async getBranchHeadSha(branch: string): Promise<string | null> {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    try {
      const raw = await this.request<RawGitRef>(
        "GET",
        `repos/${this.cfg.owner}/${this.cfg.repo}/git/ref/heads/${ref}`,
      );
      return raw?.object?.sha ?? null;
    } catch (err) {
      if (err instanceof GithubApiError && err.kind === "not_found") return null;
      throw err;
    }
  }

  /**
   * POST /repos/{owner}/{repo}/git/refs — create `refs/heads/{branch}` at
   * `sha` (spec 0133: branch creation is scaffolding, so it runs on the server
   * token). A 422 "Reference already exists" is adopted as success: two
   * creators racing still end with the one branch they both asked for.
   */
  async createBranchRef(branch: string, sha: string): Promise<void> {
    try {
      await this.request<RawGitRef>("POST", `repos/${this.cfg.owner}/${this.cfg.repo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha },
      });
    } catch (err) {
      const alreadyExists =
        err instanceof GithubApiError &&
        err.status === 422 &&
        /already exists/i.test(err.message);
      if (!alreadyExists) throw err;
    }
  }

  /**
   * GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}&base={base}
   * — the open PR for a head branch, or null (spec 0133: one PR per branch,
   * find-or-create). The `owner:` prefix on `head` is MANDATORY: without it
   * GitHub silently ignores the filter and returns every open PR, and the
   * caller would adopt an unrelated one.
   */
  async findOpenPrByHead(branch: string, base: string): Promise<GithubPrRef | null> {
    const head = encodeURIComponent(`${this.cfg.owner}:${branch}`);
    const pulls = await this.request<RawPull[]>(
      "GET",
      `repos/${this.cfg.owner}/${this.cfg.repo}/pulls?state=open&head=${head}&base=${encodeURIComponent(base)}`,
    );
    const first = (pulls ?? [])[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }

  /**
   * POST /repos/{owner}/{repo}/issues/{n}/comments — a run's spec summary
   * lands on the accumulating branch PR's timeline (spec 0133 decision 5;
   * rewriting the body each run would erase the story the PR tells).
   */
  async commentOnPr(number: number, body: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${number}/comments`,
      { body: { body } },
    );
  }
}
