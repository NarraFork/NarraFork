CREATE TABLE "intelligent_ui_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_narrator_id" text NOT NULL,
	"created_by" text NOT NULL,
	"workspace_key" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_binding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"message_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"revision" text NOT NULL,
	"epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"ui_id" text NOT NULL,
	"workspace_key" text NOT NULL,
	"head_revision" text NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"needs_rebind" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"revision" text NOT NULL,
	"actor_id" text NOT NULL,
	"action_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"fields_json" text NOT NULL,
	"message_id" text NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_kits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_key" text NOT NULL,
	"device_id" text NOT NULL,
	"cwd" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"lock_fingerprint" text NOT NULL,
	"auth_fingerprint" text NOT NULL,
	"framework" text NOT NULL,
	"catalog_version" text NOT NULL,
	"catalog_summary_json" text NOT NULL,
	"runtime_ref" text,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"request_id" text,
	"input_hash" text NOT NULL,
	"result_json" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_revision_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"revision" text NOT NULL,
	"ordinal" integer NOT NULL,
	"message_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"ui_id" text NOT NULL,
	"parent_revision" text,
	"document_json" text NOT NULL,
	"operations_json" text NOT NULL,
	"changed_ids_json" text NOT NULL,
	"document_hash" text NOT NULL,
	"document_bytes" integer NOT NULL,
	"summary" text NOT NULL,
	"renderer_kind" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligent_ui_storage_usage" (
	"workspace_key" text PRIMARY KEY NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "narrator_question_events" (
	"question_id" text NOT NULL,
	"message_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"resolution_json" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "resolution_json" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "withdraw_reason" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "summary_json" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "last_stop_reason" text;--> statement-breakpoint
ALTER TABLE "intelligent_ui_binding_events" ADD CONSTRAINT "intelligent_ui_binding_events_binding_id_intellig_eb42d7710c_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."intelligent_ui_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_binding_events" ADD CONSTRAINT "intelligent_ui_binding_events_revision_intelligen_7a8fb4ea60_fk" FOREIGN KEY ("revision") REFERENCES "public"."intelligent_ui_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_bindings" ADD CONSTRAINT "intelligent_ui_bindings_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_bindings" ADD CONSTRAINT "intelligent_ui_bindings_ui_id_intelligent_ui_artifacts_id_fk" FOREIGN KEY ("ui_id") REFERENCES "public"."intelligent_ui_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_bindings" ADD CONSTRAINT "intelligent_ui_bindings_head_revision_intelligent_d427bf0fd3_fk" FOREIGN KEY ("head_revision") REFERENCES "public"."intelligent_ui_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_interactions" ADD CONSTRAINT "intelligent_ui_interactions_binding_id_intelligen_1cb39f940d_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."intelligent_ui_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_interactions" ADD CONSTRAINT "intelligent_ui_interactions_revision_intelligent_347ca45652_fk" FOREIGN KEY ("revision") REFERENCES "public"."intelligent_ui_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_receipts" ADD CONSTRAINT "intelligent_ui_receipts_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_revision_refs" ADD CONSTRAINT "intelligent_ui_revision_refs_binding_id_intellige_2e3933a1fe_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."intelligent_ui_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_revision_refs" ADD CONSTRAINT "intelligent_ui_revision_refs_revision_intelligent_64ab05cfd0_fk" FOREIGN KEY ("revision") REFERENCES "public"."intelligent_ui_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_ui_revisions" ADD CONSTRAINT "intelligent_ui_revisions_ui_id_intelligent_ui_artifacts_id_fk" FOREIGN KEY ("ui_id") REFERENCES "public"."intelligent_ui_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_question_id_narrator_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."narrator_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_message_id_narrator_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."narrator_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ui_artifacts_workspace" ON "intelligent_ui_artifacts" USING btree ("workspace_key","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_events_binding_epoch" ON "intelligent_ui_binding_events" USING btree ("binding_id","epoch");--> statement-breakpoint
CREATE INDEX "idx_ui_events_message" ON "intelligent_ui_binding_events" USING btree ("message_id","binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_bindings_narrator_ui" ON "intelligent_ui_bindings" USING btree ("narrator_id","ui_id");--> statement-breakpoint
CREATE INDEX "idx_ui_bindings_page" ON "intelligent_ui_bindings" USING btree ("narrator_id","id");--> statement-breakpoint
CREATE INDEX "idx_ui_bindings_artifact" ON "intelligent_ui_bindings" USING btree ("ui_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_interactions_request" ON "intelligent_ui_interactions" USING btree ("binding_id","actor_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_ui_interactions_page" ON "intelligent_ui_interactions" USING btree ("binding_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_interactions_message" ON "intelligent_ui_interactions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_kits_identity" ON "intelligent_ui_kits" USING btree ("workspace_key","device_id","cwd","config_fingerprint","lock_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_ui_kits_workspace" ON "intelligent_ui_kits" USING btree ("workspace_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_receipts_tool" ON "intelligent_ui_receipts" USING btree ("narrator_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_receipts_request" ON "intelligent_ui_receipts" USING btree ("narrator_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_refs_binding_revision" ON "intelligent_ui_revision_refs" USING btree ("binding_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ui_refs_binding_ordinal" ON "intelligent_ui_revision_refs" USING btree ("binding_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_ui_refs_message" ON "intelligent_ui_revision_refs" USING btree ("message_id","binding_id");--> statement-breakpoint
CREATE INDEX "idx_ui_refs_revision" ON "intelligent_ui_revision_refs" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "idx_ui_revisions_artifact" ON "intelligent_ui_revisions" USING btree ("ui_id","id");--> statement-breakpoint
CREATE INDEX "idx_ui_revisions_parent" ON "intelligent_ui_revisions" USING btree ("parent_revision","id");--> statement-breakpoint
CREATE INDEX "idx_question_events_question_rowid" ON "narrator_question_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_question_events_question_created" ON "narrator_question_events" USING btree ("question_id","created_at","message_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_answer_message" ON "narrator_questions" USING btree ("answer_message_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_created" ON "narrator_questions" USING btree ("created_at","id");