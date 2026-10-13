/**
 * /login (spec 0073) — the Credentials sign-in surface. Server component:
 * reads the session to show a signed-in state, renders the `?error=` panel
 * from the login action. Spec 0101 restyled it onto the Mission Control
 * template: the input idiom is lifted verbatim from the already-aligned
 * /new + /connect screens so every field in the app looks the same.
 */
import { auth } from "../auth";
import { githubLoginAction, signOutAction } from "./actions";
import { Card, Btn } from "../../components/ui";

/** Field label + input, matching the already-aligned /new and /connect screens. */
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";
const INPUT =
  "w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground " +
  "placeholder:text-faint outline-none focus:border-brand/40";

export const metadata = { title: "Iniciar sesión — Odoo Launchpad" };

const ERROR_TEXT: Record<string, string> = {
  config: "No se pudo iniciar sesión — el backend de autenticación está mal configurado o no responde.",
  // Spec 0128 B: a refusal by the admission gate is a NORMAL outcome, not a
  // misconfiguration, and the message must not reveal whether the address is
  // authorised — that would make sign-in an oracle for who works here.
  notauthorized:
    "Esa cuenta de GitHub no tiene acceso. Pide a un administrador que te autorice y vuelve a intentarlo.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  const { error } = await searchParams;
  const errorText = error ? (ERROR_TEXT[error] ?? ERROR_TEXT["config"]) : null;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-10">
      <div className="mb-6">
        <p className="text-xs font-semibold text-faint">Acceso</p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">Iniciar sesión</h1>
        <p className="mt-1.5 max-w-[60ch] text-sm text-muted">
          Para actuar sobre el plano de control necesitas una sesión de propietario.
        </p>
      </div>

      <Card className="max-w-[440px]">
        {session?.user ? (
          <div className="p-5 text-sm text-muted">
            <p className="mb-3.5">
              Sesión iniciada como <strong className="font-semibold text-foreground">{session.user.email}</strong>{" "}
              <span className="ml-1 inline-flex items-center rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-faint">
                {session.user.role}
              </span>
            </p>
            <form action={signOutAction}>
              <Btn type="submit">Cerrar sesión</Btn>
            </form>
          </div>
        ) : (
          <div className="p-5 text-sm text-muted">
            {errorText ? (
              <p
                className="mb-3.5 rounded-lg border border-rose/40 bg-rose/10 px-3 py-2 text-[13px] text-rose"
                role="alert"
              >
                {errorText}
              </p>
            ) : null}
            {/* Spec 0128 B2: GitHub is the ONLY way in. The password form that used
                to live below this was removed in its own deploy, after a real GitHub
                sign-in proved the OWNER's row was claimable (decision 3c). */}
            <form action={githubLoginAction}>
              <Btn type="submit" variant="primary" className="w-full justify-center">
                Continuar con GitHub
              </Btn>
            </form>
            <p className="mt-3.5 text-[11px] text-faint">
              Solo cuentas autorizadas. Si necesitas acceso, pide a un administrador que te agregue.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
