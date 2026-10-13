/**
 * Should this platform version be deployed? (spec 0213 D.)
 *
 * `decideReleaseDeploy` cannot answer for the platform: it asks what KIND of
 * production a project has — a customer's odoo.sh, or our fleet — and refuses
 * when there is none. The platform has neither. Its production is the box the
 * app is running on, which is not a configuration but a fact.
 *
 * Pure and separate from `platform-deploy.ts` so it is testable: that module is
 * `server-only` and importing it under `node --test` fails.
 */
import { isNewer } from "@launchpad/pipeline";
import { phaseLabel } from "./run-follow-card";

export interface PlatformDeployDecision {
  blocked: boolean;
  tone: "ok" | "warn" | "danger";
  message: string;
}

/** A platform run that a deploy would interrupt (spec 0219 D). */
export interface InterruptedRun {
  specId: string;
  phase: string;
  /** The spec's `requested_by`. Empty when the frontmatter does not say. */
  who: string;
}

/**
 * Phases where a restart throws away real work (spec 0219 D).
 *
 * A run parked at a gate loses nothing — the workflow is waiting on a signal
 * and Temporal replays it. A run mid-session loses the session: it is a spawned
 * process, not a workflow, so the turns since its last commit are gone. Those
 * are the only ones worth naming, and naming ONLY those is what keeps the
 * warning credible.
 */
const INTERRUPTIBLE_PHASES = new Set(["initializing", "coding", "merging"]);

export function interruptibleRuns(
  runs: readonly InterruptedRun[],
): InterruptedRun[] {
  return runs.filter((r) => INTERRUPTIBLE_PHASES.has(r.phase));
}

/** "spec-0218 de teammate@example.com (escribiendo código)" — one run, named. */
function describeRun(r: InterruptedRun): string {
  const who = r.who ? ` de ${r.who}` : "";
  return `${r.specId}${who} (${phaseLabel(r.phase, "launchpad").toLowerCase()})`;
}

/**
 * Spec 0219 D + decision 2: WARN, never block.
 *
 * Blocking here would hand either person a veto over the other's deploys by
 * simply keeping a run open — a worse failure than a lost coder increment,
 * which costs 15–20 minutes and replays. So this only ever raises `ok` to
 * `warn` and appends the names; it never changes `blocked`.
 */
function withInterruptions(
  decision: PlatformDeployDecision,
  interrupts: readonly InterruptedRun[],
): PlatformDeployDecision {
  const at_risk = interruptibleRuns(interrupts);
  if (decision.blocked || at_risk.length === 0) return decision;
  return {
    blocked: false,
    tone: decision.tone === "ok" ? "warn" : decision.tone,
    message:
      `${decision.message} Además, esto reinicia el worker: ` +
      `${at_risk.map(describeRun).join(", ")} ` +
      `${at_risk.length === 1 ? "pierde su sesión" : "pierden su sesión"} y ` +
      `${at_risk.length === 1 ? "reintenta" : "reintentan"} desde su último commit.`,
  };
}

export function decidePlatformDeploy(input: {
  version: string;
  /** Is the release's commit still an ancestor of origin/main? `undefined` when
   * git could not answer, which is NOT the same as "no". */
  onMain: boolean | undefined;
  /** The version currently recorded as live, if any. */
  liveVersion: string | null;
  /** This instance is the staging twin, where the button must never fire. */
  isStaging: boolean;
  /** Platform runs in flight, for spec 0219 D. Absent = none known. */
  interrupts?: readonly InterruptedRun[];
}): PlatformDeployDecision {
  return withInterruptions(baseDecision(input), input.interrupts ?? []);
}

function baseDecision(input: {
  version: string;
  onMain: boolean | undefined;
  liveVersion: string | null;
  isStaging: boolean;
}): PlatformDeployDecision {
  if (input.isStaging) {
    return {
      blocked: true,
      tone: "danger",
      message:
        "Estás en el staging del control plane. Producción se despliega desde " +
        "launchpad.example.com — el botón de aquí reiniciaría los servicios de producción.",
    };
  }
  if (input.onMain === false) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `El commit de ${input.version} ya no está en main. Se reescribió la historia o la ` +
        `versión se cortó de otra rama; corta una nueva.`,
    };
  }
  // Spec 0219 C. Two people cut versions the same afternoon: a teammate cuts and
  // deploys 1.0.8 while the owner's tab still shows 1.0.7 as "next", and the owner's press
  // silently puts the teammate's work back in the box. The tenant path has refused this
  // one-click since 0170; the platform's own decision never learned it.
  //
  // `danger` and NOT blocked: the control's danger tone already demands a second
  // explicit confirmation, and unlike a tenant there is a legitimate reason to
  // do this — the newer version is broken and you want the previous one back.
  // The platform has no data migrations, so it really is reversible here.
  if (input.liveVersion && isNewer(input.liveVersion, input.version)) {
    return {
      blocked: false,
      tone: "danger",
      message:
        `En producción está la ${input.liveVersion}, más nueva que la ${input.version}. ` +
        `Alguien más desplegó mientras tenías esta página abierta. Continuar deja el código ` +
        `de ${input.version} corriendo y descarta lo que trajo la ${input.liveVersion}; ` +
        `recarga si esperabas ver la más nueva.`,
    };
  }

  if (input.liveVersion === input.version) {
    return {
      blocked: false,
      tone: "warn",
      message: `${input.version} ya está desplegada. Volver a desplegarla reconstruye y reinicia.`,
    };
  }
  if (input.onMain === undefined) {
    // Git could not answer. That is not evidence of a problem, and refusing on
    // an unanswered question would block every deploy whenever the checkout is
    // briefly unreadable — so it warns and lets a human decide.
    return {
      blocked: false,
      tone: "warn",
      message:
        `No pude confirmar que el commit de ${input.version} siga en main. ` +
        `Despliegas bajo tu criterio.`,
    };
  }
  return {
    blocked: false,
    tone: "ok",
    message:
      `${input.version} está en main. Desplegar reconstruye el checkout de producción y ` +
      `reinicia web y worker; la app se cae unos segundos.`,
  };
}
