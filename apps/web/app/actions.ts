"use server";

/**
 * Server Action backing the /fleet per-VPS "Deploy tenant" form (spec 0027).
 * Server-only — the Hostinger token and Temporal address never reach the
 * browser (spec 0022 discipline). Mirrors app/specs/[filename]/actions.ts:
 * thin wiring over pure helpers (lib/tenant-start.ts) and Temporal I/O
 * (lib/pipeline.ts#startTenantPipeline). Since spec 0074 it requires a
 * signed-in OWNER session and stamps the verified session email as actor —
 * a tenant deploy is a mutating, money-adjacent action.
 *
 * Flow: validate + RE-CHECK sandbox classification server-side (a forged
 * direct call for a non-sandbox vpsId is refused BEFORE any workflow starts) →
 * compute the next free spec id server-side (never trust a prefilled/editable
 * form value — spec 0032 item 4) → synthesize the deterministic vanilla
 * request (spec 0046 item C — the form no longer carries a free-text request
 * field) → startTenantPipeline → redirect to the spec detail page so gates
 * 1/2/3 are one click away. Any failure redirects back to `/` with `?error=`
 * rather than throwing into Next's generic error page — a click must never be
 * lost silently (spec 0007 pattern).
 */
import { redirect } from "next/navigation";
import { loadSandboxAllowlist } from "@launchpad/fleet-hostinger";
import { ownerEmail } from "./auth";
import { recordAudit } from "../lib/audit";
import { startTenantPipeline } from "../lib/pipeline";
import { listSpecs } from "../lib/specs";
import { allocateSpecId, projectBySlug } from "@launchpad/db";
import { getDb } from "../lib/db";
import { PLATFORM_PROJECT_SLUG } from "../lib/spec-project";
import {
  validateTenantStartForm,
  tenantStartRedirectPath,
  nextSpecId,
  vanillaTenantRequest,
  type TenantStartFormFields,
} from "../lib/tenant-start";

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

export async function startTenantPipelineAction(formData: FormData): Promise<void> {
  // Spec 0074: OWNER session required before anything else — a forged or
  // signed-out POST is refused before validation, allowlist reads, or any
  // workflow start.
  const actor = await ownerEmail();
  if (!actor) {
    redirect(`/?error=${encodeURIComponent("Sign in as OWNER to deploy a tenant.")}`);
    return;
  }

  const fields: TenantStartFormFields = {
    tenantId: field(formData, "tenantId"),
    odooVersion: field(formData, "odooVersion"),
    vpsId: field(formData, "vpsId"),
  };

  const sandboxIds = loadSandboxAllowlist();
  const validation = validateTenantStartForm(fields, sandboxIds);
  if (!validation.ok) {
    redirect(`/?error=${encodeURIComponent(validation.error)}`);
  }

  const { tenantId, odooVersion, vpsId } = validation.value;
  const request = vanillaTenantRequest(tenantId, odooVersion);
  // Spec 0164: filesystem for the floor, database for the number — a second
  // person starting a tenant deploy at the same moment must not get this id.
  const floor = Number(nextSpecId((await listSpecs()).map((s) => s.id))) - 1;
  const platform = await projectBySlug(getDb(), PLATFORM_PROJECT_SLUG);
  if (!platform) {
    redirect(`/?error=${encodeURIComponent("No encuentro el proyecto platform para asignar el id del spec.")}`);
    return;
  }
  const specId = await allocateSpecId(getDb(), platform.id, floor);
  try {
    await startTenantPipeline(specId, request, actor, { tenantId, vpsId, odooVersion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    redirect(`/?error=${encodeURIComponent(`Could not start tenant pipeline: ${message}`)}`);
  }

  await recordAudit({ actor, action: "tenant.start", target: specId, metadata: { tenantId, vpsId, odooVersion } });
  redirect(tenantStartRedirectPath(specId));
}
