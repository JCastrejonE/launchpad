import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKOUTS_ROOT_ENV,
  CheckoutError,
  checkoutPathFor,
  classifyCloneFailure,
  ensureProjectCheckout,
  isRetryableCloneFailure,
  originMatchesRepo,
  provisionRepoCheckout,
  SPEC_EXCLUDE_LINES,
  projectSpecsDir,
  type CheckoutDeps,
  type ProvisionCheckoutDeps,
} from "./checkout.js";

const ENV = { [CHECKOUTS_ROOT_ENV]: "/tmp/checkouts" } as NodeJS.ProcessEnv;

function fakeDeps(over: Partial<CheckoutDeps> = {}) {
  const calls = { clones: [] as string[], excludes: [] as string[], persisted: [] as string[] };
  const deps: CheckoutDeps = {
    isCheckout: async () => false,
    clone: async (_url, dest) => {
      calls.clones.push(dest);
      return { ok: true, out: "" };
    },
    addExcludes: async (root) => void calls.excludes.push(root),
    persistRepoRoot: async (_slug, root) => void calls.persisted.push(root),
    ...over,
  };
  return { deps, calls };
}

test("checkoutPathFor derives the path from the slug", () => {
  assert.equal(checkoutPathFor("client-c", ENV), "/tmp/checkouts/client-c");
});

// A path built from stored data must not escape its parent because a validator
// changed somewhere else.
test("checkoutPathFor refuses a slug that could escape its parent", () => {
  for (const bad of ["../etc", "a/b", "..", ".", "", "  ", "a\\b"]) {
    assert.throws(() => checkoutPathFor(bad, ENV), /unsafe project slug/, JSON.stringify(bad));
  }
});

// THE expensive mistake this function exists to avoid.
test("an existing checkout is REUSED, never re-cloned", async () => {
  const { deps, calls } = fakeDeps({ isCheckout: async () => true });
  const out = await ensureProjectCheckout(
    { slug: "client-c", repoOwner: "example-org", repoName: "client-c", repoRoot: "/srv/checkouts/client-c" },
    deps,
    ENV,
  );
  assert.deepEqual(out, { root: "/srv/checkouts/client-c", cloned: false });
  assert.deepEqual(calls.clones, [], "must not clone");
});

test("a fresh project clones, excludes specs, and persists the path", async () => {
  const { deps, calls } = fakeDeps();
  const out = await ensureProjectCheckout(
    { slug: "client-c", repoOwner: "example-org", repoName: "client-c", kind: "odoo" },
    deps,
    ENV,
  );
  assert.deepEqual(out, { root: "/tmp/checkouts/client-c", cloned: true });
  assert.deepEqual(calls.clones, ["/tmp/checkouts/client-c"]);
  assert.deepEqual(calls.excludes, ["/tmp/checkouts/client-c"], "specs/ excluded");
  assert.deepEqual(calls.persisted, ["/tmp/checkouts/client-c"], "repo_root written back");
});

// This repo's specs ARE the method's record and are reviewed in PRs.
test("the platform project does NOT get its specs excluded", async () => {
  const { deps, calls } = fakeDeps();
  await ensureProjectCheckout(
    { slug: "platform", repoOwner: "example-org", repoName: "launchpad", kind: "platform" },
    deps,
    ENV,
  );
  assert.deepEqual(calls.excludes, []);
});

// `.gitignore` would be a COMMIT in the customer's repo — the exact footprint the
// decision avoids. The mechanism is asserted, not just the intent.
test("the exclude lines target .git/info/exclude and say why", () => {
  const text = SPEC_EXCLUDE_LINES.join("\n");
  assert.match(text, /specs\//);
  assert.match(text, /\.git\/info\/exclude/);
  assert.match(text, /not \.gitignore/i);
  // Spec 0131 F: the no-slash pattern too. A trailing slash matches directories
  // only, and the worktree reaches the spec through a SYMLINK named `specs`,
  // which git treats as a file — so `specs/` alone leaves it untracked.
  assert.ok(SPEC_EXCLUDE_LINES.includes("specs"), "the no-slash pattern must be present");
});

// Spec 0131 F: an already-cloned checkout must pick up a pattern added later —
// otherwise a project cloned last week keeps a stale exclude file forever.
test("a REUSED checkout still has the excludes applied", async () => {
  const { deps, calls } = fakeDeps({ isCheckout: async () => true });
  await ensureProjectCheckout(
    { slug: "client-c", repoOwner: "example-org", repoName: "client-c", repoRoot: "/srv/x" },
    deps,
    ENV,
  );
  assert.deepEqual(calls.clones, [], "nothing re-cloned");
  assert.deepEqual(calls.excludes, ["/srv/x"], "excludes re-applied (idempotent by contract)");
});

// A failed persist or a restored disk leaves a usable checkout the row does not
// know about; discovering that by failing a clone into a non-empty directory is
// worse than checking.
test("a checkout at the derived path is adopted even when the row is empty", async () => {
  const { deps, calls } = fakeDeps({ isCheckout: async (d) => d === "/tmp/checkouts/client-c" });
  const out = await ensureProjectCheckout(
    { slug: "client-c", repoOwner: "example-org", repoName: "client-c", repoRoot: null },
    deps,
    ENV,
  );
  assert.equal(out.cloned, false);
  assert.deepEqual(calls.clones, []);
  assert.deepEqual(calls.persisted, ["/tmp/checkouts/client-c"], "the row is repaired");
});

test("no linked repo is an error, not an empty clone", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => ensureProjectCheckout({ slug: "bare" }, deps, ENV),
    (e: unknown) => e instanceof CheckoutError && e.kind === "not_found",
  );
});

