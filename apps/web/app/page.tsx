/**
 * Launchpad (SPEC §6.1) — the project grid, on REAL `projects` rows (spec 0084,
 * C.4a). Server half: reads the control plane and adapts rows to the display
 * shape via `lib/project-view.ts`; the client half (`Launchpad.tsx`) keeps the
 * search box, the "Agregar proyecto" menu and the animations.
 *
 * Degrade, don't block: if the DB is unreachable or unmigrated the page still
 * renders with an empty grid rather than a 500 — the same discipline the
 * workspace route uses. An empty grid is honest here (we genuinely cannot list
 * projects); it is not the same as inventing demo rows.
 */
import { listProjectsFor, projectCounts } from "@launchpad/db";
import { currentViewer } from "./viewer";
import { getDb } from "../lib/db";
import { getFleetSafe } from "../lib/fleet";
import { toProjectViews, type ProjectView } from "../lib/project-view";
import { listSpecs } from "../lib/specs";
import { sessionChromeUser } from "./chrome-user";
import { Launchpad, type FleetStat } from "./Launchpad";

// Render per request. Without this the page reads the DB at BUILD time and
// Next serves a static grid forever — `next build` reported `○ (Static)` for
// `/` until this was added, so a newly-created project would not appear until
// the next deploy. The workspace route is dynamic already (it reads the
// session); this one has no such marker of its own.
export const dynamic = "force-dynamic";

/**
 * Spec 0128 A: the dashboard shows the viewer's OWN projects, not every project
 * in the install. A control-plane OWNER still sees all of them (support).
 *
 * No viewer ⇒ no projects. That fails closed, and it is unreachable in practice
 * because middleware already redirects an anonymous request to /login — but
 * "unreachable" is not a reason to return everything.
 */
async function loadProjects(): Promise<ProjectView[]> {
  try {
    const viewer = await currentViewer();
    if (!viewer) return [];
    const db = getDb();
    const [rows, counts] = await Promise.all([
      listProjectsFor(db, viewer.userId, { isPlatformOwner: viewer.isPlatformOwner }),
      projectCounts(db),
    ]);
    return toProjectViews(rows, counts);
  } catch {
    return [];
  }
}

/** Spec 0085 (C.4b): the fleet has a real live source (Hostinger), unlike
 * `agent_runs` — so this stat stops being `—`. An unreachable API keeps
 * rendering unknown rather than `0`: "we could not ask" is not "no servers".
 * The Hostinger client stays server-side; only the two counts cross over. */
async function loadFleetStat(): Promise<FleetStat> {
  const fleet = await getFleetSafe();
  if (!fleet.available) return { available: false };
  return {
    available: true,
    total: fleet.vps.length,
    running: fleet.vps.filter((v) => v.state === "running").length,
  };
}


export default async function LaunchpadPage() {
  const [projects, fleet, user] = await Promise.all([
    loadProjects(),
    loadFleetStat(),
    sessionChromeUser(),
  ]);
  return <Launchpad projects={projects} fleet={fleet} user={user} />;
}
