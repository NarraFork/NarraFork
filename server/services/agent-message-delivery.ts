import type { SideCarBody } from "@shared/sidecar-body";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db as historyReceiptDb } from "../db";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { AgentMessageSender } from "./agent-message-origin";
import { createMailboxStore } from "./agent-runtime/mailbox";
import type { MailboxClaim } from "./agent-runtime/mailbox-types";

/** An exact delivery, never inferred from model text or a text hash. */
export interface AgentMessageDelivery {
	recipientNarratorId: string;
	recipientMessageId: string;
	deliveryId?: string;
	recipientRefId?: string;
	revision?: number;
	mailboxClaim?: MailboxClaim;
	sender: AgentMessageSender;
	fromToolUseId: string;
	senderToolCallBinding?: ToolCallBinding;
	/** Reader-facing body, before sender prefixes and reply-request instructions. */
	text: string;
}

export function createAgentMessageDelivery(
	recipientNarratorId: string,
	sender: AgentMessageSender,
	fromToolUseId: string,
	text: string,
	senderToolCallBinding?: ToolCallBinding,
): AgentMessageDelivery {
	return {
		recipientNarratorId,
		recipientMessageId: generateId(),
		sender: { ...sender },
		fromToolUseId,
		text,
		...(senderToolCallBinding ? { senderToolCallBinding: { ...senderToolCallBinding } } : {}),
	};
}

/** Only the exact recipient ref may be acknowledged; neither the sender row nor a fork. */
export type AgentMessageConsumption = Pick<
	AgentMessageDelivery,
	| "recipientNarratorId"
	| "recipientMessageId"
	| "fromToolUseId"
	| "senderToolCallBinding"
	| "deliveryId"
	| "recipientRefId"
	| "revision"
> & { senderNarratorId: string; mailboxOnly?: boolean; currentRevisionOnly?: boolean };

export interface MailboxDeliveryConsumption {
	deliveryId: string;
	recipientNarratorId: string;
	recipientMessageId?: string;
	recipientRefId?: string;
	revision: number;
}

/** Shared adoption bookkeeping for user_input/task_notice, never a model-input queue. */
export function markMailboxDeliveryConsumed(
	delivery: MailboxDeliveryConsumption,
	consumedAt = new Date(),
): Promise<void> {
	return markAgentMessageConsumed(
		{
			...delivery,
			recipientMessageId: delivery.recipientMessageId ?? "",
			senderNarratorId: "",
			fromToolUseId: "",
			mailboxOnly: true,
		},
		consumedAt,
	);
}
export function consumeMailboxDelivery(delivery: MailboxDeliveryConsumption): void {
	void markMailboxDeliveryConsumed(delivery);
}

const MAX_CONSUMED_CACHE_ENTRIES = 4096;
const MAX_PENDING_CONSUMPTIONS = 4096;
const CONSUMPTION_WRITE_BATCH_SIZE = 16;
const consumedCache = new Set<string>();
const pendingConsumptions = new Map<string, Promise<void>>();
const consumptionQueue: Array<{
	key: string;
	delivery: AgentMessageConsumption;
	consumedAt: Date;
	resolve: () => void;
}> = [];
let drainingConsumptions = false;
let lastQueueOverflowWarningAt = 0;

/**
 * Best effort bookkeeping AFTER adoption into model input. The bounded queue deduplicates
 * concurrent/rebuilt inputs and yields every small write batch. It never queues model input.
 * Failed/missing rows are not cached, so a later history adoption can repair their receipt.
 */
