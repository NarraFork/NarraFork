/**
 * Deliver a human file-editor save to a working narrator as a cut-in user message.
 *
 * Modeled after `spec-edit-interject.ts`: a running loop receives the edit through
 * the same path as a user's own cut-in message (buffered at the front, soft-stop
 * requested), so `taskReflection` recognises it as a genuine user action.
 *
 * An idle narrator does NOT get woken — that would turn every Ctrl+S into a model
 * request. Instead the edit is written as a `schedule: "none"` injection via
 * `deliverInjection`, so it appears in the conversation and is picked up on the
 * next user-initiated turn.
 *
 * Rapid consecutive saves to the same narrator are collapsed into one message (the
 * `hotSafe` map), identical to the spec-edit pattern: the user hits Ctrl+S
 * repeatedly, and stacking reversed messages would be noise.
 */

import { relative, sep } from "node:path";
import type { DiffLineStats } from "@shared/pretext-layout/diff-core";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	getBufferedMessages,
	pushBufferedMessage,
	toBufferSummary,
	updateBufferedMessage,
} from "./narrator-buffer";
import { deliverInjection } from "./narrator-injection";
import { isLoopRunning, requestBufferedMessageSoftStop } from "./narrator-session";
import type { BufferCreator } from "./narrator-session-state";

/** How the notification reached the narrator — same vocabulary as spec-edit. */
export type FileEditDelivery = "interjected" | "queued";

export interface FileEditNotification {
	/** Absolute path as the user sees it (may differ from the physical path). */
	filePath: string;
	/** The narrator's worktree root, used to compute a relative display path. */
	worktreePath: string;
	/** Line-level change summary. Null when the diff could not be computed. */
	lineStats: DiffLineStats | null;
	locale: Locale;
	userId: string | null;
}

/**
 * The still-unconsumed cut-in message per narrator — same purpose and lifecycle
 * as `specEditInterjectIds` in spec-edit-interject.ts. Rapid saves collapse
 * into one message at its original queue position rather than stacking in reverse.
 */
const fileEditInterjectIds = hotSafe<Map<string, string>>(
	"narrafork.fileEditInterjectIds",
	() => new Map(),
);

/** Build the message text. First person: this IS the user's message. */
export function formatFileEditInterjection(notification: FileEditNotification): string {
	const isZh = notification.locale === "zh-CN";

	// Show a worktree-relative path when inside the worktree, absolute otherwise.
	const rel = relative(notification.worktreePath, notification.filePath);
	const displayPath =
		rel && !rel.startsWith("..") ? rel.split(sep).join("/") : notification.filePath;

	const lines: string[] = [];
	if (isZh) {
		lines.push(`我通过文件编辑器修改了 \`${displayPath}\`。`);
	} else {
		lines.push(`I edited \`${displayPath}\` via the file editor.`);
	}

	// Bounded line stats summary — never the full file content (that would blow up
	// the context window on a large file).
	const stats = notification.lineStats;
	if (stats) {
		if (isZh) {
			lines.push(`变更：+${stats.added} 行 / -${stats.removed} 行。`);
		} else {
			lines.push(`Changes: +${stats.added} lines / -${stats.removed} lines.`);
		}
	}

	return lines.join("\n");
}

/** Look up the editing user for the buffered-message avatar. */
async function resolveCreator(userId: string | null): Promise<BufferCreator | null> {
	if (!userId) return null;
	try {
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
		});
		return user ?? null;
	} catch (err) {
		// Attribution is cosmetic; never block delivery on it.
		logger.debug("Failed to resolve file-edit interjection creator", {
			userId,
			error: String(err),
		});
		return null;
	}
}

/** Broadcast the queue snapshot so the narrator panel updates. */
function broadcastBufferSnapshot(narratorId: string): void {
	broadcastToNarrator(narratorId, {
		type: "buffer_set",
		narratorId,
		messages: toBufferSummary(getBufferedMessages(narratorId)),
	});
}

/**
 * Deliver a file-editor save notification to a narrator.
 *
 * Returns how it was delivered so the route can tell the UI.
 */
export async function interjectFileEditAsUserMessage(
	narratorId: string,
	notification: FileEditNotification,
): Promise<{ delivered: FileEditDelivery }> {
	// ── Idle narrator: park the edit as an injection, don't wake ──────────
	// Waking the model on every Ctrl+S would be expensive and noisy. The
	// injection sits in the conversation and is picked up on the next turn.
	if (!isLoopRunning(narratorId)) {
		const text = formatFileEditInterjection(notification);
		await deliverInjection(narratorId, {
			content: text,
			source: "file_editor",
			role: "user",
			schedule: "none",
			locale: notification.locale,
			createdBy: notification.userId,
		});
		return { delivered: "queued" };
	}

	// ── Running narrator: cut-in user message ────────────────────────────
	const text = formatFileEditInterjection(notification);

	// Collapse rapid saves: rewrite the previous cut-in when it is still queued,
	// so the user's repeated Ctrl+S produces one message, not a reversed stack.
	const trackedId = fileEditInterjectIds.get(narratorId);
	if (trackedId && getBufferedMessages(narratorId).some((msg) => msg.id === trackedId)) {
		if (updateBufferedMessage(narratorId, trackedId, text)) {
			requestBufferedMessageSoftStop(narratorId);
			broadcastBufferSnapshot(narratorId);
			return { delivered: "interjected" };
		}
	}

	const creator = await resolveCreator(notification.userId);
	const result = await pushBufferedMessage(
		narratorId,
		text,
		undefined,
		null,
		notification.userId,
		creator,
		undefined,
		"front",
	);
	if (!result.ok) {
		// Queue full or narrator not active in memory (subagent). Fall back to
		// injection so nothing is lost.
		fileEditInterjectIds.delete(narratorId);
		await deliverInjection(narratorId, {
			content: text,
			source: "file_editor",
			role: "user",
			schedule: "none",
			locale: notification.locale,
			createdBy: notification.userId,
		});
		return { delivered: "queued" };
	}

	fileEditInterjectIds.set(narratorId, result.id);
	requestBufferedMessageSoftStop(narratorId);
	broadcastBufferSnapshot(narratorId);
	return { delivered: "interjected" };
}
