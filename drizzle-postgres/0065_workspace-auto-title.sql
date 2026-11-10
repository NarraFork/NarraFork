ALTER TABLE "workspaces" ADD COLUMN "title_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "title_revision" integer DEFAULT 0 NOT NULL;