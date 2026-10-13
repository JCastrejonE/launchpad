"use server";

/**
 * Connect a project that already exists (spec 0225 C).
 *
 * The whole point, in the owner's words: *"connecting an existing project should be
 * easier than creating a new one, because most of the stack already exists — we
 * just plug in our forge so we can commit changes using our pipeline."* Measured
 * and true: a spec run touches the local checkout and GitHub, and
 * `deployStaging` returns null without a staging VPS, so **the commit half of
 * the pipeline needs no fleet access at all**.
 *
 * So this is deliberately thin, and almost all of it is reuse:
 *
 * - `createProjectAction` (`/new`) already inserts the row, refuses a duplicate
 *   slug by name, and adds both the creator and the default owner as members.
 * - `verifyRepoUsable` already asks whether the server token AND the asking
 *   person can push — the check whose absence surfaces an hour into a run.
 * - `ensureCheckout` materializes the checkout ON DEMAND at the first run, so
 *   connecting does not clone anything and cannot leave a half-made one.
 *
 * What is genuinely new is the REFUSAL: `connectPreflight` turns three failures
 * that today happen deep inside a run into a named refusal at this moment.
 */
import type { ProjectKind } from "@launchpad/db";
import { access, constants } from "node:fs/promises";
import { GithubClient } from "@launchpad/github";
import { checkoutsRoot, specsRoot } from "@launchpad/pipeline";
import { currentViewer } from "../viewer";
import { verifyRepoUsable } from "../../lib/repo-access";
import { parseRepoRef } from "../../lib/project-create";
import {
  connectPreflight,
  inspectRepoShape,
  preflightBlocks,
  type PreflightFinding,
} from "../../lib/connect-preflight";
import { createProjectAction } from "../new/actions";
import type { CreateProjectResult } from "../new/actions";

export interface ConnectInput {
  name: string;
  slug: string;
  /** CANONICAL spelling — the wizard translates through `fromUiKind` before
   *  calling. Typed so the UI spelling cannot reach the preflight, which is how
   *  `odoo_kind_without_addons` went silently dead. */
  kind: ProjectKind;
  client: string;
  /** `owner/name`, as typed. Required — connecting is about a repo. */
  repo: string;
  /** The customer's domain, if they have one. Recorded, never provisioned. */
  domain?: string | null;
  /** Where it already runs, so Stage 2 can find it. Never written to here. */
  productionHost?: string | null;
  /** The series the EXISTING tenant runs. Asked, because it decides the staging
   *  image; defaulting it silently claimed a fact nobody had checked. */
  odooVersion?: string | null;
  productionKind?: string | null;
}

export type ConnectResult =
  | { ok: true; slug: string; warnings: PreflightFinding[] }
  | { ok: false; problem: string; findings?: PreflightFinding[] };

/** Can the identity running this service write where the pipeline will? */
async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function connectProjectAction(input: ConnectInput): Promise<ConnectResult> {
  const ref = parseRepoRef(input.repo);
  if (!ref.ok) return { ok: false, problem: ref.problem };

  const viewer = await currentViewer();
  const usable = await verifyRepoUsable(ref.owner, ref.name, viewer?.githubLogin);
  if (!usable.ok) return { ok: false, problem: usable.problem ?? "No puedo usar ese repositorio." };

  // Read the repo's actual shape. The wizard asks for a kind; the repo IS one,
  // and where they disagree the repo wins the technical question (spec 0225
  // decision 5) — the answer is a fact and the pick is an intention.
  let findings: PreflightFinding[];
  try {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) return { ok: false, problem: "No hay GITHUB_TOKEN en este servidor." };
    const client = new GithubClient({ token, owner: ref.owner, repo: ref.name });
    // `HEAD` rather than a looked-up default branch: the trees API resolves it,
    // and asking GitHub twice to learn a name we then hand straight back is a
    // round trip for nothing.
    const tree = await client.listTreePaths("HEAD");
    if (tree.truncated) {
      // A partial tree could hide the very `specs/` this refuses on, and a
      // preflight that might have missed the thing it exists to catch is worse
      // than no preflight (VERIFICATION #2).
      return {
        ok: false,
        problem:
          "GitHub devolvió el árbol del repositorio truncado, así que no puedo comprobarlo con " +
          "certeza. Vuelve a intentarlo.",
      };
    }
    findings = connectPreflight({
      shape: inspectRepoShape(tree.paths),
      kind: input.kind,
      checkoutsRootWritable: await writable(checkoutsRoot()),
      specsRootWritable: await writable(specsRoot()),
    });
  } catch (err) {
    return { ok: false, problem: `No pude inspeccionar el repositorio: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (preflightBlocks(findings)) {
    return {
      ok: false,
      problem: findings.filter((f) => f.blocking).map((f) => f.problem).join(" "),
      findings,
    };
  }

  // Everything below is `/new`'s, unchanged. Connecting differs by what it does
  // NOT do — no DNS, no Odoo, no front, no repo scaffold.
  const created: CreateProjectResult = await createProjectAction({
    name: input.name,
    slug: input.slug,
    kind: input.kind,
    client: input.client,
    domain: input.domain ?? null,
    repo: input.repo,
    productionKind: input.productionKind ?? null,
    // NOT derived for the fleet, unlike `/new` (spec 0225 E). There the derived
    // `<slug>.odoo.example.com` is safe because provisioning creates exactly that
    // name and writes its DNS, so the row and the DNS cannot disagree. Connecting
    // creates nothing, so the same line invented a host that will never resolve:
    // taqueria-sol, which lives at `taqueria-sol.odoo.example.com`, was recorded as
    // `taqueria-sol-conectada.odoo.example.com`. `production_kind` says production
    // is on our fleet; per migration 0005 the fleet address is the `vps_id`, and
    // Stage 1 never looks at the box — so null, not a guess.
    productionHost: input.productionHost ?? null,
    odooVersion: input.odooVersion ?? null,
  }, "none");
  if (!created.ok) {
    return { ok: false, problem: created.problem ?? "No pude crear el proyecto." };
  }
  return { ok: true, slug: input.slug, warnings: findings.filter((f) => !f.blocking) };
}
