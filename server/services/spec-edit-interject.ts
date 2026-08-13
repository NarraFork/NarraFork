/**
 * Deliver a UI spec edit to a working narrator as a cut-in user message.
 *
 * A spec edit used to arrive only as an `after_tools` sidecar (see
 * `spec-update-queue.ts`), which lands in the model history as a
 * `<side_car>` block appended to the next turn's text. That is a low-weight
 * aside: `taskReflection` reads the parent history and could not tell a task
 * the user had just added from noise the assistant had injected itself, so it
 * rejected such tasks as "off the main line".
 *
 * A working narrator therefore now receives the edit through the same path as a
 * user's own cut-in message: pushed to the front of the buffer queue plus a
 * soft-stop request, so the loop finishes the current tool call and then
 * consumes it as a real `role: "user"` turn.
 *
 * An idle narrator keeps the sidecar behavior — interjecting would mean every
 * panel save wakes the model and costs a request.
 */

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
import { isLoopRunning, requestBufferedMessageSoftStop } from "./narrator-session";
import type { BufferCreator } from "./narrator-session-state";
import { type PendingSpecUpdate, pushSpecUpdateForNarrator } from "./spec-update-queue";

/**
 * How the notification actually reached the narrator.
 *
 * `interjected` — delivered as a cut-in user turn against a RUNNING loop.
 * `queued`      — parked in the idle spec-update queue, to be picked up at the next
 *                 turn boundary. (Formerly spelled `"sidecar"`, from a delivery
 *                 mechanism that no longer exists; the name described the old
 *                 transport rather than what happens, which is simply queueing.)
 */
export type SpecEditDelivery = "interjected" | "queued";

/**
 * The still-unconsumed cut-in message per narrator.
 *
 * The Spec panel binds `mod+s`, so several saves during one tool call are
 * routine. Unshifting each one would stack near-duplicate user messages AND
 * reverse their order (the newest ends up first). Instead the tracked message is
 * rewritten in place, keeping one entry at its original queue position.
 *
 * No cleanup hook is needed: liveness is decided by checking whether the id is
 * still in the live queue, so a consumed or cancelled message naturally causes
 * the next save to create a fresh entry.
 */
const specEditInterjectIds = hotSafe<Map<string, string>>(
	"narrafork.specEditInterjectIds",
	() => new Map(),
);

/** Build the cut-in message text. First person: this IS the user's message. */
export function formatSpecEditInterjection(update: PendingSpecUpdate, locale: Locale): string {
	const isZh = locale === "zh-CN";
	const lines: string[] = [];
	if (update.reset) {
		lines.push(
			isZh
				? "我通过 Spec 面板重置了整个 Dynamic Spec：所有任务、笔记与 behavior_fence 均已恢复默认/清空。请丢弃早先的计划，等待我的下一条指令。"
				: "I reset the entire Dynamic Spec via the Spec panel: all tasks, notes and the behavior fence are back to defaults/empty. Drop the earlier plan and wait for my next instruction.",
		);
		return lines.join("\n");
	}
	if (update.cleared) {
		lines.push(
			isZh
				? "我通过 Spec 面板清空了任务列表，此前的开放任务已全部移除。停止继续之前的任务，等待我的下一条指令。"
				: "I cleared the task list via the Spec panel — every previously open task is gone. Stop pursuing earlier tasks and wait for my next instruction.",
		);
		return lines.join("\n");
	}
	if (isZh) {
		lines.push(`我通过 Spec 面板更新了 ${update.uri}，请同步你的工作计划。`);
	} else {
		lines.push(`I updated ${update.uri} via the Spec panel — align your plan with it.`);
	}
	if (update.taskSummary) {
		lines.push(
			isZh ? `\n当前开放任务：\n${update.taskSummary}` : `\nOpen tasks:\n${update.taskSummary}`,
		);
	} else if (update.preview) {
		lines.push(isZh ? `\n内容预览：\n${update.preview}` : `\nContent preview:\n${update.preview}`);
	}
	return lines.join("\n");
}

/** Look up the editing user so the queued card can show their avatar. */
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
		logger.debug("Failed to resolve spec-edit interjection creator", {
			userId,
			error: String(err),
		});
		return null;
	}
}

/**
 * Broadcast the current queue snapshot.
 *
 * `pushBufferedMessage` / `updateBufferedMessage` only touch the map and DB —
 * the queue UI updates because every caller broadcasts this itself (see
 * `routes/narrators.ts`). Skipping it would leave the interjected message
 * invisible in the narrator panel until a manual refresh.
 */
function broadcastBufferSnapshot(narratorId: string): void {
	broadcastToNarrator(narratorId, {
		type: "buffer_set",
		narratorId,
		messages: toBufferSummary(getBufferedMessages(narratorId)),
	});
}

/**
 * Deliver a spec-file edit notification to a narrator.
 *
 * Returns how it was delivered so the route can tell the UI whether the edit
 * will cut in after the current tool call or is merely queued as context.
 */
export async function interjectSpecEditAsUserMessage(
	narratorId: string,
	update: PendingSpecUpdate,
	locale: Locale,
	userId: string | null,
): Promise<{ delivered: SpecEditDelivery }> {
	// An idle narrator is deliberately not woken: the sidecar rides along with
	// whatever the user does next instead of costing a model request now.
	if (!isLoopRunning(narratorId)) {
		pushSpecUpdateForNarrator(narratorId, update);
		return { delivered: "queued" };
	}

	const text = formatSpecEditInterjection(update, locale);

	// Rewrite the previous cut-in when it is still queued, so rapid saves collapse
	// into one message at its original position rather than stacking in reverse.
	const trackedId = specEditInterjectIds.get(narratorId);
	if (trackedId && getBufferedMessages(narratorId).some((msg) => msg.id === trackedId)) {
		if (updateBufferedMessage(narratorId, trackedId, text)) {
			requestBufferedMessageSoftStop(narratorId);
			broadcastBufferSnapshot(narratorId);
			return { delivered: "interjected" };
		}
	}

	const creator = await resolveCreator(userId);
	const result = await pushBufferedMessage(
		narratorId,
		text,
		undefined,
		null,
		userId,
		creator,
		undefined,
		"front",
	);
	if (!result.ok) {
		// Queue full, or the narrator is not active in memory (e.g. a subagent,
		// whose queue lives in a separate map). Fall back so nothing is lost.
		specEditInterjectIds.delete(narratorId);
		pushSpecUpdateForNarrator(narratorId, update);
		return { delivered: "queued" };
	}

	specEditInterjectIds.set(narratorId, result.id);
	requestBufferedMessageSoftStop(narratorId);
	broadcastBufferSnapshot(narratorId);
	return { delivered: "interjected" };
}
