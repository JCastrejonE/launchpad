/**
 * The project workspace's ONE loading boundary (spec 0216).
 *
 * Placed at `[id]` rather than inside each panel: the segment that changes on a
 * tab click is always BELOW this level, so every panel (`overview`, `monitoreo`,
 * `repo`, `versiones`, `chats`, `ramas`, `agentes`, `logs`, `conexiones`,
 * `ajustes`, `terminal`, `specs` and `specs/[specId]`) is covered at once. And
 * because `layout.tsx`/`WorkspaceChrome` stay mounted across panel navigation,
 * this fallback lands in the panel area with the header and tab rail still
 * visible and clickable.
 *
 * What it fixes is the ACKNOWLEDGMENT, not the wait: without a loading boundary
 * the App Router keeps the previous page frozen on screen until the server
 * render finishes, which reads as an ignored click. The renders themselves are
 * exactly as slow as before — the SSH cost behind them is `PENDING.md` row 132.
 *
 * Same voice as the SSH fallback spec 0198 ships in `ramas/page.tsx`, built from
 * the same `Card`/`Label` primitives.
 */
import { Card, Label } from "../../../components/ui";

/** `motion-reduce:animate-none` per the note in `components/forge/ForgeChat.tsx`. */
function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`h-3 animate-pulse rounded bg-border motion-reduce:animate-none ${className}`}
    />
  );
}

export default function Loading() {
  return (
    <div className="space-y-3">
      <Label>Cargando…</Label>
      <Card className="space-y-3 p-6">
        <Bar className="w-1/3" />
        <Bar className="w-2/3" />
        <Bar className="w-1/2" />
      </Card>
      <Card className="space-y-3 p-6">
        <Bar className="w-1/4" />
        <Bar className="w-3/5" />
      </Card>
    </div>
  );
}
