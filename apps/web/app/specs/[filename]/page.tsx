// Spec 0038 (item 3): spec detail moved to `/forge/specs/[filename]`. This
// stub 308-redirects old bookmarks/links there, preserving the filename.
import { permanentRedirect } from "next/navigation";

export default async function SpecDetailRedirect({
  params,
}: {
  params: Promise<{ filename: string }>;
}) {
  const { filename } = await params;
  permanentRedirect(`/forge/specs/${filename}`);
}