export function markAgentMessageConsumed(
	delivery: AgentMessageConsumption,
	consumedAt = new Date(),
): Promise<void> {
	const key = JSON.stringify([
		delivery.recipientNarratorId,
		delivery.deliveryId ?? delivery.recipientMessageId,
		delivery.revision ?? null,
		delivery.currentRevisionOnly ? "current" : "original",
	]);
	if (consumedCache.has(key)) {
		consumedCache.delete(key);
		consumedCache.add(key);
		return Promise.resolve();
	}
	const pending = pendingConsumptions.get(key);
	if (pending) return pending;
	if (pendingConsumptions.size >= MAX_PENDING_CONSUMPTIONS) {
		if (Date.now() - lastQueueOverflowWarningAt > 60_000) {
			lastQueueOverflowWarningAt = Date.now();
			logger.warn("Agent consumption receipt queue is full; input will not be redelivered", {
				limit: MAX_PENDING_CONSUMPTIONS,
			});
		}
		return Promise.resolve();
	}
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	pendingConsumptions.set(key, promise);
	consumptionQueue.push({
		key,
		// Retain coordinates only, never the potentially large model/display text.
		delivery: {
			recipientNarratorId: delivery.recipientNarratorId,
			recipientMessageId: delivery.recipientMessageId,
			...(delivery.deliveryId ? { deliveryId: delivery.deliveryId } : {}),
			...(delivery.mailboxOnly ? { mailboxOnly: true } : {}),
			...(delivery.currentRevisionOnly ? { currentRevisionOnly: true } : {}),
			...(delivery.recipientRefId ? { recipientRefId: delivery.recipientRefId } : {}),
			...(delivery.revision != null ? { revision: delivery.revision } : {}),
			senderNarratorId: delivery.senderNarratorId,
			fromToolUseId: delivery.fromToolUseId,
			...(delivery.senderToolCallBinding
				? { senderToolCallBinding: { ...delivery.senderToolCallBinding } }
				: {}),
		},
		consumedAt: new Date(consumedAt),
		resolve,
	});
	void drainConsumptionWrites();
	return promise;
}

async function drainConsumptionWrites(): Promise<void> {
	if (drainingConsumptions) return;
	drainingConsumptions = true;
	try {
		while (consumptionQueue.length) {
			const batch = consumptionQueue.splice(0, CONSUMPTION_WRITE_BATCH_SIZE);
			const startedAt = Date.now();
			for (const entry of batch) {
				try {
					if (await persistAgentMessageConsumption(entry.delivery, entry.consumedAt)) {
						consumedCache.add(entry.key);
						if (consumedCache.size > MAX_CONSUMED_CACHE_ENTRIES) {
							const oldest = consumedCache.values().next().value;
							if (oldest) consumedCache.delete(oldest);
						}
					}
				} catch (error) {
					logger.warn("Agent consumption bookkeeping failed", { error: String(error) });
				} finally {
					pendingConsumptions.delete(entry.key);
					entry.resolve();
				}
			}
			if (Date.now() - startedAt > 1000) {
				logger.warn("Slow agent consumption receipt batch", {
					count: batch.length,
					durationMs: Date.now() - startedAt,
				});
			}
			if (consumptionQueue.length) await new Promise((resolve) => setTimeout(resolve, 0));
		}
	} finally {
		drainingConsumptions = false;
	}
}

