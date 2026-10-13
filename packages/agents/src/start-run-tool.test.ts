/**
 * Spec 0174 — the tool that makes "the chat runs the pipeline" true.
 *
 * Two live sessions asked to draft a spec and run the pipeline produced no run,
 * because this surface had no way to start one: the tool below did not exist,
 * `cli.js start` is denied (and would target the launchpad's own repo anyway),
 * and the prompt told the agent to commit instead. These pin the contract the
 * host relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStartRunServer,
  PROJECT_AUTO_APPROVED_TOOLS,
  SUPERVISOR_AUTO_APPROVED_TOOLS,
  START_RUN_TOOL_FQN,
  type StartRunInput,
  type StartRunResult,
} from "./supervisor-session.js";

/** The SDK's server object keeps its tools; reach the one handler under test.
 * Measured against the SDK rather than assumed: the registered entry exposes
 * `handler`, and a guess at `callback` returned undefined — a test that calls
 * `undefined()` fails for a reason that has nothing to do with the contract. */
function handlerOf(server: unknown): (args: StartRunInput, extra?: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const tools = (server as { instance?: { _registeredTools?: Record<string, { handler: unknown }> } })
    .instance?._registeredTools;
  const entry = tools ? Object.values(tools)[0] : undefined;
  assert.ok(entry, "the server must register exactly one tool");
  assert.equal(typeof entry!.handler, "function", "the SDK's registered tool must expose a handler");
  return entry!.handler as never;
}

test("spec 0174: the tool forwards the spec id and request to the host's starter", async () => {
  const seen: StartRunInput[] = [];
  const server = createStartRunServer(async (input) => {
    seen.push(input);
    return { ok: true, workflowId: "spec-sushi-0001" };
  });
  const out = await handlerOf(server)({ specId: "0001", request: "menú + addon" });
  assert.deepEqual(seen, [{ specId: "0001", request: "menú + addon" }]);
  assert.match(out.content[0]?.text ?? "", /spec-sushi-0001/);
});

test("spec 0174: a refusal reaches the agent VERBATIM, not as a generic failure", async () => {
  // "esa rama ya tiene un run activo" is something an agent can act on;
  // "failed" sends it looking for the wrong problem.
  const server = createStartRunServer(async () => ({
    ok: false,
    problem: "esa rama ya tiene un run activo (spec 0002)",
  }));
  const out = await handlerOf(server)({ specId: "0001", request: "x" });
  assert.match(out.content[0]?.text ?? "", /esa rama ya tiene un run activo \(spec 0002\)/);
});

test("spec 0174: a host that reports no reason still says so, rather than claiming success", async () => {
  const server = createStartRunServer(async () => ({ ok: false }));
  const out = await handlerOf(server)({ specId: "0001", request: "x" });
  assert.match(out.content[0]?.text ?? "", /no se pudo/);
  assert.doesNotMatch(out.content[0]?.text ?? "", /run iniciado/);
});

test("spec 0174: the tool is auto-approved for a project chat and absent from the console", () => {
  // Auto-approved on purpose: a permission prompt nobody is watching would
  // strand the very turn the tool exists to complete.
  assert.ok((PROJECT_AUTO_APPROVED_TOOLS as readonly string[]).includes(START_RUN_TOOL_FQN));
  // The inspect console starts nothing — it is the read-only platform surface.
  assert.ok(!(SUPERVISOR_AUTO_APPROVED_TOOLS as readonly string[]).includes(START_RUN_TOOL_FQN));
});
