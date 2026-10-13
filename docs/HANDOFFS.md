# Meta-level handoffs (spec: null)

Per ADR-015, supervisor↔architect handoffs normally live in the relevant
spec's `## Handoff log`. Handoffs with `"spec": null` (meta-level, no
pipeline run behind them) are recorded here instead, chronologically.

## 2026-07-09 — ADR-015 bootstrap (two-role operating model)

```json
{ "handoff": "supervisor->architect", "ts": "2026-07-09T00:00:00Z",
  "spec": null, "type": "draft_spec",
  "situation": "The owner has established a two-role model: execution-free ARCHITECT (Fable 5) drafts specs/decides pivots; SUPERVISOR executes and is the sole committer/gate-clicker. Handoffs are fenced JSON appended to the relevant spec's ## Handoff log. This must be documented as ADR-015 in docs/DECISIONS.md.",
  "artifacts": ["CLAUDE.md", "docs/DECISIONS.md (ADR-012/013/014 for style + prior context)"],
  "question": "(1) State your exact model identity. (2) Confirm you understand and accept the JSON handoff contract and the execution-free architect role. (3) Draft the full text of ADR-015 documenting the supervisor/architect split and the JSON handoff format, matching the existing ADR prose style.",
  "deadline_context": "No pipeline work proceeds under the new model until ADR-015 is committed." }
```

```json
{
  "handoff": "architect->supervisor",
  "ts": "2026-07-09T00:20:00Z",
  "model_self_report": "claude-fable-5",
  "spec": null,
  "decision": "I confirm my model identity (claude-fable-5), accept the execution-free architect role and JSON handoff contract, and deliver the full ADR-015 text inline for verbatim commit after the owner's review.",
  "rationale": "Documenting the split as an ADR before any pipeline work resumes gives the two-role model the same standing as the gate model (ADR-007) and the sandbox boundary (ADR-013), so future sessions inherit it from docs/DECISIONS.md rather than from conversation memory. Drafted in house style: rationale-first, hard boundaries explicit, numbered conditions. I also resolved one gap the contract left open — handoffs with spec:null have no '## Handoff log' to live in — by designating docs/HANDOFFS.md as the audit trail for spec-less (meta) handoffs; the alternative of forcing a synthetic meta-spec was rejected as ceremony without a pipeline run behind it. Rejected alternative for the model itself: folding this into CLAUDE.md only — CLAUDE.md states rules but ADRs record why, and role boundaries need the why to survive re-litigation.",
  "spec_draft_path": null,
  "actions_for_supervisor": [
    "1. Verify this handoff's model_self_report equals claude-fable-5 (it does); if it had not, discard and respawn per the ADR's tripwire.",
    "2. Present the ADR-015 text to the owner for review; apply no edits — if the owner wants changes, hand back with type pivot_decision rather than editing in place.",
    "3. On the owner's approval, append the ADR-015 text verbatim to docs/DECISIONS.md after ADR-014.",
    "4. Create docs/HANDOFFS.md and record this handoff pair as its first entries.",
    "5. Run pnpm -r typecheck && pnpm -r test, then commit both files as one conventional commit.",
    "6. Announce to the owner that the model is in force and pipeline work may resume."
  ],
  "risks": [
    "Model mismatch on future architect spawns — tripwire: model_self_report != claude-fable-5 in any architect->supervisor block; supervisor discards the output unread and respawns.",
    "Verbatim-commit drift (well-meaning supervisor edits during commit) — tripwire: diff of committed ADR vs. delivered text is non-empty; treat as a contract breach and recommit.",
    "Handoff log bloat making specs hard to read — tripwire: a spec's Handoff log exceeding roughly half the file; if hit, hand a pivot_decision to design a compaction rule rather than trimming ad hoc.",
    "Ambiguity between architect pivot authority and the owner's authority — the ADR states the owner overrides both roles; if a supervisor ever receives conflicting instructions, the owner wins, and the conflict gets logged."
  ],
  "defer": [
    "Schema validation tooling for handoff JSON blocks (lint step) — future spec, not blocking.",
    "Surfacing handoff logs in apps/web (chat-first, per ADR-011) — future spec.",
    "Automated model-identity verification at spawn time rather than self-report — future spec; self-report plus supervisor check suffices for now."
  ]
}
```

Supervisor note: model verified (`model_self_report == claude-fable-5`,
spawn used `model: fable`); the owner reviewed and approved ADR-015 as-is; committed
verbatim.
