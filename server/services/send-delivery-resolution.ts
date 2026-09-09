import type { ToolCallBinding } from "../lib/agent/types";
import { getActiveSendDeliveryTargets } from "./agent-reply-waiter";

/** A receipt reserves a message id; it does NOT promise the queued message exists yet. */
export interface SendDeliveryTarget {
	id: string;
	deliveryMessageId: string;
}

export const SEND_DELIVERY_TARGETS_FIELD = "_sendDeliveryTargets";

type DeliveryLookup = (
	requesterId: string,
	toolUseId: string,
	binding?: ToolCallBinding,
) => ReadonlyArray<{ id: string; deliveryMessageId?: string }>;

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Best-effort navigation-only frame. Never claims tool completion or message persistence. */
export async function broadcastSendDeliveryResolved(
	narratorId: string,
	toolUseId: string,
	targets: readonly SendDeliveryTarget[],
	toolCallBinding?: ToolCallBinding,
): Promise<void> {
	if (!targets.length) return;
	try {
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		broadcastToNarrator(narratorId, {
			type: "send_delivery_resolved",
			narratorId,
			toolUseId,
			targets: [...targets],
			...(toolCallBinding ? { toolCallBinding } : {}),
		});
	} catch {
		// The message loader can recover the same receipt from the active waiter.
	}
}

/**
 * Enrich only the already-loaded page, using the exact tool owner + toolUseId.
 * The lookup is a synchronous in-memory checkpoint read, not a DB/history query.
 * Keep receipts outside outputJson/_metadata: queued ids may not exist on disk,
 * and a running Send has not produced its returned targets yet.
 */
export function attachActiveSendDeliveryTargets(
	// biome-ignore lint/suspicious/noExplicitAny: enriched message JSON transport
	tree: any[],
	lookup: DeliveryLookup = getActiveSendDeliveryTargets,
	// biome-ignore lint/suspicious/noExplicitAny: enriched message JSON transport
): any[] {
	const cache = new Map<string, Map<string, SendDeliveryTarget[]>>();
	function readTargets(
		owner: string,
		toolUseId: string,
		binding?: ToolCallBinding,
	): SendDeliveryTarget[] {
		const cacheKey = JSON.stringify([toolUseId, binding?.toolCallId, binding?.attempt]);
		let ownerCache = cache.get(owner);
		if (!ownerCache) {
			ownerCache = new Map();
			cache.set(owner, ownerCache);
		}
		const cached = ownerCache.get(cacheKey);
		if (cached) return cached;
		let targets: SendDeliveryTarget[] = [];
		try {
			targets = lookup(owner, toolUseId, binding)
				.filter(
					(target): target is SendDeliveryTarget =>
						nonEmpty(target.id) && nonEmpty(target.deliveryMessageId),
				)
				.map(({ id, deliveryMessageId }) => ({ id, deliveryMessageId }));
		} catch {
			// A cosmetic navigation lookup must not break a message page.
		}
		ownerCache.set(cacheKey, targets);
		return targets;
	}

	// biome-ignore lint/suspicious/noExplicitAny: enriched message JSON transport
	function patchTree(messages: any[]): any[] {
		if (!Array.isArray(messages)) return messages;
		let changed = false;
		const result = messages.map((message) => {
			const children = message?.children?.length ? patchTree(message.children) : message?.children;
			let contentChanged = false;
			const callsById = new Map(
				// biome-ignore lint/suspicious/noExplicitAny: DB relation transport
				(message?.toolCalls ?? []).map((tc: any) => [tc.id, tc] as const),
			);
			const contentJson = Array.isArray(message?.contentJson)
				? message.contentJson.map((block: Record<string, unknown>) => {
						if (
							block?.type !== "tool_use" ||
							block.name !== "Send" ||
							block.outputJson != null ||
							[
								"success",
								"completed",
								"fail",
								"failed",
								"error",
								"cancelled",
								"canceled",
								"aborted",
								"timeout",
								"denied",
							].includes(String(block.status)) ||
							!nonEmpty(block.id)
						)
							return block;
						// tcId identifies the selected execution attempt after enrichToolUseBlocks.
						// Never substitute the viewing narrator (forks can share original messages).
						const tc = callsById.get(block.tcId) as
							| { narratorId?: string; toolUseId?: string; id?: string; executionAttempt?: number }
							| undefined;
						const owner = tc?.narratorId ?? message.narratorId;
						if (!nonEmpty(owner) || (tc?.toolUseId && tc.toolUseId !== block.id)) return block;
						const toolCallId = tc?.id ?? block.tcId;
						const attempt = tc?.executionAttempt ?? block.executionAttempt;
						const binding =
							nonEmpty(toolCallId) && typeof attempt === "number"
								? { toolCallId, attempt }
								: undefined;
						const targets = readTargets(owner, block.id, binding);
						if (!targets.length) return block;
						contentChanged = true;
						return { ...block, [SEND_DELIVERY_TARGETS_FIELD]: targets };
					})
				: message?.contentJson;
			if (!contentChanged && children === message?.children) return message;
			changed = true;
			return {
				...message,
				contentJson: contentChanged ? contentJson : message.contentJson,
				children,
			};
		});
		return changed ? result : messages;
	}
	return patchTree(tree);
}
