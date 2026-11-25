CREATE TABLE "executor_session_cleanups" (
	"device_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "executor_session_cleanups_device_id_session_id_pk" PRIMARY KEY("device_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "executor_session_id" text;