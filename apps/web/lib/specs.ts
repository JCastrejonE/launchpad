/**
 * Spec inbox data layer: reads specs/*.md, parses YAML-ish frontmatter, and
 * exposes a small, framework-free API the pages render from.
 *
 * Kept intentionally independent from @launchpad/pipeline's store.ts (which
 * is worker-side and mutates spec files) — this module only ever reads.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Re-exported from the Node-free `spec-status.ts` (spec 0032 item 1) so every
// existing `from "./specs"` import keeps working unchanged; anything reached
// from a client component must import `./spec-status` directly instead (see
// its docstring for why).
export { KNOWN_STATUSES, isKnownStatus, type KnownStatus } from "./spec-status";

export interface SpecSummary {
  /** Frontmatter `id`, e.g. "0002". Falls back to the filename if missing. */
  id: string;
  /** Frontmatter `title`. Falls back to the filename if missing. */
  title: string;
  /** Raw frontmatter `status` value — may not be a KnownStatus. */
  status: string;
  /** File basename, e.g. "0002-spec-inbox-page.md". The routable key. */
  filename: string;
  /** Plan-progress checked/total (spec 0032 item 1/4) — the caller already
   * has the full markdown in hand, so this comes free alongside the rest of
   * the summary; feed it to `progressPercent` to render the `/specs` row %. */
  progress: { checked: number; total: number };
  /** Optional `product` frontmatter facet (spec 0037 / ADR-019) — rendered as
   * a small badge on `/specs` when present. A plain-data field so the client
   * `SpecInboxTable` reads it without any Node-only import (spec 0032's
   * client-bundle lesson). Absent frontmatter ⇒ `undefined`. Coder wires
   * `parseSpecSummary` to populate it. */
  product?: "hangar" | "forge" | "both";
  /** Frontmatter `tenant:` — which project owns this spec (spec 0104). Fed to
   * `projectSlugForSpec` so a workspace can show only its own specs. Optional
   * for the same reason `product` is: an explicit `undefined` key would break
   * the plain deepEqual assertions in specs.test.ts. */
  tenant?: string;
  /** Frontmatter `archived: true` (spec 0122) — hidden from a project's Specs list
   * without being deleted. Optional/omitted-when-false for the same deepEqual reason
   * as the fields above. */
  archived?: true;
  /** Frontmatter `track:` (spec 0109) — 1 = hand-authored, never runs through the
   * pipeline; 2 = pipeline-run. Optional for the same reason `product`/`tenant`
   * are (an explicit `undefined` key breaks specs.test.ts's deepEqual), and an
   * absent value is treated as Track 1 by `deriveNextStep` — fail closed. */
  track?: 1 | 2;
}

/** Repo root, derived from this package's own location so it doesn't depend
 * on the caller's cwd (works the same under `next dev`, `next build`, and
 * `node --test`, all of which run with cwd = apps/web via pnpm). */
export function repoRoot(): string {
  return path.resolve(process.cwd(), "..", "..");
}

export function specsDir(): string {
  return path.join(repoRoot(), "specs");
}

/** Parses a leading `---\n...\n---` frontmatter block into flat key/value
 * pairs. Not a general YAML parser — specs only use scalar `key: value`
 * fields (see docs/SPEC_FORMAT.md) — but tolerant of blank/missing values. */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!block) return fields;
  const body = block[1] ?? "";
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    if (!key) continue;
    fields[key] = (kv[2] ?? "").trim();
  }
  return fields;
}

