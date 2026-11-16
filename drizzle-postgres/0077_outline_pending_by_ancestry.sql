DROP INDEX "idx_outline_pending_unreported";--> statement-breakpoint
CREATE INDEX "idx_outline_pending_space_open" ON "outline_pending" USING btree ("space_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_pending_unreported" ON "outline_pending" USING btree ("requester_session","created_at","id") WHERE "reported_at" IS NULL AND "status" <> 'open';