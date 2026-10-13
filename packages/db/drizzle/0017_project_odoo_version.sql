-- Spec 0205 A2: say which Odoo each project runs, instead of inferring it.
--
-- `projects.version` has existed since the table did and NOTHING ever wrote it:
-- verified 2026-08-15, all 10 rows blank. Provisioning read that blank through
-- `provisionOdooVersion` / `odooVersionForProject` and returned 18 — so a blank
-- meant "18" and equally meant "nobody was asked", and the two were
-- indistinguishable. `/new` now asks, which only helps NEW projects; this closes
-- the existing ones.
--
-- 18 is not a guess. Every tenant container on the fleet box (203.0.113.20)
-- reports image `odoo:18` — autopartes, barberia-norte, cafeteria,
-- floreria-bella, gaming-tech, panaderia, sushi, veterinaria, plus the two
-- branch stagings. The ninth Odoo row, `client-b`, has no stack directory and
-- no container: it was never deployed, and the code path that would deploy it
-- returned 18 for a blank version, so 18 is also what it was about to get.
--
-- Deliberately NOT touched: `platform` (this repo — it runs no Odoo, and a
-- version there would be a fact about nothing) and any future row that arrives
-- blank, which the fallback still handles.
UPDATE "projects"
   SET "version" = '18'
 WHERE "version" = ''
   AND "kind" IN ('odoo', 'odoo_next');
