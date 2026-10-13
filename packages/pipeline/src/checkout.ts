/**
 * Materialise a project's git checkout on the worker (spec 0129 B).
 *
 * Spec 0126 D pointed a run at its project's repo and then refused to start when
 * that repo had no local clone — correctly, because falling back to the launchpad's
 * own checkout would have produced commits in the wrong repository. This is the
 * piece that makes the refusal unnecessary.
 *
 * The path is DERIVED from the slug ({@link checkoutPathFor}) rather than invented
 * here, so the web can name the checkout a run will use without being able to
 * create it: computing a path is pure, cloning is minutes of network and disk that
 * belongs on the worker (the same split spec 0127 made for chat turns).
 *
 * Full clone, not shallow — and that is measured, not assumed. On the real repo:
 * full 19 MB in 2 s, `--filter=blob:none` 18 MB in 2 s. A blobless clone saves ~1 MB
 * and buys a failure mode, since `git log -S` (which agents do use) then needs the
 * network to fetch blobs on demand. Spec 0129 decision 5 assumed shallow would be
 * the default; the measurement says otherwise, and a customer repo large enough to
 * change that answer should change it with its own measurement.
 */
import path from "node:path";

/** Where per-project checkouts live. Overridable so a test never writes to /srv. */
export const CHECKOUTS_ROOT_ENV = "LAUNCHPAD_CHECKOUTS_ROOT";
const DEFAULT_CHECKOUTS_ROOT = "/srv/launchpad/checkouts";

export function checkoutsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[CHECKOUTS_ROOT_ENV]?.trim() || DEFAULT_CHECKOUTS_ROOT;
}

/**
 * The checkout path for a project slug. Pure and total.
 *
 * The slug is already constrained to `[a-z0-9-]` by `isValidProjectSlug` (spec
 * 0126), but this refuses a separator or a dot-segment anyway: a path built from
 * stored data must not be able to escape its parent because a validator changed
 * somewhere else.
 */
export function checkoutPathFor(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = slug.trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || clean === "." || clean === "..") {
    throw new Error(`checkoutPathFor: refusing unsafe project slug ${JSON.stringify(slug)}`);
  }
  return path.join(checkoutsRoot(env), clean);
}

/** Where a project's SPECS live — OUTSIDE its checkout (spec 0141). */
export const SPECS_ROOT_ENV = "LAUNCHPAD_SPECS_ROOT";
const DEFAULT_SPECS_ROOT = "/srv/launchpad/specs";

export function specsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[SPECS_ROOT_ENV]?.trim() || DEFAULT_SPECS_ROOT;
}

/**
 * The specs directory for a project slug (spec 0141) — a sibling of the
 * checkouts root, never inside the working tree.
 *
 * Spec 0129 kept specs INSIDE the checkout and out of history via
 * `.git/info/exclude`. An exclusion is a request: a chat with write access ran
 * `git add -f` and the spec landed in the customer's history anyway. A
 * directory git cannot reach needs no discipline from the agent.
 *
 * Same slug guard as {@link checkoutPathFor}, for the same reason: a path built
 * from stored data must not escape its parent if a validator changes elsewhere.
 */
export function projectSpecsDir(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = slug.trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || clean === "." || clean === "..") {
    throw new Error(`projectSpecsDir: refusing unsafe project slug ${JSON.stringify(slug)}`);
  }
  return path.join(specsRoot(env), clean);
}

export type CheckoutFailure = "not_found" | "auth" | "disk" | "timeout" | "unknown";

export interface CheckoutOutcome {
  root: string;
  /** False when an existing checkout was reused — the common case after the first run. */
  cloned: boolean;
}

/**
 * Classify a `git clone` failure from its output.
 *
 * "clone failed" is useless to whoever has to fix it, and the distinction is not
 * cosmetic: `not_found` and `auth` are permanent (retrying never succeeds), while
 * `disk` and `timeout` are worth another attempt. Pure, so every mapping is tested
 * against real git/GitHub wording.
 */
export function classifyCloneFailure(output: string): CheckoutFailure {
  const out = output.toLowerCase();
  if (out.includes("could not read username") || out.includes("authentication failed") || out.includes("permission denied")) {
    return "auth";
  }
  // GitHub returns 404 for a private repo the credential cannot see, so "not found"
  // and "no access" are the same message — the classification says so rather than
  // guessing which one it was.
  if (out.includes("repository not found") || out.includes("could not read from remote repository")) {
    return "not_found";
  }
  if (out.includes("no space left") || out.includes("disk quota") || out.includes("write error")) return "disk";
  if (out.includes("timed out") || out.includes("timeout") || out.includes("operation too slow")) return "timeout";
  return "unknown";
}

