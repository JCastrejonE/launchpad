import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunContextLinks } from "./run-links.js";
import type { PullRequestRef, PipelineTarget } from "@launchpad/pipeline";

/**
 * Rule matrix for `deriveRunContextLinks` (spec 0059 increment B). Every
 * case below is called out in the spec's Scope §B / Acceptance.
 */

const SELF_TARGET: PipelineTarget = { kind: "self", repo: "launchpad" };
const TENANT_TARGET: PipelineTarget = {
  kind: "tenant",
  tenantId: "acme",
  repo: "launchpad",
  odooVersion: 18,
  vpsId: 903331,
};
// Wire-compat (spec 0036): an in-flight pre-rename run's target literally
// persists as `{ kind: "launchpad" }`. The PipelineTarget type only declares
// "self"/"tenant", so exercise this shape with a loose cast, same as the
// runtime value a legacy run's Temporal query can actually return.
const LEGACY_TARGET = { kind: "launchpad" } as unknown as PipelineTarget;

const PR: PullRequestRef = {
  repo: "launchpad",
  branch: "spec-0059",
  workdir: "/tmp/spec-0059",
  number: 42,
  url: "https://github.com/example/launchpad/pull/42",
};

test("spec link always present → /forge/specs/<specId>, internal", () => {
  const links = deriveRunContextLinks({ specId: "0059" });
  const spec = links.find((l) => l.key === "spec");
  assert.ok(spec);
  assert.equal(spec.href, "/forge/specs/0059");
  assert.equal(spec.external, false);
});

test("self run ⇒ spec + hangar-self (/), NOT hangar-host", () => {
  const links = deriveRunContextLinks({ specId: "0059", target: SELF_TARGET });
  assert.equal(links.find((l) => l.key === "hangar-host"), undefined);
  const self = links.find((l) => l.key === "hangar-self");
  assert.ok(self);
  assert.equal(self.href, "/");
});

test("tenant run ⇒ spec + hangar-host (/#vps-<vpsId>), NOT hangar-self", () => {
  const links = deriveRunContextLinks({ specId: "0059", target: TENANT_TARGET });
  assert.equal(links.find((l) => l.key === "hangar-self"), undefined);
  const host = links.find((l) => l.key === "hangar-host");
  assert.ok(host);
  assert.equal(host.href, "/#vps-903331");
  assert.match(host.label, /acme/);
  assert.match(host.label, /903331/);
});

test("legacy { kind: 'launchpad' } target ⇒ hangar-self, never hangar-host", () => {
  const links = deriveRunContextLinks({ specId: "0059", target: LEGACY_TARGET });
  assert.equal(links.find((l) => l.key === "hangar-host"), undefined);
  assert.ok(links.find((l) => l.key === "hangar-self"));
});

test("absent target / null view ⇒ spec + hangar-self", () => {
  const links = deriveRunContextLinks({ specId: "0059" });
  assert.equal(links.find((l) => l.key === "hangar-host"), undefined);
  const self = links.find((l) => l.key === "hangar-self");
  assert.ok(self);
  assert.equal(self.href, "/");
});

test("PR present + past gate park (pr.number > 0, !gate) ⇒ external PR link", () => {
  const links = deriveRunContextLinks({ specId: "0059", pr: PR });
  const pr = links.find((l) => l.key === "pr");
  assert.ok(pr);
  assert.equal(pr.href, PR.url);
  assert.equal(pr.external, true);
});

test("PR present but parked at a gate ⇒ no PR link (0052 gate cue owns it)", () => {
  const links = deriveRunContextLinks({ specId: "0059", pr: PR, gate: "pr" });
  assert.equal(links.find((l) => l.key === "pr"), undefined);
});

test("pr.number === 0 (local-diff ref) ⇒ no PR link", () => {
  const links = deriveRunContextLinks({
    specId: "0059",
    pr: { ...PR, number: 0 },
  });
  assert.equal(links.find((l) => l.key === "pr"), undefined);
});

test("exactly one Hangar link in every case — never both, never zero", () => {
  for (const target of [undefined, SELF_TARGET, TENANT_TARGET, LEGACY_TARGET]) {
    const links = deriveRunContextLinks({ specId: "0059", target });
    const hangarLinks = links.filter(
      (l) => l.key === "hangar-host" || l.key === "hangar-self",
    );
    assert.equal(hangarLinks.length, 1, `expected exactly one Hangar link for target=${JSON.stringify(target)}`);
  }
});

test("no derived href targets the /fleet, /specs, or /chat redirect stubs", () => {
  const cases = [
    { specId: "0059" },
    { specId: "0059", target: SELF_TARGET },
    { specId: "0059", target: TENANT_TARGET },
    { specId: "0059", target: LEGACY_TARGET },
    { specId: "0059", pr: PR },
    { specId: "0059", pr: PR, gate: "pr" as const },
  ];
  for (const input of cases) {
    for (const link of deriveRunContextLinks(input)) {
      assert.doesNotMatch(link.href, /^\/(fleet|specs|chat)(\/|$|#)/);
    }
  }
});
