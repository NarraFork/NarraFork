import { db } from "@server/db";
import { chapters, narrators } from "@server/db/schema";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { eq } from "drizzle-orm";
import { type AttentionReason, type HookEvent, hookService } from "./hook-service";

// === Attention → Hook bridge ===
//
// The `narrator:attention` / `narrator:attention_resolved` intents live on the
// event bus (also consumed by notification-service and the gateway). This module
// bridges them into the Hook system so users can run command/http hooks when a
// narrator needs attention or that attention is resolved.
//
// Matcher semantics: attention hooks reuse the `matcher` field to filter by
// reason (empty = all reasons). getMatchingHooks already compares matcher against
// the key we pass as `toolName`, so no change is needed there — we just pass the
// attention reason as that key.

async function runAttentionHook(
	event: Extract<HookEvent, "Attention" | "AttentionResolved">,
	payload: { narratorId: string; reason: AttentionReason; detail?: string },
): Promise<void> {
	// Resolve narrator context (chapter / cwd) for the hook input. The project
	// scope for hook matching comes from the chapter (narrators have no direct
	// projectId column); standalone narrators have no chapter → global hooks only.
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, payload.narratorId),
		columns: { chapterId: true, cwd: true },
	});
	if (!narrator) return;

	let projectId: string | undefined;
	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		projectId = chapter?.projectId ?? undefined;
	}

	await hookService.runHooks(
		event,
		{
			hook_event_name: event,
			narrator_id: payload.narratorId,
			chapter_id: narrator.chapterId ?? undefined,
			project_id: projectId,
			cwd: narrator.cwd ?? undefined,
			attention_reason: payload.reason,
			attention_detail: payload.detail,
		},
		projectId,
		// Matcher key: filter by reason (empty matcher matches all reasons).
		payload.reason,
	);
}

eventBus.on("narrator:attention", (event) => {
	runAttentionHook("Attention", {
		narratorId: event.narratorId,
		reason: event.reason,
		detail: event.detail,
	}).catch((err) => {
		logger.error("Attention hook bridge error", {
			narratorId: event.narratorId,
			reason: event.reason,
			error: err instanceof Error ? err.message : String(err),
		});
	});
});

eventBus.on("narrator:attention_resolved", (event) => {
	runAttentionHook("AttentionResolved", {
		narratorId: event.narratorId,
		reason: event.reason,
		detail: event.detail,
	}).catch((err) => {
		logger.error("AttentionResolved hook bridge error", {
			narratorId: event.narratorId,
			reason: event.reason,
			error: err instanceof Error ? err.message : String(err),
		});
	});
});
