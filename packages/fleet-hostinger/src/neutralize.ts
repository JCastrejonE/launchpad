/**
 * Neutralizing a restored copy of production (spec 0226).
 *
 * A restored production database carries production's cron jobs, mail servers,
 * payment credentials and webhooks. Un-neutralized, it will email real customers
 * and charge real cards the moment a scheduled action fires. This module exists
 * to make that impossible, and to PROVE it did.
 *
 * Three deliberate choices, each one paid for by a wrong earlier draft:
 *
 * 1. **Odoo's own neutralization, never ours.** `odoo neutralize` has shipped
 *    since v16 and is what odoo.sh runs. Reading Odoo's own
 *    `base/data/neutralize.sql` showed four things a hand-written script would
 *    have missed: it inserts a DUMMY mail server at `invalid:1025` after
 *    deactivating the real ones (to block the command-line SMTP fallback), it
 *    spares `autovacuum_job` when disabling crons, it neutralizes
 *    `ir_act_server` webhooks, and every installed module contributes its own
 *    `data/neutralize.sql` — payment, delivery, IAP, bank sync — maintained per
 *    version by Odoo rather than rotting in a script of ours.
 *
 * 2. **A ONE-OFF container, not the serving one.** Same reasoning as
 *    `initTenantDb` (spec 0093): `run --rm` overrides the service's pinned
 *    `command:`, so this never races the long-running server. It also means the
 *    un-neutralized database never has an HTTP server in front of it —
 *    `neutralize` is a CLI command that exits, so nothing listens on 8069 in it,
 *    even though the one-off carries the service's Traefik labels.
 *
 * 3. **Assert the MARKER, not the exit code.** `docker compose run` returning 0
 *    is an exit status that travelled through two layers of container plumbing
 *    (`docs/VERIFICATION.md` #8). `database.is_neutralized` read back from the
 *    database is the end state, and it is the same row that drives Odoo's own
 *    red banner.
 */
import { FleetError } from "./errors.js";
import type { SshRunner } from "./ssh.js";

/** The `ir_config_parameter` key Odoo's own `base/data/neutralize.sql` sets. */
export const NEUTRALIZED_KEY = "database.is_neutralized";

/** Odoo writes `true`; psql prints it as `t` with `-t`. Both accepted. */
export function readsAsNeutralized(psqlOutput: string): boolean {
  const v = psqlOutput.trim().toLowerCase();
  return v === "t" || v === "true";
}

export interface NeutralizeOptions {
  ssh: SshRunner;
  /** Compose project name — ALWAYS passed explicitly (CLAUDE.md #14's corollary:
   * compose takes the project name from the DIRECTORY otherwise). */
  project: string;
  composePath: string;
  dbName: string;
  /** The `db` service name in the stack, for the read-back. */
  dbService?: string;
}

/**
 * Runs Odoo's neutralization against `dbName`, then PROVES it took.
 *
 * The caller must have brought up only the `db` service. Bringing up `odoo`
 * before this returns is the one thing that makes the whole spec pointless.
 */
export async function neutralizeRestoredDb(opts: NeutralizeOptions): Promise<void> {
  const compose = `docker compose -p ${opts.project} -f ${opts.composePath}`;

  const run = await opts.ssh.exec(`${compose} run --rm --no-deps odoo neutralize -d ${opts.dbName}`);
  if (run.code !== 0) {
    throw new FleetError(
      "deploy",
      `odoo neutralize failed for ${opts.dbName} (exit ${run.code}): ${run.stderr.trim().slice(0, 500)}`,
      // Retryable: neutralization is idempotent (Odoo's script upserts the flag
      // and the UPDATEs are already-false-safe), so a transient failure may be
      // retried. A copy that is still un-neutralized after the retries is what
      // the caller must destroy.
      { retryable: true },
    );
  }

  await assertNeutralized(opts);
}

/**
 * Reads `database.is_neutralized` back FROM THE DATABASE. Separate and exported
 * so it can be re-asserted later — "it was neutralized when we made it" is a
 * claim about the past, and a branch stack outlives the run that created it.
 */
export async function assertNeutralized(opts: NeutralizeOptions): Promise<void> {
  const service = opts.dbService ?? "db";
  const compose = `docker compose -p ${opts.project} -f ${opts.composePath}`;
  const sql = `select value from ir_config_parameter where key = '${NEUTRALIZED_KEY}'`;
  const read = await opts.ssh.exec(
    `${compose} exec -T ${service} sh -c 'psql -U "$POSTGRES_USER" -d ${opts.dbName} -tAc "${sql}"'`,
  );
  if (read.code !== 0 || !readsAsNeutralized(read.stdout)) {
    throw new FleetError(
      "deploy",
      `refusing to serve ${opts.dbName}: ${NEUTRALIZED_KEY} did not read back as true ` +
        `(exit ${read.code}, value ${JSON.stringify(read.stdout.trim())}). A copy of production ` +
        `that is not provably neutralized must never be reachable.`,
      { retryable: false },
    );
  }
}
