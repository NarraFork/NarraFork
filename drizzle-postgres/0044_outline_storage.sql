CREATE TABLE "outline_block_versions" (
	"block_id" text NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer,
	"commit_id" text NOT NULL,
	"page_id" text NOT NULL,
	"parent_id" text,
	"order_key" text NOT NULL,
	"content" text,
	"task_json" text,
	"alias" text,
	"content_hash" text NOT NULL,
	"change_flags" integer NOT NULL,
	"deleted" boolean NOT NULL,
	CONSTRAINT "outline_block_versions_block_id_from_seq_pk" PRIMARY KEY("block_id","from_seq")
);
--> statement-breakpoint
CREATE TABLE "outline_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"sid" text NOT NULL,
	"parent_id" text,
	"page_id" text NOT NULL,
	"order_key" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"alias" text,
	"task_json" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"version_seq" integer NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outline_commits" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"responsible_user_id" text,
	"narrator_id" text,
	"message_id" text,
	"tool_call_id" text,
	"created_at" text NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outline_links" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"from_block_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer
);
--> statement-breakpoint
CREATE TABLE "outline_live_updates" (
	"page_block_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"update_b64" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "outline_live_updates_page_block_id_epoch_seq_pk" PRIMARY KEY("page_block_id","epoch","seq")
);
--> statement-breakpoint
CREATE TABLE "outline_spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" text,
	"narrator_id" text,
	"owner_user_id" text,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outline_view_state" (
	"user_id" text NOT NULL,
	"page_block_id" text NOT NULL,
	"collapsed_json" text DEFAULT '[]'::text NOT NULL,
	"layout" text DEFAULT 'right' NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "outline_view_state_user_id_page_block_id_pk" PRIMARY KEY("user_id","page_block_id")
);
--> statement-breakpoint
ALTER TABLE "outline_block_versions" ADD CONSTRAINT "outline_block_versions_block_id_outline_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_block_versions" ADD CONSTRAINT "outline_block_versions_commit_id_outline_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."outline_commits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_blocks" ADD CONSTRAINT "outline_blocks_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_commits" ADD CONSTRAINT "outline_commits_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_links" ADD CONSTRAINT "outline_links_from_block_id_outline_blocks_id_fk" FOREIGN KEY ("from_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_live_updates" ADD CONSTRAINT "outline_live_updates_page_block_id_outline_blocks_id_fk" FOREIGN KEY ("page_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD CONSTRAINT "outline_spaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD CONSTRAINT "outline_spaces_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD CONSTRAINT "outline_spaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_view_state" ADD CONSTRAINT "outline_view_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_view_state" ADD CONSTRAINT "outline_view_state_page_block_id_outline_blocks_id_fk" FOREIGN KEY ("page_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_versions_page_range" ON "outline_block_versions" USING btree ("page_id","from_seq","to_seq");--> statement-breakpoint
CREATE INDEX "idx_outline_versions_commit" ON "outline_block_versions" USING btree ("commit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_blocks_space_sid" ON "outline_blocks" USING btree ("space_id","sid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_blocks_space_alias" ON "outline_blocks" USING btree ("space_id","alias") WHERE "alias" IS NOT NULL AND "deleted" = FALSE;--> statement-breakpoint
CREATE INDEX "idx_outline_blocks_page" ON "outline_blocks" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_outline_blocks_children" ON "outline_blocks" USING btree ("space_id","parent_id","order_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_commits_space_seq" ON "outline_commits" USING btree ("space_id","seq");--> statement-breakpoint
CREATE INDEX "idx_outline_commits_space_narrator" ON "outline_commits" USING btree ("space_id","narrator_id","seq");--> statement-breakpoint
CREATE INDEX "idx_outline_links_from" ON "outline_links" USING btree ("from_block_id","to_seq");--> statement-breakpoint
CREATE INDEX "idx_outline_links_target" ON "outline_links" USING btree ("target_kind","target_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_spaces_key" ON "outline_spaces" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_spaces_project" ON "outline_spaces" USING btree ("project_id") WHERE "kind" = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_spaces_personal" ON "outline_spaces" USING btree ("owner_user_id") WHERE "kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_spaces_session" ON "outline_spaces" USING btree ("narrator_id") WHERE "kind" = 'session';--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_project" ON "outline_spaces" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_narrator" ON "outline_spaces" USING btree ("narrator_id");--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_owner" ON "outline_spaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_outline_view_state_page" ON "outline_view_state" USING btree ("page_block_id");