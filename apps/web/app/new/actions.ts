"use server";

/**
 * Create a project for real (spec 0126 C).
 *
 * `/new` was a mockup: its final step incremented `useState(3) // maqueta` and
 * persisted nothing. This is the one server action behind it, and it is a thin
 * composition of five steps — gate, validate, verify, insert, audit — because
 * every decision inside it lives somewhere testable:
 *   - the gate is `actorFor("request")` (`lib/capabilities.ts`);
 *   - the rules are `validateProjectInput` (`lib/project-create.ts`);
 *   - the repo verdict is `interpretRepoAccess` (`@launchpad/github`);
 *   - the insert is `createProject` (`@launchpad/db`), which REFUSES a duplicate
 *     slug rather than overwriting another project.
 *
 * `request` and not `promote`: creating a project is asking for work to be done,
 * not shipping to production, so MEMBER and OWNER both qualify (spec 0117).
 */
import {
  createProject,
  DuplicateProjectSlugError,
  projectBySlug,
  putProjectMember,
  userIdsByEmail,
} from "@launchpad/db";
// The workflow TYPE as a STRING constant, never `provisionProject` the function
// — a production minifier renames the reference and Temporal looks up a type no
// worker serves (VERIFICATION #10, the nine-hour incident). `provisionProject`
// is imported as a TYPE only, so the function never enters this bundle.
import {
  PROVISION_PROJECT_WORKFLOW,
  TASK_QUEUE,
  type LogoCommit,
  type provisionProject,
} from "@launchpad/pipeline";
import { actorFor } from "../auth";
import { currentViewer } from "../viewer";
import { recordAudit } from "../../lib/audit";
import { getDb } from "../../lib/db";
import { validateProjectInput, validateLogoCommit, type ProjectCreateInput } from "../../lib/project-create";
import { productionHostFor, type FleetHostPolicy } from "../../lib/production-host";
import { getClient } from "../../lib/pipeline";
import { verifyRepoUsable } from "../../lib/repo-access";
import { DEFAULT_PROJECT_OWNER } from "../../lib/project-access";

export interface CreateProjectResult {
  ok: boolean;
  /** Slug of the created project, for redirecting to its workspace. */
  slug?: string;
  /** Which input was wrong, so the wizard can point at it. */
  field?: string;
  /** Human-readable reason, safe to render. */
  problem?: string;
}

