import { test } from "node:test";
import assert from "node:assert/strict";
import { HostingerClient, type FetchFn } from "./client.js";
import { HostingerApiError } from "./errors.js";
import { loadFixture } from "./fixtures.js";
import type {
  CreateVpsResponse,
  VpsAction,
  VpsInstance,
  VpsPublicKey,
} from "./client.js";

// Contract tests (spec 0011): every method covered against checked-in JSON
// fixtures via an injected fetch — zero network. These are scaffolds; the coder
// step turns each `todo` into a real assertion as the method + fixture land.
//
// A ready-made offline fetch stub for that work:
function stubFetch(status: number, body: unknown): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

test("HostingerClient constructs with an injected fetch (no network)", () => {
  const client = new HostingerClient({ apiToken: "t", fetch: stubFetch(200, {}) });
  assert.ok(client instanceof HostingerClient);
});

test("HostingerApiError carries kind + retryable for activity mapping", () => {
  const err = new HostingerApiError("rate_limited", "slow down", {
    status: 429,
    retryable: true,
  });
  assert.equal(err.kind, "rate_limited");
  assert.equal(err.retryable, true);
  assert.equal(err.status, 429);
});

// Per-method contract coverage (offline, fixture-backed). Each fixture is a
// hand-authored JSON file under `fixtures/`, verified against the live
// Hostinger OpenAPI document (see client.ts doc comments) — never a live
// capture and never containing the token.

/** Like `stubFetch`, but records the last request's method/url/body for assertions. */
function capturingFetch(
  status: number,
  body: unknown,
): { fetch: FetchFn; lastCall: () => { method: string; url: string; body?: string } } {
  let last: { method: string; url: string; body?: string } | undefined;
  const fetch: FetchFn = async (url, init) => {
    last = { method: init.method, url, body: init.body };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch,
    lastCall: () => {
      if (!last) throw new Error("fetch was never called");
      return last;
    },
  };
}

test("listVps returns typed instances from list-vps.json (handles pagination)", async () => {
  const fixture = await loadFixture<VpsInstance[]>("list-vps");
  const client = new HostingerClient({ apiToken: "t", fetch: stubFetch(200, fixture) });

  const result = await client.listVps();

  // No pagination envelope in the real API (confirmed against the OpenAPI
  // spec) — a bare array in, the same typed array out.
  assert.deepEqual(result, fixture);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.hostname, "srv1001.hstgr.cloud");
  assert.equal(result[1]?.state, "stopped");
});

test("getVps returns a typed instance from get-vps.json", async () => {
  const fixture = await loadFixture<VpsInstance>("get-vps");
  const client = new HostingerClient({ apiToken: "t", fetch: stubFetch(200, fixture) });

  const result = await client.getVps(1001);

  assert.deepEqual(result, fixture);
  assert.equal(result.id, 1001);
  assert.equal(result.template?.name, "Ubuntu 22.04 with Docker");
});

test("createVps posts the request body and returns the created instance", async () => {
  const fixture = await loadFixture<CreateVpsResponse>("create-vps");
  const { fetch, lastCall } = capturingFetch(200, fixture);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const req = {
    item_id: "hostingercom-vps-kvm2-usd-1m",
    setup: {
      template_id: 1013,
      data_center_id: 6,
      hostname: "srv1003.hstgr.cloud",
    },
  };
  const result = await client.createVps(req);

  assert.deepEqual(result, fixture);
  assert.equal(result.order.status, "completed");
  assert.equal(result.virtual_machine.hostname, "srv1003.hstgr.cloud");

  const call = lastCall();
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/virtual-machines"));
  assert.deepEqual(call.body ? JSON.parse(call.body) : undefined, req);
});

// restartVps/createSnapshot/attachSshKey are the DESTRUCTIVE helpers the fleet
// sandbox allowlist (spec 0014 / ADR-013) gates — these "success" contract
// tests use the real sandbox id (100001, allowlisted in infra/fleet-sandbox.json)
// so they exercise the wire contract without tripping the refusal; sandbox.test.ts
// covers the refusal itself.
test("restartVps resolves on success", async () => {
  const fixture = await loadFixture<VpsAction>("restart-vps");
  const { fetch, lastCall } = capturingFetch(200, fixture);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.restartVps(100001);

  assert.deepEqual(result, fixture);
  assert.equal(result.name, "restart");
  const call = lastCall();
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/virtual-machines/100001/restart"));
});

test("createSnapshot resolves on success", async () => {
  const fixture = await loadFixture<VpsAction>("create-snapshot");
  const { fetch, lastCall } = capturingFetch(200, fixture);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.createSnapshot(100001);

  assert.deepEqual(result, fixture);
  assert.equal(result.name, "create_snapshot");
  const call = lastCall();
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/virtual-machines/100001/snapshot"));
});

