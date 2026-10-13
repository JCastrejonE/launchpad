import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ARCHITECT_ALLOWED_TOOLS,
  architectFenceViolations,
  createArchitectCanUseTool,
  isAllowedArchitectWritePath,
  readArchitectSpecDraft,
  runArchitectSpawn,
  type GitStatusFn,
} from "./architect-session.js";
import { modelForRole, DEFAULT_MODEL_FOR_ROLE, MODEL_ENV_VAR_FOR_ROLE } from "./models.js";
import type { QueryFn } from "./session.js";
import type { SupervisorEvent } from "./supervisor-session.js";

// Repo root, computed the same way supervisor-session.test.ts does — the
// compiled test runs from packages/agents/dist, so three levels up reaches the
// checkout root where CLAUDE.md and agents/spec-drafter.md live.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// --- Foundation invariants (spec 0050) — these run now and lock the seams. ---

test("architect tool surface stays execution-free — no Bash/Edit (spec 0050, widened by 0147)", () => {
  const tools = ARCHITECT_ALLOWED_TOOLS as readonly string[];
  // Spec 0147 added AskUserQuestion so the drafter can ASK which track a spec
  // is instead of defaulting to 1 (a mislabelled track renders as a page with
  // no gates and no Start). A question executes nothing, writes nothing and
  // returns only what the human chose, so the ADR-015 boundary is unchanged —
  // and the assertions that DEFINE that boundary are the ones below.
  assert.deepEqual([...tools], ["Read", "Grep", "Glob", "Write", "AskUserQuestion"]);
  assert.ok(!tools.includes("Bash"), "architect must not have the Bash tool (execution-free)");
  assert.ok(!tools.includes("Edit"), "architect must not have the Edit tool (execution-free)");
  // The exhaustive check, so a future addition has to come here and argue:
  // nothing in this surface may run a command or mutate anything but the spec.
  for (const t of tools) {
    assert.ok(
      ["Read", "Grep", "Glob", "Write", "AskUserQuestion"].includes(t),
      `${t} is not an execution-free drafting tool`,
    );
  }
});

// Spec 0099 (G.1) collapsed `architect` into the one `spec-drafter` role and
// retired its claude-fable-5 PIN (SPEC-ALIGNMENT §10.A: the pin was justified
// only by a self-report tripwire the runner never reads). What replaces the old
// "is it pinned to fable" assertion is the property that actually matters: the
// role resolves to ONE model, shared by both entry points, and stays
// overridable.
test("the drafting role has a single overridable model (spec 0099 retired the fable pin)", () => {
  assert.equal(modelForRole("spec-drafter"), DEFAULT_MODEL_FOR_ROLE["spec-drafter"]);
  assert.equal(MODEL_ENV_VAR_FOR_ROLE["spec-drafter"], "LAUNCHPAD_MODEL_SPEC_DRAFTER");
  assert.equal(
    modelForRole("spec-drafter", { "spec-drafter": "claude-opus-4-8" }),
    "claude-opus-4-8",
    "an account/env override must still win",
  );
  // The retired role must leave no default behind for a stale caller to hit.
  assert.ok(
    !("architect" in DEFAULT_MODEL_FOR_ROLE),
    "the `architect` role should be gone, not silently aliased",
  );
  assert.ok(!("architect" in MODEL_ENV_VAR_FOR_ROLE));
});

test("agents/spec-drafter.md loads and encodes the execution-free boundary + both entry points", async () => {
  const roleMd = await readFile(path.join(REPO_ROOT, "agents/spec-drafter.md"), "utf8");
  assert.match(roleMd, /execution-free/i);
  assert.match(roleMd, /specs\/<specId>/);
  // Spec 0099: one behaviour, two entry points — the role file must describe
  // both, since the same prompt now serves the pipeline and the in-UI spawn.
  assert.match(roleMd, /draftSpec/, "role file must name the Temporal entry point");
  assert.match(roleMd, /supervisor/i, "role file must name the in-UI entry point");
  assert.doesNotMatch(
    roleMd,
    /claude-fable-5/,
    "the retired model pin must not survive in the role prompt",
  );
});

test("runArchitectSpawn is exported as a function (implemented in A1/A2)", () => {
  assert.equal(typeof runArchitectSpawn, "function");
});

// --- A1 behavioral tests ------------------------------------------------

const credential = { mode: "api-key", apiKey: "sk-test" } as const;

/** Build a fake `queryFn` yielding a canned sequence of raw SDK messages,
 * mirroring supervisor-session.test.ts's `fakeQuery` helper. */
function fakeQuery(messages: unknown[]): QueryFn {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
}

