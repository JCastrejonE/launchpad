/**
 * `draftSpec` restructure coverage (spec 0029 Part A item 2) — the always-commit
 * wiring on top of item 1's `commitDraftIfUncommitted` helper. `specFileExists`
 * now gates ONLY the agent SESSION; the commit step runs unconditionally at
 * the end of every call, so:
 *   - a brand-new spec gets drafted (fake session) AND committed;
 *   - a pre-committed spec is a full pass-through (no session, HEAD unchanged);
 *   - a retry after a session wrote the file but crashed pre-commit commits
 *     without re-drafting (no session invoked, since the file already exists);
 *   - a retry after a successful commit is a no-op (commitDraftIfUncommitted's
 *     dirty-check).
 * Exercised against a real temp git repo (same discipline as
 * handoff-dirt.test.ts / draft-commit.test.ts: this commits/inspects with real
 * git, so a mock buys nothing) with a fake session (no real LLM/network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, run } from "./git.js";
import { coAuthorTrailer } from "./commit-trailer.js";
import { draftSpec } from "./activities.js";
import { makeRepoWithSpec } from "./handoff-dirt.test.js";
import type { PipelineInput } from "./spec.js";
import type { SessionRequest, SessionResult } from "@launchpad/agents";
import { DEFAULT_MODEL_FOR_ROLE } from "@launchpad/agents";

/** A git repo with a committed `specs/` dir but no spec file for `specId` yet. */
async function makeBareRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-draft-spec-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "Test"], root);
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# test repo\n");
  // A tracked placeholder so `specs/` itself isn't an entirely-untracked
  // directory — otherwise `git status --porcelain` collapses a later new
  // spec file to a single "specs/" line instead of "specs/NNNN-test.md",
  // and `commitDraftIfUncommitted`'s `dirty.includes(specFile)` check misses.
  await writeFile(path.join(root, "specs", ".gitkeep"), "");
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "init"], root);
  return root;
}

/** The house draft format (docs/SPEC_FORMAT.md): Spanish prose, English
 * byte-identical structure. Spec 0217 wired `specStructureViolations` over the
 * drafting session's output, so a fake drafter that writes anything less is a
 * rejected draft — this string is what a well-formed session produces. */
function draftMarkdown(specId: string): string {
  return [
    "---",
    `id: ${specId}`,
    "title: Un spec de prueba",
    "status: draft",
    "---",
    "",
    "## Intent",
    "Probar el camino de redacción.",
    "",
    "## Scope",
    "Solo la prueba.",
    "",
    "## Acceptance criteria",
    "1. El spec queda commiteado.",
    "",
    "## Out of scope / deferred",
    "- Nada más.",
    "",
    "## Handoff log",
    "",
  ].join("\n");
}

/** A fake session that writes (but does not commit) the drafted spec file. */
function fakeSessionDrafting(
  root: string,
  specId: string,
): (req: SessionRequest) => Promise<SessionResult> {
  return async (req: SessionRequest) => {
    await writeFile(path.join(root, "specs", `${specId}-test.md`), draftMarkdown(specId));
    return { role: req.role, ok: true, handoffNote: "fake session drafted", model: req.model };
  };
}

/** A session stub that fails the test if invoked — proves the session was skipped. */
function noSessionExpected(): (req: SessionRequest) => Promise<SessionResult> {
  return async () => {
    throw new Error("session should not have been invoked");
  };
}

function launchpadInput(specId: string, root: string): PipelineInput {
  return {
    specId,
    target: { kind: "self", repo: root },
    request: "test request",
    requestedBy: "test@example.com",
  };
}

function tenantInput(specId: string, root: string): PipelineInput {
  return {
    specId,
    target: { kind: "tenant", tenantId: "acme", repo: root, odooVersion: 17, vpsId: 100001 },
    request: "test request",
    requestedBy: "test@example.com",
  };
}

async function withFakeCredential<T>(fn: () => Promise<T>): Promise<T> {
  const savedKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "test-key-not-used-by-fake-session";
  try {
    return await fn();
  } finally {
    if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = savedKey;
  }
}

