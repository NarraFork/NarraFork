CREATE TABLE "legacy_migration_artifact_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"migration_project_id" text NOT NULL,
	"source_chapter_id" text NOT NULL,
	"narrator_id" text,
	"owner_user_id" text,
	"kind" text NOT NULL,
	"device_id" text NOT NULL,
	"workspace_path" text NOT NULL,
	"artifact_path" text NOT NULL,
	"shadow_key" text,
	"latest_snapshot_commit_sha" text,
	"identity_json" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_retained_chapter_metadata" (
	"source_chapter_id" text PRIMARY KEY NOT NULL,
	"migration_project_id" text NOT NULL,
	"metadata_json" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_migration_artifact_claims" ADD CONSTRAINT "legacy_migration_artifact_claims_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_migration_artifact_claims" ADD CONSTRAINT "legacy_migration_artifact_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_migration_artifact_claims" ADD CONSTRAINT "legacy_migration_artifact_claims_migration_projec_b28dec6be6_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_migration_artifact_claims" ADD CONSTRAINT "legacy_migration_artifact_claims_source_chapter_i_11d67d91bb_fk" FOREIGN KEY ("source_chapter_id") REFERENCES "public"."legacy_retained_chapter_metadata"("source_chapter_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_retained_chapter_metadata" ADD CONSTRAINT "legacy_retained_chapter_metadata_migration_projec_a2c4dbd682_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_workspace" ON "legacy_migration_artifact_claims" USING btree ("device_id","workspace_path","state");--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_shadow_key" ON "legacy_migration_artifact_claims" USING btree ("shadow_key","state");--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_path" ON "legacy_migration_artifact_claims" USING btree ("artifact_path","state");--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_chapter" ON "legacy_migration_artifact_claims" USING btree ("source_chapter_id","state");--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_narrator" ON "legacy_migration_artifact_claims" USING btree ("narrator_id");--> statement-breakpoint
CREATE INDEX "idx_legacy_artifact_migration" ON "legacy_migration_artifact_claims" USING btree ("migration_project_id");