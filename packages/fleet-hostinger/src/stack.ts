/**
 * Production tenant stack deploy (spec 0012). Renders
 * `infra/tenant/odoo-stack.tmpl.yml` for a tenant, copies it to the bootstrapped
 * VPS, brings it up with `docker compose up -d`, and verifies the containers are
 * healthy and Odoo answers on 8069 (via an SSH-side curl — real DNS/Traefik
 * wiring is a later spec). Idempotent: a re-deploy lets compose reconcile.
 *
 * TENANT DB INIT (spec 0014 plan step 4): a first deploy also initializes the
 * tenant database — `docker compose up -d db` brings up Postgres alone, then
 * (only if `tenantDbName(...)` doesn't already exist, checked via `psql`) a
 * one-off `docker compose run --rm odoo -d <db> -i base --stop-after-init`
 * installs `base` into it — BEFORE the full `up -d` brings up the `odoo`
 * service that's pinned (plan step 3) to serve exactly that DB. Idempotent:
 * an already-initialized DB is left alone on re-deploy.
 *
 * SECRET HANDLING: `ODOO_DB_PASSWORD` is generated per tenant
 * ({@link generateDbPassword}), injected into the rendered compose at deploy
 * time, and written ONLY to the VPS — never to a file committed to git, never
 * logged. `renderStack` is pure so the deploy path can render-in-memory →
 * `ssh.writeFile` without ever touching the repo tree.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path, { posix as posixPath } from "node:path";
import { randomBytes } from "node:crypto";
import { FleetError } from "./errors.js";
import { assertSandboxVps } from "./sandbox.js";
import type { SshRunner, SshExecResult } from "./ssh.js";

export type OdooVersion = 17 | 18 | 19;

/** Deploy target: prod today; `spec-<id>` ephemeral stacks are a later spec. */
export type StackName = string;

/** dist/stack.js -> repo-root/infra/tenant/odoo-stack.tmpl.yml */
export const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "infra",
  "tenant",
  "odoo-stack.tmpl.yml",
);

/** Reads the checked-in tenant stack template from `infra/tenant/`. */
export async function loadStackTemplate(): Promise<string> {
  return readFile(TEMPLATE_PATH, "utf8");
}

export interface RenderStackParams {
  tenant: string;
  stack: StackName; // "prod" | "spec-<id>"
  odooVersion: OdooVersion;
  domain: string;
  /** Generated per tenant; injected here, never persisted to the repo. */
  dbPassword: string;
  /**
   * Traefik router `Host()` rule (spec 0148 phase C). Defaults to
   * {@link routerHost} (`${stack}.${tenant}.${domain}`); odoo-next provisioning
   * passes an override like `<slug>.odoo.example.com`.
   */
  host?: string;
  /**
   * Traefik ACME cert-resolver name (staging's `letsencrypt`, spec 0148 phase
   * C). Set ONLY when {@link host} resolves publicly, so ACME can issue: it adds
   * the `tls.certresolver` + `websecure` entrypoint labels. Omitted keeps
   * today's self-signed default cert exactly — the right behaviour for every
   * non-resolving `.test` tenant.
   */
  certResolver?: string;
}

/**
 * Apply `substitutions` to `template`, refusing the one shape that silently
 * produces invalid YAML.
 *
 * Rendering is a blunt split/join over the WHOLE file, comments included. A
 * single-line value is harmless anywhere. A MULTI-LINE value is only safe where
 * the placeholder starts a line — which is how `${TLS_EXTRA_LABELS}` is used in
 * the body, indented by its own content. Put that same placeholder in a comment
 * and the second line escapes the `#`, becoming top-level YAML.
 *
 * That is not hypothetical: both templates documented their variables using
 * `${NAME}` in the header comment, and probe0161's first provisioning died on
 * `docker compose up -d db: top-level object must be a mapping`. The templates
 * are fixed; this makes the class impossible rather than trusting the next
 * editor to remember.
 */
export function renderTemplate(template: string, substitutions: Record<string, string>): string {
  for (const [placeholder, value] of Object.entries(substitutions)) {
    if (!value.includes("\n")) continue;
    for (const line of template.split("\n")) {
      const at = line.indexOf(placeholder);
      if (at > 0) {
        throw new FleetError(
          "config",
          `template renders the multi-line value ${placeholder} mid-line, which would ` +
            `break out of its context and corrupt the document: ${JSON.stringify(line.trim().slice(0, 80))}`,
          { retryable: false },
        );
      }
    }
  }
  let rendered = template;
  for (const [placeholder, value] of Object.entries(substitutions)) {
    rendered = rendered.split(placeholder).join(value);
  }
  const leftover = rendered.match(/\$\{[A-Z_]+\}/);
  if (leftover) {
    throw new FleetError("config", `unresolved template placeholder: ${leftover[0]}`, {
      retryable: false,
    });
  }
  return rendered;
}

/**
 * Substitutes `${TENANT}` / `${STACK}` / `${ODOO_VERSION}` / `${DOMAIN}` /
 * `${ODOO_DB_PASSWORD}` / `${DB_NAME}` in the template. Pure — no filesystem,
 * no repo writes.
 *
 * `${DB_NAME}` (spec 0014 plan step 3) is {@link tenantDbName} — the template
 * pins the odoo container's `command:` to `-d ${DB_NAME} --db-filter=^${DB_NAME}$`
 * (written `$$` in the template — see its header comment — since docker
 * compose itself interpolates `$` when parsing the file) so the stack SERVES
 * that DB directly (no database selector) instead of relying on odoo.conf
 * defaults.
 */
export function renderStack(template: string, params: RenderStackParams): string {
  const host = params.host ?? routerHost(params.tenant, params.stack, params.domain);
  // Router name mirrors the template's `${TENANT}-${STACK}`: the ACME labels
  // must attach to the SAME router as its `.rule`/`.tls`/`.services` labels.
  const routerName = `${params.tenant}-${params.stack}`;
  const tlsExtraLabels = params.certResolver
    ? `      - traefik.http.routers.${routerName}.tls.certresolver=${params.certResolver}\n` +
      `      - traefik.http.routers.${routerName}.entrypoints=websecure\n`
    : "";
  const substitutions: Record<string, string> = {
    "${TENANT}": params.tenant,
    "${STACK}": params.stack,
    "${ODOO_VERSION}": String(params.odooVersion),
    "${ROUTER_HOST}": host,
    "${TLS_EXTRA_LABELS}": tlsExtraLabels,
    "${ODOO_DB_PASSWORD}": params.dbPassword,
    "${DB_NAME}": tenantDbName(params.tenant, params.stack),
  };
  return renderTemplate(template, substitutions);
}

// --- odoo-next Next front stack (spec 0148 phase D) -------------------------

/** dist/stack.js -> repo-root/infra/tenant/front-stack.tmpl.yml */
export const FRONT_TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "infra",
  "tenant",
  "front-stack.tmpl.yml",
);

/** Reads the checked-in Next front stack template from `infra/tenant/`. */
export async function loadFrontStackTemplate(): Promise<string> {
  return readFile(FRONT_TEMPLATE_PATH, "utf8");
}

export interface RenderFrontStackParams {
  /**
   * Compose + Traefik router/service key, e.g. `<slug>-front`. Distinct from
   * the odoo stack's `<tenant>-<stack>` key so the two coexist on one VPS.
   */
  name: string;
  /** Traefik `Host()` rule — `<slug>.example.com`. */
  host: string;
  /**
   * The project slug, passed to the container as `PROJECT_SLUG` (spec 0169).
   *
   * Explicit rather than derived from `name` by stripping `-front`: an id's
   * parts are not "the prefix and the rest" (VERIFICATION #11), and a slug that
   * happens to end in `-front` would quietly lose a segment.
   */
  slug: string;
  /**
   * URL the front reaches its Odoo at — the phase-C stack
   * (`https://<slug>.odoo.example.com`). Injected as `ODOO_URL`.
   */
  odooUrl: string;
  /**
   * Traefik ACME cert-resolver (staging's `letsencrypt`). Set ONLY when
   * {@link host} resolves publicly (phase B makes `<slug>.example.com` resolve
   * first). Omitted keeps Traefik's self-signed default, exactly like
   * {@link renderStack}.
   */
  certResolver?: string;
  /**
   * Spec 0173 A2: an EXISTING docker network for the front to join — the Odoo
   * stack's own, so a branch front can call `http://odoo:8069` from inside the
   * box instead of leaving it and coming back through a TLS edge that serves a
   * self-signed certificate. Absent (production) renders exactly today's file.
   */
  odooNetwork?: string;
  /**
   * Spec 0208: the tenant database and the read-only credentials the front
   * authenticates with. REQUIRED, not optional — this is the third defect in
   * two days whose shape is "a function grew an optional parameter and a call
   * site never passed it" (VERIFICATION #12; specs 0205 and 0207 were the
   * others). Required means `tsc` fails for any caller that forgets, which is
   * a check that fires forever. The template refuses an unsubstituted
   * placeholder anyway, so the two guards agree.
   */
  odooDb: string;
  odooUser: string;
  odooPassword: string;
}

/**
 * Substitutes `${FRONT_NAME}` / `${ROUTER_HOST}` / `${ODOO_URL}` /
 * `${TLS_EXTRA_LABELS}` in the front template. Pure — no filesystem, no repo
 * writes. Twin of {@link renderStack} for the Next front container; the ACME
 * labels attach to the SAME router as its `.rule`/`.tls` labels (a certresolver
 * on a different router name would never take effect).
 */
export function renderFrontStack(template: string, params: RenderFrontStackParams): string {
  const tlsExtraLabels = params.certResolver
    ? `      - traefik.http.routers.${params.name}.tls.certresolver=${params.certResolver}\n` +
      `      - traefik.http.routers.${params.name}.entrypoints=websecure\n`
    : "";
  const substitutions: Record<string, string> = {
    "${FRONT_NAME}": params.name,
    "${ROUTER_HOST}": params.host,
    "${ODOO_URL}": params.odooUrl,
    "${TLS_EXTRA_LABELS}": tlsExtraLabels,
    // Spec 0169: the scaffold ships un-templated, so the slug reaches it as an
    // environment variable rather than being baked into its source.
    "${FRONT_SLUG}": params.slug,
    // Spec 0208: added to the template and to this map in the same change —
    // `renderStack`'s leftover-placeholder guard turns a half-done version into
    // a hard deploy failure rather than a container with a literal
    // `${ODOO_USER}` in its environment.
    "${ODOO_DB}": params.odooDb,
    "${ODOO_USER}": params.odooUser,
    "${ODOO_PASSWORD}": params.odooPassword,
    // Spec 0173 A2. Empty for production. When a network IS given, Traefik must
    // be told which of the front's two networks to route on: it runs on the
    // HOST network here, so it connects to a container IP, and with two to
    // choose from the choice is otherwise made for us.
    "${ODOO_NETWORK_ATTACH}": params.odooNetwork
      ? `    networks:\n      - default\n      - odoo\n`
      : "",
    "${ODOO_NETWORK_BLOCK}": params.odooNetwork
      ? `      - traefik.docker.network=${params.name}_default\n` +
        `networks:\n  odoo:\n    external: true\n    name: ${params.odooNetwork}\n`
      : "",
  };
  return renderTemplate(template, substitutions);
}

/**
 * Generates a strong random DB password for a tenant. Never persisted to the
 * repo or logs; the caller injects it into the rendered compose at deploy time.
 */
