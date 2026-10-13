/**
 * Spec 0213 A — the namespace boundary between the production and staging
 * control planes.
 *
 * This file is pure on purpose: `task-queue.ts` exists so the queue name and the
 * namespace can be read without loading `@temporalio/worker`'s native bindings,
 * which is what makes them testable at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TASK_QUEUE, temporalNamespace } from "./task-queue.js";

test("temporalNamespace: absent means 'default' — production is unchanged", () => {
  assert.equal(temporalNamespace({}), "default");
  assert.equal(temporalNamespace({ TEMPORAL_NAMESPACE: "" }), "default");
  assert.equal(temporalNamespace({ TEMPORAL_NAMESPACE: "   " }), "default");
});

test("temporalNamespace: a set value is honoured, trimmed", () => {
  assert.equal(temporalNamespace({ TEMPORAL_NAMESPACE: "staging" }), "staging");
  // Trimmed, because a stray space in an EnvironmentFile would otherwise put the
  // staging worker in a namespace of its own that nothing else writes to — the
  // run would hang and the cause would be invisible.
  assert.equal(temporalNamespace({ TEMPORAL_NAMESPACE: " staging\n" }), "staging");
});

test("temporalNamespace matches apps/web's reader, so the two halves cannot disagree", () => {
  // apps/web/lib/env.ts resolves it as `env["TEMPORAL_NAMESPACE"]?.trim() || "default"`.
  // If these two ever diverge, the client writes to one namespace and the worker
  // polls another: the run hangs with both sides believing they are correct.
  const cases = [{}, { TEMPORAL_NAMESPACE: "staging" }, { TEMPORAL_NAMESPACE: "  " }];
  for (const env of cases) {
    const web = (env as Record<string, string>)["TEMPORAL_NAMESPACE"]?.trim() || "default";
    assert.equal(temporalNamespace(env), web);
  }
});

test("the queue name is shared, so isolation cannot come from it", () => {
  // Pinning the constant is the point: both stacks poll "spec-pipeline", which is
  // exactly why the namespace has to be the boundary. If someone later makes the
  // queue name configurable and treats THAT as the isolation, this test is the
  // place that argument gets re-read.
  assert.equal(TASK_QUEUE, "spec-pipeline");
});
