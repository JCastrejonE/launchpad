# Handoff conventions

Every agent session ends by appending one entry to the spec's `## Handoff log`:

```markdown
- **YYYY-MM-DD / <role>:** <what was done, 1-2 lines>. Next: <the single next
  action>. Surprises: <anything the next agent must know, or "none">.
```

Rules: the repo must be green (typecheck + tests) at handoff; uncommitted work
is discarded; the Handoff log is the only cross-session memory — if it's not
written there, the next agent doesn't know it.
