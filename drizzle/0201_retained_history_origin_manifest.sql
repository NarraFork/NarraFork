PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `legacy_retained_history_manifests` (
	`migration_project_id` text PRIMARY KEY NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `legacy_narrator_workspace_adoptions` ADD `proof_mode` text DEFAULT 'empty' NOT NULL;
--> statement-breakpoint
ALTER TABLE `legacy_narrator_workspace_adoptions` ADD `origin_json` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
