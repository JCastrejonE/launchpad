"use client";

/**
 * Add a member, and remove one (spec 0128 E). Client halves of `MembersPanel`.
 *
 * These render only for someone the server already decided may manage members —
 * but the actions they call re-check that themselves, because hiding a form is not
 * a permission and a server action is a public POST endpoint.
 *
 * Errors are shown verbatim from the action: they are written to be read by a
 * person ("no tiene cuenta todavía", "no puedes quitar al último dueño") and
 * replacing them with a generic failure would throw away the only part that tells
 * someone what to do next.
 *
 * `AddMemberForm` deliberately does NOT list the members. It did in the first
 * version, and a screenshot of the live page showed every member twice — once in
 * the panel's list with its role badge, once here with a remove link. The list
 * belongs to the panel; removal belongs on the row of the person being removed.
 */
import { useState, useTransition } from "react";
import { Btn, Card } from "../../../components/ui";
import { addProjectMemberAction, removeProjectMemberAction } from "./members-actions";

const INPUT =
  "w-full rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] text-foreground " +
  "placeholder:text-faint outline-none focus:border-brand/40";

export function AddMemberForm({ slug }: { slug: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    startTransition(async () => {
      const res = await addProjectMemberAction(slug, email, role);
      if (!res.ok) {
        setError(res.problem ?? "No se pudo agregar.");
        return;
      }
      // The panel is a server component; `revalidatePath` in the action refreshes
      // its list, so there is no client-side copy of the members to keep in sync.
      setEmail("");
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <p className="text-[11px] uppercase tracking-widest text-faint">Agregar miembro</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={INPUT}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="persona@example.com"
          type="email"
          aria-label="Correo del miembro"
        />
        <select
          className={`${INPUT} sm:w-40`}
          value={role}
          onChange={(e) => setRole(e.target.value === "owner" ? "owner" : "member")}
          aria-label="Rol"
        >
          <option value="member">Miembro</option>
          <option value="owner">Dueño</option>
        </select>
        <Btn
          variant="primary"
          onClick={add}
          className={pending || !email.trim() ? "pointer-events-none opacity-50" : ""}
        >
          {pending ? "…" : "Agregar"}
        </Btn>
      </div>
      <p className="text-[11px] text-faint">
        La persona ya debe tener una cuenta autorizada. Verificamos su acceso al repositorio cuando
        intente hacer algo, no al agregarla — así puede ver el proyecto mientras lo solicita.
      </p>
      {error ? (
        <p className="rounded-lg border border-rose/30 bg-rose/[0.06] px-3 py-2 text-[12.5px] text-rose" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/** Remove, on the row of the person being removed — the only place it reads
 * unambiguously. A refusal (the last owner) surfaces where the click happened. */
export function RemoveMemberButton({ slug, email }: { slug: string; email: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-[11px] text-rose">{error}</span> : null}
      <button
        type="button"
        className="text-[11px] text-faint hover:text-rose disabled:opacity-40"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await removeProjectMemberAction(slug, email);
            if (!res.ok) setError(res.problem ?? "No se pudo quitar.");
          })
        }
      >
        {pending ? "…" : "quitar"}
      </button>
    </span>
  );
}
