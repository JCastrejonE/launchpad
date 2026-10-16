# Launchpad

**An eight-week experiment in building a hosting product with AI coding agents, and what its own defect record says about how to do that.**

Launchpad was a control plane for hosting Odoo businesses: provision a tenant, give every branch its own staging server, let an AI agent turn a request into code on that branch, and promote it to production behind one human click. It was built at [Netlab](https://netlab.mx) between July and August 2026, almost entirely by Claude agents steered by one developer, [Juan Carlos Castrejón](https://github.com/JCastrejonE), and stopped deliberately in October 2026.

This is a sanitized snapshot. It is kept because the record of how it was built is more useful than the product: 1,638 commits, 228 specs, 1,909 tests (35 of them run only with `TEMPORAL_TEST=1`), and an unusually honest log of every mistake, which turned into a development model and a standalone tool.

> Hosts, domains, people and customers have been replaced with placeholders (`example.com`, `203.0.113.x`, "the owner", "a teammate", `client-a`…). Where the code and docs say "the company", that is Netlab. Operations logs, the raw defect registry, run findings and most specs were removed. History starts fresh.

## What it did

**Hangar: the hosting side**
- Provisions an Odoo 18 or 19 tenant plus a Next.js front on a VPS fleet in about three minutes, with DNS and TLS.
- Gives every branch its own staging stack, in the style of odoo.sh: deploy, refresh, destroy, and an attestation of which commit was validated.
- Releases are driven by the Odoo module manifest's version. Promote is a merge, the merge is the production deploy, and it needs an owner's click.
- CI runs on its own infrastructure in a credential-free container and posts a commit status that the promote step reads.
- Destructive fleet operations are refused, at the lowest layer, on any server that is not on an explicit allowlist.

**Forge: the agent pipeline**
- A chat drafts a spec; a Temporal workflow runs an initializer and then fresh coder sessions (Claude Agent SDK) until the spec's checklist is done; a fixer gets one repair round; CI; a pull request; a human gate.

**Control plane**
- Auth.js sessions with OWNER, MEMBER and VIEWER roles, where all policy lives in one file (`apps/web/lib/capabilities.ts`) and an action can only record an actor it has authorized.
- An append-only audit log of every effectful action, and an AES-256-GCM secret store for tenant credentials.

**Stack:** TypeScript (strict), pnpm workspaces, Next.js, Temporal, Postgres with Drizzle, Docker and Traefik, the Claude Agent SDK. About 57k lines of source and 31k lines of tests.

```
apps/web                    Next.js control plane: projects, branches, releases, chat, gates
packages/pipeline           Temporal workflows and activities: runs, provisioning, releases, CI gate
packages/agents             Claude Agent SDK sessions, env scrubbing, tool policy
packages/fleet-hostinger    VPS fleet: SSH, Odoo and front stacks, staging, DNS, sandbox allowlist
packages/github             GitHub API: repos, PRs, statuses, merges
packages/db                 Drizzle schema, migrations, audit log, secret store
infra/tenant                compose templates for tenant stacks (Odoo version is a parameter)
agents/                     the prompts the pipeline gave its agents
scripts/lp                  the one entry point: start, gate, check, deployed
```

`pnpm install && pnpm check` runs the build, typecheck and tests. Running the product needs Postgres, Temporal, a VPS provider account and a domain, which this snapshot does not provide; the project's original README, with its setup notes, is in [`docs/ORIGINAL-README.md`](docs/ORIGINAL-README.md).

## What the record says

Every mistake made while building Launchpad was written down, with what it was and how it was found. Deduplicated, that is **225 defects**. Asking one question of each, *what actually detected it?*, gives this:

| Detected by | Share |
|---|---|
| Running the real system and reading its state | 53% |
| The author noticing their own measuring tool was wrong (always after a wrong conclusion) | 19% |
| A person reading code | 14% |
| A user hitting it | 7% |
| The gate (all build or lint failures) | 3% |
| Spec review | 1 defect |
| **A unit test going red** | **0** |

97% of product defects were introduced under an approved spec. Six named families cover 173 of the 225 defects; after the largest, wrong assumptions in a plan (55), the next two were invisible to the test suite by construction:

- **Instruments that confirm what their author expected (47).** Throwaway shell written to *observe* the system: a poll that could not say which state it was in, a grep that matched the wrong thing, an exit code read through a pipe. None of it was committed, so no test ever saw it.
- **Code that was built, tested and never reached (35).** Most often a new optional parameter that a second caller never passed. A unit test calls the function directly, so the function is always reached in tests.

The only mechanisms that ever closed a recurring defect shape were compile-time: a required parameter, a typed value. [`docs/VERIFICATION.md`](docs/VERIFICATION.md) has the rules the project paid for, each with the incidents behind it.

## What came out of it

- **[Proof of Work](docs/PROOF-OF-WORK.md)**, a development model derived from that record. Changes are defined by executable claims rather than specs, wiring is proven by the type system, observation scripts are code, accepted guarantees are re-checked forever, and long agent sessions are kept safe by hooks rather than by rules the agent must remember.
- **[A setup bake-off](docs/SETUP-BAKEOFF.md)**: the same brief run through this repository's agent method, plain Claude Code, gstack, ECC, a dynamic workflow and an agent team, each in a sandbox, everything measured. The model set the quality ceiling; independent review found the real bugs; every suite guarded the algorithm and almost none guarded the interaction.
- **[breakcheck](https://github.com/JCastrejonE/breakcheck)**, a Go tool extracted from the habit that worked best here: break the code on purpose, require a test to go red, put the exact bytes back, require green.

## Why it stopped

- **Odoo shipped the core idea itself.** Since April 2026 odoo.sh runs Claude Code inside the build environment and deploys to staging from its console. A self-built version would compete with the vendor's own platform.
- **No external customer used it.** Every tenant was an internal test business, and no one but the owner ever drove it.
- **The agent pipeline duplicated tools that already existed.** After its first hundred specs, the owner routed most changes around it with Claude Code directly: 115 of the 129 later specs ran as Track 1, outside the pipeline.
- **It was expensive to keep correct.** Most defects were found only by running the live system, and a few reached production, one as a twelve-hour tenant outage (2026-08-14: after a Docker daemon restart the six production tenant stacks did not come back, and nothing alerted; its write-up was among the run findings removed from this snapshot).

The useful output was never going to be the hosting product. It was the evidence about how software built by AI agents actually fails, and what catches it.

## The specs that remain

Six of the 228 specs are kept in `specs/` as examples of the method: the foundations (0001), authentication (0073), instruments as code (0201), the one whose every checklist item was honestly "built" and whose feature nothing could reach (0226), a single entry point (0229) and a path-canonicalisation fix (0230). Several are in Spanish, as the project's specs were. The agent prompts in `agents/` are unchanged apart from sanitization, as a record of what the agents were told.

## License

MIT, copyright Netlab. See [LICENSE](LICENSE).
