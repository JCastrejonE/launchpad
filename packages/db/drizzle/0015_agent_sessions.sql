-- Spec 0194: one row per spawned agent session.
--
-- `agent_runs` holds ONE row per workflow, so "how many coder sessions does a
-- run take, and what does it cost?" — the question that decides whether the
-- initializer/coder split earns its keep — could not be answered from our own
-- database. The only record was `[session]` lines in a worker journal that
-- rotates, and prose in handoff logs.
--
-- Deliberately arithmetic only: no prompts, no handoff text, no content. The
-- audit-log rule (spec 0075) applies here for the same reason, and every
-- question we have is a count or a duration.
CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Temporal workflow this session ran inside. NOT unique: that is the
  -- whole point — many sessions per run.
  "workflow_id" text NOT NULL,
  "spec_id" text NOT NULL DEFAULT '',
  -- Null for platform runs, which have no project row.
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "role" text NOT NULL,
  "model" text NOT NULL DEFAULT '',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz NOT NULL DEFAULT now(),
  "seconds" integer NOT NULL DEFAULT 0,
  "turns" integer NOT NULL DEFAULT 0,
  -- Undefined on a subscription plan; recorded because the SDK reports it, and
  -- never shown as though it were a bill (spec 0194 out-of-scope).
  "cost_usd" numeric(10, 4),
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "ok" boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS "agent_sessions_workflow_idx"
  ON "agent_sessions" ("workflow_id", "started_at");
