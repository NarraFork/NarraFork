PRAGMA foreign_keys=OFF;
--> statement-breakpoint
DROP INDEX `idx_outline_pending_unreported`;
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_space_open` ON `outline_pending` (`space_id`) WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_unreported` ON `outline_pending` (`requester_session`,`created_at`,`id`) WHERE "reported_at" IS NULL AND "status" <> 'open';
--> statement-breakpoint
PRAGMA foreign_keys=ON;
