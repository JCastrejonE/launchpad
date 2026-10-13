/**
 * Pure style-mapping logic for StatusBadge, kept framework-free (no React
 * import) so it compiles under tsconfig.test.json and is unit-testable with
 * plain `node --test` — see components/StatusBadge.tsx for the JSX shell.
 */
import { isKnownStatus, type KnownStatus } from "./specs";

export interface BadgeStyle {
  background: string;
  color: string;
  border: string;
}

const KNOWN_STYLES: Record<KnownStatus, BadgeStyle> = {
  draft: { background: "#e5e7eb", color: "#374151", border: "none" },
  approved: { background: "#dbeafe", color: "#1e40af", border: "none" },
  in_progress: { background: "#fef3c7", color: "#92400e", border: "none" },
  staged: { background: "#ede9fe", color: "#5b21b6", border: "none" },
  promoted: { background: "#dcfce7", color: "#166534", border: "none" },
  rejected: { background: "#fee2e2", color: "#991b1b", border: "none" },
  // Spec 0122: done, but not through a promote. Deliberately a DIFFERENT green from
  // `promoted` — both are terminal successes, and a reader should be able to tell at
  // a glance which one shipped through the gates and which was hand-authored.
  completed: { background: "#d1fae5", color: "#065f46", border: "none" },
};

/** Fallback for any status outside KNOWN_STATUSES. The dashed border is the
 * distinguishing signal (no known style uses a border), so an unknown status
 * still reads as visibly different even if its color happens to be reused. */
const FALLBACK_STYLE: BadgeStyle = {
  background: "#ffffff",
  color: "#7c2d12",
  border: "1px dashed #7c2d12",
};

export function getStatusBadgeStyle(status: string): BadgeStyle {
  if (isKnownStatus(status)) {
    return KNOWN_STYLES[status];
  }
  return FALLBACK_STYLE;
}
