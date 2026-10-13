/**
 * Validation and shaping for project creation (spec 0126 C), kept PURE and out
 * of the server action so every rule is unit-testable and the action stays a
 * thin composition of gate → validate → verify → insert → audit.
 *
 * Same split as `lib/capabilities.ts` and `lib/route-access.ts`: the policy lives
 * in one file with tests; the framework layer only supplies the request.
 */
import { isValidProjectSlug, type ProductionKind, type ProjectKind } from "@launchpad/db";
// VALUE import from the DEDICATED subpath, not the package index: the index
// re-exports `activities.js` (Temporal, ssh2, pg), which cannot be bundled into
// a client component. `procesos-modules.js` compiles to zero runtime imports —
// its only import is `import type`. Same move as lib/run-follow-card.ts's
// `@launchpad/pipeline/watcher-playbook`.
import { SUPPORTED_ODOO_VERSIONS, DEFAULT_ODOO_VERSION } from "@launchpad/pipeline/procesos-modules";
import type { OdooVersion } from "@launchpad/pipeline";
// Client-safe and import-free, because `/new` is a client component and this
// module reaches the database layer (see lib/slug.ts).
import { suggestSlug } from "./slug";

export { suggestSlug };

/** What the wizard collects. Everything arrives as a string from a form. */
export interface ProjectCreateInput {
  name: string;
  slug: string;
  kind: string;
  client: string;
  domain?: string | null;
  /** `owner/name`, as a person types it. Optional — a project may have no repo. */
  repo?: string | null;
  productionKind?: string | null;
  productionHost?: string | null;
  /** Spec 0191: the five business answers, keyed by the wizard's question ids.
   * Free text the customer wrote — carried through verbatim and never parsed. */
  intake?: Record<string, string> | null;
  /** Spec 0205: the Odoo series the customer picked, as a string from the form
   * ("18" / "19"). Only meaningful for the Odoo kinds. */
  odooVersion?: string | null;
}

export interface ValidatedProject {
  name: string;
  slug: string;
  kind: ProjectKind;
  client: string;
  domain: string | null;
  repoOwner: string | null;
  repoName: string | null;
  productionKind: ProductionKind;
  productionHost: string | null;
  intake: Record<string, string>;
  /** Spec 0205. The Odoo series to provision, for the kinds that run one; null
   * for `custom`/`platform`, which have no Odoo. Never blank for an Odoo
   * project: a blank `projects.version` is the ambiguity this spec removes —
   * provisioning read it as "18" and it equally meant "nobody was asked". */
  odooVersion: OdooVersion | null;
}

/** `{ ok: true, value }` or `{ ok: false, field, problem }` — the field is named
 * so the wizard can point at the input that is wrong instead of showing a
 * generic failure. */
export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; field: keyof ProjectCreateInput; problem: string };

const KINDS: readonly ProjectKind[] = ["odoo", "odoo_next", "custom", "platform"];
const PRODUCTION_KINDS: readonly ProductionKind[] = ["odoosh", "fleet", "none"];

/** GitHub's own rule for an owner or repository segment. Checked here so a
 * malformed value never reaches a URL path we build. */
const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Split `owner/name`. Rejects anything with the wrong number of segments, so a
 * pasted full URL fails loudly rather than being silently mangled into an owner
 * called `https:`.
 */
export function parseRepoRef(
  raw: string,
): { ok: true; owner: string; name: string } | { ok: false; problem: string } {
  // Accept a pasted URL as a convenience — it is the most likely thing someone
  // pastes — but normalise it explicitly rather than hoping the split works.
  // All three clone-URL shapes GitHub itself offers (spec 0137): https,
  // scp-style ssh (`git@github.com:o/r`), and URL-style ssh
  // (`ssh://git@github.com/o/r`). Only `owner/name` is ever persisted.
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/");
  if (parts.length !== 2) {
    return { ok: false, problem: 'Usa el formato "owner/repo" (por ejemplo example-org/launchpad).' };
  }
  const [owner, name] = parts as [string, string];
  if (!GH_SEGMENT.test(owner) || !GH_SEGMENT.test(name)) {
    return { ok: false, problem: 'El nombre del repositorio contiene caracteres que GitHub no permite.' };
  }
  return { ok: true, owner, name };
}

