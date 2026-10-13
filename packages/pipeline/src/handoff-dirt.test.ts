/**
 * Handoff-only-dirt repair coverage (spec 0021) — the harness enforcement half
 * of the clean-tree-handoffs fix. Exercised against a real temp git repo (same
 * discipline as worktree.test.ts: repairHandoffOnlyDirt commits/inspects with
 * real git, so a mock buys nothing).
 *
 * Cases (a)-(c) exercise `repairHandoffOnlyDirt` (spec 0021 item 2) against a
 * real temp git repo:
 *   (a) spec-only dirt   → commits `docs(spec-NNNN): coder handoff
 *       (auto-committed by harness)` WITH the Co-Authored-By trailer; tree clean
 *       afterwards.
 *   (b) clean tree       → no-op (no new commit).
 *   (c) mixed dirt       → loud `[hygiene]` warning naming the files, NO commit,
 *       NO throw; tree still dirty afterwards (teardownEnv's guard is the
 *       backstop).
 * The premise-pin case (d) guards the rationale of item 1's coder-rule change
 * against a future progress.ts regression.
 *
 * Item 3 additionally needs call-site coverage that runCoder + runInitializer
 * invoke repairHandoffOnlyDirt immediately after verifyAndRepairTrailer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, run } from "./git.js";
import { coAuthorTrailer } from "./commit-trailer.js";
import { repairHandoffOnlyDirt, runCoder, runInitializer, runRepair } from "./activities.js";
import type { EphemeralEnv, RepairContext } from "./activities.js";
import type { PipelineInput } from "./spec.js";
import type { SessionRequest, SessionResult } from "@launchpad/agents";
import { sessionProgressed } from "./progress.js";

/**
 * A minimal git repo with one commit on `main` that includes a committed
 * `specs/NNNN-test.md` spec file — the fixture the repair-helper cases build on
 * (dirty the spec, or dirty spec + another file, then call the helper). Returns
 * the repo root and the repo-relative spec path (the form `git.dirtyFiles`
 * reports and `repairHandoffOnlyDirt` expects).
 */
export async function makeRepoWithSpec(
  specId: string,
): Promise<{ root: string; specFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-handoff-dirt-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "Test"], root);
  const specFile = path.join("specs", `${specId}-test.md`);
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(
    path.join(root, specFile),
    `---\nid: ${specId}\nstatus: in_progress\n---\n## Progress\n- [x] done\n\n## Handoff log\n- seeded\n`,
  );
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "init"], root);
  return { root, specFile };
}

test(
  "repairHandoffOnlyDirt: spec-only dirt commits with the expected message + trailer (a)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    await appendFile(path.join(root, specFile), "- handoff-only edit\n");
    const before = await git.headSha(root);
    await repairHandoffOnlyDirt(root, specFile, "claude-sonnet-5");
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected a new commit");
    assert.deepEqual(await git.dirtyFiles(root), []);
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0021\): coder handoff \(auto-committed by harness\)/);
    assert.ok(
      message.includes(coAuthorTrailer("claude-sonnet-5")),
      `expected trailer in: ${message}`,
    );
  },
);

test(
  "repairHandoffOnlyDirt: clean tree is a no-op (b)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    const before = await git.headSha(root);
    await repairHandoffOnlyDirt(root, specFile, "claude-sonnet-5");
    const after = await git.headSha(root);
    assert.equal(after, before);
    assert.deepEqual(await git.dirtyFiles(root), []);
  },
);

test(
  "repairHandoffOnlyDirt: mixed dirt warns, does not commit, does not throw (c)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    await appendFile(path.join(root, specFile), "- handoff-only edit\n");
    await writeFile(path.join(root, "other.txt"), "unrelated dirt\n");
    const before = await git.headSha(root);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await repairHandoffOnlyDirt(root, specFile, "claude-sonnet-5");
    } finally {
      console.warn = originalWarn;
    }
    const after = await git.headSha(root);
    assert.equal(after, before, "no commit should have been made");
    const dirty = (await git.dirtyFiles(root)).sort();
    assert.deepEqual(dirty, [specFile, "other.txt"].sort());
    assert.ok(warnings.some((w) => w.includes("[hygiene]")), "expected a [hygiene] warning");
    assert.ok(warnings.some((w) => w.includes("other.txt")), "warning should name other.txt");
  },
);

