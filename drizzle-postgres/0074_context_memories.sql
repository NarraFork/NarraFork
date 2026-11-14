CREATE TABLE "context_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"project_id" text,
	"narrator_id" text,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_narrator_id" text,
	"source_message_id" text,
	"created_by_kind" text NOT NULL,
	"confirmed_at" text,
	"expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "context_memory_scope" CHECK (("scope" = 'user' and "scope_key" = 'user' and "project_id" is null and "narrator_id" is null) or ("scope" = 'project' and "project_id" is not null and "scope_key" = 'project:' || "project_id" and "narrator_id" is null) or ("scope" = 'session' and "narrator_id" is not null and "scope_key" = 'session:' || "narrator_id" and "project_id" is null)),
	CONSTRAINT "context_memory_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "context_memory_events" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_memories" ADD CONSTRAINT "context_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_memories" ADD CONSTRAINT "context_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_memories" ADD CONSTRAINT "context_memories_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_memory_events" ADD CONSTRAINT "context_memory_events_memory_id_context_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."context_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_memory_events" ADD CONSTRAINT "context_memory_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_context_memory_key" ON "context_memories" USING btree ("owner_user_id","scope_key","key");--> statement-breakpoint
CREATE INDEX "idx_context_memory_recall" ON "context_memories" USING btree ("owner_user_id","scope_key","status","id");--> statement-breakpoint
CREATE INDEX "idx_context_memory_project" ON "context_memories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_context_memory_narrator" ON "context_memories" USING btree ("narrator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_context_memory_event_version" ON "context_memory_events" USING btree ("memory_id","version");