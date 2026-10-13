/**
 * The **Ramas & builds** panel (spec 0157).
 *
 * One route segment, one panel, so the VPS inventory — which is an SSH round trip — is only fetched when you open this panel. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { Suspense } from "react";
import { requireProject } from "../require-project";
import { ActionErrorBanner, Ramas } from "../panels";
import { BranchesPanel } from "../branches-panel";
import { DeployedStacksPanel } from "../deployed-stacks-panel";
import { Card, Label } from "../../../../components/ui";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const project = await requireProject(id);

  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <Ramas
        branchesSlot={<BranchesPanel slug={project.id} />}
        deployedStacksSlot={
          // Spec 0198 A: the VPS inventory is ~43 sequential SSH connections
          // (0.9 s each, no multiplexing) — about 40 s on today's box, and
          // growing with every branch staging environment. Awaiting it here
          // blocked the WHOLE page, so a click on this tab looked like a dead
          // link for forty seconds; the branch rows and their buttons are a
          // millisecond DB read and now paint immediately.
          <Suspense
            fallback={
              <div className="space-y-3">
                <Label>Entornos desplegados · leídos del VPS</Label>
                <Card className="p-6 text-sm text-muted">
                  Leyendo los VPS por SSH… (esto tarda unos segundos; las ramas de arriba ya se
                  pueden usar).
                </Card>
              </div>
            }
          >
            <DeployedStacksPanel slug={project.id} />
          </Suspense>
        }
      />
    </>
  );
}
