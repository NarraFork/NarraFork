import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages } from "../db/schema";
import { narratorPersistence } from "./narrator-persistence";

function isTextualBlock(block: unknown): block is Record<string, unknown> {
	return (
		block != null &&
		typeof block === "object" &&
		"type" in block &&
		(block.type === "text" || block.type === "reasoning")
	);
}

/** Absence of the marker means legacy, not incomplete. Never infer from text/signatures. */
export function removeIncompleteOutputBlocks(content: unknown): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const retained = content.filter((block) => !isTextualBlock(block) || block.completed !== false);
	return retained.length === content.length ? undefined : retained;
}

export function completeOutputBlocks(content: unknown): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	let changed = false;
	const completed = content.map((block) => {
		if (!isTextualBlock(block) || block.completed === true) return block;
		changed = true;
		return { ...block, completed: true };
	});
	return changed ? completed : undefined;
}

function contentText(content: unknown[]): string | null {
	return (
		content
			.flatMap((block) =>
				isTextualBlock(block) && block.type === "text" && typeof block.text === "string"
					? [block.text]
					: [],
			)
			.join("\n") || null
	);
}

/** Called only on a successful assistant_message, never on an interruption/error flush. */
export async function completeAssistantOutput(
	narratorId: string,
	messageId: string,
): Promise<string> {
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { contentJson: true },
	});
	const completed = completeOutputBlocks(message?.contentJson);
	if (!completed) return messageId;
	// The persistence method updates recipient refs, versions and character accounting too.
	return narratorPersistence.copyOnWriteMessage(
		narratorId,
		messageId,
		{ contentJson: completed, contentText: contentText(completed) },
		{ preserveExecutionOwner: true },
	);
}

/**
 * Cold recovery only: run before resuming this narrator's loop. The last assistant
 * row is the only in-flight partial; use its recipient ref (not original ownership).
 * LIMIT 1 avoids reading history-wide content or raw dumps. A forked partial is
 * isolated before editing. For the actual execution owner, copy the sibling
 * snapshots instead so pending tool/approval/continuation identities never move.
 */
export async function cleanupIncompleteNarratorOutput(
	narratorId: string,
): Promise<{ messageId?: string; removedBlocks: number }> {
	const [message] = await db
		.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessages.role, "assistant")),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1);
	if (!message) return { removedBlocks: 0 };
	const retained = removeIncompleteOutputBlocks(message.contentJson);
	if (!retained) return { messageId: message.id, removedBlocks: 0 };
	const messageId = await narratorPersistence.copyOnWriteMessage(
		narratorId,
		message.id,
		{ contentJson: retained, contentText: contentText(retained) },
		{ preserveExecutionOwner: true },
	);
	return {
		messageId,
		removedBlocks: (message.contentJson as unknown[]).length - retained.length,
	};
}
