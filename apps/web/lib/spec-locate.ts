/**
 * ONE way to FIND a spec (spec 0135 D — the 0131 rule, applied to reads).
 *
 * Platform specs are FILES in this repo (`listSpecs()`); every other
 * project's specs are ROWS (`spec_files`, mirrored from the project's
 * git-excluded checkout). Before this module, run start resolved specs
 * through `listSpecs()` alone, so a chat-drafted project spec was invisible
 * to the Start button unless a human hand-placed a file in OUR tree — the
 * 0130 bootstrap hack, promoted here to a resolver both readers share.
 *
 * Files win when both exist: the platform's own specs are also rows-adjacent
 * in odd states, and the committed file is the older, stronger claim.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { specFileBySpecId } from "@launchpad/db";
import { projectSpecsDir } from "@launchpad/pipeline";
import { getDb } from "./db";
import { listSpecs, parseSpecSummary, type SpecSummary } from "./specs";
import { projectSlugForSpec, PLATFORM_PROJECT_SLUG } from "./spec-project";

export interface LocatedSpec {
  summary: SpecSummary;
  projectSlug: string;
  /** Where it was found — recorded so a wrong resolution is diagnosable
   * (VERIFICATION #9: record the distinguishing fact). `checkout` is a spec a
   * project CHAT wrote into its own checkout (spec 0140) before any run has
   * projected it into `spec_files`. */
  source: "file" | "row" | "checkout";
  /** The drafting chat's thread id, when the spec came from a row that has
   * one (spec 0135: how a run started from ANY button finds its branch). */
  chatId: string | null;
}

export async function locateSpec(
  specId: string,
  /**
   * The project the caller already knows this spec belongs to (the Specs tab
   * and the chat both do). Spec 0142: **a spec is identified by (project,
   * specId), never by specId alone.** Every project numbers its specs from
   * 0001, so an unscoped lookup for "0001" matches THIS repo's
   * `0001-launchpad-foundations.md` and resolves a customer's run to the
   * platform — which is exactly how the first A/B start failed
   * ("El proyecto platform no tiene repositorio vinculado").
   */
  projectSlug?: string,
): Promise<LocatedSpec | null> {
  if (projectSlug && projectSlug !== PLATFORM_PROJECT_SLUG) {
    return locateInProject(specId, projectSlug);
  }
  const fromFiles = (await listSpecs().catch(() => [])).find((s) => s.id === specId);
  if (fromFiles) {
    return {
      summary: fromFiles,
      projectSlug: projectSlugForSpec(fromFiles.tenant),
      source: "file",
      chatId: null,
    };
  }
  try {
    const row = await specFileBySpecId(getDb(), specId);
    if (row) {
      return {
        summary: parseSpecSummary(row.name, row.body),
        projectSlug: row.projectSlug,
        source: "row",
        chatId: row.chatId ?? null,
      };
    }
  } catch {
    // Fall through to the checkout scan — a DB blip must not hide a spec that
    // exists on disk.
  }
  return locateInProjectSpecsDirs(specId);
}

/**
 * Spec 0140's consequence: a project chat WRITES its spec straight into the
 * checkout, and no `spec_files` row exists until a run projects one. Without
 * this, the Start button cannot see a spec the user just watched get written —
 * so the checkout is the third place "find a spec" looks.
 *
 * The file is authoritative when present; the row remains the durable record
 * (spec 0129: the file is git-excluded, so a lost checkout needs the row).
 */
async function locateInProjectSpecsDirs(specId: string): Promise<LocatedSpec | null> {
  let slugs: string[] = [];
  try {
    const { listProjects } = await import("@launchpad/db");
    slugs = (await listProjects(getDb()))
      .filter((p) => p.kind !== "platform")
      .map((p) => p.slug);
  } catch {
    return null;
  }
  return locateAcross(specId, slugs);
}

/**
 * Spec 0142: resolve a spec WITHIN one known project — the row first (durable
 * record), then its specs directory (what a chat just wrote). Never consults
 * this repo's own `specs/`, which is the whole point: the platform's spec
 * numbers overlap every project's.
 */
async function locateInProject(specId: string, slug: string): Promise<LocatedSpec | null> {
  try {
    const row = await specFileBySpecId(getDb(), specId, slug);
    if (row) {
      return {
        summary: parseSpecSummary(row.name, row.body),
        projectSlug: row.projectSlug,
        source: "row",
        chatId: row.chatId ?? null,
      };
    }
  } catch {
    // A DB blip must not hide a spec that exists on disk.
  }
  return locateAcross(specId, [slug]);
}

async function locateAcross(specId: string, slugs: string[]): Promise<LocatedSpec | null> {
  for (const slug of slugs) {
    try {
      // Spec 0141: outside the checkout, where git cannot reach it.
      const dir = projectSpecsDir(slug);
      const match = (await readdir(dir)).find(
        (f) => f.endsWith(".md") && f.startsWith(`${specId}-`),
      );
      if (!match) continue;
      const body = await readFile(path.join(dir, match), "utf8");
      return {
        summary: parseSpecSummary(match, body),
        projectSlug: slug,
        source: "checkout",
        chatId: null,
      };
    } catch {
      // No checkout / no specs dir for this project — normal, keep looking.
    }
  }
  return null;
}
