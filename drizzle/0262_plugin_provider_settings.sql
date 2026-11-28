PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `plugin_provider_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`contribution_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`schema_version` integer NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`binding_fingerprint` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`config_text` text NOT NULL,
	`secrets_envelope` text,
	`key_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_plugin_provider_settings_revision" CHECK("plugin_provider_settings"."revision" >= 1 and "plugin_provider_settings"."revision" <= 9007199254740990),
	CONSTRAINT "ck_plugin_provider_settings_version" CHECK("plugin_provider_settings"."schema_version" >= 1),
	CONSTRAINT "ck_plugin_provider_settings_state" CHECK("plugin_provider_settings"."state" in ('active','dormant','deleted','blocked')),
	CONSTRAINT "ck_plugin_provider_settings_bytes" CHECK(length(cast("plugin_provider_settings"."config_text" as blob)) + coalesce(length(cast("plugin_provider_settings"."secrets_envelope" as blob)), 0) <= 65536),
	CONSTRAINT "ck_plugin_provider_settings_secret_key" CHECK(("plugin_provider_settings"."secrets_envelope" is null and "plugin_provider_settings"."key_id" is null) or ("plugin_provider_settings"."secrets_envelope" is not null and "plugin_provider_settings"."key_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_provider_settings_target` ON `plugin_provider_settings` (`plugin_id`,`contribution_id`,`target_kind`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_plugin_provider_settings_list` ON `plugin_provider_settings` (`plugin_id`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_plugin_provider_settings_provider` ON `plugin_provider_settings` (`target_kind`,`target_id`,`id`);
--> statement-breakpoint
CREATE TABLE `plugin_resource_budgets` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`resource_bytes` integer DEFAULT 0 NOT NULL,
	`resource_count` integer DEFAULT 0 NOT NULL,
	`settings_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_plugin_budget_bytes" CHECK("plugin_resource_budgets"."resource_bytes" >= 0 and "plugin_resource_budgets"."resource_bytes" <= 8388608),
	CONSTRAINT "ck_plugin_budget_resources" CHECK("plugin_resource_budgets"."resource_count" >= 0 and "plugin_resource_budgets"."resource_count" <= 4096),
	CONSTRAINT "ck_plugin_budget_settings" CHECK("plugin_resource_budgets"."settings_count" >= 0 and "plugin_resource_budgets"."settings_count" <= 4096)
);
--> statement-breakpoint
CREATE TABLE `plugin_resource_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`key` text NOT NULL,
	`installation_id` text NOT NULL,
	`binding_fingerprint` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`value_text` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_plugin_resource_revision" CHECK("plugin_resource_entries"."revision" >= 1 and "plugin_resource_entries"."revision" <= 9007199254740990),
	CONSTRAINT "ck_plugin_resource_state" CHECK("plugin_resource_entries"."state" in ('active','deleted')),
	CONSTRAINT "ck_plugin_resource_bytes" CHECK("plugin_resource_entries"."bytes" >= 0 and "plugin_resource_entries"."bytes" <= 65536 and length(cast("plugin_resource_entries"."value_text" as blob)) = "plugin_resource_entries"."bytes")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_resource_identity` ON `plugin_resource_entries` (`plugin_id`,`owner_kind`,`scope_type`,`scope_id`,`key`);
--> statement-breakpoint
CREATE INDEX `idx_plugin_resource_list` ON `plugin_resource_entries` (`plugin_id`,`owner_kind`,`scope_type`,`scope_id`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
