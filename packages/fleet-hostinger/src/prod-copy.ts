/**
 * Copying production into a branch stack (spec 0226 A, restore half).
 *
 * This is the only code in the product that touches a customer's LIVE database,
 * so the design goal is not elegance — it is that production cannot be changed
 * by it, provably, and that a copy which is not yet neutralized can never be
 * reached.
 *
 * **Production is read-only, by construction.** The prod side issues exactly two
 * things: `pg_dump` and a read of the filestore volume. Both are reads. There is
 * no code path here that writes to the production project, and
 * {@link PROD_WRITE_VERBS} plus its test exist so that stays true when someone
 * adds a step in a hurry.
 *
 * **Consistency comes from Odoo's own shape, not from locking.** `pg_dump` is an
 * online, consistent snapshot; the filestore is content-addressed, so an
 * attachment written between the two copies leaves a row without a file on a
 * TEST copy — cosmetic, and not worth taking a customer's production offline for.
 *
 * The caller must have brought up ONLY the branch's `db` service, and must
 * neutralize (`neutralizeRestoredDb`) before starting `odoo`.
 */
import { FleetError } from "./errors.js";
import type { SshRunner } from "./ssh.js";

/**
 * The ONLY two things this module may do to production, as a closed union.
 *
 * This replaced a denylist of write verbs, and the difference is the whole
 * point: a denylist checks a string AFTER it was built, is incomplete by
 * construction, and its first version flagged our own read-only copy while
 * missing anything not on the list. This cannot express a write at all —
 * production commands are BUILT here, from these two shapes, and nothing else
 * in the module has the production project name in scope to build another.
 */
export type ProductionRead =
  | { kind: "dump"; dbName: string; toPath: string }
  | { kind: "copyFilestore"; toVolume: string };

/**
 * Builds a production command. Pure, exhaustive, and the only place the prod
 * project or the prod volume is ever interpolated — so the tests can enumerate
 * every command that can possibly reach production and assert each is a read.
 */
/**
 * Every value interpolated into a production command must be inert.
 *
 * The module's premise is that production cannot be changed by it, and an
 * interpolated `>` target or database name is a hole straight through that:
 * `pg_dump … > /tmp/x; psql -c 'drop table …'` is one semicolon away. Today all
 * of these come from slugs and generated names, so this refuses nothing real —
 * which is exactly when to add it, rather than after a caller starts passing
 * something it read from a form.
 */
const SHELL_SAFE = /^[A-Za-z0-9._\/-]+$/;

function inert(label: string, value: string): string {
  if (!SHELL_SAFE.test(value)) {
    throw new FleetError(
      "config",
      `refusing to build a production command: ${label} ${JSON.stringify(value)} contains ` +
        `characters that a shell would interpret. Only letters, digits, dot, underscore, ` +
        `slash and hyphen are allowed here.`,
      { retryable: false },
    );
  }
  return value;
}

export function productionCommand(
  opts: Pick<ProdCopyOptions, "prodProject" | "prodComposePath" | "prodFilestoreVolume">,
  read: ProductionRead,
): string {
  switch (read.kind) {
    case "dump":
      // `pg_dump` only. No `psql -c`, which could carry any statement.
      return (
        `docker compose -p ${inert("prodProject", opts.prodProject)} ` +
        `-f ${inert("prodComposePath", opts.prodComposePath)} exec -T db ` +
        `sh -c 'pg_dump -U "$POSTGRES_USER" -d ${inert("dbName", read.dbName)} -Fc' ` +
        `> ${inert("toPath", read.toPath)}`
      );
    case "copyFilestore":
      // The prod volume is pinned `:ro` HERE, where it cannot be forgotten at a
      // call site. The writable mount is always the caller's target.
      return (
        `docker run --rm -v ${inert("prodFilestoreVolume", opts.prodFilestoreVolume)}:/from:ro ` +
        `-v ${inert("toVolume", read.toVolume)}:/to alpine cp -a /from/. /to/`
      );
  }
}

export interface ProdCopyOptions {
  ssh: SshRunner;
  /** Compose project + file of the LIVE stack. Read from, never written to. */
  prodProject: string;
  prodComposePath: string;
  prodDbName: string;
  /** Compose project + file of the BRANCH stack. Written to. */
  branchProject: string;
  branchComposePath: string;
  branchDbName: string;
  /** Docker volume names for the two filestores. */
  prodFilestoreVolume: string;
  branchFilestoreVolume: string;
  /** Where the dump lands on the host, between the two halves. */
  dumpPath?: string;
}

const compose = (project: string, file: string) => `docker compose -p ${project} -f ${file}`;

/**
 * Dumps the live database to a file on the HOST. Reads production; writes only
 * to `dumpPath`, which is ours.
 */
export async function dumpProduction(opts: ProdCopyOptions): Promise<string> {
  const dumpPath = opts.dumpPath ?? `/tmp/launchpad-prodcopy-${opts.branchDbName}.dump`;
  const res = await opts.ssh.exec(
    productionCommand(opts, { kind: "dump", dbName: opts.prodDbName, toPath: dumpPath }),
  );
  if (res.code !== 0) {
    throw new FleetError(
      "deploy",
      `pg_dump of ${opts.prodDbName} failed (exit ${res.code}): ${res.stderr.trim().slice(0, 400)}`,
      { retryable: true },
    );
  }
  return dumpPath;
}

