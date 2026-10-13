# `infra/front/` — the odoo-next front scaffold (spec 0169)

Committed verbatim into a newly provisioned `odoo_next` project's repo, so the
front phase has something to build. Before this existed, `provisionFront` packed
an **empty** checkout and the deploy died on
`open Dockerfile: no such file or directory` (spec 0161's live proof).

**These files are copied, not templated.** Everything tenant-specific arrives as
an environment variable from `front-stack.tmpl.yml` at deploy time —
`ODOO_URL` and `PROJECT_SLUG`. That is deliberate: spec 0161 lost a run to a
template placeholder that was substituted inside a comment, and a scaffold with
no placeholders cannot repeat it.

What the page proves: it calls the tenant's own Odoo over JSON-RPC and renders
what comes back. If Odoo is unreachable or answers an error, the page **throws**
and Next serves a 500 — because a page that always returns 200 cannot fail for
the right reason.

It authenticates with nothing. `common.version` needs no credentials, so this
public container holds no secret at all. Reading tenant *business* data (company
name, products) needs a dedicated read-only Odoo user; that is deliberately not
here, because the alternative — shipping the admin password into a
public-facing container — is worse than the feature is worth.