// "clone failed" is useless to whoever must fix it, and permanent vs transient
// decides whether retrying is anything but noise.
test("clone failures are classified from real git wording", () => {
  const cases: [string, string, boolean][] = [
    ["remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found", "not_found", false],
    ["fatal: could not read Username for 'https://github.com': No such device or address", "auth", true],
    ["fatal: Authentication failed for 'https://github.com/x/y.git/'", "auth", false],
    ["fatal: write error: No space left on device", "disk", true],
    ["fatal: the remote end hung up unexpectedly: operation too slow", "timeout", true],
    ["something nobody has seen before", "unknown", true],
  ];
  for (const [output, kind, _r] of cases) {
    assert.equal(classifyCloneFailure(output), kind, output.slice(0, 40));
  }
  // Permanent failures must NOT be retried: another attempt cannot create a repo
  // or grant a permission.
  assert.equal(isRetryableCloneFailure("not_found"), false);
  assert.equal(isRetryableCloneFailure("auth"), false);
  assert.equal(isRetryableCloneFailure("disk"), true);
  assert.equal(isRetryableCloneFailure("timeout"), true);
});

test("a clone failure carries a message naming the repo and the project", async () => {
  const { deps } = fakeDeps({
    clone: async () => ({ ok: false, out: "remote: Repository not found." }),
  });
  await assert.rejects(
    () => ensureProjectCheckout({ slug: "client-c", repoOwner: "example-org", repoName: "nope" }, deps, ENV),
    (e: unknown) => {
      const err = e as CheckoutError;
      assert.equal(err.kind, "not_found");
      assert.equal(err.retryable, false);
      assert.match(err.message, /example-org\/nope/);
      assert.match(err.message, /client-c/);
      // GitHub 404s a private repo it cannot see, so the message must not claim
      // the repo does not exist.
      assert.match(err.message, /no tiene acceso/);
      return true;
    },
  );
});

test("a failed clone does not persist a path or write excludes", async () => {
  const { deps, calls } = fakeDeps({ clone: async () => ({ ok: false, out: "fatal: Authentication failed" }) });
  await assert.rejects(() =>
    ensureProjectCheckout({ slug: "x", repoOwner: "o", repoName: "r" }, deps, ENV),
  );
  assert.deepEqual(calls.persisted, []);
  assert.deepEqual(calls.excludes, []);
});

// --- Spec 0141: specs live OUTSIDE the checkout -----------------------------

test("projectSpecsDir is a sibling of the checkouts root, never inside a checkout", () => {
  const env = {
    LAUNCHPAD_CHECKOUTS_ROOT: "/srv/launchpad/checkouts",
    LAUNCHPAD_SPECS_ROOT: "/srv/launchpad/specs",
  } as NodeJS.ProcessEnv;
  const specs = projectSpecsDir("abtest", env);
  const checkout = checkoutPathFor("abtest", env);
  assert.equal(specs, "/srv/launchpad/specs/abtest");
  // The whole point: git in the checkout cannot reach the specs.
  assert.equal(specs.startsWith(`${checkout}/`), false);
  assert.equal(specs === checkout, false);
});

test("projectSpecsDir refuses a slug that could escape its parent", () => {
  for (const bad of ["", "  ", "..", ".", "a/b", "a\\b"]) {
    assert.throws(() => projectSpecsDir(bad), /unsafe project slug/, JSON.stringify(bad));
  }
});

test("projectSpecsDir honours its env override and has a /srv default", () => {
  assert.equal(projectSpecsDir("x", { LAUNCHPAD_SPECS_ROOT: "/tmp/s" } as NodeJS.ProcessEnv), "/tmp/s/x");
  assert.equal(projectSpecsDir("x", {} as NodeJS.ProcessEnv), "/srv/launchpad/specs/x");
});

/**
 * Spec 0150 — the platform's row has a `repo_root` and NO `repo_owner`/`repo_name`,
 * because its checkout is the deployed repo and there is nothing to clone. Six
 * UI-started runs of spec 0147 failed on this in a row: `input.project` started
 * carrying the platform (spec 0142 C) while the payload still had no `repoRoot`,
 * so the known-root early return could not fire and the guard below it refused.
 */
