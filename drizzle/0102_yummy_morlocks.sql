ALTER TABLE `narrators` ADD `refs_inherited_from` text REFERENCES narrators(id);--> statement-breakpoint
ALTER TABLE `narrators` ADD `refs_backfill_cursor` integer;--> statement-breakpoint
CREATE INDEX `idx_narrators_refs_inherited_from` ON `narrators` (`refs_inherited_from`) WHERE "refs_inherited_from" IS NOT NULL;