# Hostinger contract-test fixtures

These JSON files are **hand-authored fixtures**, not live captures. Each shape
is verified by hand against the current Hostinger VPS API docs
(<https://developers.hostinger.com>) and exists so the contract tests can run
with **zero network access** — CI never calls the live API.

Loaded via `loadFixture("<name>")` (see `src/fixtures.ts`).

Rules:
- No secrets. The API token lives only in the `Authorization` header at runtime
  and must never appear in a fixture.
- One file per method / response variant. Suggested names (coder fills in as
  each method lands, verifying fields against the docs):
  - `list-vps.json` — `listVps` (include a paginated page if the API paginates)
  - `get-vps.json` — `getVps`
  - `create-vps.json` — `createVps`
  - `restart-vps.json` — `restartVps`
  - `create-snapshot.json` — `createSnapshot`
  - `create-public-key.json` — first call inside `attachSshKey`
    (`POST /public-keys`, registers the key material on the account)
  - `attach-ssh-key.json` — second call inside `attachSshKey`
    (`POST /public-keys/attach/{virtualMachineId}`, the `ActionResource`
    returned once the already-registered key id is attached to the VM).
    Verified against the live OpenAPI doc (spec 0013): key attach is
    account-scoped in two steps, there's no single "attach raw key material to
    a VM" endpoint — see the doc comment on `HostingerClient.attachSshKey`.
  - `error-429.json`, `error-401.json` — error-body shapes for retry/mapping tests
- When the live smoke run (`scripts/hostinger-smoke.mjs`) reveals a mismatch,
  update the fixture and note it in the spec Handoff log.
