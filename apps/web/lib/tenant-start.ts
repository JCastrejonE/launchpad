/**
 * Pure helpers for the /fleet tenant-start control (spec 0027). NO I/O and no
 * browser secrets: the Temporal call lives in lib/pipeline.ts#startTenantPipeline
 * and the redirect lives in app/fleet/actions.ts. Everything here is a pure
 * function so the target-building shape, next-spec-id derivation, odoo-version
 * validation, and the server-side sandbox re-check are all unit-tested without
 * a live Temporal server (mirrors the derivePipelineState split in
 * lib/pipeline.ts).
 *
 * All Plan items (1 and 3) implemented; see lib/tenant-start.test.ts.
 */
import type { OdooVersion, PipelineInput, PipelineTarget } from "@launchpad/pipeline";
import { classifyVps } from "./fleet";

/** The per-VPS tenant deploy inputs, once validated. */
export interface TenantStartArgs {
  tenantId: string;
  vpsId: number;
  odooVersion: OdooVersion;
}

/**
 * Builds the tenant `PipelineInput`, IDENTICAL in shape to `cli start-tenant`
 * (packages/pipeline/src/cli.ts lines ~83-93) for the same arguments. The
 * single source of truth for the tenant target shape on the apps/web side, so
 * the UI path and the CLI path never drift — unit-tested against the same
 * expectations. `requestedBy` is passed in (the server action supplies
 * the session email, spec 0074); `repo` comes from LAUNCHPAD_REPO_ROOT at the I/O boundary.
 */
export function buildTenantPipelineInput(
  specId: string,
  request: string,
  requestedBy: string,
  repo: string,
  args: TenantStartArgs,
): PipelineInput {
  const target: PipelineTarget = {
    kind: "tenant",
    tenantId: args.tenantId,
    repo,
    odooVersion: args.odooVersion,
    vpsId: args.vpsId,
  };
  return { specId, target, request, requestedBy };
}

/**
 * Deterministic `request` synthesized server-side for a vanilla tenant deploy
 * (spec 0046 item C). The deploy form no longer carries a free-text request
 * field; instead the server computes a fixed descriptor from the tenant id +
 * odoo version so `draftSpec` still receives well-formed input with NO browser
 * secret and NO workflow change (determinism preserved). The descriptor steers
 * the spec-drafter to leave the Progress checklist empty — a vanilla deploy is
 * an infrastructure provision, not a code change, so the coder loop should
 * converge immediately (the vacuous-interim-pipeline risk in the Handoff log;
 * ~spec 0047 removes the vacuity via a lighter flow).
 *
 */
export function vanillaTenantRequest(tenantId: string, odooVersion: OdooVersion): string {
  return (
    `Vanilla stock Odoo ${odooVersion} deployment for tenant ${tenantId} — ` +
    "infrastructure provision only, NO code change; the spec's Progress " +
    "checklist should be empty (nothing for the coder to implement)."
  );
}

/**
 * Parse/validate an Odoo-version string ("17" | "18" | "19") into an
 * OdooVersion, or `null` when invalid. Mirrors cli start-tenant's
 * --odoo-version check so the UI refuses the same bad values.
 */
export function parseOdooVersion(raw: string | undefined | null): OdooVersion | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (n === 17 || n === 18 || n === 19) return n;
  return null;
}

/**
 * Next unused, zero-padded 4-digit spec id derived from existing ids
 * (`SpecSummary.id[]` from listSpecs). Non-numeric ids (filename fallbacks) are
 * ignored. Returns `max(numeric)+1` padded to 4 digits, or "0001" when empty.
 * Pure, so the /fleet form's default spec id is unit-tested.
 */
export function nextSpecId(existingIds: string[]): string {
  const max = existingIds.reduce((acc, id) => {
    if (!/^\d+$/.test(id)) return acc;
    const n = Number(id);
    return n > acc ? n : acc;
  }, 0);
  return String(max + 1).padStart(4, "0");
}