export function parseSpecSummary(filename: string, markdown: string): SpecSummary {
  const fm = parseFrontmatter(markdown);
  const rawProduct = fm["product"];
  const product =
    rawProduct === "hangar" || rawProduct === "forge" || rawProduct === "both"
      ? rawProduct
      : undefined;
  return {
    id: fm["id"] || filename,
    title: fm["title"] || filename,
    status: fm["status"] || "unknown",
    filename,
    progress: parsePlanProgress(markdown),
    // Only set the key when a valid value is present — an explicit
    // `product: undefined` key would break the plain `parseSpecSummary`
    // deepEqual assertions in specs.test.ts (Object.keys would then include
    // "product" for every spec, valid or not). Same for `tenant` (spec 0104).
    ...(product ? { product } : {}),
    ...(fm["tenant"]?.trim() ? { tenant: fm["tenant"].trim() } : {}),
    ...(fm["track"]?.trim() === "1" ? { track: 1 as const } : {}),
    ...(fm["track"]?.trim() === "2" ? { track: 2 as const } : {}),
    // Spec 0122: only set when literally true, mirroring `readArchived` — a
    // malformed value must never hide a spec. Key omitted otherwise, for the same
    // deepEqual reason as the fields above.
    ...(fm["archived"]?.trim() === "true" ? { archived: true as const } : {}),
  };
}

/** Lists every spec under specsDir(), sorted by filename (which sorts by id
 * since files are named `NNNN-slug.md`). */
export async function listSpecs(dir: string = specsDir()): Promise<SpecSummary[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const specs: SpecSummary[] = [];
  for (const filename of files) {
    const markdown = await readFile(path.join(dir, filename), "utf8");
    specs.push(parseSpecSummary(filename, markdown));
  }
  return specs;
}

const SAFE_SPEC_FILENAME = /^[A-Za-z0-9_.-]+\.md$/;

/** Guards the detail-page route param against path traversal — it comes
 * straight from the URL. */
export function isSafeSpecFilename(filename: string): boolean {
  return SAFE_SPEC_FILENAME.test(filename) && !filename.includes("..");
}

/**
 * Extracts the entries under a spec's `## Handoff log` section, most-recent
 * entry last (file order) — same order agents append in. Each entry starts
 * with a top-level `- ` bullet; wrapped continuation lines (no `- ` prefix,
 * per the convention agents/HANDOFF.md follows) are folded back into a single
 * line so the caller can render one feed item per entry. Returns an empty
 * array when the section is missing or has no entries yet — never throws, so
 * a spec with no handoffs (nothing has run against it yet) still renders.
 */
export function parseHandoffLog(markdown: string): string[] {
  const heading = markdown.match(/^## Handoff log\r?\n/m);
  if (!heading || heading.index === undefined) return [];
  const rest = markdown.slice(heading.index + heading[0].length);
  // Stop at the next top-level heading, if any; a plain regex end-anchor
  // (`\s*$`) is unsafe here because `$` matches end-of-line too, not just
  // end-of-string, and would cut the section off after its first line.
  const nextHeadingAt = rest.search(/\r?\n## /);
  const body = nextHeadingAt === -1 ? rest : rest.slice(0, nextHeadingAt);
  const entries: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^-\s+/.test(line)) {
      entries.push([line.replace(/^-\s+/, "").trim()]);
    } else if (entries.length > 0 && line.trim() !== "") {
      entries[entries.length - 1]!.push(line.trim());
    }
  }
  return entries.map((parts) => parts.join(" "));
}

// Keep in sync with @launchpad/pipeline store.ts: optional list numbering
// ("10.", "3)") is allowed before the (human) marker.
const HUMAN_ITEM_RE = /^\s*- \[ \] (?:\d+[.)]\s*)?\(human\)\s*(.*)$/gm;

/**
 * Extracts the texts of unchecked `- [ ] (human)` items (the `(human)` marker
 * stripped) — human-only steps surfaced as a "Waiting on you" checklist on the
 * detail page when the workflow parks at gate 2 (spec 0006). Mirrors the
 * worker-side @launchpad/pipeline store.humanPendingItems, but this module
 * only ever reads.
 */
export function parseHumanPendingItems(markdown: string): string[] {
  return [...markdown.matchAll(HUMAN_ITEM_RE)].map((m) => (m[1] ?? "").trim());
}

const PLAN_ITEM_RE = /^\s*-\s\[([ xX])\]\s*(.*)$/gm;

