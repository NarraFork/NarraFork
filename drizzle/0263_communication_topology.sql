PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `narrator_communication_nodes` (
	`narrator_id` text PRIMARY KEY NOT NULL,
	`parent_narrator_id` text,
	`original_parent_narrator_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`original_parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_communication_nodes_not_self" CHECK("narrator_communication_nodes"."parent_narrator_id" is null or "narrator_communication_nodes"."parent_narrator_id" <> "narrator_communication_nodes"."narrator_id"),
	CONSTRAINT "ck_communication_nodes_version" CHECK("narrator_communication_nodes"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_communication_nodes_parent` ON `narrator_communication_nodes` (`parent_narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_communication_nodes_original_parent` ON `narrator_communication_nodes` (`original_parent_narrator_id`);
--> statement-breakpoint
CREATE TABLE `narrator_communication_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_lo` text NOT NULL,
	`endpoint_hi` text NOT NULL,
	`generation` integer NOT NULL,
	`created_by` text,
	`source` text NOT NULL,
	`admission_id` text,
	`message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`endpoint_lo`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_hi`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_communication_peers_canonical" CHECK("narrator_communication_peers"."endpoint_lo" < "narrator_communication_peers"."endpoint_hi"),
	CONSTRAINT "ck_communication_peers_generation" CHECK("narrator_communication_peers"."generation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_communication_peers_pair` ON `narrator_communication_peers` (`endpoint_lo`,`endpoint_hi`);
--> statement-breakpoint
CREATE INDEX `idx_communication_peers_hi` ON `narrator_communication_peers` (`endpoint_hi`);
--> statement-breakpoint
CREATE INDEX `idx_communication_peers_created_by` ON `narrator_communication_peers` (`created_by`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
