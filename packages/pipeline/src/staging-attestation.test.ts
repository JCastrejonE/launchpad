/**
 * Spec 0192 B. Run 4's stop, in one assertion: a branch whose front failed to
 * build must not end up with `staging_sha = <branch head>`, because that is the
 * fact 0136's promote guard and 0187 A's freshness notice both read as "somebody
 * validated this commit on a server".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { frontFailureNote, stagingRowUpdate } from "./staging-attestation.js";

const HEAD = "b887a9f1fd679b4bb7cf26858d91f248d94f83a4";
const BASE = "1c0ffee0000000000000000000000000000000ee";
const OK = { stack: "br-owner-landing-tarjetas-89c79c", host: "br.gaming-tech.example" };

test("a whole environment attests the commit it ran", () => {
  assert.deepEqual(stagingRowUpdate({ ...OK, front: { failed: undefined } }, HEAD, BASE), {
    status: "ready",
    stack: OK.stack,
    host: OK.host,
    sha: HEAD,
    baseSha: BASE,
  });
});

test("an addons-only project (no front at all) still attests", () => {
  assert.deepEqual(stagingRowUpdate(OK, HEAD, BASE), {
    status: "ready",
    stack: OK.stack,
    host: OK.host,
    sha: HEAD,
    baseSha: BASE,
  });
});

test("a front that did not build attests NOTHING — run 4's exact result", () => {
  const update = stagingRowUpdate(
    {
      ...OK,
      front: {
        failed:
          "docker compose up -d --build failed for gaming-tech-br-owner-landing-tarjetas-89c79c-front " +
          "(exit 1): [Error: ENOENT: no such file or directory, stat '/app/specs']",
      },
    },
    HEAD,
    BASE,
  );
  assert.equal(update.status, "failed");
  // Spec 0195 B: and it says WHY, in the row, where the reviewer is.
  assert.match(
    update.status === "failed" ? update.note : "",
    /ENOENT: no such file or directory, stat '\/app\/specs'/,
  );
  assert.equal(
    JSON.stringify(update).includes(HEAD),
    false,
    "the head must not appear anywhere in a failed row's update",
  );
  // The stack and host are still recorded: the environment EXISTS, and the
  // panel needs its name to offer "Reintentar staging" / "Destruir staging".
  assert.equal(update.stack, OK.stack);
  assert.equal(update.host, OK.host);
});

/**
 * The rule is only worth anything if BOTH staging writers go through it — the
 * gate-2 refresh and the explicit create/redeploy. A second call site that
 * builds its own object is exactly the shape of docs/VERIFICATION.md #12, so
 * this asserts there is no other `setBranchStaging(..., { status: "ready" ... })`
 * in the activities.
 */
test("every staging writer goes through the shared rule", async () => {
  const candidates = [
    new URL("../src/activities.ts", import.meta.url),
    new URL("./activities.ts", import.meta.url),
  ];
  let src = "";
  for (const url of candidates) {
    src = await readFile(url, "utf8").catch(() => "");
    if (src) break;
  }
  assert.ok(src, "could not read activities.ts");
  const viaRule = src.match(/setBranchStaging\(db, row\.id, stagingRowUpdate\(/g) ?? [];
  assert.equal(viaRule.length, 2, "both staging deploy paths must use stagingRowUpdate");
  assert.doesNotMatch(
    src,
    /setBranchStaging\([^)]*status:\s*"ready"/s,
    'no call site may hand-build a "ready" row',
  );
});

// --- spec 0195 B: the reason, trimmed for a page ----------------------------

test("frontFailureNote keeps the END of a build failure — the reason is last", () => {
  const noise = "#7 [builder 3/4] RUN npm ci ".repeat(80);
  const note = frontFailureNote(`${noise}\n#11 2.263 [Error: ENOENT … stat '/app/specs']`);
  assert.ok(note.length <= 301, `too long for a table cell: ${note.length}`);
  assert.match(note, /ENOENT/, "the reason must survive the trim");
  assert.match(note, /^…/, "a trimmed note says it was trimmed");
});

test("a short failure is not decorated", () => {
  assert.equal(frontFailureNote("no such stack"), "no such stack");
});

test("newlines collapse — this renders in one row", () => {
  assert.equal(frontFailureNote("a\n\n  b\tc"), "a b c");
});
