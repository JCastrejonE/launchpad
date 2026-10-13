/**
 * `commitDraftIfUncommitted` coverage (spec 0029 Part A item 1) — the harness
 * enforcement half of the dirty-primary/draft-isolation fix. `draftSpec` runs
 * before gate 1 and before any worktree exists, so for a brand-new spec it
 * writes `specs/NNNN-<slug>.md` straight into the PRIMARY checkout; leaving
 * that file uncommitted is the exact spec-0017 isolation violation this
 * closes. Exercised against a real temp git repo (same discipline as
 * handoff-dirt.test.ts: this commits/inspects with real git, so a mock buys
 * nothing).
 *
 * Cases:
 *   (a) spec-only dirt   → commits `docs(spec-NNNN): draft (auto-committed by
 *       harness)` WITH the Co-Authored-By trailer; tree clean afterwards.
 *   (b) clean tree (specFile not dirty, e.g. pre-committed OR a retry after a
 *       successful commit) → no-op, HEAD unchanged.
 *   (c) unrelated pre-existing dirt → spec committed via pathspec, the other
 *       dirt is left untouched, and a loud `[hygiene]` warning names it — NO
 *       throw (deliberately deviates from `repairHandoffOnlyDirt`'s
 *       only-dirt gate; the owner chose warn-don't-block here since refusing to
 *       commit would strand the new spec as dirt on `main`, the exact
 *       violation being fixed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";
import { coAuthorTrailer } from "./commit-trailer.js";
import { commitDraftIfUncommitted } from "./activities.js";
import { makeRepoWithSpec } from "./handoff-dirt.test.js";

test(
  "commitDraftIfUncommitted: spec-only dirt commits with the expected message + trailer (a)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0029");
    await appendFile(path.join(root, specFile), "- draft edit\n");
    const before = await git.headSha(root);
    await commitDraftIfUncommitted(root, specFile, "claude-sonnet-5");
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected a new commit");
    assert.deepEqual(await git.dirtyFiles(root), []);
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0029\): draft \(auto-committed by harness\)/);
    assert.ok(
      message.includes(coAuthorTrailer("claude-sonnet-5")),
      `expected trailer in: ${message}`,
    );
  },
);

test(
  "commitDraftIfUncommitted: specFile not dirty is a no-op (pre-committed / already-committed retry) (b)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0029");
    const before = await git.headSha(root);
    await commitDraftIfUncommitted(root, specFile, "claude-sonnet-5");
    const after = await git.headSha(root);
    assert.equal(after, before);
    assert.deepEqual(await git.dirtyFiles(root), []);
  },
);

test(
  "commitDraftIfUncommitted: unrelated pre-existing dirt is left untouched with a [hygiene] warning, spec still commits (c)",
  async () => {
    const { root, specFile } = await makeRepoWithSpec("0029");
    await appendFile(path.join(root, specFile), "- draft edit\n");
    await writeFile(path.join(root, "other.txt"), "unrelated dirt\n");
    const before = await git.headSha(root);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await commitDraftIfUncommitted(root, specFile, "claude-sonnet-5");
    } finally {
      console.warn = originalWarn;
    }
    const after = await git.headSha(root);
    assert.notEqual(after, before, "expected the spec file to still be committed");
    assert.deepEqual(await git.dirtyFiles(root), ["other.txt"]);
    const message = await git.lastCommitMessage(root);
    assert.match(message, /^docs\(spec-0029\): draft \(auto-committed by harness\)/);
    assert.ok(warnings.some((w) => w.includes("[hygiene]")), "expected a [hygiene] warning");
    assert.ok(warnings.some((w) => w.includes("other.txt")), "warning should name other.txt");
  },
);
