/**
 * Mission Control navbar for the spec detail page (spec 0122).
 *
 * The owner: *"Fix that spec page to have the mission control navbar as well."* It rendered
 * zero `TopBar` before, which is why arriving here from a workspace felt like leaving
 * the application.
 *
 * A LAYOUT rather than an edit to the page: `page.tsx` has several return paths
 * (drafting, degraded/Temporal-down, normal), and a layout wraps all of them at once
 * — one file instead of the same three lines in four places, and no new way for one
 * branch to drift from the others.
 *
 * The crumb points back at the OWNING project, computed with the same
 * `projectSlugForSpec` mapping the Specs tab filters by, so "back" lands where you
 * came from. Any failure to read the spec degrades to the generic Specs crumb rather
 * than throwing — a breadcrumb must never be able to 500 a page that renders fine.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TopBar } from "@/components/ui";
import { sessionChromeUser } from "../../../chrome-user";
import { parseFrontmatter, specsDir, isSafeSpecFilename } from "@/lib/specs";
import { projectSlugForSpec } from "@/lib/spec-project";

async function crumbsFor(filename: string) {
  const base = [{ label: "Proyectos", href: "/" }];
  try {
    if (!isSafeSpecFilename(filename)) return [...base, { label: "Spec" }];
    const md = await readFile(path.join(specsDir(), filename), "utf8");
    const fm = parseFrontmatter(md);
    const slug = projectSlugForSpec(fm["tenant"]);
    return [
      ...base,
      { label: slug, href: `/projects/${slug}` },
      { label: `spec ${fm["id"] || filename}` },
    ];
  } catch {
    return [...base, { label: "Specs", href: "/forge/specs" }];
  }
}

export default async function SpecDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ filename: string }>;
}) {
  const { filename } = await params;
  const user = await sessionChromeUser();
  return (
    <div className="min-h-screen">
      <TopBar crumbs={await crumbsFor(decodeURIComponent(filename))} user={user} />
      <main className="mx-auto max-w-[1400px] px-5 pb-24 pt-8">{children}</main>
    </div>
  );
}
