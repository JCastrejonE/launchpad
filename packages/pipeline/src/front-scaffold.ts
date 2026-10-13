/**
 * The odoo-next front scaffold (spec 0169) — the files a freshly provisioned
 * project's repo needs so the front phase has something to build.
 *
 * Before this, `provisionFront` packed the checkout of a repo the pipeline had
 * just created EMPTY (measured on spec 0161's probe: 0 files, 0 commits), and
 * the deploy died on `open Dockerfile: no such file or directory`.
 *
 * Files are read from `infra/front/` and committed VERBATIM. There is no
 * templating on purpose: spec 0161 lost a run to a placeholder that was
 * substituted inside a comment, and a scaffold with no placeholders cannot
 * repeat it. Anything tenant-specific (`ODOO_URL`, `PROJECT_SLUG`) reaches the
 * app as an environment variable from `front-stack.tmpl.yml` instead.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** dist/front-scaffold.js -> repo-root/infra/front */
export const FRONT_SCAFFOLD_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "infra",
  "front",
);

export interface ScaffoldFile {
  /** Path inside the project's repo, POSIX separators. */
  path: string;
  contentBase64: string;
}

/**
 * `README.md` documents the scaffold to US, in this repo. Copying it into the
 * customer's repo would explain the launchpad's internals to them instead of
 * their own project — so it stays behind.
 */
const NOT_COPIED = new Set(["README.md"]);

/**
 * Every file of the scaffold, ready to commit, deepest paths last so a reader of
 * the resulting history sees the project take shape in a sensible order.
 *
 * Reads the directory rather than listing names in code: a file added to
 * `infra/front/` and forgotten here would be a scaffold that silently ships
 * incomplete, and "the Dockerfile is missing" is precisely the failure this
 * module exists to prevent.
 */
/**
 * What the scaffold's `app/site.ts` is filled in with (spec 0191) — the
 * business's own facts, from the wizard's five answers.
 */
export interface SiteData {
  nombre: string;
  giro: string;
  procesos: string[];
  marca: string;
}

/**
 * The separator the wizard writes a multiple-choice answer with
 * (`apps/web/app/new/NewProject.tsx`, the choice field's `onChange`: `[...cur, o].join("|")`).
 *
 * Spec 0192 D: spec 0191 read the answer back with `.split(",")`, so
 * `gaming-tech`'s four chosen processes —
 * `"Ventas / CRM|Inventario / Almacén|Punto de venta (POS)|Facturación electrónica (CFDI)"`,
 * copied here from the stored row — rendered as ONE card holding the whole
 * string. The 0191 test passed because it fed an already-split array: it proved
 * the substitution and never the source (VERIFICATION #1).
 */
export const INTAKE_CHOICE_SEPARATOR = "|";

/**
 * The business's facts as the scaffold needs them, from the project's name and
 * the intake exactly as `/new` stored it.
 *
 * Pure, and separate from the DB read on purpose: this is the half that can be
 * wrong, so it is the half a test can hold a real stored value against.
 */
export function siteFromIntake(
  nombre: string,
  intake: Record<string, string> | null | undefined,
): SiteData {
  const answers = intake ?? {};
  return {
    nombre,
    giro: answers["giro"] ?? "",
    procesos: (answers["procesos"] ?? "")
      .split(INTAKE_CHOICE_SEPARATOR)
      .map((p) => p.trim())
      .filter(Boolean),
    marca: answers["marca"] ?? "",
  };
}

/**
 * Fill the scaffold's placeholders with THIS project's facts.
 *
 * Pure: files in, files out, no filesystem and no network — so a test can assert
 * what gets committed rather than what a call was asked to do. Every value goes
 * through `JSON.stringify`, which is not decoration: `marca` and `giro` are free
 * text a customer typed, and a stray quote or backslash pasted straight into a
 * TypeScript literal is a repo whose first commit does not compile.
 *
 * Files without a placeholder come back untouched, byte for byte.
 */
export function renderFrontScaffold(files: ScaffoldFile[], site: SiteData): ScaffoldFile[] {
  const substitutions: Record<string, string> = {
    '"__SITE_NOMBRE__"': JSON.stringify(site.nombre),
    '"__SITE_GIRO__"': JSON.stringify(site.giro),
    '"__SITE_MARCA__"': JSON.stringify(site.marca),
    __SITE_PROCESOS__: JSON.stringify(site.procesos),
  };
  return files.map((file) => {
    const text = Buffer.from(file.contentBase64, "base64").toString("utf8");
    let rendered = text;
    for (const [placeholder, value] of Object.entries(substitutions)) {
      rendered = rendered.split(placeholder).join(value);
    }
    if (rendered === text) return file;
    return { path: file.path, contentBase64: Buffer.from(rendered, "utf8").toString("base64") };
  });
}

export async function loadFrontScaffold(dir: string = FRONT_SCAFFOLD_DIR): Promise<ScaffoldFile[]> {
  const files: ScaffoldFile[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!rel && NOT_COPIED.has(entry.name)) continue;
      files.push({
        path: childRel,
        contentBase64: (await readFile(childAbs)).toString("base64"),
      });
    }
  }
  await walk(dir, "");
  if (!files.some((f) => f.path === "Dockerfile")) {
    // The one file the front phase cannot start without. Failing here names the
    // problem; failing later says `open Dockerfile: no such file or directory`
    // from inside a docker build on another machine.
    throw new Error(
      `front scaffold at ${dir} has no Dockerfile — the front phase would fail with ` +
        `"open Dockerfile: no such file or directory"`,
    );
  }
  return files;
}
