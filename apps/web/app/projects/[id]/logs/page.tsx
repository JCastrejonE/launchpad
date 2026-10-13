/**
 * The **Logs** panel (spec 0157).
 *
 * One route segment, one panel. Spec 0214: the lines are read from the fleet by
 * SSH now, so the panel body arrives in a `<Suspense>` — the fleet read is
 * several sequential SSH round trips (~0.9 s each, spec 0198), and awaiting it
 * here would leave the whole tab blank for seconds.
 */
import { Suspense } from "react";
import { requireProject } from "../require-project";
import { ActionErrorBanner } from "../panels";
import { LogsPanel } from "../logs-panel";
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
      <Suspense
        fallback={
          <div className="space-y-3">
            <Label>Logs del servidor</Label>
            <Card className="p-6 text-sm text-muted">
              Leyendo los contenedores por SSH… (esto tarda unos segundos).
            </Card>
          </div>
        }
      >
        <LogsPanel slug={project.id} />
      </Suspense>
    </>
  );
}
