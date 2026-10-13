/**
 * DESIGN.md §4.2 #6 entry-in: a new `.ev` handoff entry arriving via the 3s
 * poll refresh fades + slides in. The hard part is telling "genuinely new
 * since the feed became interactive" apart from "already present at the
 * page's initial paint" — both look identical to React (a first mount of
 * that entry's DOM node), but only the former should animate; animating
 * every entry on first paint would be the banned page-load choreography
 * (§4 / this spec's non-goal). `HandoffFeed.tsx` captures the full set of
 * entry keys present at ITS OWN mount as "already seen" and, on every later
 * render, asks this pure helper which of the current keys aren't in that
 * set yet — those are the ones that actually just arrived. Kept pure (no
 * DOM/React) so it's unit-testable without the RTL/jsdom setup this repo
 * doesn't have (component wiring itself is intentionally thin/untested,
 * matching every other motion call-site component here).
 */
export function pickNewEntryKeys(
  seen: ReadonlySet<string>,
  currentKeys: readonly string[],
): string[] {
  return currentKeys.filter((key) => !seen.has(key));
}