export function generateDbPassword(): string {
  // Prefixed with a letter, never bare base64url: that alphabet includes `-`,
  // and a password STARTING with `-` becomes a CLI flag inside the container's
  // `wait-for-psql --db_password <value>` — argparse reads it as an option and
  // dies with "expected one argument". Found live on the FIRST branch-staging
  // deploy (spec 0134 QA, 2026-08-05), a 1-in-64 draw that had been latent in
  // every tenant deploy since spec 0013. The prefix also keeps the value safe
  // as a YAML scalar and a shell word; existing stored passwords are untouched
  // (this only shapes NEW generations).
  return "p" + randomBytes(24).toString("base64url");
}

/**
 * Name of the Odoo database a tenant/stack serves. The DB init (plan step 4)
 * initializes exactly this DB and the rendered compose (plan step 3, via
 * `-d`/`--db-filter`) pins the stack to it so it serves it directly (no
 * selector). `<tenant>_<stack>` with anything outside `[a-zA-Z0-9_]` (e.g. the
 * `-` in `spec-42`) collapsed to `_`, since the name is used both as a
 * Postgres database identifier and inside a `--db-filter` regex — stable for
 * a given tenant/stack pair, distinct across tenants/stacks, safe in both
 * contexts.
 */
export function tenantDbName(tenantId: string, stack: StackName): string {
  return `${tenantId}_${stack}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Docker Compose PROJECT name for a tenant/stack (spec 0046 item A). ROOT CAUSE
 * of the 0045 collision: every `docker compose` call in this module passes only
 * `-f <path>` (never `-p`), so Compose defaults the project to the compose
 * file's parent-directory basename — the STACK (`prod`) — and the container +
 * named volumes (`prod_odoo-db`, `prod_odoo-filestore`) end up scoped to the
 * stack, SHARED across tenants on one box. Keying the project by
 * `<tenant>-<stack>` (threaded through `-p`) gives each tenant its own
 * project + volumes + password, so N tenants coexist on one VPS.
 *
 * Docker Compose project names must match `^[a-z0-9][a-z0-9_-]*$`: lowercase
 * `${tenantId}-${stack}` and collapse any other char to `-` (mirroring the
 * discipline in {@link tenantDbName}), guaranteeing a valid alphanumeric first
 * char. e.g. `("test","prod") → "test-prod"`, `("acme","prod") → "acme-prod"`
 * — distinct projects on the same box. With `-p` set, the template's bare
 * volume keys resolve to `<project>_odoo-db` / `<project>_odoo-filestore`
 * automatically (no template volume rename needed).
 *
 * Implementation: lowercase `${tenantId}-${stack}` and collapse any char
 * outside `[a-z0-9_-]` to `-`. Guarantees a valid first char since the only
 * inputs are alphanumerics (or already-`-`-collapsed chars) after lowercasing.
 */
export function composeProjectName(tenantId: string, stack: StackName): string {
  return `${tenantId}-${stack}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/**
 * Single command-prefix builder for EVERY `docker compose` invocation in this
 * module (spec 0046 item A) — routing every call through this instead of
 * inlining `-f <path>` ad hoc means the `-p <project>` flag can never drift
 * between calls (a mismatched `-p` across calls in one deploy would silently
 * split it across two projects, re-triggering the 0045 collision).
 */
function composeBase(project: string, composePath: string): string {
  return `docker compose -p ${project} -f ${composePath}`;
}

/** Default deadline (ms) for the Odoo-200 poll — generous enough for first boot. */
export const DEFAULT_ODOO_VERIFY_DEADLINE_MS = 180_000;
/** Default interval (ms) between Odoo-200 poll attempts. */
export const DEFAULT_ODOO_VERIFY_INTERVAL_MS = 5_000;

/**
 * Tunables for the poll-with-timeout Odoo-200 verify (spec 0013 plan step 1).
 * `deadlineMs`/`intervalMs` default to the constants above; `sleep` is injected
 * in tests to advance a fake clock so unit tests exercise first-boot latency
 * with NO real sleeps.
 */
export interface OdooVerifyOptions {
  deadlineMs?: number;
  intervalMs?: number;
  /** Injected in tests (fake clock); defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The SPEC §10 step-5 default business-module set for a tenant deploy (spec
 * 0093). `l10n_mx_edi` is deliberately EXCLUDED — CFDI is conditional on the
 * intake answer, so the caller appends it. `company_menu` is excluded too: it's
 * a custom addon that doesn't exist yet and would fail to install until the
 * addons mount lands (spec 0093 Scope). Opt-in: a caller passing nothing still
 * gets `base` only, so an existing tenant re-deploy is unchanged.
 */
export const ODOO_BUSINESS_MODULES: readonly string[] = ["sale", "stock", "point_of_sale", "account"];

/**
 * THE SECURITY BOUNDARY (spec 0093 Scope). Module names are interpolated into a
 * command run over SSH on a real host, so they are an injection surface. Odoo
 * module names are lower snake (`^[a-z0-9_]+$`); this rejects anything else —
 * spaces, `;`, `&&`, `$(`, backticks, `..`, quotes, empty strings — throwing a
 * NON-RETRYABLE `FleetError("config")` BEFORE any SSH call. Pure + unit-tested.
 */
export function validateModuleNames(modules: string[]): void {
  for (const name of modules) {
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new FleetError(
        "config",
        `invalid Odoo module name ${JSON.stringify(name)}: module names must match ^[a-z0-9_]+$`,
        { retryable: false },
      );
    }
  }
}

/** Addon rendered + installed when {@link DeployOptions.brand} is set (spec 0097). */
export const COMPANY_THEME_MODULE = "company_theme";

/**
 * Brand colours for the tenant's `company_theme` addon (spec 0097). Each is an
 * optional `#rrggbb` hex string; {@link validateBrandColors} rejects anything
 * else. Passing `brand` at all is the opt-in: omit it from
 * {@link DeployOptions} and no addon is written or installed — today's
 * behaviour exactly.
 */
export interface BrandOptions {
  primaryColor?: string;
  secondaryColor?: string;
}

/**
 * SECURITY BOUNDARY, twin of {@link validateModuleNames} (spec 0097). Brand
 * colours originate from intake answers and end up interpolated into the addon
 * data XML written over SSH, so each PROVIDED colour must match
 * `^#[0-9a-f]{6}$` (case-insensitive); anything else — a name (`red`), a
 * 3-digit `#fff`, a bad hex (`#12345g`), an injection (`"; rm -rf /"`) — throws
 * a NON-RETRYABLE `FleetError("config")` BEFORE any SSH call. Pure +
 * unit-tested.
 */
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function validateBrandColors(brand: BrandOptions): void {
  for (const [field, value] of Object.entries(brand)) {
    if (value !== undefined && !HEX_COLOR_RE.test(value)) {
      throw new FleetError(
        "config",
        `invalid brand colour ${JSON.stringify(value)} for ${field}: colours must match ^#[0-9a-f]{6}$`,
        { retryable: false },
      );
    }
  }
}

/**
 * Renders the `company_theme` addon's files (spec 0097). Returns relative
 * path → file content so the deploy path can write each under
 * `<stackDir>/addons/company_theme/` via `ssh.writeFile` — the same
 * in-memory-render → write path the compose file uses, so nothing touches the
 * repo tree. The set is `__init__.py` (empty), `__manifest__.py`, and one data
 * XML that sets `primary_color`/`secondary_color` on `base.main_company` (the
 * two columns verified to exist on `res_company` — `res_company` has no `logo`
 * column, so the logo is deliberately out of scope). Pure; the caller MUST
 * have validated `brand` via {@link validateBrandColors} first.
 */
export function renderCompanyThemeAddon(brand: BrandOptions): Record<string, string> {
  const dataFile = "res_company_brand.xml";
  const fields: string[] = [];
  if (brand.primaryColor !== undefined) {
    fields.push(`    <field name="primary_color">${brand.primaryColor}</field>`);
  }
  if (brand.secondaryColor !== undefined) {
    fields.push(`    <field name="secondary_color">${brand.secondaryColor}</field>`);
  }
  const dataXml = `<?xml version="1.0" encoding="utf-8"?>
<odoo>
  <record id="base.main_company" model="res.company">
${fields.join("\n")}
  </record>
</odoo>
`;
  const manifest = `{
    "name": "Company Theme",
    "version": "1.0",
    "depends": ["base"],
    "data": ["${dataFile}"],
    "installable": True,
    "license": "LGPL-3",
}
`;
  return {
    "__init__.py": "",
    "__manifest__.py": manifest,
    [dataFile]: dataXml,
  };
}

export interface DeployOptions {
  tenantId: string;
  vpsId: number;
  ssh: SshRunner;
  odooVersion: OdooVersion;
  domain: string;
  /**
   * Traefik router `Host()` override (spec 0148 phase C). Defaults to
   * {@link routerHost} (`${stack}.${tenantId}.${domain}`); odoo-next
   * provisioning passes `<slug>.odoo.example.com`. Used for BOTH the rendered rule
   * AND the ingress verification, so the host proved reachable is the host
   * actually served (no drift).
   */
  host?: string;
  /**
   * Traefik ACME cert-resolver (spec 0148 phase C) — e.g. `letsencrypt`. Set
   * only when {@link host} resolves publicly so ACME can issue a real cert;
   * omitted keeps the self-signed default (today's behaviour for `.test`).
   */
  certResolver?: string;
  /**
   * Spec 0226 D: take a NEUTRALIZED copy of production instead of initialising
   * an empty database — the "rama de pruebas" of `SPEC.md` §3.
   *
   * Called at the ONE moment `odoo` is not running (after `up -d db`, before
   * `up -d`), because Traefik routes to that service and nothing else: an
   * un-neutralized copy therefore has no HTTP server in front of it, by
   * construction rather than by ordering. It must restore, neutralize and PROVE
   * the neutralization (`neutralizeRestoredDb` asserts
   * `database.is_neutralized` from the branch DB) before returning; throwing
   * fails the deploy, which is the intended outcome — a half-neutralized copy
   * must never be served.
   *
   * Absent for every production deploy and for every branch that did not ask,
   * so the path that has been shipping for months is unchanged.
   */
  restoreFromProduction?: (target: {
    project: string;
    composePath: string;
    dbName: string;
  }) => Promise<void>;
  /** Defaults to "prod". */
  stack?: StackName;
  /**
   * REQUIRED (spec 0013 plan step 4): re-deploying with a freshly-generated
   * password breaks Postgres auth against the volume the first password
   * initialized, so `deployProductionStack` never invents one silently.
   * New-tenant callers generate one via {@link generateDbPassword} and pass it
   * explicitly; re-deploy callers must pass the SAME password used originally.
   */
  dbPassword: string;
  /**
   * Odoo's MASTER password (spec 0121) — what `/web/database/manager` asks for,
   * i.e. create/drop/duplicate/backup rights on this stack's database. Rendered
   * into a mounted `odoo.conf`, since no CLI flag exists.
   *
   * REQUIRED, deliberately. Optional would mean the image's commented-out default
   * (`admin`) governs a host that spec 0121 makes deliberately public — and an
   * optional security control is one that silently is not there.
   */
  masterPassword: string;
  /**
   * Password for the `admin` LOGIN (spec 0121) — a different thing from
   * `masterPassword`, and conflating them is how people lock themselves out.
   * Applied through the ORM on every deploy, so it is also how an existing
   * tenant's password gets corrected: one mechanism, no separate migration.
   */
  adminPassword: string;
  /**
   * Spec 0208: the read-only login the tenant's own FRONT authenticates with.
   * Required alongside `adminPassword` and for the same reason — the deploy is
   * the only moment we hold an open shell into this database, so it is the only
   * place the user can be created. Without it the front ships credentials that
   * authenticate against nothing.
   */
  odooReadonlyUser: string;
  odooReadonlyPassword: string;
  /** Poll-with-timeout tunables for the Odoo-200 verify (spec 0013 plan step 1). */
  verify?: OdooVerifyOptions;
  /**
   * Business modules to install alongside `base` (spec 0093). Omitted keeps
   * today's behaviour exactly (`base` alone). Validated by
   * {@link validateModuleNames} before any SSH call. Use
   * {@link ODOO_BUSINESS_MODULES} for the default set.
   */
  modules?: string[];
  /**
   * Brand colours (spec 0097). When set, the `company_theme` addon is rendered
   * ({@link renderCompanyThemeAddon}), written to
   * `<stackDir>/addons/company_theme/`, and `company_theme` is appended to the
   * SAME `-i` install pass (0093's one-pass rule). Validated by
   * {@link validateBrandColors} before any SSH call. Omitted ⇒ no addon
   * written and nothing installed — today's behaviour exactly, so existing
   * callers are unchanged.
   */
  brand?: BrandOptions;
  /**
   * A base64 `tar.gz` of addon directories to extract into the stack's mounted
   * `addons/` dir before the stack comes up (spec 0119 — staging environments).
   *
   * Sent as ONE `writeFile` + ONE `exec` rather than a `writeFile` per file: a
   * real Odoo addon is dozens of files, and `ssh.writeFile` is one SSH
   * connection each. Two round trips instead of fifty.
   *
   * Omitted keeps today's behaviour exactly — no upload, no extract. Orthogonal
   * to `brand`, which renders its addon in memory; both can be set, and both
   * land under the same `addons/` mount the template already declares.
   */
  addonsArchive?: string;
}

/**
 * Characters allowed in an Odoo password this code writes (spec 0121).
 *
 * A TRUST BOUNDARY, not tidiness: both passwords are interpolated into a remote
 * shell command and one of them into a Python literal, so a value containing a
 * quote, backslash, backtick or `$` could break out of either. Rejecting up front
 * is the only place this can be checked once for both.
 */
const SAFE_PASSWORD_RE = /^[A-Za-z0-9_@%+=:,./-]{8,128}$/;

function assertSafePassword(value: string, what: string): void {
  if (!SAFE_PASSWORD_RE.test(value)) {
    // Never echo the value — this message is logged.
    throw new FleetError(
      "config",
      `${what} must be 8-128 chars of [A-Za-z0-9_@%+=:,./-]; it is interpolated into a ` +
        `remote shell command and a Python literal, so quotes/backslashes/backticks/$ are refused`,
      { retryable: false },
    );
  }
}

/**
 * The `odoo.conf` mounted over the image's own (spec 0121).
 *
 * There is NO command-line flag for the master password — the image ships
 * `/etc/odoo/odoo.conf` with `; admin_passwd = admin` commented out, so without
 * this file Odoo's default governs `/web/database/manager`, which is
 * create/drop/duplicate/backup on the tenant's database. The owner wants these hosts
 * public, which makes that default unacceptable rather than theoretical.
 *
 * `addons_path` and `data_dir` are repeated verbatim from the image's own config:
 * this file REPLACES it, so omitting them would break spec 0097's extra-addons
 * mount and move the filestore out from under the existing volume.
 */
export function renderOdooConf(masterPassword: string): string {
  assertSafePassword(masterPassword, "master password");
  return [
    "[options]",
    "addons_path = /mnt/extra-addons",
    "data_dir = /var/lib/odoo",
    `admin_passwd = ${masterPassword}`,
    "",
  ].join("\n");
}

/** Path of the rendered `odoo.conf` on the VPS — mounted read-only by the stack. */
export function remoteOdooConfPath(tenantId: string, stack: StackName): string {
  return posixPath.join(remoteStackDir(tenantId, stack), "odoo.conf");
}

export interface DeployResult {
  tenantId: string;
  stack: StackName;
  odooVersion: OdooVersion;
  /** All compose services report healthy/running. */
  healthy: boolean;
  /**
   * Odoo answered HTTP 200 on 8069 — checked with `docker compose exec` INSIDE
   * the container, so this says nothing about whether anyone can reach it. See
   * `ingressOk`, which is the field that answers that question.
   */
  odooHttpOk: boolean;
  /**
   * Traefik served this stack's host over TLS (spec 0120). This is the field that
   * means "reachable": `odooHttpOk` was true for months on stacks the ingress
   * answered 404 for. Verified from the VPS with `--resolve`, so it tests routing
   * independently of whether the name resolves publicly.
   */
  ingressOk: boolean;
  /**
   * Modules actually INSTALLED by this deploy alongside `base` (spec 0093,
   * corrected by spec 0094). Absent when this deploy installed nothing — in
   * particular on every re-deploy against an existing tenant DB: the
   * `tenantDbExists` guard skips `initTenantDb` entirely, so a re-deploy
   * installs no modules no matter what `DeployOptions.modules` requested.
   */
  modules?: string[];
}

/** Services the rendered template declares; used to check post-deploy health. */
const EXPECTED_SERVICES = ["db", "odoo"];

/** Directory on the VPS a tenant/stack's rendered compose file lives under. */
export function remoteStackDir(tenantId: string, stack: StackName): string {
  return posixPath.join("/opt/launchpad", tenantId, stack);
}

/** Path to the rendered compose file for a tenant/stack on the VPS. */
export function remoteComposePath(tenantId: string, stack: StackName): string {
  return posixPath.join(remoteStackDir(tenantId, stack), "docker-compose.yml");
}

/**
 * Checks that every {@link EXPECTED_SERVICES} entry is reported as running by
 * compose. A not-yet-running service reads as unhealthy (caller decides
 * retryable vs fatal) rather than throwing here.
 */
async function verifyStackHealthy(ssh: SshRunner, project: string, composePath: string): Promise<boolean> {
  const result = await ssh.exec(`${composeBase(project, composePath)} ps --status running --services`);
  if (result.code !== 0) {
    return false;
  }
  const running = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return EXPECTED_SERVICES.every((service) => running.has(service));
}

/** Default real-time sleep used when {@link OdooVerifyOptions.sleep} isn't injected. */
function defaultSleep(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * Checks whether `dbName` already exists via a one-shot `psql` query against
 * the (already-started) `db` service — spec 0014 plan step 4's idempotency
 * gate. Connects to the always-present `postgres` admin database (never to
 * `dbName` itself, which may not exist yet). Any non-zero exit / unexpected
 * output (including "Postgres isn't accepting connections yet") reads as
 * "not initialized" — the safe default, since it leads to attempting init
 * rather than silently skipping it.
 */
async function tenantDbExists(ssh: SshRunner, project: string, composePath: string, dbName: string): Promise<boolean> {
  const result = await ssh.exec(
    `${composeBase(project, composePath)} exec -T db psql -U odoo -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
  );
  return result.code === 0 && result.stdout.trim() === "1";
}

/**
 * Initializes `dbName` with `base` plus any requested business modules (spec
 * 0093) via a one-off `docker compose run --rm` container rather than
 * `exec`-ing into the long-running serving container: the trailing args here
 * OVERRIDE the `odoo` service's pinned `command:` (docker compose's own
 * semantics for `run <service> <command...>`), so this never
 * races/duplicates the main server process — the caller only brings that up
 * (via `up -d`) once this has completed. `--stop-after-init` exits the
 * one-off container once the install finishes.
 *
 * `modules` are installed in the SAME `-i` pass as `base` (never one
 * container per module): Odoo resolves dependencies across the whole `-i`
 * set in one shot, and N sequential one-off containers would be N chances to
 * half-apply. Caller MUST have already validated `modules` via
 * {@link validateModuleNames} — this function only interpolates.
 */
async function initTenantDb(
  ssh: SshRunner,
  project: string,
  composePath: string,
  dbName: string,
  modules: readonly string[],
): Promise<void> {
  const installList = ["base", ...modules].join(",");
  const result = await ssh.exec(
    `${composeBase(project, composePath)} run --rm odoo -d ${dbName} -i ${installList} --stop-after-init`,
  );
  if (result.code !== 0) {
    throw new FleetError(
      "deploy",
      `tenant DB init failed for ${dbName} (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
}

/**
 * Single-shot curl of Odoo's login page from inside the `odoo` container over
 * the SSH connection (not the host's public interface — DNS/Traefik routing
 * for real domains is a later spec). Returns whether it answered HTTP 200.
 *
 * Honest readiness (spec 0014 plan step 5): with `db_name` fixed (step 3) an
 * initialized stack returns 200-no-redirect here. A 303 →
 * /web/database/selector means "stack serving selector — DB not
 * initialized/configured" — a distinct, non-retryable failure mode, not a
 * transient one worth polling to the deadline for. This curl uses `-fsS`
 * WITHOUT `-L`, so a 3xx already surfaces as a non-200 code (`-f` only trips
 * on 4xx/5xx, so a 303 still exits 0 with `%{http_code}` = "303"); this
 * function recognizes that specific case and throws immediately so
 * {@link verifyOdooHttp}'s poll loop short-circuits instead of retrying it to
 * the deadline.
 */
async function checkOdooHttp(ssh: SshRunner, project: string, composePath: string): Promise<boolean> {
  const result = await ssh.exec(
    `${composeBase(project, composePath)} exec -T odoo curl -fsS -o /dev/null -w '%{http_code}' http://localhost:8069/web/login`,
  );
  const httpCode = result.stdout.trim();
  if (result.code === 0 && httpCode === "303") {
    throw new FleetError(
      "verify",
      "Odoo is serving the database selector (303 → /web/database/selector) instead of " +
        "the tenant DB directly — stack serving selector — DB not initialized/configured. " +
        "This is a fast, non-retryable failure: fix db_name/dbfilter (plan step 3) or run " +
        "tenant DB init (plan step 4) rather than re-deploying and waiting.",
      { retryable: false },
    );
  }
  return result.code === 0 && httpCode === "200";
}

/**
 * Polls {@link checkOdooHttp} every `intervalMs` until it answers 200 or
 * `deadlineMs` of logical time elapses (spec 0013 plan step 1 — the 0012 live
 * smoke caught that a single-shot curl fires before Odoo finishes first boot).
 * "Logical" because elapsed time is counted in `intervalMs` increments rather
 * than read from the wall clock, so an injected no-op `sleep` (as unit tests
 * use) reaches the deadline deterministically with no real waiting.
 *
 * On deadline, re-checks container health to distinguish the two failure
 * shapes callers need to react to differently:
 *  - containers not all running → fatal `FleetError` (retryable: false),
 *    message includes a `docker compose ps` summary for diagnosis.
 *  - containers up but Odoo still not answering → retryable `FleetError`
 *    (retryable: true) — a caller may reasonably retry the whole deploy.
 */
async function verifyOdooHttp(
  ssh: SshRunner,
  project: string,
  composePath: string,
  options?: OdooVerifyOptions,
): Promise<void> {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_ODOO_VERIFY_DEADLINE_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_ODOO_VERIFY_INTERVAL_MS;
  const sleep = options?.sleep ?? defaultSleep;

  let elapsedMs = 0;
  for (;;) {
    if (await checkOdooHttp(ssh, project, composePath)) {
      return;
    }
    if (elapsedMs >= deadlineMs) {
      break;
    }
    await sleep(intervalMs);
    elapsedMs += intervalMs;
  }

  const healthy = await verifyStackHealthy(ssh, project, composePath);
  if (!healthy) {
    const ps = await ssh.exec(`${composeBase(project, composePath)} ps`);
    throw new FleetError(
      "verify",
      `Odoo did not answer HTTP 200 within ${deadlineMs}ms and containers are not all running:\n${ps.stdout.trim().slice(0, 1000)}`,
      { retryable: false },
    );
  }
  throw new FleetError(
    "verify",
    `Odoo did not answer HTTP 200 on 8069 within ${deadlineMs}ms after deploy (containers up)`,
    { retryable: true },
  );
}

/**
 * Sets the `admin` login's password through Odoo's ORM (spec 0121).
 *
 * **Through the ORM, not SQL.** Odoo stores a passlib hash; writing one by hand
 * into `res_users` produces a tenant nobody can log into, and the symptom looks
 * like a wrong password rather than a wrong hash format.
 *
 * **Via `/entrypoint.sh`,** because `docker compose exec` does not run the image's
 * entrypoint, and it is the entrypoint that turns the service's HOST/USER/PASSWORD
 * env into `--db_host`/`--db_user`/`--db_password`. Without it `odoo shell` tries a
 * local unix socket and fails. Passing those flags ourselves would put the DB
 * password in the box's process list.
 *
 * **Looks up by login rather than assuming id 2.** That is true today, but a
 * hardcoded row id silently targeting the wrong user is not a failure this would
 * report.
 *
 * Idempotent: setting the same password twice is a no-op from the caller's view.
 */
async function setAdminPassword(
  ssh: SshRunner,
  project: string,
  composePath: string,
  dbName: string,
  adminPassword: string,
): Promise<void> {
  assertSafePassword(adminPassword, "admin password");
  const script =
    `u = env['res.users'].search([('login','=','admin')], limit=1)\n` +
    `u.write({'password': '${adminPassword}'})\n` +
    `env.cr.commit()\n` +
    `print('ADMIN_PASSWORD_SET', len(u))\n`;
  const result = await ssh.exec(
    `printf '%s' ${shellSingleQuote(script)} | ${composeBase(project, composePath)} ` +
      `exec -T odoo /entrypoint.sh odoo shell -d ${dbName} --no-http 2>&1`,
  );
  // A check that can fail: the marker proves the script ran AND matched exactly one
  // user. `exec` exiting 0 while the ORM matched nothing would otherwise read as
  // success and leave the old password in place.
  if (result.code !== 0 || !result.stdout.includes("ADMIN_PASSWORD_SET 1")) {
    throw new FleetError(
      "deploy",
      `failed to set the admin password on ${dbName} (exit ${result.code}); expected the ` +
        `marker "ADMIN_PASSWORD_SET 1" in the shell output. Last 500 chars: ` +
        `${result.stdout.trim().slice(-500)}`,
      { retryable: true },
    );
  }
}

/**
 * Spec 0208: the READ-ONLY Odoo user a tenant's own front authenticates as.
 *
 * The front container is public-facing, so "read-only" has to be enforced by
 * Odoo's own groups rather than by trusting the front to only issue reads. The
 * user is created with NO groups at all beyond the implied portal/internal base
 * the ORM assigns — explicitly never `base.group_system`, and never
 * `base.group_user`, which carries write access across most business models.
 *
 * Idempotent by login, like {@link setAdminPassword}: an existing user has its
 * password reset to the stored one rather than a second row being created.
 * That matters because the credential is read-or-create — the store keeps the
 * password across redeploys, and this makes the database agree with it.
 *
 * Marker discipline, for the same reason spec 0121 introduced it: `exec`
 * exiting 0 while the ORM matched or wrote nothing reads as success. The script
 * prints a token with a count and the caller refuses unless it sees exactly
 * that token.
 */
/** The models a tenant's public-facing front may READ. The owner, 2026-08-15. Adding
 *  one widens what a public container can reach, so the list is short and lives
 *  here rather than spread across call sites. */
export const READONLY_MODELS: readonly string[] = ["product.template", "product.category"];

/** The group those read-only grants hang off, inside each tenant's own database. */
export const READONLY_GROUP_NAME = "Front (solo lectura)";

export async function ensureOdooReadonlyUser(
  ssh: SshRunner,
  project: string,
  composePath: string,
  dbName: string,
  login: string,
  password: string,
): Promise<void> {
  assertSafePassword(password, "odoo read-only password");
  if (!/^[a-z][a-z0-9_]{2,32}$/.test(login)) {
    throw new FleetError(
      "config",
      `odoo read-only login must be lowercase [a-z0-9_], 3-33 chars; it is interpolated ` +
        `into a Python literal`,
      { retryable: false },
    );
  }
  // The groups field was RENAMED between the majors we run: Odoo 18 calls it
  // `groups_id`, Odoo 19 calls it `group_ids`. Measured on live tenants of both,
  // not recalled — `ir_model_fields` for `res.users` returns exactly one of the
  // two. Asking the ORM's own registry beats threading the version down here: it
  // is right against whatever Odoo actually booted, including the next rename.
  //
  // Hardcoding `groups_id` shipped once and failed the deploy with
  // `ValueError: Invalid field 'groups_id' in 'res.users'` — loudly, only because
  // of the marker below. The unit test asserted the SCRIPT TEXT, which is
  // VERIFICATION #1: it proved the argument, never Odoo's answer.
  // The groups field was RENAMED between the majors we run: Odoo 18 calls it
  // `groups_id`, Odoo 19 calls it `group_ids`. Measured on live tenants of both,
  // not recalled. Asking the ORM's own registry beats threading the version down
  // here: it is right against whatever Odoo booted, including the next rename.
  // Hardcoding one of them shipped and failed a deploy.
  //
  // WHY A DEDICATED GROUP AND NOT ZERO GROUPS. The first version gave the user no
  // groups, reasoning that no groups means no writes. Measured: it also means no
  // READS — access in Odoo comes from `ir.model.access` rows attached to groups,
  // so a user with none has no grants at all. `base.group_portal` and
  // `base.group_public` cannot read `product.template` either; only
  // `base.group_user` can, and it also writes across most business models. So the
  // guarantee is an OWN group with explicit `perm_read`-only rows on exactly the
  // models the front may see (the owner, 2026-08-15) — enumerable, not inherited.
  const models = READONLY_MODELS.map((m) => `'${m}'`).join(", ");
  const script =
    `Users = env['res.users'].with_context(no_reset_password=True)\n` +
    `gfield = 'group_ids' if 'group_ids' in Users._fields else 'groups_id'\n` +
    `grp = env['res.groups'].search([('name','=','${READONLY_GROUP_NAME}')], limit=1)\n` +
    `if not grp:\n` +
    `    grp = env['res.groups'].create({'name': '${READONLY_GROUP_NAME}'})\n` +
    `acl = 0\n` +
    `for mname in [${models}]:\n` +
    // A model the tenant has not installed is SKIPPED, not an error: a branch
    // staging database is `base` plus the branch's own addons, so `product.*`
    // legitimately does not exist there.
    `    m = env['ir.model'].search([('model','=',mname)], limit=1)\n` +
    `    if not m:\n` +
    `        continue\n` +
    `    vals = {'name': 'front_readonly_' + mname.replace('.','_'), 'model_id': m.id,\n` +
    `            'group_id': grp.id, 'perm_read': True, 'perm_write': False,\n` +
    `            'perm_create': False, 'perm_unlink': False}\n` +
    `    a = env['ir.model.access'].search([('group_id','=',grp.id),('model_id','=',m.id)], limit=1)\n` +
    `    a.write(vals) if a else env['ir.model.access'].create(vals)\n` +
    `    acl += 1\n` +
    `u = Users.search([('login','=','${login}')], limit=1)\n` +
    `if u:\n` +
    `    u.write({'password': '${password}', 'active': True})\n` +
    `else:\n` +
    `    u = Users.create({\n` +
    `        'name': 'Front (solo lectura)',\n` +
    `        'login': '${login}',\n` +
    `        'password': '${password}',\n` +
    `    })\n` +
    // Re-asserted on EVERY deploy, and as the user's ONLY group: a membership
    // added by hand in the tenant's Odoo cannot silently widen what the
    // public-facing container reaches.
    `u.write({gfield: [(6, 0, [grp.id])]})\n` +
    `env.cr.commit()\n` +
    `print('ODOO_READONLY_USER_READY', len(u), 'acl=', acl)\n`;
  const result = await ssh.exec(
    `printf '%s' ${shellSingleQuote(script)} | ${composeBase(project, composePath)} ` +
      `exec -T odoo /entrypoint.sh odoo shell -d ${dbName} --no-http 2>&1`,
  );
  if (result.code !== 0 || !result.stdout.includes("ODOO_READONLY_USER_READY 1")) {
    throw new FleetError(
      "deploy",
      `failed to create the read-only Odoo user on ${dbName} (exit ${result.code}); expected ` +
        `the marker "ODOO_READONLY_USER_READY 1" in the shell output. Last 500 chars: ` +
        `${result.stdout.trim().slice(-500)}`,
      { retryable: true },
    );
  }
}

/** Single-quotes a string for a remote POSIX shell, escaping embedded quotes. */
function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The host Traefik routes this stack on — the exact value in the router's
 * `Host()` rule. One definition, because the ingress check below and the staging
 * result's `host` field must agree; two copies of this string is how you get a
 * check that passes against a host nobody can reach.
 */
export function routerHost(tenantId: string, stack: StackName, domain: string): string {
  return `${stack}.${tenantId}.${domain}`;
}

/**
 * HTTP status Traefik answers for `host` over TLS, from the VPS itself.
 *
 * `--resolve` pins the name to loopback, so this works for a domain that does
 * not resolve publicly (every tenant to date is on `.test`) — it tests ROUTING,
 * not DNS. `-k` because step 1 of spec 0120 serves Traefik's default self-signed
 * cert.
 *
 * Returns the raw status deliberately, so the caller can reject the ones that
 * look like success and are not: `301` is what the global `web → websecure`
 * redirect returns for EVERY host, valid or invented, and `404` is what Traefik
 * answers when no router matched. Treating either as "reachable" is the mistake
 * that hid spec 0120's defect for months.
 */
async function checkIngressStatus(ssh: SshRunner, host: string, path = "/web/login"): Promise<string> {
  const result = await ssh.exec(
    `curl -sk -o /dev/null -w '%{http_code}' --resolve ${host}:443:127.0.0.1 https://${host}${path}`,
  );
  return result.stdout.trim();
}

/**
 * Verifies the stack is reachable THROUGH Traefik, not merely alive inside its
 * container (spec 0120).
 *
 * This is the durable half of that spec. `verifyOdooHttp` runs its curl with
 * `docker compose exec -T odoo`, i.e. inside the container against
 * `localhost:8069` — it can never observe the ingress, which is exactly why
 * every deploy reported success while no tenant host served a single request.
 *
 * Polls, because Traefik's docker provider needs a moment to register a router
 * for a just-started container. Only `200` passes: see `checkIngressStatus` for
 * why 301 and 404 must not.
 */
async function verifyIngress(
  ssh: SshRunner,
  host: string,
  options?: OdooVerifyOptions,
  path = "/web/login",
): Promise<void> {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_ODOO_VERIFY_DEADLINE_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_ODOO_VERIFY_INTERVAL_MS;
  const sleep = options?.sleep ?? defaultSleep;

  let elapsedMs = 0;
  let lastStatus = "(none)";
  for (;;) {
    lastStatus = await checkIngressStatus(ssh, host, path);
    if (lastStatus === "200") return;
    if (elapsedMs >= deadlineMs) break;
    await sleep(intervalMs);
    elapsedMs += intervalMs;
  }

  // Name the two failures precisely, because they mean different things and one
  // of them used to be read as success.
  const diagnosis =
    lastStatus === "404"
      ? "Traefik matched no router for this host — check the router's `tls` label " +
        "(a router with no TLS config cannot serve the websecure entrypoint)"
      : lastStatus === "301"
        ? "got the global web→websecure redirect, which answers for ANY host and is " +
          "not evidence of routing — the request never reached a router"
        : `unexpected status ${lastStatus}`;
  throw new FleetError(
    "verify",
    `stack is not reachable through Traefik at ${host} after ${deadlineMs}ms ` +
      `(last status ${lastStatus}): ${diagnosis}. Odoo itself may be perfectly healthy — ` +
      `this checks the ingress, which is the gap spec 0120 closed.`,
    { retryable: true },
  );
}

/**
 * Renders the stack, copies it to the VPS, `docker compose up -d`, and verifies
 * health + Odoo on 8069. Idempotent (compose reconciles on re-deploy). All work
 * goes through `opts.ssh`. Refuses a non-sandbox-allowlisted `opts.vpsId` before
 * any side effect (ADR-013 / spec 0014 plan step 2 — see `sandbox.ts`).
 * `dbPassword` is required (spec 0013 plan step 4) —
 * omitting it throws rather than silently generating a fresh one, since a new
 * password on re-deploy breaks Postgres auth against the already-initialized
 * volume. The password is never written anywhere but the rendered compose on
 * the VPS.
 */
export async function deployProductionStack(opts: DeployOptions): Promise<DeployResult> {
  const { tenantId, ssh, odooVersion, domain } = opts;
  const stack = opts.stack ?? "prod";
  const dbPassword = opts.dbPassword;
  const modules = opts.modules ?? [];
  assertSandboxVps(opts.vpsId, "deployProductionStack");
  validateModuleNames(modules);
  if (opts.brand) {
    validateBrandColors(opts.brand);
  }
  if (!dbPassword) {
    throw new FleetError(
      "config",
      "dbPassword is required: deployProductionStack no longer generates one silently — " +
        "a fresh password on re-deploy would break Postgres auth against the volume the " +
        "original password initialized. Pass the tenant's existing password, or call " +
        "generateDbPassword() explicitly for a brand-new tenant.",
      { retryable: false },
    );
  }

  // One definition of the effective host (default via routerHost, or the
  // opts.host override), used for BOTH the rendered rule and verifyIngress —
  // two copies is how you get a check that passes against a host nobody serves.
  const host = opts.host ?? routerHost(tenantId, stack, domain);

  const template = await loadStackTemplate();
  const rendered = renderStack(template, {
    tenant: tenantId,
    stack,
    odooVersion,
    domain,
    dbPassword,
    host,
    certResolver: opts.certResolver,
  });

  const dir = remoteStackDir(tenantId, stack);
  const composePath = remoteComposePath(tenantId, stack);
  const dbName = tenantDbName(tenantId, stack);
  const project = composeProjectName(tenantId, stack);
  // 0093's one-pass rule: company_theme (when brand is set) installs in the
  // SAME `-i` pass as `base` + the requested business modules, never a
  // separate container.
  const installModules = opts.brand ? [...modules, COMPANY_THEME_MODULE] : modules;

  const mkdir = await ssh.exec(`mkdir -p ${dir}`);
  if (mkdir.code !== 0) {
    throw new FleetError(
      "deploy",
      `failed to create ${dir} (exit ${mkdir.code}): ${mkdir.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  // The rendered compose (with the live password embedded) goes ONLY to the
  // VPS via the SSH seam — it is never written to the repo tree.
  await ssh.writeFile(composePath, rendered);
  // Spec 0121: same rule for odoo.conf, which carries the master password. Written
  // BEFORE `up`, because the stack mounts it — a missing file would be created by
  // docker as an empty DIRECTORY and Odoo would start on its defaults.
  await ssh.writeFile(remoteOdooConfPath(tenantId, stack), renderOdooConf(opts.masterPassword));

  // The company_theme addon (spec 0097): rendered in memory and written under
  // the stack's mounted addons dir via the same ssh.writeFile seam as the
  // compose file — nothing touches the repo tree.
  if (opts.brand) {
    const addonDir = posixPath.join(dir, "addons", COMPANY_THEME_MODULE);
    // mkdir FIRST. `ssh.writeFile` is a bare `cat > <path>` — it does NOT
    // create parent directories, and the `mkdir -p ${dir}` above only makes the
    // stack dir, not `addons/<module>/`. Without this every branded deploy dies
    // on the first write with "No such file or directory". Found at gate 2 and
    // invisible to the unit tests: `FakeSshRunner.writeFile` is a `Map.set`, so
    // it has no notion of parent directories and cannot model this at all —
    // the same fake-vs-reality gap specs 0093/0094 hit. The ORDERING is what
    // the tests can and now do assert.
    const addonMkdir = await ssh.exec(`mkdir -p ${addonDir}`);
    if (addonMkdir.code !== 0) {
      throw new FleetError(
        "deploy",
        `failed to create ${addonDir} (exit ${addonMkdir.code}): ${addonMkdir.stderr.trim().slice(0, 500)}`,
        { retryable: true },
      );
    }
    for (const [relPath, content] of Object.entries(renderCompanyThemeAddon(opts.brand))) {
      await ssh.writeFile(posixPath.join(addonDir, relPath), content);
    }
  }

  // Spec 0119: the change under review, as addon directories, into the SAME
  // mounted `addons/` dir. Same mkdir-first ordering the brand block above had
  // to learn the hard way — `ssh.writeFile` is a bare `cat >` and creates no
  // parents.
  if (opts.addonsArchive) {
    const addonsRoot = posixPath.join(dir, "addons");
    const archivePath = posixPath.join(dir, "addons.tar.gz.b64");
    const mk = await ssh.exec(`mkdir -p ${addonsRoot}`);
    if (mk.code !== 0) {
      throw new FleetError(
        "deploy",
        `failed to create ${addonsRoot} (exit ${mk.code}): ${mk.stderr.trim().slice(0, 500)}`,
        { retryable: true },
      );
    }
    await ssh.writeFile(archivePath, opts.addonsArchive);
    // `base64 -d` is GNU coreutils on the Ubuntu images we deploy to. The
    // archive file is removed on success AND on failure — a half-extracted
    // upload left on disk would be silently mounted read-only into Odoo.
    // `--no-same-owner`: we extract as root, so without it tar applies the
    // archive's stored uid/gid — a developer laptop's `501:staff` showed up on
    // the files inside a real container on the first live run. Files under a
    // read-only mount should belong to root.
    const extract = await ssh.exec(
      `base64 -d < ${archivePath} | tar -xzf - --no-same-owner -C ${addonsRoot}; ` +
        `rc=$?; rm -f ${archivePath}; exit $rc`,
    );
    if (extract.code !== 0) {
      throw new FleetError(
        "deploy",
        `failed to extract addons into ${addonsRoot} (exit ${extract.code}): ` +
          extract.stderr.trim().slice(0, 500),
        { retryable: false },
      );
    }
  }

  // Bring up Postgres first. The `odoo` service is pinned to `dbName` via
  // -d/--db-filter (plan step 3) — starting it before `dbName` exists would
  // have the long-running server fail against a database that isn't there
  // yet, so first-deploy init (spec 0014 plan step 4) below runs against a
  // one-off `run --rm` container, never the serving one, and the full
  // `up -d` that brings `odoo` up follows only once `dbName` is guaranteed
  // to exist.
  const upDb = await ssh.exec(`${composeBase(project, composePath)} up -d db`);
  if (upDb.code !== 0) {
    throw new FleetError(
      "deploy",
      `docker compose up -d db failed (exit ${upDb.code}): ${upDb.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  // Idempotent tenant DB init: an already-initialized DB is detected and left
  // alone — a re-deploy must never re-init or wipe it. Whether init ran is
  // also the truth about whether any module actually installed (spec 0094):
  // a re-deploy against an existing DB installs nothing, however long
  // `opts.modules` is.
  const initRan = !(await tenantDbExists(ssh, project, composePath, dbName));
  if (initRan) {
    // Spec 0226 D. The database is being created RIGHT NOW, which is the only
    // moment a copy of production may be taken (`decideProductionCopy` —
    // odoo.sh copies at branch creation and never re-creates on later pushes).
    //
    // Strictly opt-in: `restoreFromProduction` is absent for every production
    // deploy and for every branch that did not ask, so this whole block is
    // unreachable on the path that has been shipping for months.
    //
    // It sits HERE rather than anywhere else because this is the window in
    // which `odoo` is not running: Traefik routes to that service and to
    // nothing else, so an un-neutralized copy has no HTTP server in front of it
    // until the `up -d` below. That is the safety property, and it is
    // structural — not an ordering someone has to remember.
    if (opts.restoreFromProduction) {
      await opts.restoreFromProduction({ project, composePath, dbName });
    } else {
      await initTenantDb(ssh, project, composePath, dbName, installModules);
    }
  }

  const up = await ssh.exec(`${composeBase(project, composePath)} up -d`);
  if (up.code !== 0) {
    throw new FleetError(
      "deploy",
      `docker compose up failed (exit ${up.code}): ${up.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  const healthy = await verifyStackHealthy(ssh, project, composePath);
  if (!healthy) {
    throw new FleetError(
      "verify",
      `stack services not all running after compose up (expected: ${EXPECTED_SERVICES.join(", ")})`,
      { retryable: true },
    );
  }

  await verifyOdooHttp(ssh, project, composePath, opts.verify);
  // Spec 0121: Odoo is up and the DB is reachable, so the login password can be
  // set. Every deploy, not just the initialising one — that is what corrects an
  // existing tenant instead of needing a separate migration.
  await setAdminPassword(ssh, project, composePath, dbName, opts.adminPassword);
  // Spec 0208: and the read-only user the front reads with. AFTER the admin
  // password, in the same open shell — every deploy, not just the initialising
  // one, so an existing tenant picks it up on redeploy exactly as spec 0121's
  // admin password does.
  await ensureOdooReadonlyUser(
    ssh,
    project,
    composePath,
    dbName,
    opts.odooReadonlyUser,
    opts.odooReadonlyPassword,
  );
  // Spec 0120: and then through the ingress. The check above proves Odoo is alive
  // inside its container; this proves anyone can actually reach it.
  await verifyIngress(ssh, host, opts.verify);

  // Spec 0205 D: what `ir_module_module` says, not what we asked for. This
  // field echoed its own argument, so `modules: ["point_of_sale"]` read as
  // "POS installed" whether or not the install pass had done anything —
  // VERIFICATION #1, in a field whose doc comment already claimed otherwise.
  // Still `undefined` when init did not run, which is the presence check
  // `staging.ts` keys on.
  const verified = initRan
    ? await installedModules(ssh, project, composePath, dbName)
    : undefined;

  return {
    tenantId,
    stack,
    odooVersion,
    healthy,
    odooHttpOk: true,
    ingressOk: true,
    modules: verified && installModules.filter((m) => verified.includes(m)),
  };
}

// --- odoo-next Next front stack DEPLOY (spec 0148 phase D2) ------------------

export interface DeployFrontStackOptions {
  /** Project slug — the front routes at `<slug>.${domain}` and lives under `<slug>/front`. */
  slug: string;
  vpsId: number;
  ssh: SshRunner;
  /** Zone the front is served under (`example.com`), so the host is `<slug>.example.com`. */
  domain: string;
  /** URL the front reaches its Odoo at — the phase-C stack. Injected as `ODOO_URL`. */
  odooUrl: string;
  /**
   * base64 `tar.gz` of the project checkout (phase A), extracted into the stack
   * dir so the front template's `build.context: .` builds the repo's OWN root
   * Dockerfile. Same one-writeFile-one-exec upload as
   * {@link DeployOptions.addonsArchive}.
   */
  sourceArchive: string;
  /**
   * Traefik ACME cert-resolver (`letsencrypt`), opt-in exactly like
   * {@link DeployOptions.certResolver}: set only once phase B makes
   * `<slug>.${domain}` resolve so ACME can issue; omitted keeps the self-signed
   * default.
   */
  certResolver?: string;
  /**
   * Spec 0172: which front this is. Defaults to `"front"` — production's, under
   * `<slug>/front`. A branch's staging passes its own so the two never share a
   * stack dir, a compose project or a Traefik router key.
   */
  stack?: StackName;
  /**
   * Spec 0172: the exact `Host()` rule. Defaults to `<slug>.<domain>`, which is
   * production's front. Same override `DeployOptions.host` gives the Odoo side,
   * and for the same reason: one deploy function, more than one place to serve.
   */
  host?: string;
  /** Spec 0173 A2: an existing docker network to join, so the front can reach
   * its Odoo by service name instead of through the public TLS edge. */
  odooNetwork?: string;
  /**
   * Spec 0208: the tenant database and the read-only credentials the front
   * authenticates with. REQUIRED — see {@link RenderFrontStackParams.odooDb}
   * for why these are not optional.
   */
  odooDb: string;
  odooUser: string;
  odooPassword: string;
  /** Poll-with-timeout tunables for the ingress verify. */
  verify?: OdooVerifyOptions;
}

export interface FrontDeployResult {
  slug: string;
  /** Compose project + Traefik router/service key — `<slug>-front`. */
  name: string;
  /** The host Traefik routes the front on — the exact `Host()` rule value. */
  host: string;
  /** Traefik served the front over TLS at {@link host} (200 at `/`). */
  ingressOk: boolean;
}

/**
 * The TAIL of a failed build's own output (spec 0192 C).
 *
 * A head slice cuts exactly the wrong end. Buildkit streams layer noise first
 * and prints the reason last — the failing step's own stdout in a `------`
 * block, then `failed to solve: … exit code: 1`. Run 4 recorded only docker's
 * one-line summary (`RUN npm run build … exit code: 1`), which names the step
 * and not the cause; finding the real one
 * (`ENOENT: no such file or directory, stat '/app/specs'`) took a hand-run
 * rebuild of the deployed context on the tenant box. A recorded failure has to
 * carry its reason, because the person reading it later cannot rerun the build.
 */
export function buildFailureTail(
  result: { stdout: string; stderr: string },
  limit = 2000,
): string {
  const text = [result.stderr, result.stdout]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * Deploys the Next front for an odoo-next project (spec 0148 phase D2): a
 * Traefik-routed container built from the project's OWN repo (phase A), serving
 * `<slug>.${domain}` and reaching its Odoo at `odooUrl` (the phase-C stack).
 *
 * Twin of {@link deployProductionStack} for the front. Reuses the stack-dir /
 * compose-project / ingress-verify machinery: the front lives under
 * `<slug>/front` so it never collides with the odoo stack (`<tenant>/prod`) on
 * one VPS, and its compose project name doubles as the render `name`
 * (`<slug>-front`).
 *
 *  - Refuses a non-sandbox `vpsId` via {@link assertSandboxVps} BEFORE any SSH
 *    (ADR-013 floor).
 *  - Uploads `sourceArchive` as one base64 `tar.gz` and extracts it into the
 *    stack dir so `build.context: .` is the repo root — the same
 *    upload-then-extract pattern as {@link DeployOptions.addonsArchive}. The
 *    archive is removed on success AND failure; the extract runs BEFORE we write
 *    our deploy compose, so ours always wins over any `docker-compose.yml` the
 *    repo itself ships.
 *  - `docker compose up -d --build` rebuilds the image from that context.
 *  - {@link verifyIngress} proves Traefik actually routes to the front over TLS,
 *    at `/` (a Next front does not serve Odoo's `/web/login`), on the SAME host
 *    the router rule uses — so the host proved reachable is the host served.
 */
export async function deployFrontStack(opts: DeployFrontStackOptions): Promise<FrontDeployResult> {
  const { slug, ssh, domain, odooUrl, sourceArchive } = opts;
  assertSandboxVps(opts.vpsId, "deployFrontStack");
  if (!sourceArchive) {
    throw new FleetError(
      "config",
      "deployFrontStack requires sourceArchive: the front is built from the project's own " +
        "repo (phase A), so there is nothing to build without the checkout.",
      { retryable: false },
    );
  }

  // One definition of the front's identity, threaded into BOTH the rendered rule
  // and verifyIngress — two copies is how you get a check that passes against a
  // host nobody serves (spec 0120). The `<slug>/front` stack keeps the front's
  // dir + compose project distinct from the odoo stack's `<tenant>/prod`.
  const stack: StackName = opts.stack ?? "front";
  const name = composeProjectName(slug, stack); // `<slug>-front`, also the router/service key
  const host = opts.host ?? `${slug}.${domain}`;
  const dir = remoteStackDir(slug, stack);
  const composePath = remoteComposePath(slug, stack);

  const rendered = renderFrontStack(await loadFrontStackTemplate(), {
    name,
    host,
    slug,
    odooUrl,
    certResolver: opts.certResolver,
    ...(opts.odooNetwork ? { odooNetwork: opts.odooNetwork } : {}),
    // Spec 0208.
    odooDb: opts.odooDb,
    odooUser: opts.odooUser,
    odooPassword: opts.odooPassword,
  });

  // Spec 0192 A2: REPLACE the build context, never merge into it.
  //
  // Extraction does not delete what the new archive omits, and the front's stack
  // dir is reused on every redeploy — so anything a previous deploy left behind
  // stays in the context forever. Measured on `gaming-tech` an hour after A
  // stopped packing `specs`: the symlink was still there from 02:56 and the
  // build failed with the SAME `ENOENT … stat '/app/specs'`. Beside it sat a
  // `.next/` and a `tsconfig.tsbuildinfo` from earlier builds — the generated
  // directory that outlives what generated it (docs/VERIFICATION.md #7), inside
  // the context of a Next build.
  //
  // `validateTenantStack` FIRST: both names are interpolated raw into this path
  // and this is now an `rm -rf`. The front stack has no volumes and no bind
  // mounts (infra/tenant/front-stack.tmpl.yml), so clearing the directory cannot
  // disturb the container currently serving.
  validateTenantStack(slug, stack);
  const mkdir = await ssh.exec(`rm -rf ${dir} && mkdir -p ${dir}`);
  if (mkdir.code !== 0) {
    throw new FleetError(
      "deploy",
      `failed to create ${dir} (exit ${mkdir.code}): ${mkdir.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  // Upload + extract the project checkout so `build.context: .` is the repo
  // root. One writeFile + one exec (the addonsArchive pattern): a repo is many
  // files and each writeFile is a fresh SSH connection. `--no-same-owner`: we
  // extract as root, so without it tar would stamp the archive's stored uid/gid
  // onto the build context. The b64 file is removed on success AND failure.
  const archivePath = posixPath.join(dir, "source.tar.gz.b64");
  await ssh.writeFile(archivePath, sourceArchive);
  const extract = await ssh.exec(
    `base64 -d < ${archivePath} | tar -xzf - --no-same-owner -C ${dir}; ` +
      `rc=$?; rm -f ${archivePath}; exit $rc`,
  );
  if (extract.code !== 0) {
    throw new FleetError(
      "deploy",
      `failed to extract the project checkout into ${dir} (exit ${extract.code}): ` +
        extract.stderr.trim().slice(0, 500),
      { retryable: false },
    );
  }

  // Our deploy compose is written AFTER the extract so it always wins over any
  // docker-compose.yml the repo ships. Straight to the VPS via the SSH seam —
  // never the repo tree.
  await ssh.writeFile(composePath, rendered);

  const up = await ssh.exec(`${composeBase(name, composePath)} up -d --build`);
  if (up.code !== 0) {
    throw new FleetError(
      "deploy",
      `docker compose up -d --build failed for ${name} (exit ${up.code}): ${buildFailureTail(up)}`,
      { retryable: true },
    );
  }

  // Spec 0120's durable check: Traefik actually routes to the front over TLS —
  // at `/`, not Odoo's `/web/login`, because this is a Next app.
  await verifyIngress(ssh, host, opts.verify, "/");

  return { slug, name, host, ingressOk: true };
}

// --- Install modules into an ALREADY-DEPLOYED tenant (spec 0100) -------------

/** Options for {@link installTenantModules}. */
export interface InstallModulesOptions {
  tenantId: string;
  ssh: SshRunner;
  /** Defaults to "prod" — same convention as {@link DeployOptions.stack}. */
  stack?: StackName;
  /**
   * Modules to install alongside what the tenant already has. Stock Odoo
   * modules only (they ship in the image); a CUSTOM addon additionally needs the
   * `extra-addons` mount spec 0097 added to the template, which no
   * already-running stack has — see spec 0100's non-goals.
   */
  modules: string[];
  /**
   * Caller-supplied UTC timestamp (compact `YYYYMMDDTHHMMSSZ`) for the
   * pre-install backup {@link backupTenant} takes BEFORE the `-i` pass (spec
   * 0105). MUST come from the caller — never `Date.now()` on this path: a
   * Temporal activity may retry, and a self-generated id would orphan a backup
   * directory on every retry (same reason as {@link BackupTenantOptions.timestamp}).
   */
  timestamp: string;
  /** Poll-with-timeout tunables for the post-restart Odoo-200 verify. */
  verify?: OdooVerifyOptions;
}

/** Outcome of {@link installTenantModules}. */
export interface InstallModulesResult {
  tenantId: string;
  stack: StackName;
  /** The modules requested — each VERIFIED `installed` in `ir_module_module`. */
  modules: string[];
  /** Tenant answered HTTP 200 after the restart. */
  odooHttpOk: boolean;
}

/**
 * Reads the names of modules currently in `state='installed'` for `dbName`.
 * Used to VERIFY the install actually took, rather than trusting the installer
 * command's exit code (spec 0100 — see that spec's note on why a green fake
 * suite proves nothing here).
 */
async function installedModules(
  ssh: SshRunner,
  project: string,
  composePath: string,
  dbName: string,
): Promise<string[]> {
  const result = await ssh.exec(
    `${composeBase(project, composePath)} exec -T db psql -U odoo -d ${dbName} -tAc ` +
      `"SELECT name FROM ir_module_module WHERE state='installed'"`,
  );
  if (result.code !== 0) {
    throw new FleetError(
      "verify",
      `could not read installed modules for ${dbName} (exit ${result.code}): ` +
        result.stderr.trim().slice(0, 300),
      { retryable: true },
    );
  }
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Installs `modules` into a tenant that is ALREADY RUNNING (spec 0100), without
 * touching its data.
 *
 * This is the operation `deployProductionStack` deliberately cannot do: spec
 * 0094 bound module install to first init (`initRan = !tenantDbExists(...)`), so
 * a re-deploy installs nothing and the only other route to adding a module was
 * dropping the tenant DB.
 *
 * Order, and why each step is there:
 *   1. {@link validateModuleNames} — module names reach a shell over SSH, so
 *      they are an injection surface. Runs BEFORE any SSH call.
 *   2. Refuse when the tenant DB does not exist. `odoo -i` against a missing DB
 *      CREATES and initializes one, so without this guard a typo in `tenantId`
 *      would silently manufacture a tenant instead of failing.
 *   3. {@link backupTenant} FIRST (spec 0105) — this is the one operation that
 *      mutates a live tenant's DB, so it takes a full backup (DB + filestore +
 *      compose) before touching anything. A failed backup throws here and the
 *      install never runs: no backup, no mutation.
 *   4. `run --rm odoo -d <db> -i <modules> --stop-after-init` — a one-off
 *      container whose trailing args override the service's pinned `command:`,
 *      so it never races the serving process ({@link initTenantDb} explains this
 *      at length). One `-i` pass for all modules: Odoo resolves the dependency
 *      closure in one shot, where N containers would be N chances to
 *      half-apply. Odoo treats `-i` on an already-installed module as a no-op,
 *      which is what makes this idempotent and safe to retry.
 *   5. `restart odoo` — step 4 changed the registry from a separate process
 *      while the serving worker holds a cached one. Odoo's registry signalling
 *      is supposed to make it reload, but that is subtle, version-dependent
 *      behaviour to bet a live tenant on; a few seconds of restart is
 *      unambiguous.
 *   6. Verify in BOTH places: every requested module reports `installed` in
 *      `ir_module_module`, and the tenant still answers 200. A command exit code
 *      is not evidence the world changed.
 *
 * Caller-side note: this takes an {@link SshRunner} and never resolves a host,
 * so the ADR-013 sandbox allowlist (`assertSandboxVps`) stays where it already
 * is — at whoever builds the runner. This function neither widens nor rechecks
 * that boundary.
 */
export async function installTenantModules(
  opts: InstallModulesOptions,
): Promise<InstallModulesResult> {
  const stack = opts.stack ?? "prod";
  const { tenantId, ssh } = opts;

  validateModuleNames(opts.modules); // step 1 — before ANY ssh call
  if (opts.modules.length === 0) {
    throw new FleetError("config", "installTenantModules: no modules requested", {
      retryable: false,
    });
  }

  const project = composeProjectName(tenantId, stack);
  const composePath = remoteComposePath(tenantId, stack);
  const dbName = tenantDbName(tenantId, stack);

  if (!(await tenantDbExists(ssh, project, composePath, dbName))) {
    throw new FleetError(
      "deploy",
      `installTenantModules: tenant DB ${dbName} does not exist — refusing to ` +
        `install into it (odoo -i would CREATE it, manufacturing a tenant). ` +
        `Deploy ${tenantId}/${stack} first.`,
      { retryable: false },
    );
  }

  // spec 0105: a module install mutates a live tenant DB, so take a full backup
  // FIRST — if it throws, the install below never runs (no backup, no mutation).
  // backupTenant re-checks tenantDbExists; that small redundancy keeps both
  // functions self-contained rather than plumbing a skip flag through.
  await backupTenant({ tenantId, ssh, stack, timestamp: opts.timestamp });

  const installResult = await ssh.exec(
    `${composeBase(project, composePath)} run --rm odoo -d ${dbName} ` +
      `-i ${opts.modules.join(",")} --stop-after-init`,
  );
  if (installResult.code !== 0) {
    throw new FleetError(
      "deploy",
      `module install failed for ${dbName} (exit ${installResult.code}): ` +
        installResult.stderr.trim().slice(0, 500),
      { retryable: true },
    );
  }

  const restartResult = await ssh.exec(`${composeBase(project, composePath)} restart odoo`);
  if (restartResult.code !== 0) {
    throw new FleetError(
      "deploy",
      `odoo restart failed after installing ${opts.modules.join(",")} into ${dbName} ` +
        `(exit ${restartResult.code}): ${restartResult.stderr.trim().slice(0, 300)}`,
      { retryable: true },
    );
  }

  const installed = new Set(await installedModules(ssh, project, composePath, dbName));
  const missing = opts.modules.filter((m) => !installed.has(m));
  if (missing.length > 0) {
    throw new FleetError(
      "verify",
      `module install reported success but ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not in state='installed' for ${dbName}`,
      { retryable: false },
    );
  }

  await verifyOdooHttp(ssh, project, composePath, opts.verify);

  return { tenantId, stack, modules: [...opts.modules], odooHttpOk: true };
}

// --- Per-tenant backup + one-click restore (spec 0105) ----------------------
//
// The recovery primitive the pipeline was missing: a per-TENANT (never
// per-VPS) backup taken before anything mutates a live tenant, plus a
// human-triggered restore. Two facts shaped this (spec 0105 F1/F2):
//   - Per tenant, not per host. `HostingerClient.createSnapshot` is VPS-level
//     and single-slot; three tenants share the sandbox box, so a VPS snapshot
//     restore would roll back two innocent tenants — a second outage.
//   - A tenant is DB + filestore. Odoo's `ir_attachment` rows point at files in
//     the `odoo-filestore` volume by checksum, so a DB-only restore yields a
//     tenant whose records reference attachments that no longer exist — broken
//     subtly, the worst way to be broken.
// A backup is therefore `{ db.sql.gz, filestore.tar.gz, docker-compose.yml }`.
// These functions live here so they can reuse this module's private helpers
// (`tenantDbExists`, `composeBase`, `verifyOdooHttp`) and 0100's injection
// discipline directly.

/**
 * Directory on the VPS holding a tenant/stack's backups — one sub-directory per
 * backup, named by the caller-supplied timestamp. Mirrors {@link remoteStackDir}
 * / {@link remoteComposePath}; shared by all three backup/restore functions so
 * the path is defined once.
 */
export function remoteBackupsDir(tenantId: string, stack: StackName): string {
  return posixPath.join(remoteStackDir(tenantId, stack), "backups");
}

/** Basenames of the three artifacts written into each backup directory. */
export const BACKUP_DB_FILE = "db.sql.gz";
export const BACKUP_FILESTORE_FILE = "filestore.tar.gz";
export const BACKUP_COMPOSE_FILE = "docker-compose.yml";

/** How many backups to keep per tenant/stack; older ones are pruned (spec 0105). */
export const BACKUP_RETENTION = 3;

/**
 * SECURITY BOUNDARY for the backup/restore family (spec 0105), twin of
 * {@link validateModuleNames}. `tenantId`/`stack` are interpolated RAW into
 * remote shell paths (`remoteStackDir` → `/opt/launchpad/<tenant>/<stack>`) and
 * `composeProjectName`/`tenantDbName` only COLLAPSE bad chars — neither rejects
 * an injection — so this throwing check must run BEFORE any SSH call. Accepts an
 * alphanumeric-led `[a-zA-Z0-9_-]` name (covers `acme`, `acme-staging`, `prod`,
 * `spec-42`); rejects empty, spaces, `/`, `..`, `;`, `&&`, `$(`, backticks and
 * quotes with a NON-RETRYABLE FleetError("config"). Pure + unit-tested.
 */
const TENANT_STACK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateTenantStack(tenantId: string, stack: StackName): void {
  for (const [field, value] of [
    ["tenantId", tenantId],
    ["stack", stack],
  ] as const) {
    if (!TENANT_STACK_RE.test(value)) {
      throw new FleetError(
        "config",
        `invalid ${field} ${JSON.stringify(value)}: must match ${TENANT_STACK_RE.source}`,
        { retryable: false },
      );
    }
  }
}

/**
 * The caller-supplied backup id is interpolated into a remote path AND is the
 * sort key retention/listing rely on. Requiring compact-UTC (`YYYYMMDDTHHMMSSZ`,
 * e.g. `20260729T123456Z`) does both jobs at once: it is injection-safe (digits,
 * `T`, `Z` only) and lexically sortable == chronologically sortable, so "newest
 * first" is a plain string sort. Anything else throws a NON-RETRYABLE
 * FleetError("config"). Pure + unit-tested; reused for restore's `backupId`.
 */
const BACKUP_TIMESTAMP_RE = /^\d{8}T\d{6}Z$/;

function validateBackupTimestamp(timestamp: string): void {
  if (!BACKUP_TIMESTAMP_RE.test(timestamp)) {
    throw new FleetError(
      "config",
      `invalid backup timestamp ${JSON.stringify(timestamp)}: must be compact UTC ` +
        `matching ${BACKUP_TIMESTAMP_RE.source} (e.g. 20260729T123456Z)`,
      { retryable: false },
    );
  }
}

/**
 * Runs one backup/restore SSH step and throws a RETRYABLE FleetError on a
 * non-zero exit. The whole family (spec 0105) is retry-safe — a re-run with the
 * SAME caller-supplied timestamp/backupId overwrites the same paths — so a
 * transient step failure is retryable.
 */
async function runBackupStep(ssh: SshRunner, command: string, what: string): Promise<SshExecResult> {
  const result = await ssh.exec(command);
  if (result.code !== 0) {
    throw new FleetError(
      "deploy",
      `${what} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
  return result;
}

/** Options for {@link backupTenant}. */
export interface BackupTenantOptions {
  tenantId: string;
  ssh: SshRunner;
  /** Defaults to "prod" — same convention as {@link DeployOptions.stack}. */
  stack?: StackName;
  /**
   * Caller-supplied UTC timestamp, used verbatim as the backup id AND its
   * directory name (`<stackDir>/backups/<timestamp>/`). MUST come from the
   * caller — never `Date.now()` on this path: a Temporal activity may retry, and
   * a self-generated id would orphan a directory on every retry (spec 0105).
   */
  timestamp: string;
}

/** Outcome of {@link backupTenant}. */
export interface BackupResult {
  tenantId: string;
  stack: StackName;
  /** Equals the caller-supplied `timestamp`; the restore point's id. */
  backupId: string;
  /** Size in bytes of the gzipped DB dump. */
  dbBytes: number;
  /** Size in bytes of the gzipped filestore archive. */
  filestoreBytes: number;
}

/** Options for {@link listTenantBackups}. */
export interface ListTenantBackupsOptions {
  tenantId: string;
  ssh: SshRunner;
  /** Defaults to "prod". */
  stack?: StackName;
}

/** Options for {@link restoreTenant}. */
export interface RestoreTenantOptions {
  tenantId: string;
  ssh: SshRunner;
  /** Defaults to "prod". */
  stack?: StackName;
  /**
   * The EXPLICIT backup id to restore — never "the latest". Restore is a
   * human-reviewed production mutation (spec 0105 non-goals: one click, never
   * zero); an unknown id is rejected.
   */
  backupId: string;
  /** Poll-with-timeout tunables for the post-restore Odoo-200 verify. */
  verify?: OdooVerifyOptions;
}

/** Outcome of {@link restoreTenant}. */
export interface RestoreResult {
  tenantId: string;
  stack: StackName;
  backupId: string;
  /** Tenant answered HTTP 200 after the restore. */
  odooHttpOk: boolean;
}

/**
 * Writes `<stackDir>/backups/<timestamp>/{db.sql.gz, filestore.tar.gz,
 * docker-compose.yml}` for a live tenant, then prunes to the newest
 * {@link BACKUP_RETENTION} (spec 0105 item 1).
 *
 * Contract (spec 0105 acceptance):
 *  - refuses (non-retryably) an invalid tenant/stack name and an invalid
 *    `timestamp` BEFORE any SSH call ({@link validateTenantStack} /
 *    {@link validateBackupTimestamp});
 *  - refuses (non-retryably) when the tenant DB does not exist (nothing to back
 *    up ⇒ the caller is confused about which tenant it is touching);
 *  - DB via `pg_dump -U odoo <db> | gzip` (guarded by `set -o pipefail` so a
 *    failed dump can't masquerade as a good backup); filestore via
 *    `docker run --rm -v <project>_odoo-filestore:/src:ro … tar czf` (volume
 *    mounted read-only ⇒ no Odoo downtime); compose copied byte-identical so a
 *    restore rebuilds the exact stack (Odoo version is a template parameter — a
 *    guessed version could silently upgrade a tenant).
 */
export async function backupTenant(opts: BackupTenantOptions): Promise<BackupResult> {
  const stack = opts.stack ?? "prod";
  const { tenantId, ssh, timestamp } = opts;

  // Injection surface: tenantId/stack/timestamp are interpolated RAW into
  // remote shell paths, so validate BEFORE any SSH call (spec 0105 acceptance).
  validateTenantStack(tenantId, stack);
  validateBackupTimestamp(timestamp);

  const project = composeProjectName(tenantId, stack);
  const composePath = remoteComposePath(tenantId, stack);
  const dbName = tenantDbName(tenantId, stack);
  const backupsDir = remoteBackupsDir(tenantId, stack);
  const backupDir = posixPath.join(backupsDir, timestamp);
  const dbPath = posixPath.join(backupDir, BACKUP_DB_FILE);
  const filestorePath = posixPath.join(backupDir, BACKUP_FILESTORE_FILE);
  const composeBackupPath = posixPath.join(backupDir, BACKUP_COMPOSE_FILE);

  // Nothing to back up ⇒ the caller is confused about which tenant it is
  // touching. Non-retryable, mirroring installTenantModules' missing-DB refusal.
  if (!(await tenantDbExists(ssh, project, composePath, dbName))) {
    throw new FleetError(
      "deploy",
      `backupTenant: tenant DB ${dbName} does not exist — refusing to back up a ` +
        `tenant that isn't there. Deploy ${tenantId}/${stack} first.`,
      { retryable: false },
    );
  }

  await runBackupStep(ssh, `mkdir -p ${backupDir}`, `mkdir ${backupDir}`);

  // DB: plain SQL dump piped through gzip. `set -o pipefail` (via an explicit
  // bash) is NOT optional — without it a pipeline's exit code is gzip's, so a
  // failed pg_dump would still exit 0 and write a truncated db.sql.gz that looks
  // like a good backup. A silently-broken backup is the exact failure this spec
  // exists to prevent.
  await runBackupStep(
    ssh,
    `bash -c 'set -o pipefail; ${composeBase(project, composePath)} exec -T db ` +
      `pg_dump -U odoo ${dbName} | gzip > ${dbPath}'`,
    `pg_dump for ${dbName}`,
  );

  // Filestore: archive the named volume via a throwaway container with the
  // volume mounted READ-ONLY, so Odoo keeps serving (no downtime) and the live
  // filestore is never mutated.
  await runBackupStep(
    ssh,
    `docker run --rm -v ${project}_odoo-filestore:/src:ro -v ${backupDir}:/backup ` +
      `alpine tar czf /backup/${BACKUP_FILESTORE_FILE} -C /src .`,
    `filestore archive for ${project}`,
  );

  // Compose: a byte-identical host copy so a restore rebuilds the EXACT stack,
  // including the Odoo version (a template parameter — a guessed version could
  // silently upgrade a tenant on restore).
  await runBackupStep(ssh, `cp ${composePath} ${composeBackupPath}`, `compose copy`);

  const stat = await runBackupStep(ssh, `stat -c %s ${dbPath} ${filestorePath}`, `stat backup artifacts`);
  const sizes = stat.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (sizes.length !== 2 || sizes.some((n) => !Number.isFinite(n))) {
    throw new FleetError(
      "deploy",
      `backupTenant: could not read backup artifact sizes for ${backupDir}: ${JSON.stringify(stat.stdout)}`,
      { retryable: true },
    );
  }
  const [dbBytes = 0, filestoreBytes = 0] = sizes;

  // Retention: keep the newest BACKUP_RETENTION, prune older ones. The sort is
  // done HERE (not in a shell one-liner) so the unit tests can prove exactly
  // which directories are removed; compact-UTC ids sort lexically == newest first.
  const ls = await runBackupStep(ssh, `ls -1 ${backupsDir}`, `list backups in ${backupsDir}`);
  const existing = ls.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => BACKUP_TIMESTAMP_RE.test(n));
  existing.sort().reverse();
  const toDelete = existing.slice(BACKUP_RETENTION);
  if (toDelete.length > 0) {
    const paths = toDelete.map((name) => posixPath.join(backupsDir, name)).join(" ");
    await runBackupStep(ssh, `rm -rf ${paths}`, `prune old backups in ${backupsDir}`);
  }

  return { tenantId, stack, backupId: timestamp, dbBytes, filestoreBytes };
}

/**
 * Lists the restorable backup ids for a tenant/stack, NEWEST FIRST (spec 0105
 * item 2) — a restore UI that cannot enumerate restore points is not a restore
 * UI. Refuses an invalid tenant/stack name BEFORE any SSH call
 * ({@link validateTenantStack}).
 *
 * `ls -1 <backupsDir>`, filtered to compact-UTC ids ({@link BACKUP_TIMESTAMP_RE})
 * so a stray file can't masquerade as a restore point, then sorted descending —
 * the same lexical==chronological sort `backupTenant`'s retention relies on. A
 * tenant with no backups yet has no `backups/` directory, so `ls` exits
 * non-zero; that is a legitimate "zero restore points", not an error, and
 * returns `[]` (mirroring {@link tenantDbExists}'s "unknown ⇒ safe default").
 */
export async function listTenantBackups(opts: ListTenantBackupsOptions): Promise<string[]> {
  const stack = opts.stack ?? "prod";
  const { tenantId, ssh } = opts;

  validateTenantStack(tenantId, stack);

  const ls = await ssh.exec(`ls -1 ${remoteBackupsDir(tenantId, stack)}`);
  if (ls.code !== 0) {
    return [];
  }
  return ls.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => BACKUP_TIMESTAMP_RE.test(n))
    .sort()
    .reverse();
}

/**
 * Restores a tenant from an EXPLICIT `backupId` (spec 0105 item 3) — never "the
 * latest": restore is a human-reviewed production mutation, so the caller names
 * the restore point and an unknown one is refused.
 *
 * Order, and why each step is there:
 *  1. validate tenant/stack/backupId BEFORE any SSH call (same injection surface
 *     as {@link backupTenant} — the id is interpolated into a remote path);
 *  2. reject an unknown `backupId` via {@link listTenantBackups} (non-retryable
 *     config error) so a typo can't restore nothing or the wrong point;
 *  3. `stop odoo` ONLY — `db` stays up so we can drop/recreate + reload against
 *     it, and a stopped Odoo has released its connection pool (so `dropdb`
 *     succeeds) and its filestore (so we can replace it);
 *  4. `dropdb`/`createdb` then reload the gzipped plain-SQL dump
 *     (`gunzip -c … | psql`, `set -o pipefail`-guarded so a failed gunzip can't
 *     feed psql an empty stream and pass — the truncated-backup failure this
 *     spec exists to prevent, mirrored on the restore side);
 *  5. REPLACE the filestore volume contents (clear then extract, not merge) so
 *     the restored `ir_attachment` rows match the files on disk exactly (F2);
 *  6. `up -d` to bring `odoo` back, then {@link verifyOdooHttp} 200 or throw — a
 *     restore that doesn't serve is a failed restore, and it fails loudly.
 *
 * Nothing calls this on a timer or threshold — restore is one click, never zero
 * (spec 0105 non-goals). The backed-up `docker-compose.yml` is kept as part of
 * the restore point's record; this spec's restore reuses the tenant's live
 * compose (version drift between backup and restore is out of scope, consistent
 * with the migrate-on-deploy non-goal).
 */
export async function restoreTenant(opts: RestoreTenantOptions): Promise<RestoreResult> {
  const stack = opts.stack ?? "prod";
  const { tenantId, ssh, backupId } = opts;

  // Injection surface: tenantId/stack/backupId are interpolated RAW into remote
  // shell paths, so validate BEFORE any SSH call (spec 0105 acceptance).
  validateTenantStack(tenantId, stack);
  validateBackupTimestamp(backupId);

  const project = composeProjectName(tenantId, stack);
  const composePath = remoteComposePath(tenantId, stack);
  const dbName = tenantDbName(tenantId, stack);
  const backupDir = posixPath.join(remoteBackupsDir(tenantId, stack), backupId);
  const dbPath = posixPath.join(backupDir, BACKUP_DB_FILE);
  const compose = composeBase(project, composePath);

  // Reject an unknown restore point — never restore "the latest" or a
  // nonexistent id. listTenantBackups enumerates the real restore points.
  const available = await listTenantBackups({ tenantId, ssh, stack });
  if (!available.includes(backupId)) {
    throw new FleetError(
      "config",
      `restoreTenant: unknown backupId ${JSON.stringify(backupId)} for ${tenantId}/${stack} — ` +
        `known restore points: ${available.join(", ") || "(none)"}. Refusing to restore.`,
      { retryable: false },
    );
  }

  // Stop ONLY odoo — db stays up for the drop/recreate/reload below.
  await runBackupStep(ssh, `${compose} stop odoo`, `stop odoo for ${project}`);

  // DB: drop + recreate an empty database, then reload the gzipped plain-SQL
  // dump into it. pipefail (via an explicit bash) is NOT optional — without it a
  // failed gunzip would still exit 0 and feed psql an empty stream, reloading
  // nothing while looking like success.
  await runBackupStep(ssh, `${compose} exec -T db dropdb -U odoo ${dbName}`, `dropdb ${dbName}`);
  await runBackupStep(ssh, `${compose} exec -T db createdb -U odoo ${dbName}`, `createdb ${dbName}`);
  await runBackupStep(
    ssh,
    `bash -c 'set -o pipefail; gunzip -c ${dbPath} | ${compose} exec -T db psql -U odoo -d ${dbName}'`,
    `reload DB dump into ${dbName}`,
  );

  // Filestore: REPLACE (clear then extract), not merge — the restored tenant's
  // attachments must match its DB exactly. Volume mounted read-WRITE here (the
  // backup mounted it :ro).
  await runBackupStep(
    ssh,
    `docker run --rm -v ${project}_odoo-filestore:/dst -v ${backupDir}:/backup ` +
      `alpine sh -c 'find /dst -mindepth 1 -delete && tar xzf /backup/${BACKUP_FILESTORE_FILE} -C /dst'`,
    `restore filestore for ${project}`,
  );

  // Bring the stack back up and prove it actually serves — a restore that
  // doesn't answer 200 is a failed restore.
  await runBackupStep(ssh, `${compose} up -d`, `compose up after restore for ${project}`);
  await verifyOdooHttp(ssh, project, composePath, opts.verify);

  return { tenantId, stack, backupId, odooHttpOk: true };
}
