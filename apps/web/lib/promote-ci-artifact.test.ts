import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMOTE_CI_ARTIFACT_SCHEMA,
  promoteCiArtifactPath,
  parsePromoteCiArtifact,
  selectPromoteCiArtifact,
  type PromoteCiArtifact,
} from "./promote-ci-artifact.js";

// --- promote-ci artifact contract (spec 0058) -------------------------------
// The pure schema/path/parse foundation shared by the watcher's postMerge()
// writer (scripts/supervise.mjs, Plan item 1) and the gate reader
// (getPromoteCiState, Plan item 2). These cover the "treat as absent" mapping
// rules from Scope B; the coder extends this + pipeline.test.ts as the read
// seam and the three gate outcomes land.

const SHA = "deadbeefcafe0000deadbeefcafe0000deadbeef";

function artifact(overrides: Partial<PromoteCiArtifact> = {}): PromoteCiArtifact {
  return {
    schema: PROMOTE_CI_ARTIFACT_SCHEMA,
    specId: "0058",
    branch: "spec/0058",
    mergeSha: SHA,
    evaluatedSha: SHA,
    conclusion: "success",
    ranAt: "2026-07-16T00:00:00.000Z",
    steps: [{ name: "build", ok: true, ms: 12345 }],
    ...overrides,
  };
}

test("promoteCiArtifactPath: keys the file by repo root + merge SHA", () => {
  assert.equal(
    promoteCiArtifactPath("/home/dev/launchpad", SHA),
    `/home/dev/launchpad/.preflight/promote-ci-${SHA}.json`,
  );
});

test("parsePromoteCiArtifact: valid success artifact for the requested SHA → parsed", () => {
  const parsed = parsePromoteCiArtifact(JSON.stringify(artifact()), SHA);
  assert.ok(parsed);
  assert.equal(parsed?.conclusion, "success");
  assert.equal(parsed?.mergeSha, SHA);
});

test("parsePromoteCiArtifact: valid failure artifact → parsed (the genuine-block case)", () => {
  const parsed = parsePromoteCiArtifact(
    JSON.stringify(artifact({ conclusion: "failure" })),
    SHA,
  );
  assert.equal(parsed?.conclusion, "failure");
});

test("parsePromoteCiArtifact: malformed JSON → null (treated as absent)", () => {
  assert.equal(parsePromoteCiArtifact("{not json", SHA), null);
});

test("parsePromoteCiArtifact: non-object JSON → null", () => {
  assert.equal(parsePromoteCiArtifact("42", SHA), null);
  assert.equal(parsePromoteCiArtifact("null", SHA), null);
});

test("parsePromoteCiArtifact: wrong schema version → null", () => {
  assert.equal(parsePromoteCiArtifact(JSON.stringify(artifact({ schema: 2 as 1 })), SHA), null);
});

test("parsePromoteCiArtifact: mergeSha field != requested SHA → null (mis-keyed/stale file)", () => {
  const other = parsePromoteCiArtifact(JSON.stringify(artifact()), "some-other-sha");
  assert.equal(other, null);
});

test("parsePromoteCiArtifact: conclusion not success|failure → null (no local 'pending')", () => {
  assert.equal(
    parsePromoteCiArtifact(JSON.stringify(artifact({ conclusion: "pending" as "success" })), SHA),
    null,
  );
});

// --- selectPromoteCiArtifact: token-less specId+evaluatedSha guard (spec 0063 Scope B) ---

const MAIN_TIP = "cafefeeddeadbeef0000cafefeeddeadbeef0000";

test("selectPromoteCiArtifact: specId + evaluatedSha match → artifact", () => {
  const selected = selectPromoteCiArtifact(
    [JSON.stringify(artifact({ evaluatedSha: MAIN_TIP }))],
    "0058",
    MAIN_TIP,
  );
  assert.ok(selected);
  assert.equal(selected?.evaluatedSha, MAIN_TIP);
});

test("selectPromoteCiArtifact: evaluatedSha mismatch (stale/pre-polish) → null", () => {
  const selected = selectPromoteCiArtifact(
    [JSON.stringify(artifact({ evaluatedSha: SHA }))],
    "0058",
    MAIN_TIP,
  );
  assert.equal(selected, null);
});

test("selectPromoteCiArtifact: specId mismatch → null", () => {
  const selected = selectPromoteCiArtifact(
    [JSON.stringify(artifact({ specId: "0060", evaluatedSha: MAIN_TIP }))],
    "0058",
    MAIN_TIP,
  );
  assert.equal(selected, null);
});

test("selectPromoteCiArtifact: malformed JSON / wrong schema / bad conclusion → null", () => {
  assert.equal(selectPromoteCiArtifact(["{not json"], "0058", MAIN_TIP), null);
  assert.equal(
    selectPromoteCiArtifact(
      [JSON.stringify(artifact({ schema: 2 as 1, evaluatedSha: MAIN_TIP }))],
      "0058",
      MAIN_TIP,
    ),
    null,
  );
  assert.equal(
    selectPromoteCiArtifact(
      [JSON.stringify(artifact({ conclusion: "pending" as "success", evaluatedSha: MAIN_TIP }))],
      "0058",
      MAIN_TIP,
    ),
    null,
  );
});

test("selectPromoteCiArtifact: two matches → latest ranAt wins", () => {
  const older = artifact({ evaluatedSha: MAIN_TIP, ranAt: "2026-07-16T00:00:00.000Z" });
  const newer = artifact({
    evaluatedSha: MAIN_TIP,
    ranAt: "2026-07-16T01:00:00.000Z",
    conclusion: "failure",
  });
  const selected = selectPromoteCiArtifact(
    [JSON.stringify(older), JSON.stringify(newer)],
    "0058",
    MAIN_TIP,
  );
  assert.equal(selected?.ranAt, newer.ranAt);
  assert.equal(selected?.conclusion, "failure");
});
