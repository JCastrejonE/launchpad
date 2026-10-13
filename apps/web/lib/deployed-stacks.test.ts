/**
 * Spec 0121. The interesting assertions are the refusals: a stack whose identity
 * could not be parsed must NOT get a guessed URL, and an unresolvable domain must
 * not get a link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDeployedStacks, stacksForProject } from "./deployed-stacks";
import type { TenantStack } from "@launchpad/fleet-hostinger";

function stack(overrides: Partial<TenantStack> = {}): TenantStack {
  return {
    tenant: "sandbox-prod",
    identity: { tenantId: "sandbox", stack: "prod", kind: "tenant" },
    routerHost: "prod.sandbox.203.0.113.20.sslip.io",
    dbs: ["sandbox_prod"],
    status: "running",
    ...overrides,
  };
}

test("a tenant stack becomes a clickable URL built from its identity", () => {
  const [view] = deriveDeployedStacks([stack()]);
  assert.equal(view?.label, "sandbox/prod");
  assert.equal(view?.host, "prod.sandbox.203.0.113.20.sslip.io");
  assert.equal(view?.href, "https://prod.sandbox.203.0.113.20.sslip.io");
  assert.equal(view?.kind, "tenant");
});

test("a per-spec staging stack is labelled as staging, with the host the box reported", () => {
  const [view] = deriveDeployedStacks([
    stack({
      identity: { tenantId: "sandbox", stack: "spec-0120", kind: "staging" },
      routerHost: "spec-0120.sandbox.staging.example.com",
    }),
  ]);
  assert.equal(view?.kind, "staging");
  assert.equal(view?.host, "spec-0120.sandbox.staging.example.com");
});

test("an unparsed identity gets NO url — a guess could point at another tenant", () => {
  const [view] = deriveDeployedStacks([stack({ identity: undefined })]);
  assert.equal(view?.host, undefined);
  assert.equal(view?.href, undefined);
  assert.equal(view?.kind, "unknown");
  assert.match(view?.note ?? "", /no coincide/);
  // Still listed: the operator should see the stack exists even unaddressable.
  assert.equal(view?.label, "sandbox-prod");
});

test("an unresolvable host is shown as TEXT with the reason, never a link", () => {
  // A stack still serving its OLD `.test` rule — exactly the case that made
  // deriving the host from the CURRENT env wrong, since the env now says sslip.io
  // while this stack answers on neither.
  const [view] = deriveDeployedStacks([
    stack({ routerHost: "prod.sandbox.sandbox.launchpad.test" }),
  ]);
  assert.equal(view?.host, "prod.sandbox.sandbox.launchpad.test");
  assert.equal(view?.href, undefined);
  assert.match(view?.note ?? "", /no resuelve/);
});

test("a stopped stack is still listed, with its empty db list carried through honestly", () => {
  const [view] = deriveDeployedStacks([stack({ status: "stopped", dbs: [] })]);
  assert.equal(view?.status, "stopped");
  assert.deepEqual(view?.dbs, []);
  // It still gets a link: the URL is a property of the router rule, not of whether
  // the container happens to be up right now.
  assert.equal(view?.href, "https://prod.sandbox.203.0.113.20.sslip.io");
});

test("a stack whose Traefik rule could not be read shows no URL at all", () => {
  const [view] = deriveDeployedStacks([stack({ routerHost: undefined })]);
  assert.equal(view?.host, undefined);
  assert.equal(view?.href, undefined);
  assert.match(view?.note ?? "", /regla de Traefik/);
});

/**
 * Spec 0181 — measured: `sushi`'s Ramas & builds page listed four
 * `ab-test-sandbox` environments with clickable URLs, because the panel read
 * the box and never asked whose page it was on.
 */
test("spec 0181: a project's page shows only that project's stacks", () => {
  const stacks = [
    { tenant: "sushi", status: "running", dbs: [], routerHost: "a", identity: { tenantId: "sushi", stack: "prod", kind: "tenant" } },
    { tenant: "sushi", status: "running", dbs: [], routerHost: "b", identity: { tenantId: "sushi", stack: "front", kind: "tenant" } },
    { tenant: "ab-test-sandbox", status: "running", dbs: [], routerHost: "c", identity: { tenantId: "ab-test-sandbox", stack: "prod", kind: "tenant" } },
    { tenant: "ab-test-sandbox", status: "running", dbs: [], routerHost: "d", identity: { tenantId: "ab-test-sandbox", stack: "br-x-1", kind: "staging" } },
  ] as unknown as Parameters<typeof stacksForProject>[0];
  const mine = stacksForProject(stacks, "sushi");
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((s) => s.routerHost), ["a", "b"]);
});

test("spec 0181: an unattributable stack is not attributed to this customer", () => {
  // No identity means no tenant we can name. Showing it on a project's page
  // would claim someone else's environment belongs to them.
  const stacks = [
    { tenant: "weird-dir", status: "running", dbs: [], identity: undefined },
  ] as unknown as Parameters<typeof stacksForProject>[0];
  assert.deepEqual(stacksForProject(stacks, "sushi"), []);
});
