import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Spec 0080 (C.1): the Mission Control mockup shell replaces the bespoke
// NavBar/glow/shell layout (ADR-010/017 bespoke design system is off-roadmap
// per CLAUDE.md — the template mockup supersedes it). Each page renders its own
// `TopBar` (components/ui.tsx). `class="dark"` is forced (the mockup is a
// dark-only terminal aesthetic) — this also keeps the retained legacy surfaces
// (/login, /forge, /specs) readable via their `.dark` design tokens until C.3
// retires them. The old light/dark toggle + THEME_INIT are dropped with NavBar.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mission Control · Launchpad",
  description:
    "Launchpad maestro de la empresa — orquestación de proyectos Odoo, agentes y despliegues.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#08090c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`dark ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