test("draftSpec: new spec is drafted (fake session) and committed to main, tree clean", async () => {
  const root = await makeBareRepo();
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput("0029", root), fakeSessionDrafting(root, "0029"));
  });
  assert.deepEqual(await git.dirtyFiles(root), []);
  const message = await git.lastCommitMessage(root);
  assert.match(message, /^docs\(spec-0029\): draft \(auto-committed by harness\)/);
  // The subject here is "the trailer carries the model draftSpec RESOLVED", not
  // which model that is — so read the constant. This assertion used to hardcode
  // "claude-sonnet-5", a literal copy of the drafter's default, and broke the
  // moment spec 0103 changed it (Fable). Reading DEFAULT_MODEL_FOR_ROLE keeps it
  // honest across future model changes.
  assert.ok(
    message.includes(coAuthorTrailer(DEFAULT_MODEL_FOR_ROLE["spec-drafter"])),
    `expected trailer in: ${message}`,
  );
});

// Also the spec-0217 control that the structural guard is DRAFT-TIME ONLY:
// `makeRepoWithSpec`'s spec has no `## Intent`/`## Scope`/`## Acceptance
// criteria` (like the 216 historical specs, 21 of which use `## Acceptance`).
// If the guard ever moved outside the `if (!specFileExists)` block, this test
// goes red rather than a real run failing over closed history.
test("draftSpec: pre-committed spec is a pass-through — no session, HEAD unchanged, clean", async () => {
  const { root } = await makeRepoWithSpec("0029");
  const before = await git.headSha(root);
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput("0029", root), noSessionExpected());
  });
  const after = await git.headSha(root);
  assert.equal(after, before, "HEAD must not move for an already-committed spec");
  assert.deepEqual(await git.dirtyFiles(root), []);
});

test("draftSpec: retry with file-written-but-uncommitted commits without re-drafting", async () => {
  const root = await makeBareRepo();
  const specId = "0029";
  // Simulate a prior session that wrote the file but crashed before the commit step.
  await writeFile(
    path.join(root, "specs", `${specId}-test.md`),
    `---\nid: ${specId}\nstatus: draft\n---\n## Progress\n\n## Handoff log\n`,
  );
  const before = await git.headSha(root);
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput(specId, root), noSessionExpected());
  });
  const after = await git.headSha(root);
  assert.notEqual(after, before, "expected the harness to commit the already-written spec");
  assert.deepEqual(await git.dirtyFiles(root), []);
  const message = await git.lastCommitMessage(root);
  assert.match(message, /^docs\(spec-0029\): draft \(auto-committed by harness\)/);
});

test("draftSpec: retry after a successful commit is a no-op", async () => {
  const root = await makeBareRepo();
  const specId = "0029";
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput(specId, root), fakeSessionDrafting(root, specId));
  });
  const afterFirst = await git.headSha(root);
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput(specId, root), noSessionExpected());
  });
  const afterRetry = await git.headSha(root);
  assert.equal(afterRetry, afterFirst, "retry after a successful commit must not add a new commit");
  assert.deepEqual(await git.dirtyFiles(root), []);
});

test("draftSpec: tenant-target input exercises the same drafting + commit path", async () => {
  const root = await makeBareRepo();
  const specId = "0029";
  await withFakeCredential(async () => {
    await draftSpec(tenantInput(specId, root), fakeSessionDrafting(root, specId));
  });
  assert.deepEqual(await git.dirtyFiles(root), []);
  const message = await git.lastCommitMessage(root);
  assert.match(message, /^docs\(spec-0029\): draft \(auto-committed by harness\)/);
});

// --- Least-privilege drafting guards (spec 0099 / G.1) ----------------------
//
// draftSpec used to run on runAgentSession's default surface (Bash + Edit +
// Write-anywhere) even though its whole job is to create one markdown file,
// while the IDENTICAL in-UI drafting session was fenced three ways. These lock
// the guards so a future edit can't quietly widen them back.