async function collect(gen: AsyncGenerator<SupervisorEvent, void, unknown>): Promise<SupervisorEvent[]> {
  const out: SupervisorEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

/** Minimal, well-typed stand-in for the `canUseTool` third argument — the
 * fields `runArchitectSpawn`'s policy never inspects don't need real values. */
function fakePermissionOptions() {
  return { signal: new AbortController().signal, toolUseID: "tu_1", requestId: "req_1" };
}

/** `CanUseTool` returns `PermissionResult | null` (null only means "the
 * consumer already answered out-of-band" — never the case for our synchronous
 * policy); asserts non-null so tests can read `.behavior` directly. */
function assertDenied(result: Awaited<ReturnType<ReturnType<typeof createArchitectCanUseTool>>>): void {
  assert.ok(result, "expected a PermissionResult, got null");
  assert.equal(result.behavior, "deny");
}

// A fake gitStatusFn with no working-tree change at all — the terminal A2
// checks (fence backstop) then have nothing to flag; only the model check and
// the on-disk draft read decide the outcome. Most A2 tests that don't care
// about the fence use this.
const noWorkingTreeChange: GitStatusFn = async () => [];

test("runArchitectSpawn streams assistant text as architect_progress events", async () => {
  const q = fakeQuery([
    {
      type: "system",
      subtype: "init",
      model: modelForRole("spec-drafter"),
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading the codebase to ground the spec..." }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Drafting specs/0051-example.md now." }] },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const events = await collect(
    runArchitectSpawn(
      { credential, workdir: process.cwd(), brief: "add dark mode", specId: "0051" },
      q,
      noWorkingTreeChange,
    ),
  );

  // The fake session's model matches and the fence is clean, but no message
  // actually wrote specs/0051-*.md to disk — so the terminal event is the
  // "no draft found" error, not a spec_draft (a real Write would make it
  // findable; see the success-path test below).
  assert.deepEqual(events, [
    { type: "architect_progress", delta: "Reading the codebase to ground the spec..." },
    { type: "architect_progress", delta: "Drafting specs/0051-example.md now." },
    {
      type: "error",
      message: "architect finished but did not write specs/0051-*.md",
    },
  ]);
});

test("runArchitectSpawn yields spec_draft when the model matches, the fence is clean, and the file is on disk", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "launchpad-architect-spawn-"));
  try {
    await mkdir(path.join(workdir, "specs"), { recursive: true });
    await writeFile(
      path.join(workdir, "specs", "0051-dark-mode.md"),
      [
        "---",
        "id: 0051",
        "title: Dark mode toggle",
        "status: draft",
        "---",
        "",
        "## Intent",
        "Add a dark mode toggle to the settings page.",
        "",
        "## Scope",
        "TBD.",
        "",
        // Spec 0217: the draft-time required headings, byte-exact English —
        // `specStructureViolations` now runs between readArchitectSpecDraft and
        // the spec_draft event, so an incomplete fixture is a rejected draft.
        "## Acceptance criteria",
        "1. The toggle persists the choice.",
        "",
        "## Out of scope / deferred",
        "- Custom themes.",
        "",
        "## Handoff log",
        "",
      ].join("\n"),
      "utf8",
    );

    const q = fakeQuery([
      { type: "system", subtype: "init", model: modelForRole("spec-drafter") },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Drafting specs/0051-dark-mode.md now." }] },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);

    // Simulate the architect's own Write: the spec file shows up as a new
    // dirty path between the before/after snapshots, and nothing else does.
    const gitStatusFn: GitStatusFn = (() => {
      let calls = 0;
      return async () => (calls++ === 0 ? [] : ["specs/0051-dark-mode.md"]);
    })();

    const events = await collect(
      runArchitectSpawn(
        { credential, workdir, brief: "add dark mode", specId: "0051" },
        q,
        gitStatusFn,
      ),
    );

    assert.deepEqual(events, [
      { type: "architect_progress", delta: "Drafting specs/0051-dark-mode.md now." },
      {
        type: "spec_draft",
        specId: "0051",
        specPath: path.join("specs", "0051-dark-mode.md"),
        title: "Dark mode toggle",
        summary: "Add a dark mode toggle to the settings page.",
        model: modelForRole("spec-drafter"),
      },
    ]);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("runArchitectSpawn discards a draft whose structure is not byte-exact English (spec 0217)", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "launchpad-architect-structure-"));
  try {
    await mkdir(path.join(workdir, "specs"), { recursive: true });
    // A drafter that translated the structure along with the prose: the
    // headings are Spanish and its checklist lands outside `## Progress`.
    await writeFile(
      path.join(workdir, "specs", "0051-modo-oscuro.md"),
      [
        "---",
        "id: 0051",
        "title: Interruptor de modo oscuro",
        "status: draft",
        "---",
        "",
        "## Intención",
        "Añadir un interruptor de modo oscuro.",
        "",
        "## Progreso",
        "- [ ] el interruptor",
        "",
      ].join("\n"),
      "utf8",
    );

    const q = fakeQuery([
      { type: "system", subtype: "init", model: modelForRole("spec-drafter") },
      { type: "result", subtype: "success", result: "done" },
    ]);
    const gitStatusFn: GitStatusFn = (() => {
      let calls = 0;
      return async () => (calls++ === 0 ? [] : ["specs/0051-modo-oscuro.md"]);
    })();

    const events = await collect(
      runArchitectSpawn(
        { credential, workdir, brief: "modo oscuro", specId: "0051" },
        q,
        gitStatusFn,
      ),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error", "a mistranslated structure must not reach review");
    const message = (events[0] as { message: string }).message;
    assert.match(message, /spec structure violation \(spec 0217\)/);
    assert.match(message, /## Intent/, "the missing heading must be named");
    assert.match(message, /checkbox item outside "## Progress"/);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("runArchitectSpawn discards the draft on a model-identity mismatch (spec 0050 / ADR-015)", async () => {
  const q = fakeQuery([
    { type: "system", subtype: "init", model: "some-other-model" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Drafting specs/0051-example.md now." }] },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const events = await collect(
    runArchitectSpawn(
      { credential, workdir: process.cwd(), brief: "add dark mode", specId: "0051" },
      q,
      noWorkingTreeChange,
    ),
  );

  assert.deepEqual(events, [
    { type: "architect_progress", delta: "Drafting specs/0051-example.md now." },
    {
      type: "error",
      message:
        `architect model mismatch (spec 0050 / ADR-015): requested ${modelForRole("spec-drafter")}, ` +
        "got some-other-model — discarding the draft",
    },
  ]);
});

test("runArchitectSpawn discards the draft on an execution-free fence violation (spec 0050 / ADR-015)", async () => {
  const q = fakeQuery([
    { type: "system", subtype: "init", model: modelForRole("spec-drafter") },
    { type: "result", subtype: "success", result: "done" },
  ]);

  // A simulated stray write outside specs/ — the canUseTool gate is supposed
  // to prevent this, but the fence is defense-in-depth for a gap in that gate.
  const gitStatusFn: GitStatusFn = (() => {
    let calls = 0;
    return async () => (calls++ === 0 ? [] : ["docs/DECISIONS.md"]);
  })();

  const events = await collect(
    runArchitectSpawn(
      { credential, workdir: process.cwd(), brief: "add dark mode", specId: "0051" },
      q,
      gitStatusFn,
    ),
  );

  assert.deepEqual(events, [
    {
      type: "error",
      message:
        "architect execution-free fence violation (spec 0050 / ADR-015): touched " +
        "docs/DECISIONS.md outside specs/0051-*.md — discarding the draft",
    },
  ]);
});

test("architectFenceViolations ignores paths already dirty before the session and paths inside specs/<specId>-*.md", () => {
  assert.deepEqual(
    architectFenceViolations(["specs/0049-x.md" /* pre-existing dirt */], ["specs/0049-x.md"], "0051"),
    [],
  );
  assert.deepEqual(architectFenceViolations([], ["specs/0051-new.md"], "0051"), []);
  assert.deepEqual(architectFenceViolations([], ["specs/0051-new.md", "CLAUDE.md"], "0051"), [
    "CLAUDE.md",
  ]);
  assert.deepEqual(architectFenceViolations([], ["specs/0099-wrong-id.md"], "0051"), [
    "specs/0099-wrong-id.md",
  ]);
});

test("readArchitectSpecDraft returns null when no specs/<specId>-*.md file exists", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "launchpad-architect-draft-"));
  try {
    await mkdir(path.join(workdir, "specs"), { recursive: true });
    assert.equal(await readArchitectSpecDraft(workdir, "0051"), null);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("createArchitectCanUseTool allows a Write scoped to specs/<specId>-*.md", async () => {
  const workdir = process.cwd();
  const canUseTool = createArchitectCanUseTool(workdir, "0051");
  const input = { file_path: path.join(workdir, "specs", "0051-example.md"), content: "..." };
  const result = await canUseTool("Write", input, fakePermissionOptions());
  // `updatedInput` is NOT cosmetic: the SDK's runtime permission-response schema
  // requires it, and an allow without it is rejected as malformed — so from spec
  // 0050 until 0099 this gate turned every PERMITTED write into a hard failure.
  // `PermissionResult` types it optional, which is why tsc never complained and
  // why the old `deepEqual(result, {behavior:"allow"})` assertion passed while
  // the real thing could not write a single spec. Assert the full shape.
  assert.deepEqual(result, { behavior: "allow", updatedInput: input });
});

test("createArchitectCanUseTool denies a Write outside specs/<specId>-*.md", async () => {
  const workdir = process.cwd();
  const canUseTool = createArchitectCanUseTool(workdir, "0051");

  const wrongId = await canUseTool(
    "Write",
    { file_path: path.join(workdir, "specs", "0099-example.md"), content: "..." },
    fakePermissionOptions(),
  );
  assertDenied(wrongId);

  const outsideSpecs = await canUseTool(
    "Write",
    { file_path: path.join(workdir, "docs", "0051-example.md"), content: "..." },
    fakePermissionOptions(),
  );
  assertDenied(outsideSpecs);

  const nested = await canUseTool(
    "Write",
    { file_path: path.join(workdir, "specs", "nested", "0051-example.md"), content: "..." },
    fakePermissionOptions(),
  );
  assertDenied(nested);

  const traversal = await canUseTool(
    "Write",
    { file_path: path.join(workdir, "specs", "..", "CLAUDE.md"), content: "..." },
    fakePermissionOptions(),
  );
  assertDenied(traversal);
});

test("createArchitectCanUseTool denies Bash and Edit outright (execution-free, defense-in-depth)", async () => {
  const canUseTool = createArchitectCanUseTool(process.cwd(), "0051");
  const bash = await canUseTool("Bash", { command: "rm -rf /" }, fakePermissionOptions());
  assertDenied(bash);
  const edit = await canUseTool(
    "Edit",
    { file_path: "CLAUDE.md", old_string: "a", new_string: "b" },
    fakePermissionOptions(),
  );
  assertDenied(edit);
});

test("createArchitectCanUseTool allows Read/Grep/Glob unconditionally", async () => {
  const canUseTool = createArchitectCanUseTool(process.cwd(), "0051");
  for (const tool of ["Read", "Grep", "Glob"]) {
    const result = await canUseTool(tool, {}, fakePermissionOptions());
    // Same SDK requirement as the Write allow above — every allow echoes input.
    assert.deepEqual(result, { behavior: "allow", updatedInput: {} }, `${tool} should be allowed`);
  }
});

test("isAllowedArchitectWritePath is the pure check createArchitectCanUseTool builds on", () => {
  const workdir = process.cwd();
  assert.ok(isAllowedArchitectWritePath(workdir, "0051", path.join(workdir, "specs", "0051-example.md")));
  assert.ok(!isAllowedArchitectWritePath(workdir, "0051", path.join(workdir, "specs", "0099-example.md")));
  assert.ok(!isAllowedArchitectWritePath(workdir, "0051", path.join(workdir, "specs", "0051-example.txt")));
  assert.ok(
    !isAllowedArchitectWritePath(workdir, "0051", path.join(workdir, "specs", "nested", "0051-example.md")),
  );
});

// Spec 0147: the drafter asking about the track is the fix for a spec whose
// mislabelled track made the product look broken. The gate must actually
// deliver the answer — and must never silently allow an unanswered question.
test("the drafter's AskUserQuestion resolves with the human's answer", async () => {
  const gate = createArchitectCanUseTool(REPO_ROOT, "0147", async () => ({
    "¿Track?": "Track 2",
  }));
  const decision = (await gate(
    "AskUserQuestion",
    { questions: [{ question: "¿Track?", options: [{ label: "Track 2" }] }] },
    { signal: new AbortController().signal, suggestions: [] } as never,
  )) as unknown as { behavior: string; updatedInput: { answers: unknown } };
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput.answers, { "¿Track?": "Track 2" });
});

test("a drafting session with nobody to ask DENIES the question, with a reason", async () => {
  const headless = createArchitectCanUseTool(REPO_ROOT, "0147");
  const d = (await headless(
    "AskUserQuestion",
    { questions: [] },
    { signal: new AbortController().signal, suggestions: [] } as never,
  )) as unknown as { behavior: string; message: string };
  assert.equal(d.behavior, "deny");
  assert.match(d.message, /criterio/);
});

test("widening to AskUserQuestion did NOT open Bash or Edit", async () => {
  const gate = createArchitectCanUseTool(REPO_ROOT, "0147", async () => ({}));
  for (const tool of ["Bash", "Edit", "NotebookEdit"]) {
    const d = (await gate(tool, {}, { signal: new AbortController().signal, suggestions: [] } as never)) as unknown as {
      behavior: string;
    };
    assert.equal(d.behavior, "deny", `${tool} must stay denied`);
  }
});
