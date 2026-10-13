"use client"

import { useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import type { Health } from "@/lib/mock-data"
import { chromeInitials, type ChromeUser } from "@/lib/chrome-user"
import { signOutAction } from "../app/login/actions"
import { PendingQuestionsChip } from "./PendingQuestionsChip"
import { Command, User } from "lucide-react"

// ── Health / status pill ─────────────────────────────────────────────────
const HEALTH_MAP: Record<Health, { label: string; color: string; dot: string }> = {
  operational: { label: "Operativo", color: "text-brand", dot: "bg-brand" },
  building: { label: "Construyendo", color: "text-cyan", dot: "bg-cyan" },
  degraded: { label: "Degradado", color: "text-amber", dot: "bg-amber" },
  down: { label: "Caído", color: "text-rose", dot: "bg-rose" },
  sleeping: { label: "Dormido", color: "text-faint", dot: "bg-faint" },
}

export function StatusPill({ status, live }: { status: Health; live?: boolean }) {
  const h = HEALTH_MAP[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] tracking-wide">
      <span className={`h-1.5 w-1.5 rounded-full ${h.dot} ${live ? "mc-live-dot" : ""}`} />
      <span className={h.color}>{h.label}</span>
    </span>
  )
}

export function Dot({ status, live }: { status: Health; live?: boolean }) {
  const h = HEALTH_MAP[status]
  return <span className={`h-2 w-2 rounded-full ${h.dot} ${live ? "mc-live-dot" : ""}`} />
}

// ── Section label ────────────────────────────────────────────────────────
export function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-faint text-[11px] uppercase tracking-[0.2em] mb-3">{children}</p>
}

// ── Card ─────────────────────────────────────────────────────────────────
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: React.ReactNode
  className?: string
  hover?: boolean
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-card ${
        hover ? "transition-colors hover:border-border-strong hover:bg-card-hover" : ""
      } ${className}`}
    >
      {children}
    </div>
  )
}

// ── Top bar (shared header) ──────────────────────────────────────────────
/** `user` is REQUIRED and may be null (spec 0209): null means SIGNED OUT and renders
 * a neutral glyph, never invented initials. Required rather than optional so a call
 * site that forgets it fails `tsc` instead of quietly rendering a generic avatar
 * (CLAUDE.md verification rule #12). */
export function TopBar({
  crumbs,
  user,
}: {
  crumbs?: { label: string; href?: string }[]
  user: ChromeUser | null
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-5">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-brand/40 bg-brand/10">
            <Command className="h-4 w-4 text-brand" />
          </span>
          <span className="hidden sm:flex items-baseline gap-1.5">
            <span className="text-sm font-semibold tracking-tight text-foreground">Mission Control</span>
            <span className="text-[10px] text-faint">by the company</span>
          </span>
        </Link>

        {crumbs && (
          <nav className="flex items-center gap-1.5 text-xs text-muted overflow-hidden">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5 truncate">
                <span className="text-faint">/</span>
                {c.href ? (
                  <Link href={c.href} className="hover:text-foreground truncate">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-foreground truncate">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-3">
          {/* Spec 0220: a run parked on an AskUserQuestion, visible on every
              screen. Renders nothing unless one is actually pending, and only
              for a signed-in user — the route answers `[]` without a session,
              so polling a login page would be pure noise. */}
          {user && <PendingQuestionsChip />}
          <div className="hidden md:flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-faint">
            <span className="mc-cursor text-brand">▍</span>
            <span>⌘K para comandos</span>
          </div>
          {user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={`Cuenta: ${user.email}`}
                aria-expanded={menuOpen}
                className="grid h-8 w-8 place-items-center rounded-full border border-border bg-surface text-[11px] text-brand hover:border-border-strong"
              >
                {chromeInitials(user)}
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-10 w-60 rounded-lg border border-border bg-card p-3.5 shadow-xl">
                  <p className="truncate text-[13px] text-foreground">{user.email}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.15em] text-faint">{user.role}</p>
                  <form action={signOutAction} className="mt-3.5">
                    <Btn type="submit" className="w-full justify-center">
                      Cerrar sesión
                    </Btn>
                  </form>
                </div>
              )}
            </div>
          ) : (
            <span
              aria-label="Sin sesión"
              className="grid h-8 w-8 place-items-center rounded-full border border-dashed border-border text-faint"
            >
              <User className="h-4 w-4" />
            </span>
          )}
        </div>
      </div>
    </header>
  )
}

// ── Buttons ──────────────────────────────────────────────────────────────
export function Btn({
  children,
  variant = "default",
  className = "",
  ...props
}: {
  children: React.ReactNode
  variant?: "default" | "primary" | "ghost" | "danger"
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    default: "border border-border bg-surface text-foreground hover:border-border-strong hover:bg-card-hover",
    primary: "border border-brand/50 bg-brand/15 text-brand hover:bg-brand/25",
    ghost: "text-muted hover:text-foreground hover:bg-card-hover",
    danger: "border border-rose/40 bg-rose/10 text-rose hover:bg-rose/20",
  }[variant]
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function LogoMark() {
  return <Image src="/logo.png" alt="Launchpad" width={110} height={18} className="h-6 w-auto opacity-90" />
}