/**
 * A fake session runner that never touches the network/LLM: it applies
 * `mutate` to the on-disk repo (simulating whatever an agent session left
 * behind — here, a handoff-only edit with no commit, the exact shape of spec
 * 0020 run d1bc4732's failure) and returns a minimal ok `SessionResult`.
 * Injected as `runCoder`/`runInitializer`'s third (optional) parameter so
 * item 3's wiring — repairHandoffOnlyDirt called immediately after
 * verifyAndRepairTrailer — is exercised without a real Claude Agent SDK call.
 */
function fakeSessionLeavingDirt(
  root: string,
  specFile: string,
): (req: SessionRequest) => Promise<SessionResult> {
  return async (req: SessionRequest) => {
    await appendFile(path.join(root, specFile), "- handoff-only edit from fake session\n");
    return { role: req.role, ok: true, handoffNote: "fake session, no commit", model: req.model };
  };
}

function callSiteEnv(root: string): EphemeralEnv {
  return { envId: "test", branch: "spec/0021", buildUrl: "local", workdir: root };
}

function callSiteInput(specId: string, root: string): PipelineInput {
  return {
    specId,
    target: { kind: "self", repo: root },
    request: "test",
    requestedBy: "test@example.com",
  };
}

test(
  "runCoder call-site: repairHandoffOnlyDirt commits a handoff-only edit the (fake) session left dirty",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    const before = await git.headSha(root);
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-used-by-fake-session";
    try {
      const result = await runCoder(
        callSiteInput("0021", root),
        callSiteEnv(root),
        fakeSessionLeavingDirt(root, specFile),
      );
      assert.equal(result.progressed, false, "handoff-only edit must not read as progress");
    } finally {
      if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected the harness repair to commit the dirty handoff edit");
    assert.deepEqual(await git.dirtyFiles(root), [], "tree must be clean after runCoder returns");
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0021\): coder handoff \(auto-committed by harness\)/);
  },
);

test(
  "runInitializer call-site: repairHandoffOnlyDirt commits a handoff-only edit the (fake) session left dirty",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    const before = await git.headSha(root);
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-used-by-fake-session";
    try {
      await runInitializer(
        callSiteInput("0021", root),
        callSiteEnv(root),
        fakeSessionLeavingDirt(root, specFile),
      );
    } finally {
      if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected the harness repair to commit the dirty handoff edit");
    assert.deepEqual(await git.dirtyFiles(root), [], "tree must be clean after runInitializer returns");
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0021\): coder handoff \(auto-committed by harness\)/);
  },
);

test(
  "runRepair call-site: repairHandoffOnlyDirt commits a handoff-only edit the (fake) fixer session left dirty",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0021");
    const before = await git.headSha(root);
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-used-by-fake-session";
    const context: RepairContext = { error: "coder session threw: boom", stalled: false };
    try {
      await runRepair(
        callSiteInput("0021", root),
        callSiteEnv(root),
        context,
        fakeSessionLeavingDirt(root, specFile),
      );
    } finally {
      if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected the harness repair to commit the dirty handoff edit");
    assert.deepEqual(await git.dirtyFiles(root), [], "tree must be clean after runRepair returns");
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0021\): coder handoff \(auto-committed by harness\)/);
  },
);

test("premise pin: a handoff-only commit reads progressed:false (d)", () => {
  // Pins existing progress.ts behavior the coder-rule change relies on: a
  // spec-file-only commit with no checkbox change must NOT count as progress,
  // so committing the handoff (item 1) can't mask a stall — two nothing-to-do
  // sessions still trip gate 2 exactly as before.
  const specFile = "specs/0021-clean-tree-handoffs.md";
  assert.equal(
    sessionProgressed({ changedFiles: [specFile], checkboxDelta: 0, specFile }),
    false,
  );
});
