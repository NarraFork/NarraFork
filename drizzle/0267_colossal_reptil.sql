PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `team_work_item_dependencies` (
	`item_id` text NOT NULL,
	`depends_on_item_id` text NOT NULL,
	`team_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `depends_on_item_id`),
	FOREIGN KEY (`item_id`) REFERENCES `team_work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_item_id`) REFERENCES `team_work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `project_teams`(`narrator_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_team_work_item_dependencies_self" CHECK("team_work_item_dependencies"."item_id" <> "team_work_item_dependencies"."depends_on_item_id")
);
--> statement-breakpoint
CREATE INDEX `idx_team_work_item_dependencies_target` ON `team_work_item_dependencies` (`depends_on_item_id`,`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_work_item_dependencies_team` ON `team_work_item_dependencies` (`team_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