export async function createProjectAction(
  input: ProjectCreateInput,
  /** REQUIRED: this action is shared by `/new` and `/connect`, which need
   *  opposite answers. See `lib/production-host.ts` for why it is not optional. */
  fleetHost: FleetHostPolicy,
): Promise<CreateProjectResult> {
  const check = await actorFor("request");
  if (!check.ok) {
    return { ok: false, problem: check.reason };
  }

  // Needed for both the creator's repo check (C) and the membership row below (A).
  const viewer = await currentViewer();

  const validated = validateProjectInput(input);
  if (!validated.ok) {
    return { ok: false, field: validated.field, problem: validated.problem };
  }
  const project = validated.value;

  // Verify the repo BEFORE inserting anything. Storing `owner/name` proves
  // nothing: the failure it hides surfaces at gate 2, an hour into a run, as a
  // 404 on a project that looked linked. Only when a repo was actually given —
  // a project may legitimately have none yet.
  if (project.repoOwner && project.repoName) {
    // Spec 0151: the two-part check now lives in `lib/repo-access.ts`, because
    // linking a repo to an EXISTING project asks the same question and must not
    // get a weaker answer.
    const usable = await verifyRepoUsable(project.repoOwner, project.repoName, viewer?.githubLogin);
    if (!usable.ok) return { ok: false, field: "repo", problem: usable.problem };
  }

  let projectId: string;
  try {
    projectId = await createProject(getDb(), {
      slug: project.slug,
      name: project.name,
      kind: project.kind,
      client: project.client,
      domain: project.domain,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      productionKind: project.productionKind,
      // Spec 0225 E, corrected: derived for `/new` (provisioning creates exactly
      // that name and writes its DNS, so row and DNS cannot disagree), never for
      // `/connect` (the tenant already exists somewhere we have not looked).
      productionHost: productionHostFor(fleetHost, {
        productionKind: project.productionKind,
        productionHost: project.productionHost,
        slug: project.slug,
      }),
      // Spec 0191: what the customer told us about their business, kept.
      intake: project.intake,
      // Spec 0205: the Odoo series they picked. `provisionOdoo` reads this column
      // (`provisionOdooVersion`), so this is the whole of "respect the version" —
      // the plumbing was already there, nothing ever wrote the value.
      ...(project.odooVersion === null ? {} : { version: String(project.odooVersion) }),
    });
  } catch (err) {
    if (err instanceof DuplicateProjectSlugError) {
      return { ok: false, field: "slug", problem: `Ya existe un proyecto con el identificador "${err.slug}".` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problem: `No pude crear el proyecto: ${message}` };
  }

  // Spec 0128 A: the creator becomes this project's owner, in the same request as
  // the insert. A project with no owner cannot have members added to it ever
  // again — nobody would hold the permission — so that state must be unreachable.
  if (viewer) {
    try {
      await putProjectMember(getDb(), {
        projectId,
        userId: viewer.userId,
        role: "owner",
        addedBy: viewer.email,
      });
    } catch {
      // The project exists; failing the whole action now would leave a row the
      // creator cannot see. Surfaced as a warning rather than swallowed silently.
      return {
        ok: true,
        slug: project.slug,
        problem: "El proyecto se creó, pero no pudimos registrarte como dueño. Pide que te agreguen en Ajustes.",
      };
    }
  }

  // Spec 0190: the platform owner is a member of every project. A MEMBERSHIP,
  // not a role escalation, so every gate and refusal keeps working as written and
  // simply finds the owner listed. `putProjectMember` upserts, so creator-is-owner collapses
  // to one row. Best-effort like the creator ownership above: the project exists,
  // and failing the action now would report a failure that did not happen.
  try {
    const ids = await userIdsByEmail(getDb(), [DEFAULT_PROJECT_OWNER]);
    const defaultOwnerId = ids.get(DEFAULT_PROJECT_OWNER);
    if (defaultOwnerId && defaultOwnerId !== viewer?.userId) {
      await putProjectMember(getDb(), {
        projectId,
        userId: defaultOwnerId,
        role: "owner",
        // No person pressed anything — the trail should not claim one did.
        addedBy: "spec-0190 (default owner)",
      });
    }
  } catch (err) {
    console.warn(
      `[project-create] ${project.slug}: could not add ${DEFAULT_PROJECT_OWNER} as default owner:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }

  // Spec 0075: one row per effectful action, after it succeeded. Shape only —
  // never a domain, a host, or anything that could carry a credential.
  await recordAudit({
    actor: check.actor,
    action: "project.create",
    target: project.slug,
    metadata: {
      kind: project.kind,
      linkedRepo: Boolean(project.repoOwner),
      productionKind: project.productionKind,
    },
  });

  return { ok: true, slug: project.slug };
}

export interface StartProvisioningResult {
  ok: boolean;
  problem?: string;
}

/**
 * Start the odoo-next provisioning workflow for a just-created project (spec
 * 0161 F2). Called by `/new` right after `createProjectAction` for a
 * `kind:odoo_next` project; the input is deliberately minimal (`{slug, logo?}`),
 * because the activities resolve repo coords, sandbox VPS and domain worker-side
 * from the project row + env — no worker-only secret crosses into apps/web.
 *
 * `request` and not `promote`, the same reasoning as `createProjectAction`:
 * provisioning is asking for work, not shipping to production (spec 0117).
 */
export async function startProvisioningAction(
  slug: string,
  logo?: LogoCommit,
): Promise<StartProvisioningResult> {
  const check = await actorFor("request");
  if (!check.ok) return { ok: false, problem: check.reason };

  // Re-validate at the trust boundary: the wizard's client-side check is a
  // convenience a forged payload skips, and these bytes become a commit in the
  // project's repo (VERIFICATION #1).
  if (logo) {
    const valid = validateLogoCommit(logo);
    if (!valid.ok) return { ok: false, problem: valid.problem };
  }

  // Spec 0182: the project's `domain` IS the zone (the owner), so the run carries it
  // and every phase agrees. Read once here rather than per activity — the
  // constant this replaces is why `ab-test-sandbox` has a hostname in a zone
  // nobody created: provisioning wrote into `example.com` while the project's
  // domain said otherwise, and the release deploy believed the project.
  const project = await projectBySlug(getDb(), slug).catch(() => null);
  const zone = project?.domain?.trim() || undefined;

  try {
    const client = await getClient();
    await client.workflow.start<typeof provisionProject>(PROVISION_PROJECT_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      // One provisioning run per project — a double submit is a Temporal
      // duplicate-id refusal, caught below, not a second run.
      workflowId: `provision-${slug}`,
      args: [{ slug, ...(logo ? { logo } : {}), ...(zone ? { zone } : {}) }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already started|Workflow execution already/i.test(message)) {
      return { ok: false, problem: "Ya hay un aprovisionamiento en curso para este proyecto." };
    }
    return { ok: false, problem: `No pude iniciar el aprovisionamiento: ${message}` };
  }

  await recordAudit({
    actor: check.actor,
    action: "project.provision",
    target: slug,
    metadata: { hasLogo: Boolean(logo) },
  });

  return { ok: true };
}
