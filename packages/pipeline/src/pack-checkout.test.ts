/**
 * Spec 0192 A. The failure this guards was observed live, twice removed from
 * where it looked like it was: a branch's front served the page from BEFORE the
 * change, because the build context carried `specs` — a symlink to
 * `/srv/launchpad/specs/<slug>` (spec 0141) that resolves on the worker and
 * points at nothing inside the image. `next build` stats it and dies with
 * `ENOENT: no such file or directory, stat '/app/specs'`.
 *
 * These assert the EXTRACTED TREE — what a docker build would actually see —
 * not the argv we handed tar (VERIFICATION #1). The first reproduction attempt
 * used `git archive`, which exports only TRACKED files and so could never carry
 * a git-excluded symlink: a check that could not fail (VERIFICATION #2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packCheckoutWithTar, escapingSymlinkExcludes } from "./pack-checkout.js";

const execFileP = promisify(execFile);

/** A checkout shaped like the real thing: a front to build, our `specs` symlink
 * pointing at a directory OUTSIDE it (which exists — that is the whole trap),
 * a dangling link, and a link that stays inside the tree. */
function fixture(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pack-checkout-"));
  const root = path.join(base, "checkout");
  const outside = path.join(base, "srv-specs");
  mkdirSync(path.join(root, "app"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "0001-something.md"), "# not the customer's\n");
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-alpine\n");
  writeFileSync(path.join(root, "app", "page.tsx"), "export default function Page() {}\n");
  // What `runCi` leaves in the run's worktree, which the gate-2 refresh packs.
  mkdirSync(path.join(root, ".next", "static"), { recursive: true });
  writeFileSync(path.join(root, ".next", "static", "chunk.js"), "// the worker's build\n");
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "x.js"), "// host arch\n");
  symlinkSync(outside, path.join(root, "specs"));
  symlinkSync("/nonexistent-target-9f2", path.join(root, "dangling"));
  symlinkSync("./app", path.join(root, "inside"));
  return { root, outside };
}

/** Unpack what the front deploy would upload, the same way the box does. */
async function unpack(archiveB64: string): Promise<string> {
  const dest = mkdtempSync(path.join(tmpdir(), "pack-checkout-out-"));
  const b64 = path.join(dest, "source.tar.gz.b64");
  writeFileSync(b64, archiveB64);
  await execFileP("bash", ["-c", `base64 -d < ${b64} | tar -xzf - -C ${dest}`]);
  return dest;
}

test("the packed context carries no link a build cannot follow", async () => {
  const { root } = fixture();
  const out = await unpack(await packCheckoutWithTar(root));

  assert.ok(existsSync(path.join(out, "Dockerfile")), "the front must still be buildable");
  assert.ok(existsSync(path.join(out, "app/page.tsx")), "and its sources must be there");

  // The two that would dangle inside the image — this is the run-4 failure.
  assert.equal(lstatSync(path.join(out, "specs"), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(path.join(out, "dangling"), { throwIfNoEntry: false }), undefined);

  // And the worker's own build output, which the gate-2 refresh would otherwise
  // pack out of the run's worktree and lay under the image's `next build`.
  assert.equal(lstatSync(path.join(out, ".next"), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(path.join(out, "node_modules"), { throwIfNoEntry: false }), undefined);

  // ...and a link that stays inside the tree is NOT collateral: the rule is
  // about the target, not about symlinks.
  const inside = lstatSync(path.join(out, "inside"), { throwIfNoEntry: false });
  assert.ok(inside?.isSymbolicLink(), "an in-tree symlink must survive the pack");
  assert.ok(existsSync(path.join(out, "inside")), "and must still resolve after extraction");
});

test("a checkout with nothing to exclude packs exactly as before", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pack-plain-"));
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-alpine\n");
  assert.deepEqual(await escapingSymlinkExcludes(root), []);
  const out = await unpack(await packCheckoutWithTar(root));
  assert.ok(existsSync(path.join(out, "Dockerfile")));
});

test("an unreadable root yields no excludes rather than failing the pack", async () => {
  assert.deepEqual(await escapingSymlinkExcludes("/definitely/not/a/directory/9f2"), []);
});