/** Indexed CAS plus reconnect invalidation; retries are receipts only, never delivery. */
async function persistAgentMessageConsumption(
	delivery: AgentMessageConsumption,
	consumedAt: Date,
): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { db } = await import("../db");
			const candidateRef = db
				.select({ id: narratorMessageRefs.id })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, delivery.recipientNarratorId),
						delivery.recipientRefId
							? eq(narratorMessageRefs.id, delivery.recipientRefId)
							: eq(narratorMessageRefs.messageId, delivery.recipientMessageId),
					),
				)
				.get();
			if (!candidateRef && !delivery.deliveryId) return false;
			const stable =
				delivery.deliveryId || candidateRef
					? db
							.select({
								deliveryId: narratorBufferedMessages.deliveryId,
								kind: narratorBufferedMessages.kind,
								narratorId: narratorBufferedMessages.narratorId,
								refId: narratorBufferedMessages.recipientRefId,
								messageId: narratorBufferedMessages.currentMessageId,
								revision: narratorBufferedMessages.contentRevision,
								currentRevision: narratorBufferedMessages.currentRevision,
								disposition: narratorBufferedMessages.receiptDisposition,
								sourceNarratorId: narratorBufferedMessages.sourceNarratorId,
								sourceToolCallId: narratorBufferedMessages.sourceToolCallId,
								sourceAttempt: narratorBufferedMessages.sourceAttempt,
							})
							.from(narratorBufferedMessages)
							.where(
								delivery.deliveryId
									? eq(narratorBufferedMessages.deliveryId, delivery.deliveryId)
									: and(
											eq(narratorBufferedMessages.narratorId, delivery.recipientNarratorId),
											eq(narratorBufferedMessages.recipientRefId, candidateRef?.id ?? ""),
										),
							)
							.get()
					: undefined;
			if (delivery.deliveryId && !stable) return false;
			if (delivery.currentRevisionOnly) {
				if (
					!stable?.deliveryId ||
					!stable.refId ||
					stable.narratorId !== delivery.recipientNarratorId ||
					stable.refId !== delivery.recipientRefId ||
					stable.currentRevision !== delivery.revision ||
					stable.disposition === "recipient_deleted"
				)
					return false;
				return createMailboxStore(db).ackCurrentAdopted(
					stable.deliveryId,
					delivery.recipientNarratorId,
					stable.refId,
					stable.currentRevision,
					consumedAt.toISOString(),
				);
			}
			if (
				stable &&
				(stable.narratorId !== delivery.recipientNarratorId ||
					stable.disposition !== "active" ||
					!stable.refId ||
					!stable.messageId ||
					(delivery.revision != null && stable.revision !== delivery.revision) ||
					(delivery.recipientRefId != null && stable.refId !== delivery.recipientRefId) ||
					(!delivery.mailboxOnly &&
						stable.sourceNarratorId != null &&
						stable.sourceNarratorId !== delivery.senderNarratorId) ||
					(delivery.senderToolCallBinding != null &&
						(stable.sourceToolCallId !== delivery.senderToolCallBinding.toolCallId ||
							stable.sourceAttempt !== delivery.senderToolCallBinding.attempt)))
			)
				return false;
			const exactRef = and(
				eq(narratorMessageRefs.narratorId, delivery.recipientNarratorId),
				stable?.refId
					? eq(narratorMessageRefs.id, stable.refId)
					: eq(narratorMessageRefs.messageId, delivery.recipientMessageId),
			);
			const readReceipt = () =>
				db
					.select({ consumedAt: narratorMessageRefs.injectionConsumedAt })
					.from(narratorMessageRefs)
					.where(exactRef)
					.get();
			const existing = readReceipt();
			if (!existing) return false;
			if (existing.consumedAt != null) {
				// Upgrade pre-mailbox acknowledgement without changing its timestamp or re-invalidating pages.
				if (stable?.deliveryId && stable.refId)
					return createMailboxStore(db).ackAdopted(
						stable.deliveryId,
						delivery.recipientNarratorId,
						stable.refId,
						stable.revision,
						existing.consumedAt.toISOString(),
					);
				return true;
			}
			if (delivery.mailboxOnly && stable?.kind !== "agent_message") {
				return (
					!!stable?.deliveryId &&
					!!stable.refId &&
					createMailboxStore(db).ackAdopted(
						stable.deliveryId,
						delivery.recipientNarratorId,
						stable.refId,
						stable.revision,
						consumedAt.toISOString(),
					)
				);
			}
			const senderId = stable?.sourceNarratorId ?? delivery.senderNarratorId;
			const senderBinding =
				delivery.senderToolCallBinding ??
				(stable?.sourceToolCallId && stable.sourceAttempt
					? { toolCallId: stable.sourceToolCallId, attempt: stable.sourceAttempt }
					: undefined);
			const senderToolUseId =
				delivery.fromToolUseId ||
				(senderBinding
					? db
							.select({ id: narratorToolCalls.toolUseId })
							.from(narratorToolCalls)
							.where(
								and(
									eq(narratorToolCalls.id, senderBinding.toolCallId),
									eq(narratorToolCalls.executionAttempt, senderBinding.attempt),
								),
							)
							.get()?.id
					: undefined);
			const changed = db.transaction((tx) => {
				const receipt =
					stable?.deliveryId && stable.refId
						? createMailboxStore(db).ackAdopted(
								stable.deliveryId,
								delivery.recipientNarratorId,
								stable.refId,
								stable.revision,
								consumedAt.toISOString(),
							)
						: tx
								.update(narratorMessageRefs)
								.set({ injectionConsumedAt: consumedAt })
								.where(
									and(
										eq(narratorMessageRefs.narratorId, delivery.recipientNarratorId),
										eq(narratorMessageRefs.messageId, delivery.recipientMessageId),
										isNull(narratorMessageRefs.injectionConsumedAt),
									),
								)
								.returning({ id: narratorMessageRefs.id })
								.get();
				if (!receipt) return false;
				// A lost WS frame must be repaired by incremental reconnect. Follow the
				// existing message-version invalidation protocol without rewriting Send's
				// output or terminal state. The source subagent's parent renders its card too.
				const sender = tx
					.select({
						type: narrators.type,
						parentNarratorId: narrators.parentNarratorId,
					})
					.from(narrators)
					.where(eq(narrators.id, senderId))
					.get();
				const ids = new Set([senderId]);
				if (sender?.type === "subagent" && sender.parentNarratorId)
					ids.add(sender.parentNarratorId);
				tx.update(narrators)
					.set({
						messageVersion: sql`${narrators.messageVersion} + 1`,
						updatedAt: new Date().toISOString(),
					})
					.where(inArray(narrators.id, [...ids]))
					.run();
				return true;
			});
			if (changed && senderToolUseId) {
				const { broadcastSendDeliveryResolved } = await import("./send-delivery-resolution");
				await broadcastSendDeliveryResolved(
					senderId,
					senderToolUseId,
					[
						{
							id: delivery.recipientNarratorId,
							deliveryMessageId: stable?.messageId ?? delivery.recipientMessageId,
							...(stable
								? {
										deliveryId: stable.deliveryId ?? undefined,
										recipientRefId: stable.refId ?? undefined,
										revision: stable.revision,
									}
								: {}),
							injectionConsumedAt: consumedAt.toISOString(),
						},
					],
					senderBinding,
				);
			}
			return changed || readReceipt()?.consumedAt != null;
		} catch (error) {
			if (attempt === 2) {
				logger.warn("Failed to record adopted agent injection; delivery will not be repeated", {
					...delivery,
					error: String(error),
				});
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
		}
	}
	return false;
}

