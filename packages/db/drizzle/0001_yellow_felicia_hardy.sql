CREATE TYPE "public"."health" AS ENUM('operational', 'degraded', 'down', 'building');--> statement-breakpoint
CREATE TYPE "public"."project_kind" AS ENUM('odoo', 'odoo_next', 'custom', 'platform');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "project_kind" NOT NULL,
	"client" text NOT NULL,
	"domain" text,
	"health" "health" DEFAULT 'operational' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"accent" text DEFAULT '' NOT NULL,
	"stack" text[] DEFAULT '{}' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"vps_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "spec_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" uuid,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"provider" text DEFAULT 'hostinger' NOT NULL,
	"external_id" text NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"docker" boolean DEFAULT false NOT NULL,
	"status" "health" DEFAULT 'operational' NOT NULL,
	"assigned_to" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_files" ADD CONSTRAINT "spec_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;