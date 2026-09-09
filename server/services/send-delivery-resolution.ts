import type { SendDeliveryTarget as StableSendDeliveryTarget } from "@shared/communication-tool";
import type { ToolCallBinding } from "../lib/agent/types";
import {
	getActiveSendDeliveryTargetCount,
	getActiveSendDeliveryTargets,
} from "./agent-reply-waiter";

/** A receipt reserves a message id; it does NOT promise the queued message exists yet. */
export interface SendDeliveryTarget extends StableSendDeliveryTarget {
	id: string;
	deliveryMessageId: string;
	title?: string | null;
	injectionConsumedAt?: string;
}

export interface SendTargetDetails extends StableSendDeliveryTarget {
	id: string;
	deliveryMessageId?: string;
	title?: string | null;
	injectionConsumedAt?: string;
}

export const SEND_DELIVERY_TARGETS_FIELD = "_sendDeliveryTargets";

type DeliveryLookup = (
	requesterId: string,
	toolUseId: string,
	binding?: ToolCallBinding,
) => ReadonlyArray<SendTargetDetails>;

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Best-effort navigation-only frame. Never claims tool completion or message persistence. */
export async function broadcastSendDeliveryResolved(
	narratorId: string,
	toolUseId: string,
	targets: readonly SendDeliveryTarget[],
	toolCallBinding?: ToolCallBinding,
	targetCount?: number,
): Promise<void> {
	if (!targets.length && targetCount == null) return;
	try {
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		const frame = {
			type: "send_delivery_resolved" as const,
			narratorId,
			toolUseId,
			targets: [...targets],
			...(targetCount != null ? { targetCount } : {}),
			...(toolCallBinding ? { toolCallBinding } : {}),
		};
		broadcastToNarrator(narratorId, frame);
		// A child's outgoing Send can also be present in the parent's loaded tree.
		// Resolve that placement by the exact bound call, never a reused provider id.
		if (toolCallBinding) {
			const [
				{ db },
				{ narrators, narratorToolCalls, narratorMessages },
				{ and, eq },
				{ isSubagentVariant },
			] = await Promise.all([
				import("../db"),
				import("../db/schema"),
				import("drizzle-orm"),
				import("../lib/narrator-utils"),
			]);
			const [owner] = await db
				.select({
					parentNarratorId: narrators.parentNarratorId,
					variant: narrators.variant,
					parentToolUseId: narratorMessages.parentToolUseId,
				})
				.from(narratorToolCalls)
				.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
				.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
				.where(
					and(
						eq(narratorToolCalls.id, toolCallBinding.toolCallId),
						eq(narratorToolCalls.executionAttempt, toolCallBinding.attempt),
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, toolUseId),
					),
				)
				.limit(1);
			if (
				owner?.parentNarratorId &&
				owner.parentToolUseId &&
				isSubagentVariant(owner.variant ?? "")
			) {
				broadcastToNarrator(owner.parentNarratorId, {
					...frame,
					narratorId: owner.parentNarratorId,
					parentToolUseId: owner.parentToolUseId,
				});
			}
		}
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
				.map((target) => ({ ...target }));
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
						const targetCount = getActiveSendDeliveryTargetCount(owner, block.id, binding);
						if (!targets.length && targetCount == null) return block;
						contentChanged = true;
						return {
							...block,
							...(targets.length ? { [SEND_DELIVERY_TARGETS_FIELD]: targets } : {}),
							...(targetCount != null ? { _sendDeliveryTargetCount: targetCount } : {}),
						};
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

const DETAIL_BATCH_SIZE = 128;
function record(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function detailKey(target: SendTargetDetails): string {
	return JSON.stringify([
		target.id,
		target.deliveryId ?? target.deliveryMessageId ?? null,
		target.deliveryId ? (target.revision ?? 1) : null,
	]);
}

/** Narrow, indexed page-local lookups. No message bodies, history scans, or N+1 queries. */
export async function loadSendTargetDetails(
	targets: readonly SendTargetDetails[],
	database?: typeof import("../db").db,
): Promise<SendTargetDetails[]> {
	if (!targets.length) return [];
	const [
		{ db },
		{ narrators, narratorMessageRefs, narratorBufferedMessages: mailbox },
		{ and, eq, inArray, or },
	] = await Promise.all([
		database ? Promise.resolve({ db: database }) : import("../db"),
		import("../db/schema"),
		import("drizzle-orm"),
	]);
	const titles = new Map<string, string | null>();
	const consumed = new Map<string, string>();
	const stableDetails = new Map<string, SendTargetDetails>();
	const ids = [...new Set(targets.map((target) => target.id))];
	for (let start = 0; start < ids.length; start += DETAIL_BATCH_SIZE) {
		const batch = ids.slice(start, start + DETAIL_BATCH_SIZE);
		const rows = await db
			.select({ id: narrators.id, title: narrators.title })
			.from(narrators)
			.where(inArray(narrators.id, batch))
			.limit(DETAIL_BATCH_SIZE);
		for (const row of rows) titles.set(row.id, row.title);
	}
	const receipts = targets.filter(
		(target) => !target.deliveryId && nonEmpty(target.deliveryMessageId),
	);
	for (let start = 0; start < receipts.length; start += DETAIL_BATCH_SIZE) {
		const batch = receipts.slice(start, start + DETAIL_BATCH_SIZE);
		const rows = await db
			.select({
				id: narratorMessageRefs.narratorId,
				deliveryMessageId: narratorMessageRefs.messageId,
				injectionConsumedAt: narratorMessageRefs.injectionConsumedAt,
				deliveryId: mailbox.deliveryId,
				recipientRefId: mailbox.recipientRefId,
				revision: mailbox.contentRevision,
				receiptDisposition: mailbox.receiptDisposition,
				adoptedAt: mailbox.adoptedAt,
				adoptedRevision: mailbox.adoptedRevision,
			})
			.from(narratorMessageRefs)
			.leftJoin(
				mailbox,
				and(
					eq(mailbox.narratorId, narratorMessageRefs.narratorId),
					eq(mailbox.recipientRefId, narratorMessageRefs.id),
				),
			)
			.where(
				or(
					...batch.map((target) =>
						and(
							eq(narratorMessageRefs.narratorId, target.id),
							eq(narratorMessageRefs.messageId, target.deliveryMessageId as string),
						),
					),
				),
			)
			.limit(DETAIL_BATCH_SIZE);
		for (const row of rows) {
			if (row.deliveryId && row.revision != null && row.receiptDisposition) {
				stableDetails.set(detailKey({ id: row.id, deliveryMessageId: row.deliveryMessageId }), {
					id: row.id,
					deliveryMessageId: row.deliveryMessageId,
					deliveryId: row.deliveryId,
					recipientRefId: row.recipientRefId ?? undefined,
					revision: row.revision,
					receiptDisposition: row.receiptDisposition,
					...(row.adoptedRevision === row.revision && row.adoptedAt
						? { injectionConsumedAt: row.adoptedAt }
						: {}),
				});
			}
			if (!row.deliveryId && row.injectionConsumedAt)
				consumed.set(
					detailKey({ id: row.id, deliveryMessageId: row.deliveryMessageId }),
					row.injectionConsumedAt.toISOString(),
				);
		}
	}
	const stableTargets = targets.filter(
		(target) =>
			nonEmpty(target.deliveryId) ||
			(!stableDetails.has(detailKey(target)) && nonEmpty(target.deliveryMessageId)),
	);
	for (let start = 0; start < stableTargets.length; start += DETAIL_BATCH_SIZE) {
		const batch = stableTargets.slice(start, start + DETAIL_BATCH_SIZE);
		const rows = await db
			.select({
				deliveryId: mailbox.deliveryId,
				id: mailbox.narratorId,
				deliveryMessageId: mailbox.currentMessageId,
				recipientMessageId: mailbox.recipientMessageId,
				recipientRefId: mailbox.recipientRefId,
				revision: mailbox.contentRevision,
				receiptDisposition: mailbox.receiptDisposition,
				adoptedRevision: mailbox.adoptedRevision,
				adoptedAt: mailbox.adoptedAt,
			})
			.from(mailbox)
			.where(
				or(
					...batch.map((target) =>
						target.deliveryId
							? eq(mailbox.deliveryId, target.deliveryId)
							: and(
									eq(mailbox.narratorId, target.id),
									eq(mailbox.recipientMessageId, target.deliveryMessageId as string),
								),
					),
				),
			)
			.limit(DETAIL_BATCH_SIZE);
		for (const row of rows) {
			const target = batch.find(
				(target) =>
					(target.deliveryId
						? target.deliveryId === row.deliveryId
						: target.deliveryMessageId === row.recipientMessageId) &&
					target.id === row.id &&
					(target.revision ?? 1) === row.revision,
			);
			if (!target) continue;
			stableDetails.set(detailKey(target), {
				...target,
				deliveryId: row.deliveryId ?? undefined,
				deliveryMessageId:
					row.deliveryMessageId ?? row.recipientMessageId ?? target.deliveryMessageId,
				recipientRefId: row.recipientRefId ?? undefined,
				revision: row.revision,
				receiptDisposition: row.receiptDisposition,
				...(row.adoptedRevision === row.revision && row.adoptedAt
					? { injectionConsumedAt: row.adoptedAt }
					: {}),
			});
		}
	}
	return targets.map((target) => ({
		...target,
		...(titles.has(target.id) ? { title: titles.get(target.id) } : {}),
		...(!target.deliveryId && consumed.has(detailKey(target))
			? { injectionConsumedAt: consumed.get(detailKey(target)) }
			: {}),
		...stableDetails.get(detailKey(target)),
	}));
}

/** Enrich both finished and running Send/TeamStatus without modifying returned tool output. */
export async function attachSendTargetDetails(
	// biome-ignore lint/suspicious/noExplicitAny: message transport
	tree: any[],
	lookup: (
		targets: readonly SendTargetDetails[],
	) => Promise<SendTargetDetails[]> = loadSendTargetDetails,
	// biome-ignore lint/suspicious/noExplicitAny: message transport
): Promise<any[]> {
	const requests = new Map<string, SendTargetDetails>();
	const targetsByBlock = new Map<object, SendTargetDetails[]>();
	// biome-ignore lint/suspicious/noExplicitAny: message transport
	function collect(messages: any[]): void {
		for (const message of messages) {
			for (const block of Array.isArray(message?.contentJson) ? message.contentJson : []) {
				if (block?.type !== "tool_use" || (block.name !== "Send" && block.name !== "TeamStatus"))
					continue;
				const input = record(block.inputJson ?? block.input);
				if (block.name === "TeamStatus" && input.action !== "send" && input.action !== "broadcast")
					continue;
				const metadata = record(block._metadata ?? record(block.outputJson)._metadata);
				const source = Array.isArray(metadata.targets)
					? metadata.targets
					: block[SEND_DELIVERY_TARGETS_FIELD];
				if (!Array.isArray(source)) continue;
				const targets: SendTargetDetails[] = source.flatMap((value) => {
					const target = record(value);
					if (!nonEmpty(target.id)) return [];
					return [
						{
							id: target.id,
							...(nonEmpty(target.deliveryId)
								? {
										deliveryId: target.deliveryId,
										revision: typeof target.revision === "number" ? target.revision : 1,
									}
								: {}),
							...(nonEmpty(target.recipientRefId) ? { recipientRefId: target.recipientRefId } : {}),
							...(nonEmpty(target.deliveryMessageId)
								? { deliveryMessageId: target.deliveryMessageId }
								: {}),
						},
					];
				});
				if (!targets.length) continue;
				targetsByBlock.set(block, targets);
				for (const target of targets) requests.set(detailKey(target), target);
			}
			if (message?.children?.length) collect(message.children);
		}
	}
	collect(tree);
	if (!requests.size) return tree;
	let loaded: SendTargetDetails[];
	try {
		loaded = await lookup([...requests.values()]);
	} catch {
		// Receipt enrichment is optional: a failed lookup must not fail the conversation page.
		return tree;
	}
	const details = new Map(loaded.map((target) => [detailKey(target), target]));
	// Upgrading a legacy address to a stable identity changes its key; preserve the requested alias.
	const requested = [...requests.values()];
	for (let index = 0; index < requested.length; index++) {
		const original = requested[index];
		const resolved = loaded[index];
		if (resolved?.id === original.id && !original.deliveryId && resolved.deliveryId)
			details.set(detailKey(original), resolved);
	}
	// biome-ignore lint/suspicious/noExplicitAny: message transport
	function patch(messages: any[]): any[] {
		let changed = false;
		const result = messages.map((message) => {
			const children = message?.children?.length ? patch(message.children) : message?.children;
			let contentChanged = false;
			const contentJson = Array.isArray(message?.contentJson)
				? message.contentJson.map((block: object) => {
						const targets = targetsByBlock.get(block);
						if (!targets) return block;
						contentChanged = true;
						return {
							...block,
							[SEND_DELIVERY_TARGETS_FIELD]: targets.map(
								(target) => details.get(detailKey(target)) ?? target,
							),
						};
					})
				: message?.contentJson;
			if (!contentChanged && children === message?.children) return message;
			changed = true;
			return { ...message, contentJson, children };
		});
		return changed ? result : messages;
	}
	return patch(tree);
}