/**
 * Count checked vs. total plan items (`- [x]` / `- [ ]`, excluding `(human)`
 * items) — shown on the detail page while the workflow is in the `coding`
 * phase, in place of gate buttons (spec 0007). Read-only, like the rest of
 * this module.
 *
 * Scans the whole document for checklist-style bullets rather than scoping to
 * the `## Progress` heading, matching parseHumanPendingItems's approach above
 * — specs only ever use `- [ ]`/`- [x]` bullets under Progress (the Plan
 * section uses numbered `1.` items), so this doesn't overcount in practice.
 */
export function parsePlanProgress(markdown: string): { checked: number; total: number } {
  let checked = 0;
  let total = 0;
  for (const match of markdown.matchAll(PLAN_ITEM_RE)) {
    const box = match[1] ?? " ";
    const text = (match[2] ?? "").trim();
    if (/^\(human\)/.test(text)) continue;
    total += 1;
    if (box !== " ") checked += 1;
  }
  return { checked, total };
}

/**
 * Coding-completion percentage (spec 0032 item 4) from a `parsePlanProgress`
 * result — surfaced next to "Plan progress x/y" on the detail page (during the
 * `coding` phase) and on the `/specs` rows. Guards `total === 0` (a spec with no
 * plan items yet) so it never divides by zero: 0 items ⇒ 0%. Returns a rounded
 * integer 0..100. Pure, so it's unit-tested without rendering.
 */
export function progressPercent(progress: { checked: number; total: number }): number {
  if (progress.total <= 0) return 0;
  return Math.round((progress.checked / progress.total) * 100);
}

/**
 * Structured breakdown of one `## Handoff log` entry (a joined string from
 * `parseHandoffLog`) for readable, collapsible rendering (spec 0032 item 2):
 * a `<summary>` shows `lead`; the expanded body renders `fields` as a
 * key/value table and `body` as wrapped prose. Splits out the structured
 * `key: value` / `key:{...}` fragments these entries carry so they stop
 * printing as a tall vertical blob, degrading to plain prose when an entry has
 * no structured fragments. Pure, so it's unit-tested without rendering.
 */
export interface HandoffEntryParts {
  /** Summary line: date / author / first clause. */
  lead: string;
  /** Structured `key: value` / `key:{...}` fragments, rendered as a table. */
  fields: { key: string; value: string }[];
  /** Remaining free prose, rendered wrapped. */
  body: string;
}

// Bracketed fragments like `target:{kind:tenant,vpsId:100001}` — the
// canonical "structured" shape called out in the spec (item 2). Requires a
// word boundary before the key so it never fires mid-token (e.g. inside a
// `` `path/like.this` `` reference).
const BRACED_FIELD_RE = /\b([A-Za-z][\w-]*):(\{[^}]*\})/g;

// The two labeled fields agents/HANDOFF.md's convention always closes an
// entry with (`Next: ...` / `Surprises: ...`). Deliberately NOT a generic
// "any word before a colon" scan — prose is full of `word:` (file refs,
// clarifications) that isn't meant to become a table row; these two labels
// are the ones the convention guarantees, so they're worth pulling out.
const LABELED_FIELD_RE = /\b(Next|Surprises):\s*/g;

export function parseHandoffEntry(entry: string): HandoffEntryParts {
  // Lead: the bold "**date / role:**" prefix plus its first clause (up to the
  // first period), matching the "date / author / first clause" the spec
  // wants in the collapsed <summary>. Falls back to the first clause of
  // plain text, or the whole entry when there's no period to split on.
  const boldMatch = entry.match(/^\*\*[^*]+\*\*/);
  const afterLeadPrefix = boldMatch ? entry.slice(boldMatch[0].length) : entry;
  const periodIdx = afterLeadPrefix.indexOf(".");
  const lead = periodIdx === -1 ? entry.trim() : (boldMatch?.[0] ?? "") + afterLeadPrefix.slice(0, periodIdx + 1);
  let rest = periodIdx === -1 ? "" : afterLeadPrefix.slice(periodIdx + 1).trim();

  const fields: { key: string; value: string }[] = [];

  rest = rest.replace(BRACED_FIELD_RE, (_match, key: string, value: string) => {
    fields.push({ key, value: value.slice(1, -1) });
    return "";
  });

  const labelMatches = [...rest.matchAll(LABELED_FIELD_RE)];
  let body = rest;
  if (labelMatches.length > 0) {
    for (const [i, m] of labelMatches.entries()) {
      const start = m.index + m[0].length;
      const end = i + 1 < labelMatches.length ? labelMatches[i + 1]!.index : rest.length;
      const value = rest.slice(start, end).trim();
      if (value) fields.push({ key: m[1]!, value });
    }
    body = rest.slice(0, labelMatches[0]!.index);
  }

  return { lead: lead.trim(), fields, body: body.trim() };
}

