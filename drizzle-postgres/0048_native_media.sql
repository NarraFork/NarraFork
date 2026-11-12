DO $$
DECLARE
	column_info record;
BEGIN
	-- Older feature branches may already have this column and its data.
	ALTER TABLE "narrator_buffered_messages" ADD COLUMN IF NOT EXISTS "media_json" text;

	SELECT a.atttypid, a.atttypmod, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity
	INTO STRICT column_info
	FROM pg_catalog.pg_attribute AS a
	WHERE a.attrelid = '"narrator_buffered_messages"'::pg_catalog.regclass
		AND a.attname = 'media_json' AND a.attnum > 0 AND NOT a.attisdropped;

	IF column_info.atttypid <> 'pg_catalog.text'::pg_catalog.regtype
		OR column_info.atttypmod <> -1
		OR column_info.attnotnull OR column_info.atthasdef
		OR column_info.attgenerated <> '' OR column_info.attidentity <> '' THEN
		RAISE EXCEPTION 'Migration 0046: narrator_buffered_messages.media_json must be nullable text without a default or generated/identity expression (found type %, typmod %, not null %, default %, generated %, identity %)',
			pg_catalog.format_type(column_info.atttypid, column_info.atttypmod),
			column_info.atttypmod, column_info.attnotnull, column_info.atthasdef,
			column_info.attgenerated, column_info.attidentity
			USING ERRCODE = '42804';
	END IF;
END $$;
--> statement-breakpoint
-- The old native-media branch's 0046 has a later timestamp than upstream's
-- 0046. Drizzle's timestamp watermark skips the upstream migration on that
-- branch, so replay it only when its exact ledger fingerprint is absent.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE hash IN ('464e7af3b67b68b65073d71ce14e2bcad9b08ff2b970e99a8638265080672644', '75e1fab8ccd88e57be0d5803ecca76e72b86084ae2aa239a57c2ace83ae9843c')
	) AND NOT EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE hash IN ('07be557cc8e920ac4299abc42544e80e11792be703d6e8313503537f3a979e34', '23c9f51f0fbaba7b4c12d7da2ca0777e6bb4e47a1df6e9c9dc5204e891c40c1f')
	) THEN
		CREATE TABLE "outline_task_claims" (
			"task_block_id" text PRIMARY KEY NOT NULL,
			"holder_narrator_id" text,
			"holder_user_id" text,
			"epoch" integer NOT NULL,
			"task_version_at_claim" integer NOT NULL,
			"claimed_at" text NOT NULL,
			"expires_at" text,
			"last_holder_narrator_id" text,
			"last_holder_user_id" text
		);
		ALTER TABLE "outline_blocks" ADD COLUMN "in_process" boolean DEFAULT false NOT NULL;
		ALTER TABLE "outline_spaces" ADD COLUMN "in_process_ready" boolean DEFAULT false NOT NULL;
		ALTER TABLE "outline_spaces" ADD COLUMN "in_process_epoch" integer DEFAULT 0 NOT NULL;
		ALTER TABLE "outline_task_claims" ADD CONSTRAINT "outline_task_claims_task_block_id_outline_blocks_id_fk" FOREIGN KEY ("task_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "idx_outline_task_claims_holder" ON "outline_task_claims" USING btree ("holder_narrator_id") WHERE "holder_narrator_id" IS NOT NULL;
		CREATE INDEX "idx_outline_task_claims_expiry" ON "outline_task_claims" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL;
		CREATE INDEX "idx_outline_blocks_open_tasks" ON "outline_blocks" USING btree ("space_id") WHERE ("task_json"::jsonb #>> '{status}') IN ('todo', 'doing') AND "deleted" = FALSE;
		CREATE INDEX "idx_outline_blocks_doing_tasks" ON "outline_blocks" USING btree ("id") WHERE ("task_json"::jsonb #>> '{status}') = 'doing' AND "deleted" = FALSE;
		CREATE INDEX "idx_outline_spaces_in_process_pending" ON "outline_spaces" USING btree ("id") WHERE "in_process_ready" = FALSE;
		INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
		VALUES ('07be557cc8e920ac4299abc42544e80e11792be703d6e8313503537f3a979e34', 1793383934682);
	END IF;
END $$;
--> statement-breakpoint
-- The previous media 0047 watermark is newer than upstream ModelTrace 0047.
-- Repair only databases known to have run that exact migration, and record the
-- upstream migration atomically so repeated execution cannot replay its DDL.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE hash IN ('9c78534134d6f92741a478b05e4290f62b72d8b073d9ee5f052b5c15db0043d7', 'f2ecf4303ae75d856f1fe37c88ca9419e21131b8e34edbbef2d982a812945728')
	) AND NOT EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE hash IN ('d837b29b7004e8d02c4f88f098d0747e1944972dbf2b02a0faa29b88f8a1fd4e', '9506699a359b5c8a6e1ec148461b126a721ff3807bca63904d699d30c823e562')
	) THEN
		ALTER TABLE "narrators" ADD COLUMN "hidden_from_lists" boolean DEFAULT false NOT NULL;
		ALTER TABLE "narrators" ADD COLUMN "modeltrace_key" text;
		CREATE UNIQUE INDEX "idx_narrators_modeltrace_key" ON "narrators" USING btree ("modeltrace_key");
		INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
		VALUES ('d837b29b7004e8d02c4f88f098d0747e1944972dbf2b02a0faa29b88f8a1fd4e', 1793519539201);
	END IF;
END $$;