// A history identity represents exactly one build's source rows, not all rows that happen
// to exist by the time a request starts. Weak keys cannot retain completed conversations.
const historyConsumptions = new WeakMap<
	unknown[],
	Array<AgentMessageConsumption & { currentInputText?: string }>
>();

/** Register candidates only. Loading/compacting/preparing history is NOT consumption. */
export function trackAgentMessageHistory(
	narratorId: string,
	history: unknown[],
	messages: readonly {
		id: string;
		narratorId?: string;
		parentToolUseId?: string | null;
		role?: string;
		injectionConsumedAt?: Date | string | null;
		contentJson: unknown;
	}[],
	trailingUserText?: string,
): void {
	const deliveries: Array<AgentMessageConsumption & { currentInputText?: string }> = [];
	const modelMessages = messages.filter(
		(message) =>
			!message.parentToolUseId &&
			(message.role === "user" || message.role === "assistant" || message.role === "sys"),
	);
	// Builders pop the final user row (after any extracted sys tail). It only counts
	// if this request really carries that row as current input, not a different prompt.
	let lastNonSystem = modelMessages.length - 1;
	while (trailingUserText && modelMessages[lastNonSystem]?.role === "sys") lastNonSystem--;
	const poppedUser =
		modelMessages[lastNonSystem]?.role === "user" ? modelMessages[lastNonSystem] : undefined;
	for (const message of modelMessages) {
		// Shared fork refs and child subtrees must never acknowledge another recipient.
		if (message.narratorId !== narratorId || message.injectionConsumedAt) continue;
		if (!Array.isArray(message.contentJson)) continue;
		const injectionBlocks = message.contentJson.filter(
			(block) => block?.type === "system_injection" && block.body?.kind === "messages",
		);
		if (!injectionBlocks.length) continue;
		const modelText = message.contentJson
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!modelText) continue;
		const requiresCurrentInput =
			message === poppedUser || (message.role === "sys" && !!trailingUserText?.includes(modelText));
		for (const block of injectionBlocks) {
			if (!Array.isArray(block.body.items)) continue;
			for (const item of block.body.items) {
				if (!item || typeof item.fromId !== "string" || typeof item.fromToolUseId !== "string")
					continue;
				if (item.recipientNarratorId != null && item.recipientNarratorId !== narratorId) continue;
				deliveries.push({
					...(typeof item.deliveryId === "string"
						? {
								deliveryId: item.deliveryId,
								revision: Number.isSafeInteger(item.revision) ? item.revision : 1,
							}
						: {}),
					recipientNarratorId: narratorId,
					recipientMessageId: message.id,
					senderNarratorId: item.fromId,
					fromToolUseId: item.fromToolUseId,
					...(typeof item.fromToolCallBinding?.toolCallId === "string" &&
					Number.isSafeInteger(item.fromToolCallBinding?.attempt)
						? { senderToolCallBinding: { ...item.fromToolCallBinding } }
						: {}),
					...(requiresCurrentInput ? { currentInputText: modelText } : {}),
				});
			}
		}
	}
	// Recover generic mailbox identities only for this build's exact source page. No bodies are loaded.
	// This is essential after a crash between materialization and adoption of a task notice/user input.
	const candidates = modelMessages.filter((message) => !message.injectionConsumedAt);
	try {
		for (let start = 0; start < candidates.length; start += 100) {
			const page = candidates.slice(start, start + 100);
			const rows = historyReceiptDb
				.select({
					messageId: narratorMessageRefs.messageId,
					refId: narratorMessageRefs.id,
					deliveryId: narratorBufferedMessages.deliveryId,
					revision: narratorBufferedMessages.contentRevision,
					currentRevision: narratorBufferedMessages.currentRevision,
					disposition: narratorBufferedMessages.receiptDisposition,
					kind: narratorBufferedMessages.kind,
				})
				.from(narratorMessageRefs)
				.innerJoin(
					narratorBufferedMessages,
					and(
						eq(narratorBufferedMessages.narratorId, narratorId),
						eq(narratorBufferedMessages.recipientRefId, narratorMessageRefs.id),
					),
				)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(
							narratorMessageRefs.messageId,
							page.map((message) => message.id),
						),
						eq(narratorBufferedMessages.state, "materialized"),
						inArray(narratorBufferedMessages.receiptDisposition, ["active", "superseded"]),
					),
				)
				.limit(100)
				.all();
			for (const row of rows) {
				// Agent-message envelopes above retain their exact sender/attempt and WS receipt protocol.
				if (
					!row.deliveryId ||
					(row.disposition === "active" &&
						(row.kind === "agent_message" ||
							deliveries.some((delivery) => delivery.deliveryId === row.deliveryId)))
				)
					continue;
				const message = page.find((message) => message.id === row.messageId);
				if (!message || !Array.isArray(message.contentJson)) continue;
				const text = message.contentJson
					.filter((block) => block?.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("\n")
					.trim();
				if (!text) continue;
				const requiresInput =
					message === poppedUser || (message.role === "sys" && !!trailingUserText?.includes(text));
				deliveries.push({
					recipientNarratorId: narratorId,
					recipientMessageId: row.messageId,
					recipientRefId: row.refId,
					deliveryId: row.deliveryId,
					revision: row.disposition === "superseded" ? row.currentRevision : row.revision,
					...(row.disposition === "superseded" ? { currentRevisionOnly: true } : {}),
					senderNarratorId: "",
					fromToolUseId: "",
					mailboxOnly: true,
					...(requiresInput ? { currentInputText: text } : {}),
				});
			}
		}
	} catch (error) {
		logger.warn("Mailbox history adoption candidates unavailable; input is not redelivered", {
			narratorId,
			error: String(error),
		});
	}
	if (deliveries.length) historyConsumptions.set(history, deliveries);
	else historyConsumptions.delete(history);
}

