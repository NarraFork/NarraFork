PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_narrator_communication_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_lo` text NOT NULL,
	`endpoint_hi` text NOT NULL,
	`created_by` text,
	`source` text NOT NULL,
	`admission_id` text,
	`message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`endpoint_lo`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_hi`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_communication_peers_canonical" CHECK("__new_narrator_communication_peers"."endpoint_lo" < "__new_narrator_communication_peers"."endpoint_hi")
);
--> statement-breakpoint
INSERT INTO `__new_narrator_communication_peers`("id", "endpoint_lo", "endpoint_hi", "created_by", "source", "admission_id", "message_id", "created_at") SELECT "id", "endpoint_lo", "endpoint_hi", "created_by", "source", "admission_id", "message_id", "created_at" FROM `narrator_communication_peers`;
--> statement-breakpoint
DROP TABLE `narrator_communication_peers`;
--> statement-breakpoint
ALTER TABLE `__new_narrator_communication_peers` RENAME TO `narrator_communication_peers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_communication_peers_pair` ON `narrator_communication_peers` (`endpoint_lo`,`endpoint_hi`);
--> statement-breakpoint
CREATE INDEX `idx_communication_peers_hi` ON `narrator_communication_peers` (`endpoint_hi`);
--> statement-breakpoint
CREATE INDEX `idx_communication_peers_created_by` ON `narrator_communication_peers` (`created_by`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