/** Whether another attempt could plausibly succeed. */
export function isRetryableCloneFailure(kind: CheckoutFailure): boolean {
  return kind === "disk" || kind === "timeout" || kind === "unknown";
}

export function describeCloneFailure(kind: CheckoutFailure, slug: string, repo: string): string {
  switch (kind) {
    case "auth":
      return `No pudimos autenticarnos con GitHub para clonar ${repo} (proyecto "${slug}"). El servidor necesita un GITHUB_TOKEN con acceso a ese repositorio.`;
    case "not_found":
      return `GitHub no encuentra ${repo}, o el token del servidor no tiene acceso (proyecto "${slug}"). GitHub responde igual en los dos casos.`;
    case "disk":
      return `No hay espacio en disco para clonar ${repo} (proyecto "${slug}").`;
    case "timeout":
      return `La clonación de ${repo} (proyecto "${slug}") excedió el tiempo límite.`;
    default:
      return `Falló la clonación de ${repo} (proyecto "${slug}").`;
  }
}

/** The lines added to `.git/info/exclude` for a non-platform project. */
export const SPEC_EXCLUDE_LINES = [
  "# spec 0129: the launchpad's specs live here but are NOT part of this repository.",
  "# .git/info/exclude and not .gitignore — a .gitignore change would be a COMMIT in",
  "# the customer's repo, which is exactly the footprint this avoids.",
  "specs/",
  "# Spec 0131 F: BOTH patterns, measured. A run's worktree reaches the spec through",
  "# a SYMLINK named `specs`, and git treats a symlink as a file — so the pattern",
  "# above (trailing slash = directories only) does not match it and the worktree",
  "# reports `?? specs`, which fails teardown's clean-tree assertion.",
  "specs",
] as const;

/** Injectable I/O, so the decision logic is testable with no git and no disk. */
export interface CheckoutDeps {
  /** True when `dir` is an existing git checkout (a `.git` entry is present). */
  isCheckout: (dir: string) => Promise<boolean>;
  clone: (url: string, dest: string) => Promise<{ ok: boolean; out: string }>;
  /** Append `lines` to `<root>/.git/info/exclude`, creating it if needed. Idempotent. */
  addExcludes: (root: string, lines: readonly string[]) => Promise<void>;
  /** Persist the resolved path onto the project row. */
  persistRepoRoot: (slug: string, root: string) => Promise<void>;
}

export interface EnsureCheckoutInput {
  slug: string;
  repoOwner?: string | null;
  repoName?: string | null;
  /** Already-known checkout, if the project has one. */
  repoRoot?: string | null;
  /** `platform` keeps its specs committed; every other kind excludes them. */
  kind?: string | null;
}

export class CheckoutError extends Error {
  readonly kind: CheckoutFailure;
  readonly retryable: boolean;
  constructor(kind: CheckoutFailure, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.kind = kind;
    this.retryable = isRetryableCloneFailure(kind);
  }
}

/**
 * Ensure the project's checkout exists, and return where it is.
 *
 * Order matters: an existing `repoRoot` that IS a checkout wins before anything
 * else, because re-cloning a large repo on every run is the expensive mistake this
 * function exists to avoid.
 */
