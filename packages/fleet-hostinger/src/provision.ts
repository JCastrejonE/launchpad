/**
 * Ephemeral spec-stack provisioning on a client's Hostinger VPS. This is a
 * LATER spec (the ephemeral-env work) — the stubs remain TODO here.
 *
 * The production VPS lifecycle that spec 0012 implements now lives next door:
 *  - VPS bootstrap → `provisionClientVps` in `bootstrap.ts`
 *  - production stack deploy → `deployProductionStack` in `stack.ts`
 * Both run docker-compose over the injectable SSH seam (`ssh.ts`) using
 * `infra/tenant/` templates; the generated DB password is injected at deploy
 * time and never stored on the repo or the client VPS.
 */

export interface EphemeralStack {
  tenantId: string;
  specId: string;
  buildUrl: string;
}

export async function createEphemeralStack(
  tenantId: string,
  specId: string,
): Promise<EphemeralStack> {
  throw new Error(
    `TODO(ephemeral-env spec): restore sanitized snapshot, up spec-${specId} stack, add Traefik route`,
  );
}

export async function destroyEphemeralStack(stack: EphemeralStack): Promise<void> {
  throw new Error(`TODO(ephemeral-env spec): down + prune spec-${stack.specId}`);
}