/** Called exclusively by the execution loop after adopting this history as model input. */
export function consumeAgentMessageHistory(history: unknown[], content: string): void {
	const deliveries = historyConsumptions.get(history);
	historyConsumptions.delete(history);
	for (const { currentInputText, ...delivery } of deliveries ?? []) {
		// Identity comes from the exact structured envelope, never from matching words.
		// This only verifies that a builder-extracted row was not dropped by its caller.
		if (currentInputText && !content.includes(currentInputText)) continue;
		void markAgentMessageConsumed(delivery);
	}
}

export function consumeAgentMessageDelivery(delivery: AgentMessageDelivery): void {
	void markAgentMessageConsumed({ ...delivery, senderNarratorId: delivery.sender.id });
}

export function agentMessageDeliveryBody(delivery: AgentMessageDelivery): SideCarBody {
	return {
		kind: "messages",
		items: [
			{
				fromId: delivery.sender.id,
				fromTitle: delivery.sender.title ?? null,
				fromLabel: delivery.sender.label,
				fromType: delivery.sender.type ?? null,
				fromToolUseId: delivery.fromToolUseId,
				...(delivery.deliveryId
					? {
							deliveryId: delivery.deliveryId,
							recipientNarratorId: delivery.recipientNarratorId,
							revision: delivery.revision ?? 1,
						}
					: {}),
				...(delivery.senderToolCallBinding
					? { fromToolCallBinding: { ...delivery.senderToolCallBinding } }
					: {}),
				text: delivery.text,
			},
		],
	};
}