export async function ensureProjectCheckout(
  input: EnsureCheckoutInput,
  deps: CheckoutDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckoutOutcome> {
  const known = input.repoRoot?.trim();
  if (known && (await deps.isCheckout(known))) {
    await applyExcludes(known, input, deps);
    return { root: known, cloned: false };
  }

  if (!input.repoOwner?.trim() || !input.repoName?.trim()) {
    throw new CheckoutError(
      "not_found",
      `El proyecto "${input.slug}" no tiene repositorio vinculado, así que no hay nada que clonar.`,
    );
  }

  const dest = checkoutPathFor(input.slug, env);
  // The destination may already be a checkout from a previous run even when the row
  // does not say so (a failed persist, a restored disk). Reusing it is right, and
  // cheaper than discovering that a clone into a non-empty directory fails.
  if (await deps.isCheckout(dest)) {
    await applyExcludes(dest, input, deps);
    await deps.persistRepoRoot(input.slug, dest);
    return { root: dest, cloned: false };
  }

  const repo = `${input.repoOwner.trim()}/${input.repoName.trim()}`;
  const url = `https://github.com/${repo}.git`;
  const result = await deps.clone(url, dest);
  if (!result.ok) {
    const kind = classifyCloneFailure(result.out);
    throw new CheckoutError(kind, describeCloneFailure(kind, input.slug, repo));
  }

  await applyExcludes(dest, input, deps);
  await deps.persistRepoRoot(input.slug, dest);
  return { root: dest, cloned: true };
}

/**
 * Injectable I/O for {@link provisionRepoCheckout}: the clone deps plus the two
 * extra effects provisioning needs — persisting the GitHub coordinates onto the
 * project row, and reading the checkout's `origin` remote back to verify it.
 */
export interface ProvisionCheckoutDeps extends CheckoutDeps {
  /** Persist the GitHub coordinates onto the project row (db `setProjectRepo`). */
  persistRepo: (slug: string, owner: string, name: string) => Promise<void>;
  /** `git remote get-url origin` in the checkout; null when no origin is set. */
  originUrl: (root: string) => Promise<string | null>;
}

export interface ProvisionCheckoutInput {
  slug: string;
  /** The repo `createRepoInOrg` just created — its GitHub coordinates. */
  owner: string;
  name: string;
  /** `platform` keeps its specs committed; every other kind excludes them. */
  kind?: string | null;
}

export interface ProvisionCheckoutOutcome extends CheckoutOutcome {
  /** The `origin` remote read BACK from the checkout — proves what was cloned
   * (VERIFICATION #1), rather than echoing the value we persisted. */
  originUrl: string;
}

/**
 * True when `origin` addresses `owner/name` — spec 0148 A's clone-verification.
 *
 * Normalises the three clone-URL shapes GitHub offers (https, scp-style ssh,
 * URL-style ssh) down to `owner/name`, case-insensitively (GitHub treats owner
 * and repo names case-insensitively). Deliberately a local copy of
 * `apps/web/lib/project-create.ts`'s `parseRepoRef` normalisation rather than an
 * import: the pipeline package must not depend on apps/web, and this is five
 * lines. Pure, so the wrong-repo guard below is testable without a real clone.
 */
export function originMatchesRepo(origin: string, owner: string, name: string): boolean {
  const cleaned = origin
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return cleaned.toLowerCase() === `${owner.trim()}/${name.trim()}`.toLowerCase();
}

/**
 * Provision a freshly-created repo's checkout on the worker (spec 0148 A).
 *
 * `createRepoInOrg` makes the repo; this makes it usable. Persist the GitHub
 * coordinates onto the project row, clone it, then confirm the clone actually
 * points at that repo by READING its `origin` remote — never by trusting the
 * value we just wrote (VERIFICATION #1). A checkout whose origin is some other
 * repo is the wrong-repo hazard spec 0126 D refused to risk (a run would commit
 * into the wrong repository), so this fails loudly rather than returning it.
 *
 * The clone reuses {@link ensureProjectCheckout}, so provisioning inherits its
 * idempotency (a retried activity reuses an existing checkout) and its failure
 * classification for free.
 */
export async function provisionRepoCheckout(
  input: ProvisionCheckoutInput,
  deps: ProvisionCheckoutDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProvisionCheckoutOutcome> {
  // Coordinates FIRST: a linked-but-uncloned project is a recoverable state
  // (spec 0151 `setProjectRepo`), so a clone failure after this still leaves the
  // row pointing at the right repo for the retry.
  await deps.persistRepo(input.slug, input.owner, input.name);

  const outcome = await ensureProjectCheckout(
    { slug: input.slug, repoOwner: input.owner, repoName: input.name, kind: input.kind },
    deps,
    env,
  );

  const origin = await deps.originUrl(outcome.root);
  if (!origin || !originMatchesRepo(origin, input.owner, input.name)) {
    throw new CheckoutError(
      "unknown",
      `El checkout de "${input.slug}" no apunta a ${input.owner}/${input.name} (origin: ${origin ?? "ninguno"}).`,
    );
  }
  return { ...outcome, originUrl: origin };
}

/**
 * Non-platform projects keep their specs OUT of the customer's history.
 *
 * On EVERY path, not just a fresh clone (spec 0131 F): `addExcludes` is idempotent
 * by contract, and a checkout cloned before a pattern was added would otherwise
 * keep the old exclude file forever — which is not cosmetic, since a missing
 * pattern makes the run's worktree report `?? specs` and fails teardown's
 * clean-tree assertion.
 */
async function applyExcludes(
  root: string,
  input: EnsureCheckoutInput,
  deps: CheckoutDeps,
): Promise<void> {
  if ((input.kind ?? "") === "platform") return;
  await deps.addExcludes(root, SPEC_EXCLUDE_LINES);
}
