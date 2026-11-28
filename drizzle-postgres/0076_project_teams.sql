CREATE TABLE "project_teams" (
	"narrator_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"base_branch" text NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"settings_json" text DEFAULT '{}'::text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "ck_project_teams_status" CHECK ("status" in ('active', 'archived')),
	CONSTRAINT "ck_project_teams_brief_bytes" CHECK (octet_length("brief") <= 4096),
	CONSTRAINT "ck_project_teams_settings_bytes" CHECK (octet_length("settings_json") <= 16384)
);
--> statement-breakpoint
CREATE TABLE "team_work_events" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"detail_json" text,
	"created_at" text NOT NULL,
	CONSTRAINT "ck_team_work_events_actor_kind" CHECK ("actor_kind" in ('person', 'agent', 'system')),
	CONSTRAINT "ck_team_work_events_detail_bytes" CHECK ("detail_json" is null or octet_length("detail_json") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "team_work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'change' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"branch_name" text,
	"base_ref" text,
	"worktree_resource_id" text,
	"head_sha" text,
	"worker_narrator_id" text,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"last_review" text,
	"changed_paths_json" text,
	"changed_paths_at_sha" text,
	"exclusive_key" text,
	"outline_space_id" text,
	"outline_block_id" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "ck_team_work_items_state" CHECK ("state" in ('queued', 'in_progress', 'in_review', 'ready', 'merged', 'cancelled')),
	CONSTRAINT "ck_team_work_items_last_review" CHECK ("last_review" is null or "last_review" in ('blocker', 'clear')),
	CONSTRAINT "ck_team_work_items_review_rounds" CHECK ("review_rounds" >= 0),
	CONSTRAINT "ck_team_work_items_changed_paths_bytes" CHECK ("changed_paths_json" is null or octet_length("changed_paths_json") <= 131072)
);
--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_events" ADD CONSTRAINT "team_work_events_work_item_id_team_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."team_work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_events" ADD CONSTRAINT "team_work_events_team_id_project_teams_narrator_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."project_teams"("narrator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_items" ADD CONSTRAINT "team_work_items_team_id_project_teams_narrator_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."project_teams"("narrator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_items" ADD CONSTRAINT "team_work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_items" ADD CONSTRAINT "team_work_items_worker_narrator_id_narrators_id_fk" FOREIGN KEY ("worker_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_items" ADD CONSTRAINT "team_work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_items" ADD CONSTRAINT "team_work_items_worktree_resource_id_narrator_wor_27df0f6fdd_fk" FOREIGN KEY ("worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_teams_project_status" ON "project_teams" USING btree ("project_id","status","narrator_id");--> statement-breakpoint
CREATE INDEX "idx_project_teams_created_by" ON "project_teams" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_team_work_events_team_created" ON "team_work_events" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_team_work_events_item_created" ON "team_work_events" USING btree ("work_item_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_team_work_items_team_state" ON "team_work_items" USING btree ("team_id","state","id");--> statement-breakpoint
CREATE INDEX "idx_team_work_items_project_state" ON "team_work_items" USING btree ("project_id","state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_team_work_items_exclusive" ON "team_work_items" USING btree ("project_id","exclusive_key") WHERE "exclusive_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_team_work_items_worktree" ON "team_work_items" USING btree ("worktree_resource_id");--> statement-breakpoint
CREATE INDEX "idx_team_work_items_worker" ON "team_work_items" USING btree ("worker_narrator_id");--> statement-breakpoint
CREATE INDEX "idx_team_work_items_created_by" ON "team_work_items" USING btree ("created_by");