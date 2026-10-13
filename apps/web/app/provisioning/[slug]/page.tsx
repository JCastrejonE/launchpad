/**
 * Follow view for an odoo-next provisioning run (spec 0161 F3b). `/new` redirects
 * here right after `startProvisioningAction`. Thin server page: the whole app is
 * session-gated in middleware and the polled `GET /api/provisioning/[slug]` is
 * membership-gated, so this only frames the client stepper.
 */
import { TopBar } from "../../../components/ui";
import { sessionChromeUser } from "../../chrome-user";
import { ProvisioningFollow } from "../../../components/provisioning/ProvisioningFollow";

export default async function ProvisioningPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await sessionChromeUser();
  return (
    <div className="min-h-screen mc-grid-bg">
      <TopBar crumbs={[{ label: "Nuevo", href: "/new" }, { label: slug }]} user={user} />
      <main className="mx-auto flex max-w-[1400px] justify-center px-5 py-10">
        <ProvisioningFollow slug={slug} />
      </main>
    </div>
  );
}
