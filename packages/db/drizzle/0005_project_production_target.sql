-- Spec 0126: give a Project its production target, so "where does this ship to?"
-- is a stored fact instead of an assumption made at deploy time.
--
-- Exactly two columns, and text rather than an enum. `production_kind` takes
-- 'odoosh' | 'fleet' | 'none' — a CHECK constraint, not a pgEnum, because
-- adding a value to a Postgres enum is a migration while adding one to a CHECK
-- is a migration too but a revertible one, and this vocabulary is young.
--
-- `production_host` is the odoo.sh SSH host (diagnosis only — deploy
-- confirmation reads odoo.sh's own `ci/odoo.sh` commit status via
-- `readOdooShBuild`, spec 0115, and we never deploy to odoo.sh ourselves). For
-- `kind = 'fleet'` the address is the existing `vps_id`, so nothing new is
-- needed there.
--
-- Hand-written and IDEMPOTENT, same discipline as 0002/0003/0004: `ADD COLUMN IF
-- NOT EXISTS` so a re-run is a no-op. NULLABLE with no default, because every
-- existing row predates this and 'none' is the honest reading of a project whose
-- production target was never recorded — writing 'none' into them would claim a
-- decision nobody made.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "production_kind" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "production_host" text;

-- Guard the vocabulary at the boundary the application cannot bypass. NULL is
-- allowed (see above); anything outside the three literals is not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_production_kind_check'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_production_kind_check"
      CHECK ("production_kind" IS NULL OR "production_kind" IN ('odoosh', 'fleet', 'none'));
  END IF;
END $$;
