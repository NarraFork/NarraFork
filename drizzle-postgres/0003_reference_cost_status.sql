CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" text,
	"chapter_id" text,
	"narrator_id" text,
	"title" text NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"link_json" text NOT NULL,
	"source_key" text NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"created_at" bigint NOT NULL,
	"read_at" bigint
);
--> statement-breakpoint
CREATE TABLE "user_usage_totals" (
	"user_id" text PRIMARY KEY NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"unpriced_request_count" integer DEFAULT 0 NOT NULL,
	"partial_request_count" integer DEFAULT 0 NOT NULL,
	"first_used_at" text NOT NULL,
	"last_used_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "cost_status" text;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "cost_missing_fields" text;--> statement-breakpoint
ALTER TABLE "credential_usage_totals" ADD COLUMN "partial_request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrator_messages" ADD COLUMN "cost_status" text;--> statement-breakpoint
ALTER TABLE "narrator_messages" ADD COLUMN "cost_missing_fields" text;--> statement-breakpoint
ALTER TABLE "narrator_tool_calls" ADD COLUMN "cost_status" text;--> statement-breakpoint
ALTER TABLE "narrator_tool_calls" ADD COLUMN "cost_missing_fields" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notifications_user_kind_source" ON "notifications" USING btree ("user_id","kind","source_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_status_created" ON "notifications" USING btree ("user_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_api_requests_user_created" ON "api_requests" USING btree ("user_id","created_at","id");