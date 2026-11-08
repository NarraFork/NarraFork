PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `question_reflection_override` text DEFAULT 'inherit' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