test("ensureProjectCheckout: a known checkout wins even with no clone URL (the platform)", async () => {
  const calls: string[] = [];
  const out = await ensureProjectCheckout(
    { slug: "platform", kind: "platform", repoRoot: "/srv/launchpad/repo" },
    {
      isCheckout: async (dir) => dir === "/srv/launchpad/repo",
      clone: async () => {
        calls.push("clone");
        return { ok: false, out: "" };
      },
      addExcludes: async () => {
        calls.push("excludes");
      },
      persistRepoRoot: async () => {
        calls.push("persist");
      },
    },
    {},
  );
  assert.deepEqual(out, { root: "/srv/launchpad/repo", cloned: false });
  // Never clones, and never writes the specs exclude into a repo that COMMITS
  // its specs — the two ways this path could quietly do damage.
  assert.deepEqual(calls, []);
});

test("ensureProjectCheckout: no known checkout and no clone URL still refuses", async () => {
  await assert.rejects(
    () =>
      ensureProjectCheckout(
        { slug: "client-b", kind: "odoo_next", repoRoot: null },
        {
          isCheckout: async () => false,
          clone: async () => ({ ok: false, out: "" }),
          addExcludes: async () => {},
          persistRepoRoot: async () => {},
        },
        {},
      ),
    /no tiene repositorio vinculado/,
  );
});

// --- Spec 0148 A: provision a freshly-created repo's checkout ----------------

test("originMatchesRepo accepts every clone-URL shape, case-insensitively", () => {
  for (const origin of [
    "https://github.com/example-org/client-c.git",
    "https://github.com/example-org/client-c",
    "git@github.com:example-org/client-c.git",
    "ssh://git@github.com/example-org/client-c",
    "https://github.com/Example-Org/Client-C.git",
  ]) {
    assert.equal(originMatchesRepo(origin, "example-org", "client-c"), true, origin);
  }
  // A DIFFERENT repo must not match — the wrong-repo hazard this guards against.
  assert.equal(originMatchesRepo("https://github.com/example-org/other.git", "example-org", "client-c"), false);
  assert.equal(originMatchesRepo("", "example-org", "client-c"), false);
});

function fakeProvisionDeps(over: Partial<ProvisionCheckoutDeps> = {}) {
  const calls = {
    linked: [] as string[],
    persistedRoot: [] as string[],
    origins: [] as string[],
  };
  const deps: ProvisionCheckoutDeps = {
    isCheckout: async () => false,
    clone: async () => ({ ok: true, out: "" }),
    addExcludes: async () => {},
    persistRepoRoot: async (_slug, root) => void calls.persistedRoot.push(root),
    persistRepo: async (_slug, owner, name) => void calls.linked.push(`${owner}/${name}`),
    originUrl: async (root) => {
      calls.origins.push(root);
      return "https://github.com/example-org/client-c.git";
    },
    ...over,
  };
  return { deps, calls };
}

test("provisionRepoCheckout links, clones, and returns the origin read back", async () => {
  const { deps, calls } = fakeProvisionDeps();
  const out = await provisionRepoCheckout(
    { slug: "client-c", owner: "example-org", name: "client-c", kind: "odoo_next" },
    deps,
    ENV,
  );
  assert.equal(out.root, "/tmp/checkouts/client-c");
  assert.equal(out.cloned, true);
  // The origin comes from READING the remote, not from what we persisted.
  assert.equal(out.originUrl, "https://github.com/example-org/client-c.git");
  assert.deepEqual(calls.linked, ["example-org/client-c"], "coordinates written to the row");
  assert.deepEqual(calls.persistedRoot, ["/tmp/checkouts/client-c"], "repo_root written to the row");
  assert.deepEqual(calls.origins, ["/tmp/checkouts/client-c"], "origin verified in the checkout");
});

// The whole point of reading the remote: a clone that landed on the WRONG repo
// (a stale checkout at the derived path, a mixed-up URL) must fail loudly, never
// be returned as if it were right — a run would commit into the wrong repository.
test("provisionRepoCheckout refuses a checkout whose origin is a different repo", async () => {
  const { deps } = fakeProvisionDeps({
    originUrl: async () => "https://github.com/example-org/somethingelse.git",
  });
  await assert.rejects(
    () => provisionRepoCheckout({ slug: "client-c", owner: "example-org", name: "client-c" }, deps, ENV),
    (e: unknown) => e instanceof CheckoutError && /no apunta a example-org\/client-c/.test(e.message),
  );
});

// Coordinates are written BEFORE the clone so a clone failure leaves the row in
// the recoverable linked-but-uncloned state (spec 0151), not unlinked.
test("provisionRepoCheckout links the repo even when the clone then fails", async () => {
  const { deps, calls } = fakeProvisionDeps({
    clone: async () => ({ ok: false, out: "fatal: Authentication failed" }),
  });
  await assert.rejects(() =>
    provisionRepoCheckout({ slug: "client-c", owner: "example-org", name: "client-c" }, deps, ENV),
  );
  assert.deepEqual(calls.linked, ["example-org/client-c"], "row linked before the clone was attempted");
  assert.deepEqual(calls.persistedRoot, [], "no repo_root persisted for a failed clone");
});