// Branding-logo constraints (spec 0148 E2a) live in their own zero-import module
// so the client wizard can import them without dragging `@launchpad/db` into the
// browser bundle (the `suggestSlug`/`./slug` split, spec 0161 E2b). Re-exported
// here so the server side keeps one import path.
export { LOGO_MAX_BYTES, validateLogoUpload, validateLogoCommit } from "./logo-upload";
export type { LogoUpload, LogoValidation } from "./logo-upload";

/** Validate and normalise the wizard's input. Pure. */
export function validateProjectInput(input: ProjectCreateInput): Validation<ValidatedProject> {
  const name = input.name?.trim() ?? "";
  if (name.length < 2) return { ok: false, field: "name", problem: "El nombre necesita al menos 2 caracteres." };
  if (name.length > 120) return { ok: false, field: "name", problem: "El nombre es demasiado largo (máx. 120)." };

  // Trimmed but NOT lowercased. Casing is part of the identifier someone typed,
  // and this file's rule is validate-never-sanitise (the same reason
  // `createProject` refuses rather than rewrites): quietly turning `Client-C`
  // into `client-c` hands them a project addressed by a name they did not
  // choose. `suggestSlug` already offers a lowercase default to edit.
  const slug = input.slug?.trim() ?? "";
  if (!isValidProjectSlug(slug)) {
    return {
      ok: false,
      field: "slug",
      problem: "El identificador debe ser minúsculas, números y guiones internos (2–40 caracteres).",
    };
  }

  const kind = input.kind?.trim() as ProjectKind;
  if (!KINDS.includes(kind)) return { ok: false, field: "kind", problem: "Tipo de proyecto no reconocido." };

  // Spec 0205. Asked only for the kinds that actually run an Odoo; a `custom`
  // project storing "19" would be a fact about nothing.
  const runsOdoo = kind === "odoo" || kind === "odoo_next";
  let odooVersion: OdooVersion | null = null;
  if (runsOdoo) {
    const raw = input.odooVersion?.trim() ?? "";
    // Absent means the caller predates the picker (the wizard always sends one),
    // so it takes the default — and that default is WRITTEN to the row rather
    // than re-derived at provision time, which is where "" quietly became 18.
    const parsed = raw ? Number(raw.split(".")[0]) : DEFAULT_ODOO_VERSION;
    if (!SUPPORTED_ODOO_VERSIONS.includes(parsed as OdooVersion)) {
      return {
        ok: false,
        field: "odooVersion",
        problem: `Versión de Odoo no soportada (${SUPPORTED_ODOO_VERSIONS.join(" o ")}).`,
      };
    }
    odooVersion = parsed as OdooVersion;
  }

  const client = input.client?.trim() || name;

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  if (input.repo?.trim()) {
    const parsed = parseRepoRef(input.repo);
    if (!parsed.ok) return { ok: false, field: "repo", problem: parsed.problem };
    repoOwner = parsed.owner;
    repoName = parsed.name;
  }

  const productionKindRaw = (input.productionKind?.trim() || "none") as ProductionKind;
  if (!PRODUCTION_KINDS.includes(productionKindRaw)) {
    return { ok: false, field: "productionKind", problem: "Destino de producción no reconocido." };
  }

  const productionHost = input.productionHost?.trim() || null;
  // An odoo.sh target with no host is allowed (the commit status is what confirms
  // a deploy, not SSH), but a host on a target that cannot use one is a mistake
  // worth naming rather than storing.
  if (productionHost && productionKindRaw !== "odoosh") {
    return {
      ok: false,
      field: "productionHost",
      problem: "Solo un destino odoo.sh usa un host SSH; para la flota el destino es el VPS.",
    };
  }

  return {
    ok: true,
    value: {
      name,
      slug,
      kind,
      client,
      domain: input.domain?.trim() || null,
      repoOwner,
      repoName,
      productionKind: productionKindRaw,
      productionHost,
      // Spec 0191: trimmed, empty answers dropped, otherwise untouched. Not
      // validated against a vocabulary — these are the customer's own words, and
      // a validator here would be a filter on what they are allowed to say.
      intake: Object.fromEntries(
        Object.entries(input.intake ?? {})
          .map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""])
          .filter(([, v]) => v !== ""),
      ) as Record<string, string>,
      odooVersion,
    },
  };
}
