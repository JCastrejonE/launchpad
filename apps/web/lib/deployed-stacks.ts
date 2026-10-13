/**
 * Deployed stacks, as the workspace's Ramas & builds tab renders them (spec 0121).
 *
 * PURE, like `staging-view.ts` and `gate3-evidence.ts`: a function of what the
 * fleet read already returned, so every branch is testable without SSH.
 *
 * The owner: *"I want to be able to access all currently deployed tenants from our UI."*
 * So the job here is to turn a stack into something clickable — and to refuse to
 * when it honestly cannot be (spec 0084's rule). Two ways that happens:
 *
 *  - the stack's `identity` is absent, meaning its config path did not match the
 *    deploy layout, so no hostname can be derived. A row with no link is correct;
 *    a guessed hostname could point at another tenant's environment.
 *  - the domain in use cannot resolve (`.test`), in which case the host is shown
 *    as text with the reason, never as a dead link.
 */
import type { TenantStack } from "@launchpad/fleet-hostinger";
// `stagingHostIsResolvable` lives with the staging query type (spec 0119) — one
// rule about unresolvable domains, shared rather than re-derived here.
import { stagingHostIsResolvable } from "@launchpad/pipeline";

export interface DeployedStackView {
  /** `<tenant>/<stack>`, or the compose project name when identity is unknown. */
  label: string;
  kind: "tenant" | "staging" | "unknown";
  /** Running / stopped, straight from the fleet read. */
  status: string;
  /** Odoo application databases in the stack, as reported. Empty for a stopped
   * stack (its db container is not up to ask). */
  dbs: string[];
  /** The Traefik host, when one can be derived. Always safe as text. */
  host?: string;
  /** Set ONLY when that host can actually resolve. */
  href?: string;
  /** Why there is no link, when there is a host but no href. */
  note?: string;
}

/**
 * Takes the host the fleet READ off each stack's deployed Traefik rule. An earlier
 * draft of this derived the host from the current env instead, which was wrong in a
 * way worth recording: the domain is env-driven, so a stack deployed before the env
 * changed still routes on its OLD hostname, and the UI would have advertised a URL
 * that 404s. Read the truth; do not recompute it.
 */
/**
 * Spec 0181: the stacks belonging to ONE project.
 *
 * `sushi`'s page listed every `ab-test-sandbox` environment on the box, with
 * clickable URLs — the panel read the machine and never asked whose page it was
 * on. Spec 0168 made project membership the boundary; a panel that routes around
 * the model by reading infrastructure is a hole in it.
 *
 * A stack whose `identity` we cannot parse belongs to nobody we can name, so it
 * is excluded from a project's page: showing it here would attribute another
 * tenant's environment to this customer. The fleet-wide view is where an
 * unattributable stack belongs, and that is a different surface.
 */
export function stacksForProject(
  stacks: readonly TenantStack[],
  slug: string,
): readonly TenantStack[] {
  return stacks.filter((s) => s.identity?.tenantId === slug);
}

export function deriveDeployedStacks(stacks: readonly TenantStack[]): DeployedStackView[] {
  return stacks.map((s) => {
    if (!s.identity) {
      return {
        label: s.tenant,
        kind: "unknown" as const,
        status: s.status,
        dbs: s.dbs,
        note: "No se puede derivar la URL: la ruta del stack no coincide con el layout de despliegue.",
      };
    }
    const { tenantId, stack, kind } = s.identity;
    const host = s.routerHost;
    if (!host) {
      return {
        label: `${tenantId}/${stack}`,
        kind,
        status: s.status,
        dbs: s.dbs,
        note: "No se pudo leer la regla de Traefik de este stack, así que no hay URL que mostrar.",
      };
    }
    const resolvable = stagingHostIsResolvable(host);
    return {
      label: `${tenantId}/${stack}`,
      kind,
      status: s.status,
      dbs: s.dbs,
      host,
      ...(resolvable ? { href: `https://${host}` } : {}),
      ...(resolvable
        ? {}
        : { note: "Este dominio no resuelve públicamente; sólo se alcanza desde el VPS." }),
    };
  });
}
