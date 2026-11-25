CREATE TABLE "narrator_communication_nodes" (
	"narrator_id" text PRIMARY KEY NOT NULL,
	"parent_narrator_id" text,
	"original_parent_narrator_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ck_communication_nodes_not_self" CHECK ("parent_narrator_id" is null or "parent_narrator_id" <> "narrator_id"),
	CONSTRAINT "ck_communication_nodes_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "narrator_communication_peers" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_lo" text NOT NULL,
	"endpoint_hi" text NOT NULL,
	"generation" integer NOT NULL,
	"created_by" text,
	"source" text NOT NULL,
	"admission_id" text,
	"message_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "ck_communication_peers_canonical" CHECK ("endpoint_lo" < "endpoint_hi"),
	CONSTRAINT "ck_communication_peers_generation" CHECK ("generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "narrator_communication_nodes" ADD CONSTRAINT "narrator_communication_nodes_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_communication_nodes" ADD CONSTRAINT "narrator_communication_nodes_parent_narrator_id_narrators_id_fk" FOREIGN KEY ("parent_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_communication_nodes" ADD CONSTRAINT "narrator_communication_nodes_original_parent_narr_88c92662fd_fk" FOREIGN KEY ("original_parent_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_communication_peers" ADD CONSTRAINT "narrator_communication_peers_endpoint_lo_narrators_id_fk" FOREIGN KEY ("endpoint_lo") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_communication_peers" ADD CONSTRAINT "narrator_communication_peers_endpoint_hi_narrators_id_fk" FOREIGN KEY ("endpoint_hi") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_communication_peers" ADD CONSTRAINT "narrator_communication_peers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_communication_nodes_parent" ON "narrator_communication_nodes" USING btree ("parent_narrator_id");--> statement-breakpoint
CREATE INDEX "idx_communication_nodes_original_parent" ON "narrator_communication_nodes" USING btree ("original_parent_narrator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_communication_peers_pair" ON "narrator_communication_peers" USING btree ("endpoint_lo","endpoint_hi");--> statement-breakpoint
CREATE INDEX "idx_communication_peers_hi" ON "narrator_communication_peers" USING btree ("endpoint_hi");--> statement-breakpoint
CREATE INDEX "idx_communication_peers_created_by" ON "narrator_communication_peers" USING btree ("created_by");