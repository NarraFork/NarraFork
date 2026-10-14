CREATE TABLE "legacy_retained_history_manifests" (
	"migration_project_id" text PRIMARY KEY NOT NULL,
	"manifest_json" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_narrator_workspace_adoptions" ADD COLUMN "proof_mode" text DEFAULT 'empty' NOT NULL;--> statement-breakpoint
ALTER TABLE "legacy_narrator_workspace_adoptions" ADD COLUMN "origin_json" text;--> statement-breakpoint
ALTER TABLE "legacy_retained_history_manifests" ADD CONSTRAINT "legacy_retained_history_manifests_migration_proje_26801ed8ca_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE restrict ON UPDATE no action;