/** Parsed summary of a tenant vanilla-deploy manifest (spec 0047 item C) —
 * `writeTenantDeployManifest`'s (`@launchpad/pipeline` activities.ts) fixed
 * body shape, read back here purely from the markdown already loaded for the
 * detail page (no new Temporal query). Detects the tenant-deploy case AND
 * carries the fields the gate copy needs ("vanilla stock Odoo <version> →
 * VPS <id>"). Matches each field independently (not one combined regex) so
 * it stays robust to unrelated prose changes in the manifest body. */
export interface TenantDeployManifest {
  tenantId: string;
  vpsId: number;
  odooVersion: number;
}

const TENANT_MANIFEST_TENANT_ID_RE = /^- Target tenant: `([^`]+)`$/m;
const TENANT_MANIFEST_VPS_ID_RE = /^- VPS: (\d+)$/m;
const TENANT_MANIFEST_ODOO_VERSION_RE = /^- Odoo version: (\d+)$/m;

/** Returns `null` for any non-tenant-manifest spec (self/code specs, or a
 * tenant spec whose body doesn't match — never throws), so callers can use
 * it as a plain presence check (`if (parseTenantDeployManifest(content))`). */
export function parseTenantDeployManifest(markdown: string): TenantDeployManifest | null {
  const tenantMatch = markdown.match(TENANT_MANIFEST_TENANT_ID_RE);
  const vpsMatch = markdown.match(TENANT_MANIFEST_VPS_ID_RE);
  const odooMatch = markdown.match(TENANT_MANIFEST_ODOO_VERSION_RE);
  if (!tenantMatch || !vpsMatch || !odooMatch) return null;
  const tenantId = tenantMatch[1];
  const vpsId = Number(vpsMatch[1]);
  const odooVersion = Number(odooMatch[1]);
  if (!tenantId || !Number.isFinite(vpsId) || !Number.isFinite(odooVersion)) return null;
  return { tenantId, vpsId, odooVersion };
}

/** Reads one spec's raw markdown by filename, for the detail/viewer page. */
export async function readSpecFile(
  filename: string,
  dir: string = specsDir(),
): Promise<string> {
  if (!isSafeSpecFilename(filename)) {
    throw new Error(`Unsafe spec filename: ${filename}`);
  }
  return readFile(path.join(dir, filename), "utf8");
}

const SAFE_SPEC_ID = /^[A-Za-z0-9_-]+$/;

/** Guards a bare spec id (no slug, no `.md`) straight from a URL segment —
 * e.g. the `/specs/<id>` redirect target a just-started tenant run lands on
 * (spec 0027) before its `NNNN-slug.md` file has been resolved. */
export function isSafeSpecId(id: string): boolean {
  return SAFE_SPEC_ID.test(id) && !id.includes("..");
}

/**
 * Resolves a bare spec id to its actual `NNNN-slug.md` filename by prefix
 * match — mirrors `@launchpad/pipeline` `store.ts#findSpecFile`, but this
 * module only ever reads. Returns `null` when no file starts with `<id>-`
 * (not drafted yet, or an unknown id) rather than throwing, so the detail
 * page can 404 cleanly instead of crashing.
 */
export async function resolveSpecFilenameById(
  id: string,
  dir: string = specsDir(),
): Promise<string | null> {
  if (!isSafeSpecId(id)) return null;
  const files = await readdir(dir);
  return files.find((f) => f.startsWith(`${id}-`) && f.endsWith(".md")) ?? null;
}
