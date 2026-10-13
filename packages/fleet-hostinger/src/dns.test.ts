import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HostingerClient,
  resolveDnsBaseUrl,
  type DnsRecordSet,
  type FetchFn,
} from "./client.js";
import { HostingerApiError } from "./errors.js";

// Phase B (spec 0148) — the Hostinger DNS client. Offline, driven by a STATEFUL
// in-memory zone so a GET after a PUT reflects the write: idempotency and the
// collision refusal are asserted against that read-back, never a status code
// (VERIFICATION #1/#2). The sandbox VPS IP and the colliding `client-b` target are
// the real values gate-1 measured against the live zone.
const SANDBOX_IP = "203.0.113.20";
const CLIENT_B_IP = "203.0.113.30";
const ZONE = "example.com";

/**
 * Simulates `GET /zones/{domain}` (returns current record sets) and
 * `PUT /zones/{domain}` (merges, matching `overwrite: false`) over an in-memory
 * zone, recording every request so tests can assert URL/body and PUT count.
 */
function statefulDnsFetch(initial: DnsRecordSet[]): {
  fetch: FetchFn;
  zone: () => DnsRecordSet[];
  puts: () => number;
  calls: () => Array<{ method: string; url: string; body?: string }>;
} {
  const zone: DnsRecordSet[] = JSON.parse(JSON.stringify(initial));
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  let putCount = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch: FetchFn = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    if (init.method === "GET") return json(200, zone);
    if (init.method === "PUT") {
      putCount++;
      const parsed = init.body ? (JSON.parse(init.body) as { zone?: DnsRecordSet[] }) : {};
      for (const incoming of parsed.zone ?? []) {
        const match = zone.find((s) => s.name === incoming.name && s.type === incoming.type);
        if (match) match.records.push(...incoming.records);
        else zone.push({ ...incoming, records: [...incoming.records] });
      }
      return json(200, { message: "ok" });
    }
    throw new Error(`unexpected method ${init.method}`);
  };
  return { fetch, zone: () => zone, puts: () => putCount, calls: () => calls };
}

test("resolveDnsBaseUrl falls back to the documented /api/dns/v1 default", () => {
  assert.equal(resolveDnsBaseUrl({ apiToken: "t" }), "https://developers.hostinger.com/api/dns/v1");
  assert.equal(
    resolveDnsBaseUrl({ apiToken: "t", dnsBaseUrl: "https://x.test/dns" }),
    "https://x.test/dns",
  );
});

test("getDnsRecords hits the DNS base at zones/{domain} and returns the record sets", async () => {
  const seed: DnsRecordSet[] = [
    { name: "client-b", type: "A", ttl: 14400, records: [{ content: CLIENT_B_IP }] },
  ];
  const { fetch, calls } = statefulDnsFetch(seed);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.getDnsRecords(ZONE);

  assert.deepEqual(result, seed);
  const call = calls()[0];
  assert.equal(call?.method, "GET");
  assert.ok(call?.url.endsWith("/api/dns/v1/zones/example.com"), call?.url);
});

test("upsertDnsRecord creates an A record to the sandbox IP; asserted by read-back", async () => {
  const { fetch, puts, calls } = statefulDnsFetch([]);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.upsertDnsRecord({ domain: ZONE, name: "acme", content: SANDBOX_IP });

  assert.equal(result.outcome, "created");
  assert.equal(puts(), 1);

  // The PUT body is an A record (not CNAME) at the sandbox IP.
  const put = calls().find((c) => c.method === "PUT");
  assert.deepEqual(put?.body ? JSON.parse(put.body) : undefined, {
    overwrite: false,
    zone: [{ name: "acme", type: "A", ttl: 14400, records: [{ content: SANDBOX_IP }] }],
  });

  // Read-back through the client, not the write's status: the record is really there.
  const after = await client.getDnsRecords(ZONE);
  assert.deepEqual(
    after.filter((s) => s.name === "acme" && s.type === "A").flatMap((s) => s.records),
    [{ content: SANDBOX_IP }],
  );
});

test("upsertDnsRecord is idempotent: a second identical call writes nothing", async () => {
  const { fetch, puts, zone } = statefulDnsFetch([]);
  const client = new HostingerClient({ apiToken: "t", fetch });
  const input = { domain: ZONE, name: "acme", content: SANDBOX_IP };

  const first = await client.upsertDnsRecord(input);
  const second = await client.upsertDnsRecord(input);

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "unchanged");
  // Only the first call wrote; the second saw the record via read-back and no-op'd.
  assert.equal(puts(), 1);
  // No duplicate accreted in the zone — exactly one A value for the name.
  const values = zone()
    .filter((s) => s.name === "acme" && s.type === "A")
    .flatMap((s) => s.records);
  assert.deepEqual(values, [{ content: SANDBOX_IP }]);
});

test("upsertDnsRecord refuses a slug already pointing at a different target — never overwrites", async () => {
  // client-b already resolves to a different VPS (a live customer's DNS, gate-1 Q3).
  const { fetch, puts, zone } = statefulDnsFetch([
    { name: "client-b", type: "A", ttl: 14400, records: [{ content: CLIENT_B_IP }] },
  ]);
  const client = new HostingerClient({ apiToken: "t", fetch });

  await assert.rejects(
    client.upsertDnsRecord({ domain: ZONE, name: "client-b", content: SANDBOX_IP }),
    (err: unknown) => {
      assert.ok(err instanceof HostingerApiError);
      assert.equal(err.kind, "conflict");
      assert.equal(err.retryable, false);
      return true;
    },
  );

  // Refusal is observable in the zone: no PUT, client-b still points where it did.
  assert.equal(puts(), 0);
  assert.deepEqual(
    zone()
      .find((s) => s.name === "client-b" && s.type === "A")
      ?.records,
    [{ content: CLIENT_B_IP }],
  );
});

test("upsertDnsRecord on a slug already pointing at the sandbox IP is unchanged, not a conflict", async () => {
  const { fetch, puts } = statefulDnsFetch([
    { name: "acme", type: "A", ttl: 14400, records: [{ content: SANDBOX_IP }] },
  ]);
  const client = new HostingerClient({ apiToken: "t", fetch });

  const result = await client.upsertDnsRecord({ domain: ZONE, name: "acme", content: SANDBOX_IP });

  assert.equal(result.outcome, "unchanged");
  assert.equal(puts(), 0);
});
