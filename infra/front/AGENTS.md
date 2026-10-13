# AGENTS.md — how to work in this repository

This project's site and its Odoo backend were provisioned by the company. This file is
the convention file coding agents read before touching anything (the `AGENTS.md`
standard); a session that skips it re-derives all of this from scratch, badly.

## What this repository is

A Next.js app (App Router) that serves the business's public site and reads its
own Odoo instance. It is deployed as a container built from the `Dockerfile` at
the root; there is no separate build server.

- `app/site.ts` — **the business's own facts**: name, giro, processes, brand
  note, and anything else about *this* business. Generated once from the intake
  answers and committed, so from that moment it is yours to edit.
- `app/components/` — **presentation**. One component per section.
- `app/page.tsx` — **composition only**. It imports components and orders them.
- `app/odoo.ts` + `app/components/EstadoOdoo.tsx` — the live read from this
  project's own Odoo. Leave them alone unless the change is about Odoo itself.

## Rules

1. **Data in `site.ts`, presentation in `app/components/`.** A change to what the
   site SAYS edits the data; a change to how it LOOKS edits a component. Do not
   inline business facts into a component.
2. **A new section is two edits, not one.** Create the component *and* mount it
   in `app/page.tsx`. A component that exists and is never rendered is dead code
   that compiles, passes CI, and ships nothing — it has happened here before.
3. **Keep the visual language.** Dark card `#11161d`, border `#1d242d`, muted
   text `#7d8590`, small uppercase section headings. Match the existing sections
   rather than introducing a new style per section.
4. **An empty section renders nothing.** If its data is missing, return `null` —
   the way `Servicios` does with no processes.
5. **`npm run build` must pass.** That is the same build the deploy runs; if it
   is red, the site does not update.
6. **Do not touch the deploy.** `Dockerfile`, `docker-compose.yml` and the
   hosting are managed by the company's pipeline.
