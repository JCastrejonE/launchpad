"use client";

// DESIGN.md §4.2 #6 entry-in call site (spec 0041 item 4). A thin client
// component: it owns the `.ev` collapsible-<details> markup (spec 0032
// behavior, unchanged) AND decides, per entry, whether it "just arrived" this
// render (via lib/handoff-motion) so only genuinely-new entries fade+slide in —
// never the page's initial paint (that would be the banned page-load
// choreography, §4 non-goal). It takes SERIALIZABLE parsed data, NOT a render
// function: passing functions from the server page across the RSC boundary is
// illegal ("Functions cannot be passed directly to Client Components").
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pickNewEntryKeys } from "../lib/handoff-motion";

export type HandoffFeedEntry = {
  key: string;
  lead: string;
  fields: { key: string; value: string }[];
  body: string;
  isFirst: boolean;
};

// Inline marks (**bold**, `code`) → elements; mirrors the server page's helper
// (kept here so this client component renders entries without a function prop).
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={i}
          className="rounded border border-border bg-surface px-1 py-px text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

export function HandoffFeed({ entries }: { entries: HandoffFeedEntry[] }) {
  // Captured once, at THIS component's own mount — every key present then is
  // "already on the page", never animated, no matter how the server later
  // re-renders it.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set(entries.map((e) => e.key));
  }
  const [enteringKeys, setEnteringKeys] = useState<ReadonlySet<string>>(new Set());
  const keysSignature = entries.map((e) => e.key).join(" ");

  useEffect(() => {
    const known = seen.current!;
    const fresh = pickNewEntryKeys(known, entries.map((e) => e.key));
    if (fresh.length > 0) {
      fresh.forEach((key) => known.add(key));
      setEnteringKeys(new Set(fresh));
    }
    // Keyed on the joined key list, not `entries` — the caller maps fresh every
    // render so `entries` is never reference-stable; keysSignature changes only
    // when the underlying handoff log does.
  }, [keysSignature]);

  return (
    <>
      {/* Spec 0101: the `.ev`/`.me`/`.entry-*`/`.kv` component classes are gone.
          The timeline rail, spacing and colours are utilities; only the node dot
          and the <details> caret stay in CSS (`.mc-entry`), because both are
          pseudo-elements. `last:border-l-transparent` reproduces the old
          `.ev:last-child` rule so the rail stops at the final entry. */}
      {entries.map((e) => {
        const cls = [
          "mc-entry relative border-l-[1.5px] border-border py-3 pl-6 last:border-l-transparent",
          e.isFirst ? "mc-entry-first" : "",
          enteringKeys.has(e.key) ? "mc-entry-in" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <details key={e.key} className={cls} open={e.isFirst}>
            <summary
              className={`cursor-pointer text-[13px] ${e.isFirst ? "text-foreground" : "text-muted"}`}
            >
              {renderInline(e.lead)}
            </summary>
            <div className="min-w-0 pt-2">
              {e.fields.length > 0 && (
                <div className="mb-1">
                  {e.fields.map((f, fi) => (
                    <div
                      key={fi}
                      className="flex justify-between gap-4 border-b border-dashed border-border py-2 text-[12.5px] last:border-b-0"
                    >
                      <span className="text-faint">{f.key}</span>
                      <span className="min-w-0 break-words text-right tabular-nums text-foreground">
                        {renderInline(f.value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {e.body && (
                <p className="m-0 break-words whitespace-pre-wrap text-[13px] text-muted">
                  {renderInline(e.body)}
                </p>
              )}
            </div>
          </details>
        );
      })}
    </>
  );
}
