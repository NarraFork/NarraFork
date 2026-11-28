CREATE TABLE "team_work_item_dependencies" (
	"item_id" text NOT NULL,
	"depends_on_item_id" text NOT NULL,
	"team_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "team_work_item_dependencies_item_id_depends_on_item_id_pk" PRIMARY KEY("item_id","depends_on_item_id"),
	CONSTRAINT "ck_team_work_item_dependencies_self" CHECK ("item_id" <> "depends_on_item_id")
);
--> statement-breakpoint
ALTER TABLE "team_work_item_dependencies" ADD CONSTRAINT "team_work_item_dependencies_item_id_team_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."team_work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_item_dependencies" ADD CONSTRAINT "team_work_item_dependencies_depends_on_item_id_te_69b44cd09b_fk" FOREIGN KEY ("depends_on_item_id") REFERENCES "public"."team_work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_work_item_dependencies" ADD CONSTRAINT "team_work_item_dependencies_team_id_project_teams_94291c95ba_fk" FOREIGN KEY ("team_id") REFERENCES "public"."project_teams"("narrator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_team_work_item_dependencies_target" ON "team_work_item_dependencies" USING btree ("depends_on_item_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_team_work_item_dependencies_team" ON "team_work_item_dependencies" USING btree ("team_id");