/** Raw, un-trusted /fleet form fields (all strings from the multipart body). */
export interface TenantStartFormFields {
  tenantId?: string;
  odooVersion?: string;
  vpsId?: string;
}

/**
 * Validated tenant-start request, ready to hand to startTenantPipeline. No
 * `specId` here — the form no longer carries one (spec 0032 item 4, removing
 * an editable/prefilled TOCTOU-ish field); the caller (app/fleet/actions.ts)
 * computes the next free id server-side at submit via
 * `nextSpecId(listSpecs().map((s) => s.id))`. No `request` here either (spec
 * 0046 item C) — the form no longer carries a free-text request field; the
 * caller computes the deterministic `request` via `vanillaTenantRequest`
 * AFTER validation, from the now-validated `tenantId`/`odooVersion`.
 */
export interface TenantStartRequest {
  tenantId: string;
  odooVersion: OdooVersion;
  vpsId: number;
}

export type TenantStartValidation =
  | { ok: true; value: TenantStartRequest }
  | { ok: false; error: string };

/**
 * Validates raw /fleet form fields AND re-checks the sandbox classification
 * server-side (spec 0027 acceptance: a forged direct call for a non-sandbox
 * vpsId is refused with a clear error BEFORE any workflow starts). Pure — takes
 * the sandbox allowlist rather than reading it — so both the happy path and the
 * refusal path are unit-tested. The worker's `assertSandboxVps` remains the
 * real enforcement layer regardless of this UI-side check. Does NOT touch
 * `specId` (spec 0032 item 4) — that is computed server-side by the caller,
 * never taken from the form.
 */
export function validateTenantStartForm(
  fields: TenantStartFormFields,
  sandboxIds: number[],
): TenantStartValidation {
  const tenantId = (fields.tenantId ?? "").trim();
  if (!tenantId) return { ok: false, error: "Tenant id is required" };

  const odooVersion = parseOdooVersion(fields.odooVersion);
  if (odooVersion === null) {
    return {
      ok: false,
      error: `Invalid Odoo version "${fields.odooVersion ?? ""}" (must be 17, 18, or 19)`,
    };
  }

  const rawVpsId = (fields.vpsId ?? "").trim();
  if (!/^\d+$/.test(rawVpsId)) {
    return { ok: false, error: `Invalid VPS id "${fields.vpsId ?? ""}"` };
  }
  const vpsId = Number(rawVpsId);

  // Server-side re-check (never trust the browser): a forged direct call for
  // a non-sandbox vpsId is refused here, BEFORE any workflow starts. The
  // worker's assertSandboxVps remains the real enforcement layer regardless.
  if (classifyVps(vpsId, sandboxIds) !== "sandbox") {
    return {
      ok: false,
      error: `Refusing: VPS ${vpsId} is a production VPS, not a sandbox — tenant deploys can only be started for sandbox VPSes`,
    };
  }

  return { ok: true, value: { tenantId, odooVersion, vpsId } };
}

/**
 * Builds the redirect target for a just-started tenant run: the spec detail
 * page for `specId`, so gates 1/2/3 are one click away (spec 0027 acceptance).
 *
 * RESOLVED (was an open question in the Handoff log): the spec file does not
 * exist yet at redirect time — the workflow's async `draftSpec` creates it and
 * picks its OWN slug, so a precomputed `/forge/specs/<specId>-<slug>` would
 * 404 or mismatch. Rather than have this pure, id-only helper guess the slug,
 * it redirects to the BARE id (`/forge/specs/<specId>`);
 * `app/forge/specs/[filename]/page.tsx` now resolves a bare id to its actual
 * `<specId>-slug.md` file by prefix (`lib/specs.ts#resolveSpecFilenameById`,
 * mirroring `@launchpad/pipeline` `store.ts#findSpecFile`) instead of
 * requiring an exact filename match.
 */
export function tenantStartRedirectPath(specId: string): string {
  return `/forge/specs/${specId}`;
}
