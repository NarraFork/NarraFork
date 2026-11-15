PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_live_log` (
	`space_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`seq` integer NOT NULL,
	`update_b64` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`space_id`, `epoch`, `seq`),
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
