/**
 * Which Odoo modules a customer's `/new` answers ask for (spec 0205).
 *
 * Until now the five intake answers were recorded and nothing read them — a
 * customer ticked "Punto de venta (POS)" and the only effect was a string on
 * their landing page (decision 5, reversed by the owner 2026-08-15). This is the map
 * from what they picked to what gets installed.
 *
 * Pure: no I/O, no Odoo, no network. The caller does the installing.
 *
 * WHAT IS VERIFIED, AND HOW. Every module below was checked against the real
 * images by listing `/usr/lib/python3/dist-packages/odoo/addons` inside
 * `odoo:18` and `odoo:19` — 686 and 685 modules respectively. Availability is
 * IDENTICAL across the two for everything here, which is why one table serves
 * both. Nothing in this file is from memory; `docs/ODOO-ADDONS.md` records the
 * same evidence. A version we have not listed gets no table rather than a
 * guessed one.
 */
import type { OdooVersion } from "./spec.js";
// Spec 0206. Pure and import-free, like this module — `apps/web` reaches both
// through the `@launchpad/pipeline/procesos-modules` subpath, so neither may
// grow a runtime dependency.
import { cfdiVendoredFor, CFDI_MODULE } from "./vendored-addons.js";

/** Versions a project may be provisioned on. 17 renders (the compose template is
 *  parameterised) but has never been checked, and an option nobody verified is a
 *  promise — see this spec's own first draft for what that costs. */
export const SUPPORTED_ODOO_VERSIONS: readonly OdooVersion[] = [18, 19];

/** Default for a new project: 19, because every addon in `docs/ODOO-ADDONS.md`
 *  — `cdfi_invoice`, `web_responsive`, `app_menu_enterprise` — targets 19.0.x.
 *  Provisioning 18 by default would mean nothing the company owns could be installed. */
export const DEFAULT_ODOO_VERSION: OdooVersion = 19;

/**
 * The exact options the wizard offers, copied from `apps/web/lib/mock-data.ts`
 * (question `procesos`). A copy, because this package cannot import `apps/web` —
 * so `procesos-modules.test.ts` reads that file from disk and fails if the two
 * drift. A stale copy here would silently map nothing.
 */
export const PROCESO_OPTIONS_SEEN_IN_WIZARD: readonly string[] = [
  "Ventas / CRM",
  "Inventario / Almacén",
  "Punto de venta (POS)",
  "Facturación electrónica (CFDI)",
  "Compras",
  "Contabilidad",
  "RRHH / Nómina",
  "Proyectos",
];

/**
 * The wizard's `choice` questions are MULTI-select and store their answers
 * pipe-joined in one `intake` string (`apps/web/app/new/NewProject.tsx`'s `Question`:
 * `value.split("|")`). Split here rather than at each caller, and guarded by
 * `procesos-modules.test.ts` reading that file — if the separator ever changes,
 * every proceso becomes one unrecognised answer and the whole plan refuses.
 */
export function procesosFromIntake(intake: Record<string, string> | null | undefined): string[] {
  return (intake?.procesos ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A refusal carries its reason. Callers must record these — a proceso that was
 *  asked for and silently not installed is the wizard lying, which is the thing
 *  this spec exists to stop. */
export interface RefusedProceso {
  proceso: string;
  why: string;
}

export interface ModulePlan {
  /** Technical module names, deduplicated, in the table's order. */
  install: string[];
  refused: RefusedProceso[];
}

/** The one proceso whose answer depends on something outside this file: CFDI is
 *  deliverable only where the vendoring registry has a `cdfi_invoice` row for
 *  that series (spec 0206). */
const CFDI = "Facturación electrónica (CFDI)";

/**
 * The table. Keys are the EXACT strings the wizard offers
 * (`apps/web/lib/mock-data.ts`, question `procesos`) — a near-miss here is a
 * silent no-op, so they are copied verbatim rather than normalised.
 */
const PROCESO_MODULES: Record<string, readonly string[]> = {
  "Ventas / CRM": ["sale_management", "crm"],
  "Inventario / Almacén": ["stock"],
  "Punto de venta (POS)": ["point_of_sale"],
  Compras: ["purchase"],
  Contabilidad: ["account", "l10n_mx"],
  Proyectos: ["project"],
  // Spec 0206: vendored, not in the image. Only reached on a series the registry
  // has a row for — `refusalFor` turns this back into a refusal otherwise.
  [CFDI]: [CFDI_MODULE],
  // `hr` is real; `hr_payroll` is absent from BOTH 18 and 19 — Enterprise, not a
  // version gap. So this installs the HR core and says what it could not do.
  "RRHH / Nómina": ["hr"],
};

/** Procesos we cannot honour on a given version, and why — stated once so every
 *  caller says the same thing to the customer. */
function refusalFor(proceso: string, version: OdooVersion): string | undefined {
  if (proceso !== CFDI) return undefined;
  if (cfdiVendoredFor(version)) return undefined;
  return (
    "CFDI necesita el addon de terceros `cdfi_invoice` (ver docs/ODOO-ADDONS.md), " +
    `y no hay una versión verificada de ese addon para Odoo ${version}; ` +
    "Odoo Community no trae `l10n_mx_edi` en 18 ni en 19."
  );
}

/** Procesos that install something but not everything they imply. */
const PROCESO_CAVEATS: Record<string, string> = {
  "RRHH / Nómina":
    "Se instala `hr` (empleados); la NÓMINA no — `hr_payroll` no existe en Odoo Community 18 ni 19.",
  // Spec 0206: installing the addon is not the same as being able to stamp. The
  // module arrives; the PAC key and the company's CSD do not, and without them
  // the first attempt to issue a CFDI fails at the customer, not here.
  [CFDI]:
    "Se instala `cdfi_invoice`; TIMBRAR todavía no — falta configurar la cuenta del PAC " +
    "(api_key de IT Admin) y el CSD de la empresa (.cer, .key y contraseña) en la ficha de la compañía.",
};

/**
 * Modules for these answers on this version.
 *
 * An unsupported version refuses everything BY NAME rather than falling back to
 * another version's list: installing 18's modules into a 17 tenant because a
 * lookup missed would be the silent-wrong-default this spec is built to avoid.
 */
export function modulesFor(procesos: readonly string[], version: OdooVersion): ModulePlan {
  if (!SUPPORTED_ODOO_VERSIONS.includes(version)) {
    return {
      install: [],
      refused: procesos.map((proceso) => ({
        proceso,
        why: `No hay mapa de módulos verificado para Odoo ${version} (soportados: ${SUPPORTED_ODOO_VERSIONS.join(", ")}).`,
      })),
    };
  }

  const install: string[] = [];
  const refused: RefusedProceso[] = [];

  for (const proceso of procesos) {
    const refusal = refusalFor(proceso, version);
    if (refusal) {
      refused.push({ proceso, why: refusal });
      continue;
    }
    const mods = PROCESO_MODULES[proceso];
    if (!mods) {
      // An answer we do not recognise. Louder than ignoring it: the wizard's
      // options and this table can drift, and drift that says nothing is the
      // failure mode.
      refused.push({ proceso, why: `Proceso desconocido — no hay módulo mapeado para "${proceso}".` });
      continue;
    }
    for (const m of mods) if (!install.includes(m)) install.push(m);
    const caveat = PROCESO_CAVEATS[proceso];
    if (caveat) refused.push({ proceso, why: caveat });
  }

  return { install, refused };
}
