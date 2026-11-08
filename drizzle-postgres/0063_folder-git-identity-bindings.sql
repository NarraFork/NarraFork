CREATE TABLE "folder_git_identity_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL,
	"user_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "git_identity_folder_context_menu" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folder_git_identity_bindings" ADD CONSTRAINT "folder_git_identity_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_git_identity_bindings" ADD CONSTRAINT "folder_git_identity_bindings_identity_id_user_git_b105c2a3b2_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_git_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_folder_git_identity_unique" ON "folder_git_identity_bindings" USING btree ("folder_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_folder_git_identity_user" ON "folder_git_identity_bindings" USING btree ("user_id");