// Resilience (spec 0011): retry/backoff behavior. `retryBaseDelayMs: 1` keeps
// these assertions fast — the backoff *bound* is what's under test, not the
// production delay curve (that's `DEFAULT_RETRY_BASE_DELAY_MS`).
type PrivateRequest = {
  request: (m: string, p: string) => Promise<unknown>;
};

function countingFetch(status: number, body: unknown): { fetch: FetchFn; callCount: () => number } {
  let calls = 0;
  const fetch: FetchFn = async () => {
    calls++;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, callCount: () => calls };
}

test("429 is retried up to maxRetries then surfaces as retryable", async () => {
  const { fetch, callCount } = countingFetch(429, { message: "slow down" });
  const client = new HostingerClient({
    apiToken: "t",
    fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    (client as unknown as PrivateRequest).request("GET", "/virtual-machines"),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "rate_limited");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  // Initial attempt + 2 retries = 3 calls total; bounded, never unbounded.
  assert.equal(callCount(), 3);
});

test("5xx is retried; 4xx (401/404) is NOT retried and is fatal", async () => {
  const serverError = countingFetch(503, { message: "unavailable" });
  const serverClient = new HostingerClient({
    apiToken: "t",
    fetch: serverError.fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  await assert.rejects(
    (serverClient as unknown as PrivateRequest).request("GET", "/virtual-machines"),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "server");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(serverError.callCount(), 3);

  const notFound = countingFetch(404, { message: "not found" });
  const notFoundClient = new HostingerClient({
    apiToken: "t",
    fetch: notFound.fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  await assert.rejects(
    (notFoundClient as unknown as PrivateRequest).request("GET", "/virtual-machines/1"),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "not_found");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  // No retry on a fatal 4xx: exactly one call.
  assert.equal(notFound.callCount(), 1);
});

test("a request timeout surfaces as a retryable HostingerApiError", async () => {
  const timeoutFetch: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const client = new HostingerClient({
    apiToken: "t",
    fetch: timeoutFetch,
    timeoutMs: 5,
    maxRetries: 1,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    (client as unknown as PrivateRequest).request("GET", "/virtual-machines"),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

/**
 * Like `capturingFetch`, but queues a distinct response per call and records
 * every call (not just the last) — needed for `attachSshKey`, which makes two
 * sequential requests (register the key, then attach it).
 */
function sequencedFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetch: FetchFn; calls: () => Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    const index = calls.length;
    calls.push({ method: init.method, url, body: init.body });
    const next = responses[Math.min(index, responses.length - 1)];
    if (!next) throw new Error("sequencedFetch: no response queued for this call");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls: () => calls };
}

// Spec 0013 plan step 2 — SSH key attach contract, offline + fixture-backed.
// Verified against the live OpenAPI doc: key attach is account-scoped in two
// calls (register the key material, then attach the registered id to the
// VM) — see the doc comment on `HostingerClient.attachSshKey`.
test("attachSshKey registers the key on the account, then attaches it to the VM", async () => {
  const registered = await loadFixture<VpsPublicKey>("create-public-key");
  const attached = await loadFixture<VpsAction>("attach-ssh-key");
  const { fetch, calls } = sequencedFetch([
    { status: 200, body: registered },
    { status: 200, body: attached },
  ]);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.attachSshKey(100001, {
    name: "fleet-bootstrap",
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleFleetBootstrapKey fleet@launchpad",
  });

  assert.deepEqual(result, attached);
  assert.equal(result.name, "attach_public_key");

  const [createCall, attachCall] = calls();
  assert.equal(createCall?.method, "POST");
  assert.ok(createCall?.url.endsWith("/public-keys"));
  assert.deepEqual(createCall?.body ? JSON.parse(createCall.body) : undefined, {
    name: "fleet-bootstrap",
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleFleetBootstrapKey fleet@launchpad",
  });

  assert.equal(attachCall?.method, "POST");
  assert.ok(attachCall?.url.endsWith("/public-keys/attach/100001"));
  assert.deepEqual(attachCall?.body ? JSON.parse(attachCall.body) : undefined, {
    ids: [registered.id],
  });
});

test("the API token never appears in a thrown error message", async () => {
  const secretToken = "hostinger-secret-abc123";
  const client = new HostingerClient({
    apiToken: secretToken,
    fetch: stubFetch(401, { message: "Unauthorized" }),
  });

  await assert.rejects(
    // `request` is private; the transport contract (never leak the token into
    // a thrown error) applies regardless of which public method calls it.
    (client as unknown as { request: (m: string, p: string) => Promise<unknown> }).request(
      "GET",
      "/virtual-machines",
    ),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "auth");
      assert.equal(err.retryable, false);
      assert.ok(!err.message.includes(secretToken));
      assert.ok(!JSON.stringify(err).includes(secretToken));
      return true;
    },
  );
});
