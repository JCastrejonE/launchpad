# Product

## Register

product

## Platform

web

## Users

The primary audience is external customers who want an outcome — a shipped code
change or a running Odoo tenant — without operating the machinery that produces
it. They arrive through two surfaces that make up one product: Forge, where they
describe the work they want in plain language and a verified pipeline carries it
to real code, and Hangar, where they deploy and manage Odoo tenants across the
VPS fleet. Their context is goal-first, not tool-first: they know what they want
to happen and expect the system to do the heavy lifting while keeping them in
control at the moments that matter. Success is the customer getting a trusted
result — code merged, a tenant live — in as few steps as possible, and trusting
what happened along the way.

## Product Purpose

Turn a description of work into shipped software. Forge is the chat-first code
pipeline: a request in plain language becomes spec-driven, agent-built,
human-gated code. Hangar is the deploy and fleet surface: it stands up and
manages production Odoo tenants across the VPS fleet, and can hand work to Forge.
The product exists to collapse the distance between *saying what you want* and
*having it running*, without asking the customer to assemble config, wrangle
infrastructure, or trust a black box.

## Brand Personality

Fast, modern, effortless. The interface should feel quick and frictionless —
intent in, result out — where the speed itself signals competence. Motion and
responsiveness are how that speed is felt, not decoration layered on afterward.
Because these surfaces face paying customers rather than internal operators, the
craft bar is deliberately above dev-grade: polish and delight are part of the
product, not a finishing garnish. The register underneath stays composed and
trustworthy — this is infrastructure people rely on — so effortless never tips
into flashy.

## Anti-references

Three families to stay clear of. Legacy or enterprise admin: dense gray
Bootstrap-era dashboards, heavy chrome, cluttered toolbars — the classic Odoo
backend look this product is meant to replace. Consumer or playful: rounded
blobs, mascots, candy colors, and bouncy animation read as too casual for
infrastructure people depend on. Crypto or dark-neon maximalism: glowing
gradients, neon-on-black, and glassmorphism everywhere trade trust for spectacle.

## Design Principles

Describe it, ship it. The plain-language front door *is* the product; every
surface should keep the customer in the describe → verify → ship flow rather than
dropping them into forms and config they have to assemble by hand.

Effortless is the feeling to protect. Fewer steps, fast responses, no dead ends.
When the system can infer, decide, or do the work, it should — and let the
customer state intent and steer rather than operate.

Trust through visible verification. These surfaces face outsiders, so the state
of a run, the status of each gate, and what is happening right now must be
legible at a glance. Confidence comes from seeing the work checked and controlled
— human-gated promotion made visible — not from being told to trust it.

Restraint over chrome. The opposite of the legacy admin it replaces: density
with calm. Every element earns its place; nothing decorative that fails to carry
meaning.

Polish is the differentiator. For paying customers, craft — considered motion,
real empty and error states, micro-interactions — is how an infrastructure tool
earns the word premium. It serves effortlessness and trust; it is never spectacle
for its own sake.

## Accessibility & Inclusion

Target WCAG 2.1 AA: body text at ≥4.5:1 contrast (≥3:1 for large text), full
keyboard navigation, visible focus states, and a reduced-motion alternative for
every animation (the base is already in `globals.css`). Both light and dark
themes must meet the bar, not just the dark-first default.
