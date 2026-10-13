/**
 * How a run's staging environment reads in the workspace (spec 0119).
 *
 * PURE, for the same reason `gate3-evidence.ts` is: a function of state the
 * caller already loaded, so every branch — including the awkward ones — is
 * unit-testable with no Temporal client and no SSH.
 *
 * The rule it exists to enforce is spec 0084's: **never present what we cannot
 * observe**. Two absences must not be dressed up as an environment:
 *
 *  - a run with no staging (dogfood target, or gate 2 not reached) shows NOTHING,
 *    not an empty panel implying one is coming;
 *  - a host that cannot resolve is shown as TEXT, never as a link. While the
 *    tenant domain is `.test` that is every host, and a link that silently fails
 *    to resolve is worse than a name plus the reason.
 *
 * A failed create is different from both, and says so with its reason: "missing
 * with no explanation" reads as "not built yet" when it may mean "the box
 * refused".
 */
import { stagingHostIsResolvable, type StagingState } from "@launchpad/pipeline";

export interface StagingView {
  tone: "ok" | "info" | "warn";
  /** One line: what exists, in the reviewer's terms. */
  headline: string;
  /** The Traefik host, when there is one. Always safe to render as text. */
  host?: string;
  /** Set ONLY when the host can actually resolve — otherwise there is no link. */
  href?: string;
  /**
   * Spec 0226 E. Two facts about what this environment IS, always shown
   * together, because they are one message: a copy for testing, not a place to
   * keep anything.
   *
   * `neutralized` is present only when the marker was PROVEN
   * (`database.is_neutralized`, read back from the branch DB) — absent means
   * "clean Odoo", never "probably neutralized".
   *
   * `disposable` is unconditional. odoo.sh states plainly that staging builds
   * are not backed up; we said nothing, which reads as durability — and that
   * gets worse the moment the environment holds a copy of production, because it
   * will look like the most backed-up thing we own.
   */
  neutralized?: boolean;
  disposable: true;
  /** Why there is no link, what got installed, or why the create failed. */
  detail?: string;
}

/**
 * `null` means render nothing at all. That is the honest answer both for a run
 * that never had staging and for one started before the query handler existed —
 * in neither case is there an environment to talk about.
 */
export function deriveStagingView(state: StagingState | undefined): StagingView | null {
  if (!state || state.status === "none") return null;

  if (state.status === "failed") {
    return {
      tone: "warn",
      disposable: true,
      headline: "Sin entorno de prueba para este cambio",
      detail: `El entorno no se pudo crear: ${state.error}. El cambio sigue siendo revisable en el PR.`,
    };
  }

  const { host, addons, odooHttpOk } = state.ref;
  const resolvable = stagingHostIsResolvable(host);
  const installed = addons.length > 0 ? `Módulos instalados: ${addons.join(", ")}.` : "Sin módulos propios: sólo `base`.";
  // `odooHttpOk` means Odoo answered ON THE VPS. Saying more than that would be
  // the exact overclaim the spec's handoff warns about.
  const answered = odooHttpOk
    ? "Odoo respondió en el VPS."
    : "Odoo aún no respondía cuando terminó el despliegue.";

  return {
    tone: odooHttpOk ? "ok" : "info",
    disposable: true,
    ...(state.ref.neutralized ? { neutralized: true as const } : {}),
    headline: "Entorno de prueba listo para este cambio",
    host,
    ...(resolvable ? { href: `https://${host}` } : {}),
    detail: resolvable
      ? `${installed} ${answered}`
      : `${installed} ${answered} Este nombre todavía no resuelve públicamente (falta el registro DNS comodín), así que por ahora sólo se alcanza desde el VPS.`,
  };
}
