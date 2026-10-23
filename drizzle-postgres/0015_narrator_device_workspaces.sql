CREATE TABLE "narrator_device_workspace_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"request_id" text NOT NULL,
	"actor_user_id" text,
	"kind" text NOT NULL,
	"device_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"expected_binding_revision" integer NOT NULL,
	"expected_selection_revision" integer,
	"result_json" text NOT NULL,
	"install_state" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "narrator_device_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"device_id" text NOT NULL,
	"binding_revision" integer NOT NULL,
	"cwd" text NOT NULL,
	"path_flavor" text NOT NULL,
	"workspace_context" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narrator_device_workspace_requests" ADD CONSTRAINT "narrator_device_workspace_requests_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_device_workspaces" ADD CONSTRAINT "narrator_device_workspaces_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_narrator_device_workspace_request" ON "narrator_device_workspace_requests" USING btree ("narrator_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_device_workspace_request_created" ON "narrator_device_workspace_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_narrator_device_workspace" ON "narrator_device_workspaces" USING btree ("narrator_id","device_id");