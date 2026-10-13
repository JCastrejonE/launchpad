/**
 * Slug suggestion — deliberately in its own module with ZERO imports.
 *
 * `/new` is a client component and needs this to prefill its identifier field.
 * When it lived in `project-create.ts`, importing it dragged `@launchpad/db` —
 * and therefore `pg` — into the browser bundle, and `next build` failed on
 * `Can't resolve 'dns'`. A module boundary is the fix, not a bundler alias: the
 * client genuinely has no business importing the database layer.
 */

/**
 * Derive a slug from a project name. A SUGGESTION for prefilling a form, never
 * an automatic correction: `createProject` refuses an invalid slug rather than
 * rewriting it, because being handed a project addressed by a name you did not
 * choose is worse than being asked to fix one character.
 */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "Ferretería" → "Ferreteria"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
