CREATE TABLE "narrator_worktree_resource_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"migration_project_id" text NOT NULL,
	"source_chapter_id" text NOT NULL,
	"narrator_id" text,
	"owner_user_id" text,
	"state" text DEFAULT 'unresolved' NOT NULL,
	"ownership_revision" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "ck_worktree_resource_claim_revision" CHECK ("ownership_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "narrator_worktree_resource_origins" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"migration_project_id" text NOT NULL,
	"source_chapter_id" text NOT NULL,
	"device_id" text NOT NULL,
	"common_directory_path" text NOT NULL,
	"git_admin_directory_path" text NOT NULL,
	"evidence_json" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "ck_worktree_origin_evidence_bytes" CHECK (octet_length("evidence_json") <= 16384)
);
--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_claims" ADD CONSTRAINT "narrator_worktree_resource_claims_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_claims" ADD CONSTRAINT "narrator_worktree_resource_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_claims" ADD CONSTRAINT "narrator_worktree_resource_claims_resource_id_nar_ae30272eb2_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_claims" ADD CONSTRAINT "narrator_worktree_resource_claims_migration_proje_6711728038_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_origins" ADD CONSTRAINT "narrator_worktree_resource_origins_resource_id_na_2f08217b36_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resource_origins" ADD CONSTRAINT "narrator_worktree_resource_origins_migration_proj_57b5eb2ac5_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worktree_resource_claim_user" ON "narrator_worktree_resource_claims" USING btree ("resource_id","narrator_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_claim_migration" ON "narrator_worktree_resource_claims" USING btree ("migration_project_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_claim_chapter" ON "narrator_worktree_resource_claims" USING btree ("source_chapter_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_claim_narrator" ON "narrator_worktree_resource_claims" USING btree ("narrator_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_claim_owner" ON "narrator_worktree_resource_claims" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_origin_migration" ON "narrator_worktree_resource_origins" USING btree ("migration_project_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_origin_chapter" ON "narrator_worktree_resource_origins" USING btree ("source_chapter_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_origin_common" ON "narrator_worktree_resource_origins" USING btree ("device_id","common_directory_path");--> statement-breakpoint
CREATE INDEX "idx_worktree_origin_admin" ON "narrator_worktree_resource_origins" USING btree ("device_id","git_admin_directory_path");