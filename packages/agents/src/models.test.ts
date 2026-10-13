import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelForRole,
  modelOverridesFromEnv,
  modelForCoderItem,
  DEFAULT_MODEL_FOR_ROLE,
  DOCS_MODEL,
} from "./models.js";
import { loadCredential } from "./credentials.js";

test("modelForRole returns the documented default for each role", () => {
  assert.equal(modelForRole("initializer"), DEFAULT_MODEL_FOR_ROLE.initializer);
  assert.equal(modelForRole("coder"), DEFAULT_MODEL_FOR_ROLE.coder);
  assert.equal(modelForRole("spec-drafter"), DEFAULT_MODEL_FOR_ROLE["spec-drafter"]);
});

test("modelForRole applies an account override when present", () => {
  assert.equal(modelForRole("coder", { coder: "claude-haiku-5" }), "claude-haiku-5");
});

test("modelForRole falls back to the default for roles absent from overrides", () => {
  assert.equal(modelForRole("initializer", { coder: "claude-haiku-5" }), DEFAULT_MODEL_FOR_ROLE.initializer);
});

// --- Per-item model routing (spec 0007, item 6) --------------------------
test("modelForCoderItem routes [docs] items to DOCS_MODEL", () => {
  assert.equal(modelForCoderItem("docs"), DOCS_MODEL);
});

test("modelForCoderItem routes [code] items to the coder default", () => {
  assert.equal(modelForCoderItem("code"), DEFAULT_MODEL_FOR_ROLE.coder);
});

test("modelForCoderItem honors a coder override for [code] items", () => {
  assert.equal(modelForCoderItem("code", { coder: "claude-sonnet-custom" }), "claude-sonnet-custom");
});

test("modelOverridesFromEnv reads only the LAUNCHPAD_MODEL_* vars that are set", () => {
  const overrides = modelOverridesFromEnv({ LAUNCHPAD_MODEL_CODER: "claude-haiku-5" });
  assert.deepEqual(overrides, { coder: "claude-haiku-5" });
});

test("env overrides win in the dev fallback path (loadCredential owner branch)", async () => {
  const prevOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  const prevOverride = process.env["LAUNCHPAD_MODEL_INITIALIZER"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok-test";
  process.env["LAUNCHPAD_MODEL_INITIALIZER"] = "claude-opus-test";
  try {
    const cfg = await loadCredential("owner");
    assert.equal(modelForRole("initializer", cfg.modelOverrides), "claude-opus-test");
    // Roles without an env var still fall back to the documented default.
    assert.equal(modelForRole("coder", cfg.modelOverrides), DEFAULT_MODEL_FOR_ROLE.coder);
  } finally {
    if (prevOauth === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = prevOauth;
    if (prevOverride === undefined) delete process.env["LAUNCHPAD_MODEL_INITIALIZER"];
    else process.env["LAUNCHPAD_MODEL_INITIALIZER"] = prevOverride;
  }
});

// --- Spec 0103: the owner's model assignment ---------------------------------------
// Locked because these two are deliberate cost/quality choices, not incidental
// values: a silent revert would quietly change what every run costs and how well
// it drafts. Asserted as literals HERE on purpose — this test's whole subject is
// which model each role gets. Elsewhere (e.g. draft-spec.test.ts's commit
// trailer) the constant must be read instead, which is what spec 0103 fixed.

test("spec 0103: the drafting role runs on Fable", () => {
  assert.equal(modelForRole("spec-drafter"), "claude-fable-5");
  // Not a reversal of spec 0099: 0099 made the model an overridable CHOICE
  // (removing a bogus security justification for the pin); this exercises it.
  assert.equal(
    modelForRole("spec-drafter", { "spec-drafter": "claude-sonnet-5" }),
    "claude-sonnet-5",
    "an account/env override must still win over the owner's default",
  );
});

test("spec 0103/0197: every code-writing role runs on Opus 5", () => {
  for (const role of ["coder", "initializer", "fixer"] as const) {
    assert.equal(modelForRole(role), "claude-opus-5", `${role} should be Opus 5`);
  }
  // One Opus version across the repo — a second one would be a latent trap, and
  // spec 0197 moved the version rather than breaking the rule.
  const opus = new Set(
    (["coder", "initializer", "fixer", "supervisor"] as const).map((r) => modelForRole(r)),
  );
  assert.equal(opus.size, 1, `expected a single Opus version, got ${[...opus].join(", ")}`);
});

// Spec 0197: the role is gone, and the type is what enforces it. A future edit
// that re-adds "uiux-coder" to AgentRole would make this stop compiling — which
// is the point: nothing could reach that session (no service, no cron, no
// process), and a model default for unreachable code is a maintenance tax.
test("spec 0197: uiux-coder is not a role any more", () => {
  assert.deepEqual(Object.keys(DEFAULT_MODEL_FOR_ROLE).sort(), [
    "coder",
    "fixer",
    "initializer",
    "spec-drafter",
    "supervisor",
  ]);
});

test("spec 0103: [docs] items stay on the cheap model even though the coder is Opus", () => {
  // The point of the tag. Moving the coder to Opus makes this split MORE
  // valuable, so a future edit must not "simplify" it away.
  assert.equal(modelForCoderItem("docs"), DOCS_MODEL);
  assert.notEqual(modelForCoderItem("docs"), modelForRole("coder"));
  assert.equal(modelForCoderItem("code"), "claude-opus-5");
  assert.equal(modelForCoderItem("code", { coder: "claude-sonnet-5" }), "claude-sonnet-5");
});
