# GitHub contract-test fixtures

These JSON files are **hand-authored fixtures**, not live captures. Each shape
is verified by hand against the current GitHub REST API docs
(<https://docs.github.com/en/rest>) and exists so the contract tests can run
with **zero network access** — CI never calls the live API.

Loaded via `loadFixture("<name>")` (see `src/fixtures.ts`).

Rules:
- No secrets. `GITHUB_TOKEN` lives only in the `Authorization` header at
  runtime and must never appear in a fixture.
- One file per method / response variant:
  - `open-pr.json` — `openPr` (`POST /pulls` response subset: number/html_url/state/merged/mergeable/head.sha)
  - `get-pull-open.json` — the PR half of `getPrState` for an open, mergeable PR
  - `reviews-approved.json` — `GET /pulls/{n}/reviews`: a stale COMMENTED review
    followed by the decisive APPROVED one (exercises "latest review per user wins")
  - `reviews-changes-requested.json` — an earlier APPROVED review superseded by a
    later CHANGES_REQUESTED one (exercises the same "latest wins" reduction the
    other way)
  - `check-runs-success.json` — `GET /commits/{sha}/check-runs`, all completed + green
  - `check-runs-pending.json` — a run still `in_progress`
  - `merge-pr.json` — `PUT /pulls/{n}/merge` success (`merged: true`)
  - `merge-pr-declined.json` — GitHub 200s but declines to merge (`merged: false`) —
    the client turns this into a thrown `GithubApiError`
  - `close-pr.json` — `PATCH /pulls/{n}` response with `state: "closed"` (the
    rejection path `getPrState` must distinguish from a merge)
- When the live dogfood run (spec 0015 acceptance criteria / spec 0016) reveals
  a shape mismatch, update the fixture and note it in the spec Handoff log.
