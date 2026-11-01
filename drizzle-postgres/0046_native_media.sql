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