ALTER TABLE `narrators` ADD `variant` text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `traits` text DEFAULT '[]' NOT NULL;--> statement-breakpoint

-- Data migration: populate variant from type + subagent_type
UPDATE `narrators` SET `variant` = 'subagent:' || `subagent_type`
  WHERE `type` = 'subagent' AND `subagent_type` IS NOT NULL;--> statement-breakpoint

-- Data migration: populate traits from boolean flags + chapterId
-- standalone (primary narrators with no chapter)
UPDATE `narrators` SET `traits` = '["standalone"]'
  WHERE `type` = 'primary' AND `chapter_id` IS NULL
    AND `is_ask_in_passing` = 0 AND `is_background` = 0;--> statement-breakpoint

-- ask-in-passing only
UPDATE `narrators` SET `traits` = '["ask-in-passing"]'
  WHERE `is_ask_in_passing` = 1 AND `chapter_id` IS NOT NULL
    AND `is_background` = 0;--> statement-breakpoint

-- standalone + ask-in-passing
UPDATE `narrators` SET `traits` = '["standalone","ask-in-passing"]'
  WHERE `is_ask_in_passing` = 1 AND `chapter_id` IS NULL
    AND `is_background` = 0;--> statement-breakpoint

-- background only (subagent with chapter)
UPDATE `narrators` SET `traits` = '["background"]'
  WHERE `is_background` = 1 AND `chapter_id` IS NOT NULL;--> statement-breakpoint

-- standalone + background (subagent without chapter)
UPDATE `narrators` SET `traits` = '["standalone","background"]'
  WHERE `is_background` = 1 AND `chapter_id` IS NULL;