/**
 * Restores that dump into the BRANCH database and copies the filestore.
 *
 * Asserts the end state rather than the exit codes: a restore that "succeeded"
 * into an empty database is the failure mode worth catching, because the next
 * step would neutralize nothing and the branch would serve an empty Odoo that
 * looks fine (VERIFICATION #8).
 */
export async function restoreIntoBranch(opts: ProdCopyOptions, dumpPath: string): Promise<void> {
  const branch = compose(opts.branchProject, opts.branchComposePath);

  const restore = await opts.ssh.exec(
    `${branch} exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d ${opts.branchDbName} --no-owner --clean --if-exists' < ${dumpPath}`,
  );
  if (restore.code !== 0) {
    throw new FleetError(
      "deploy",
      `pg_restore into ${opts.branchDbName} failed (exit ${restore.code}): ${restore.stderr.trim().slice(0, 400)}`,
      { retryable: true },
    );
  }

  // Built by `productionCommand`, which pins the prod volume `:ro` where a call
  // site cannot forget it.
  //
  // NO `|| true`, and no `2>/dev/null`. The first draft had both — which made
  // the exit-code check below unreachable and blanked the stderr its message
  // quotes: a guard disarmed in the same statement that declares it
  // (VERIFICATION #2). They were there to tolerate an empty filestore, which
  // `cp -a /from/.` already tolerates: `.` exists even when the dir is empty.
  const files = await opts.ssh.exec(
    productionCommand(opts, { kind: "copyFilestore", toVolume: opts.branchFilestoreVolume }),
  );
  if (files.code !== 0) {
    throw new FleetError(
      "deploy",
      `filestore copy failed (exit ${files.code}): ${files.stderr.trim().slice(0, 400)}`,
      { retryable: true },
    );
  }

  await assertRestored(opts);
}

/** Did the data actually land? An empty database is the failure that looks fine. */
export async function assertRestored(opts: ProdCopyOptions): Promise<void> {
  const res = await opts.ssh.exec(
    `${compose(opts.branchProject, opts.branchComposePath)} exec -T db ` +
      `sh -c 'psql -U "$POSTGRES_USER" -d ${opts.branchDbName} -tAc "select count(*) from ir_module_module"'`,
  );
  const n = Number.parseInt(res.stdout.trim(), 10);
  if (res.code !== 0 || !Number.isFinite(n) || n <= 0) {
    throw new FleetError(
      "deploy",
      `restore into ${opts.branchDbName} did not land: ir_module_module reads ` +
        `${JSON.stringify(res.stdout.trim())} (exit ${res.code}). An empty copy would neutralize ` +
        `cleanly and serve an Odoo that looks fine, so this refuses instead.`,
      { retryable: false },
    );
  }
}

/**
 * Should this branch deploy copy production? (Spec 0226 C.)
 *
 * Pure, and separated from the copying because getting it wrong is the
 * expensive mistake rather than a slow one: **odoo.sh copies production when
 * the staging branch is CREATED, and on later pushes "the database is not
 * re-created".** Our 0134 redeploys a branch's staging at gate-2 arrival, so
 * copying there would wipe the tester's data on every round — destroying the
 * exact thing a staging environment exists to accumulate, and doing it right
 * when someone is in the middle of using it.
 *
 * The reason string is part of the answer, not decoration: a run that quietly
 * skipped the copy and a run that quietly did one look identical afterwards.
 */
export interface CopyDecision {
  copy: boolean;
  reason: string;
}

export function decideProductionCopy(input: {
  /** Is there already a stack for this branch? A redeploy, not a creation. */
  stackExists: boolean;
  /** Did anyone ask for a copy of production on this branch? */
  wantsCopy: boolean;
  /** Is there a production to copy FROM? */
  hasProduction: boolean;
}): CopyDecision {
  // First, and unconditional: a branch configured to want a copy must STILL not
  // get one on redeploy. (The ORDER relative to `wantsCopy` only changes which
  // reason is reported — both orders give the same decision. What matters is
  // that this branch exists at all; deleting it is the regression that wipes a
  // tester's data, and that is what the test pins.)
  if (input.stackExists) {
    return {
      copy: false,
      reason:
        "el entorno de esta rama ya existe: se reconstruye el CÓDIGO y se conserva su base de " +
        "datos. Copiar producción aquí borraría lo que hayas capturado probando.",
    };
  }
  if (!input.wantsCopy) {
    return { copy: false, reason: "esta rama se levanta con un Odoo limpio, sin copiar producción." };
  }
  if (!input.hasProduction) {
    return {
      copy: false,
      reason: "no hay producción de la cual copiar, así que la rama arranca con un Odoo limpio.",
    };
  }
  return { copy: true, reason: "primer despliegue de la rama: se copia producción y se neutraliza." };
}
