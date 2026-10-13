import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestBody } from "./pr-body.js";

test("lead line includes the title when present", () => {
  const body = buildPullRequestBody({
    specId: "0006",
    title: "Coder loop convergence",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.match(body, /^Spec 0006: Coder loop convergence/);
});

test("lead line falls back to bare 'Spec <id>' when title is ''", () => {
  const body = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.match(body, /^Spec 0006(?!:)/);
});

test("goal paragraph is rendered byte-verbatim, omitted when ''", () => {
  const withGoal = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "Multi-line goal\nwith an internal line break.",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.match(withGoal, /Multi-line goal\nwith an internal line break\./);

  const withoutGoal = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.equal(withoutGoal, "Spec 0006");
});

test("clean convergence: no stall note", () => {
  const body = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "did a thing",
  });
  assert.ok(!/stalled/i.test(body));
});

test("stall arrival: prominent 'coder loop stalled' note + last handoff", () => {
  const body = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: true,
    lastHandoff: "blocked on gate click",
  });
  assert.match(body, /coder loop stalled/i);
  assert.match(body, /blocked on gate click/);
});

test("Key changes rendered as a plain bullet list, omitted when empty", () => {
  const withChanges = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: ["did thing one", "did thing two"],
    stalled: false,
    lastHandoff: "",
  });
  assert.match(withChanges, /## Key changes/);
  assert.match(withChanges, /- did thing one/);
  assert.match(withChanges, /- did thing two/);

  const withoutChanges = buildPullRequestBody({
    specId: "0006",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.ok(!/## Key changes/.test(withoutChanges));
});

test("never renders a 'Waiting on you' section, for any input", () => {
  const bodies = [
    buildPullRequestBody({
      specId: "0006",
      title: "A title",
      goal: "A goal.",
      keyChanges: ["a change"],
      stalled: true,
      lastHandoff: "an entry",
    }),
    buildPullRequestBody({
      specId: "0006",
      title: "",
      goal: "",
      keyChanges: [],
      stalled: false,
      lastHandoff: "",
    }),
  ];
  for (const body of bodies) {
    assert.doesNotMatch(body, /Waiting on you/);
  }
});

test("empty-everything input still yields a valid 'Spec <id>' body", () => {
  const body = buildPullRequestBody({
    specId: "0099",
    title: "",
    goal: "",
    keyChanges: [],
    stalled: false,
    lastHandoff: "",
  });
  assert.equal(body, "Spec 0099");
});
