-- Spec 0078: fold chat-store's bootstrap-created forge_threads/forge_messages
-- under Drizzle + add the SPEC §5 project_id link. Hand-edited to be
-- IDEMPOTENT so it ADOPTS the pre-existing tables on the launchpad DB (created
-- by chat-store's `CREATE TABLE IF NOT EXISTS` bootstrap, spec 0067) as well as
-- CREATES them on a fresh DB. forge_threads is created first so forge_messages'
-- FK resolves on a fresh DB; project_id is added via ADD COLUMN IF NOT EXISTS
-- for tables that predate it, and its FK via a guarded DO block.
CREATE TABLE IF NOT EXISTS "forge_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"sdk_session_id" text,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forge_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"events" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_messages_role_check" CHECK ("forge_messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "forge_messages_thread_id_forge_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forge_threads"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "forge_threads" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "forge_threads" ADD CONSTRAINT "forge_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
