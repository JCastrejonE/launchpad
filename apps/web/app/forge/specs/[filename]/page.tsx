/**
 * `/forge/specs/<filename|id>` — now a redirect to THE spec page (spec 0149).
 *
 * The owner: *"launchpad is treating specs differently than other projects, every
 * project should use the same layout/routes."* It did, because this page
 * existed: the platform's specs had a stepper, gate buttons, Start and Complete
 * here, and every other project's had a plain read-only view. The whole surface
 * moved to `/projects/<slug>/specs/<id>`, which serves EVERY project including
 * this one, so what is left here is the redirect that keeps existing links,
 * bookmarks and the run-start redirect target working.
 *
 * `?error=` is carried through: `app/forge/specs/[filename]/actions.ts` (still
 * the chat's `GateActionButtons` server action) reports failures by redirecting
 * back here with one, and dropping it would silently swallow the message.
 */
import { redirect } from "next/navigation";
import { isSafeSpecFilename, isSafeSpecId } from "../../../../lib/specs";
import { PLATFORM_PROJECT_SLUG } from "../../../../lib/spec-project";

export default async function SpecDetailRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ filename: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { filename: raw } = await params;
  const { error } = await searchParams;
  // Both shapes this route has always accepted: `NNNN-slug.md` (every link in
  // the app) and a bare `NNNN` (the redirect target of a just-started tenant
  // run, whose spec file may not exist yet — spec 0027). The destination is
  // keyed by id, so both collapse to the same place.
  const ok = raw.endsWith(".md") ? isSafeSpecFilename(raw) : isSafeSpecId(raw);
  if (!ok) redirect("/forge/specs");
  const specId = raw.endsWith(".md")
    ? (raw.match(/^(\d+)/)?.[1] ?? raw.replace(/\.md$/, ""))
    : raw;
  const query = error ? `?error=${encodeURIComponent(error)}` : "";
  redirect(`/projects/${PLATFORM_PROJECT_SLUG}/specs/${specId}${query}`);
}
