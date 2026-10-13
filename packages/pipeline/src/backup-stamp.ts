/**
 * The compact UTC stamp (`20260812T123456Z`) a pre-install backup is named by.
 *
 * Minted from the WORKFLOW's own start time, never inside an activity, because
 * spec 0105 requires the caller to supply it: an activity that stamps itself
 * orphans one backup directory per retry. Workflow time is deterministic and
 * identical on replay, so a retried activity reuses the same directory — which
 * is the whole point.
 *
 * Spec 0176's first attempt passed the release UUID instead and the fleet layer
 * refused it by format, which is the refusal working.
 *
 * Lives here (spec 0187 E) rather than in `release-workflow.ts`, where it was
 * born, because a second and third caller arrived: the branch staging op and the
 * gate-2 staging refresh both install into a database that already exists.
 */
export function backupStampFor(startTime: Date): string {
  return `${startTime.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}
