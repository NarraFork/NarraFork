PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `title_source` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `title_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