test("draftSpec: the session runs execution-free — no Bash, no Edit, Write gated to its own spec", async () => {
  const root = await makeBareRepo();
  let seen: SessionRequest | undefined;
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput("0099", root), async (req) => {
      seen = req;
      return fakeSessionDrafting(root, "0099")(req);
    });
  });
  const tools = [...(seen?.allowedTools ?? [])];
  // Spec 0147 added AskUserQuestion to the drafting surface so the CHAT's
  // drafter can ask which track a spec is. It asks; it never executes.
  assert.deepEqual(tools, ["Read", "Grep", "Glob", "Write", "AskUserQuestion"]);
  assert.ok(!tools.includes("Bash"), "the drafting session must not receive Bash");
  assert.ok(!tools.includes("Edit"), "the drafting session must not receive Edit");

  // Spec 0147, and the property that matters HERE: this is the PIPELINE's
  // drafter, running headless in the worker with no human attached. The tool
  // exists but must always be DENIED — otherwise a run could block for 15
  // minutes waiting on an answer nobody is there to give.
  const headlessGate = seen?.canUseTool;
  assert.ok(headlessGate, "draftSpec must supply a canUseTool gate");
  const asked = (await headlessGate!(
    "AskUserQuestion",
    { questions: [{ question: "¿Track?", options: [{ label: "2" }] }] },
    { signal: new AbortController().signal, suggestions: [] } as never,
  )) as unknown as { behavior: string };
  assert.equal(asked.behavior, "deny", "a headless run must never wait on a question");

  // The Write gate must be bound to THIS run's spec id, not merely present.
  const gate = seen?.canUseTool;
  assert.ok(gate, "draftSpec must supply a canUseTool gate");
  const decide = async (tool: string, input: Record<string, unknown>) =>
    (await gate(tool, input, {} as never))?.behavior;
  assert.equal(await decide("Write", { file_path: path.join(root, "specs", "0099-test.md") }), "allow");
  assert.equal(await decide("Write", { file_path: path.join(root, "specs", "0098-other.md") }), "deny");
  assert.equal(await decide("Write", { file_path: path.join(root, "packages/db/src/x.ts") }), "deny");
  assert.equal(await decide("Bash", { command: "git push" }), "deny");
});

test("draftSpec: a session that dirties files outside its spec fails non-retryably, dirt left for inspection", async () => {
  const root = await makeBareRepo();
  await withFakeCredential(async () => {
    await assert.rejects(
      () =>
        draftSpec(launchpadInput("0099", root), async (req) => {
          // A drafter that escaped the tool gate (or a future code path that
          // forgot to pass it): writes its spec AND something else.
          await writeFile(path.join(root, "specs", "0099-test.md"), "---\nid: 0099\n---\n");
          await writeFile(path.join(root, "README.md"), "# clobbered\n");
          return { role: req.role, ok: true, handoffNote: "escaped", model: req.model };
        }),
      (err: unknown) => {
        const e = err as { type?: string; nonRetryable?: boolean; message: string };
        assert.equal(e.type, "SpecDrafterFenceViolation");
        assert.equal(e.nonRetryable, true);
        assert.match(e.message, /README\.md/);
        return true;
      },
    );
  });
  // The activity must NOT tidy up behind a fence violation — the evidence is
  // the point, and a retry would redraft over it.
  assert.ok((await git.dirtyFiles(root)).includes("README.md"));
});

test("draftSpec: a drafted spec with translated structure fails non-retryably, uncommitted (spec 0217)", async () => {
  const root = await makeBareRepo();
  const before = await git.headSha(root);
  await withFakeCredential(async () => {
    await assert.rejects(
      () =>
        draftSpec(launchpadInput("0217", root), async (req) => {
          // A drafter that translated the STRUCTURE along with the prose.
          await writeFile(
            path.join(root, "specs", "0217-prueba.md"),
            "---\nid: 0217\nstatus: draft\n---\n## Intención\nProbar.\n\n## Progreso\n- [ ] algo\n",
          );
          return { role: req.role, ok: true, handoffNote: "translated", model: req.model };
        }),
      (err: unknown) => {
        const e = err as { type?: string; nonRetryable?: boolean; message: string };
        assert.equal(e.type, "SpecStructureViolation");
        // A retry re-runs the session and would redraft the same way.
        assert.equal(e.nonRetryable, true);
        assert.match(e.message, /## Intent/);
        assert.match(e.message, /checkbox item outside "## Progress"/);
        return true;
      },
    );
  });
  // The guard runs BEFORE commitDraftIfUncommitted: the malformed draft must
  // never reach a commit, and is left on disk for inspection.
  assert.equal(await git.headSha(root), before, "a rejected draft must not be committed");
  assert.ok((await git.dirtyFiles(root)).includes("specs/0217-prueba.md"));
});

test("draftSpec: pre-existing dirt on the primary checkout is NOT a fence violation", async () => {
  const root = await makeBareRepo();
  // draftSpec runs on the primary checkout on main, which can legitimately be
  // dirty when a run starts (spec 0029). Only what the SESSION touched counts —
  // which is why the fence snapshots before/after instead of filtering after.
  await writeFile(path.join(root, "README.md"), "# already dirty before the run\n");
  await withFakeCredential(async () => {
    await draftSpec(launchpadInput("0099", root), fakeSessionDrafting(root, "0099"));
  });
  const log = await run("git", ["log", "--oneline", "-1"], root);
  assert.match(log.out, /docs\(spec-0099\): draft/);
});
