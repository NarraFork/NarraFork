import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../db";
import type { narratorMessageRefs, narratorMessages } from "../db/schema";
import {
	narratorMessageRefs as messageRefs,
	narratorMessages as messages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { generateId } from "../lib/id";
import type { DeliveryState } from "./agent-runtime/mailbox-types";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DeliveryKind = "user_input" | "agent_message" | "task_notice";

export interface CanonicalMessageDraft {
	narratorId: string;
	messageId: string;
	role: "user" | "sys";
	contentJson: unknown;
	contentText: string;
	parentToolUseId?: string | null;
	commandText?: string | null;
	createdBy?: string | null;
	origin?: "user" | "system" | "assistant";
	originLabel?: string | null;
	createdAt?: string;
	deliveryId: string;
	deliveryKind: DeliveryKind;
	deliveryState?: DeliveryState;
}

export interface CanonicalMessageProjection {
	message: typeof narratorMessages.$inferSelect;
	ref: typeof narratorMessageRefs.$inferSelect;
	seq: number;
}

/** Message shape used by eager admission responses and websocket projection events. */
export type CanonicalTreeMessage = typeof narratorMessages.$inferSelect & {
	seq: number;
	deliveryId: string | null;
	deliveryKind: DeliveryKind | null;
	deliveryState: DeliveryState | null;
	children: CanonicalTreeMessage[];
	toolCalls: Array<typeof narratorToolCalls.$inferSelect>;
};

function nextSeq(tx: DbTx, narratorId: string): number {
	const row = tx
		.select({ maxSeq: sql<number | null>`MAX(${messageRefs.seq})` })
		.from(messageRefs)
		.where(eq(messageRefs.narratorId, narratorId))
		.all()[0];
	return (row?.maxSeq ?? -1) + 1;
}

/** Insert one eagerly visible message and its per-narrator delivery projection. */
export function insertCanonicalMessageTx(
	tx: DbTx,
	draft: CanonicalMessageDraft,
): CanonicalMessageProjection {
	const existingRef = tx
		.select()
		.from(messageRefs)
		.where(
			and(
				eq(messageRefs.narratorId, draft.narratorId),
				eq(messageRefs.deliveryId, draft.deliveryId),
			),
		)
		.get();
	if (existingRef) {
		const existingMessage = tx
			.select()
			.from(messages)
			.where(eq(messages.id, existingRef.messageId))
			.get();
		if (!existingMessage) throw new Error("Delivery projection points to missing message");
		return { message: existingMessage, ref: existingRef, seq: existingRef.seq };
	}

	const existingMessage = tx.select().from(messages).where(eq(messages.id, draft.messageId)).get();
	if (existingMessage && existingMessage.narratorId !== draft.narratorId)
		throw new Error("Delivery projection message belongs to another narrator");
	const createdAt = draft.createdAt ?? new Date().toISOString();
	const created =
		existingMessage ??
		tx
			.insert(messages)
			.values({
				id: draft.messageId,
				narratorId: draft.narratorId,
				parentToolUseId: draft.parentToolUseId ?? null,
				role: draft.role,
				contentJson: draft.contentJson,
				contentText: draft.contentText,
				commandText: draft.commandText ?? null,
				createdBy: draft.createdBy ?? null,
				origin: draft.origin ?? (draft.role === "user" ? "user" : "system"),
				originLabel: draft.originLabel ?? null,
				createdAt,
			})
			.returning()
			.get();
	const seq = nextSeq(tx, draft.narratorId);
	const ref = tx
		.insert(messageRefs)
		.values({
			id: generateId(),
			narratorId: draft.narratorId,
			messageId: created.id,
			seq,
			isCompact: 0,
			deliveryId: draft.deliveryId,
			deliveryKind: draft.deliveryKind,
			deliveryState: draft.deliveryState ?? "queued",
		})
		.returning()
		.get();

	tx.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			messageCount: sql`COALESCE(${narrators.messageCount}, 0) + 1`,
			updatedAt: createdAt,
		})
		.where(eq(narrators.id, draft.narratorId))
		.run();
	return { message: created, ref, seq };
}

export function findCanonicalProjectionTx(
	tx: DbTx,
	narratorId: string,
	deliveryId: string,
): CanonicalMessageProjection | null {
	const ref = tx
		.select()
		.from(messageRefs)
		.where(and(eq(messageRefs.narratorId, narratorId), eq(messageRefs.deliveryId, deliveryId)))
		.get();
	if (!ref) return null;
	const message = tx.select().from(messages).where(eq(messages.id, ref.messageId)).get();
	if (!message) return null;
	return { message, ref, seq: ref.seq };
}

const MAX_ENQUEUE_TREE_NODES = 256;

type MessageTreeReadTx = DbTx;

/**
 * Read one canonical projection in the same narrator scope as its ref.
 *
 * This is intentionally a synchronous, bounded read: admission responses need to
 * return the canonical row immediately, but must not use mailbox payload as a second
 * message source. New mailbox rows have no children; the recursive path is for a
 * duplicate of a message that already owns tool-call children.
 */
export function readCanonicalMessageTreeTx(
	tx: MessageTreeReadTx,
	narratorId: string,
	deliveryId: string,
): CanonicalTreeMessage | null {
	const projection = findCanonicalProjectionTx(tx, narratorId, deliveryId);
	if (!projection) return null;

	const build = (
		messageId: string,
		ref: typeof narratorMessageRefs.$inferSelect,
		seen: Set<string>,
	): CanonicalTreeMessage => {
		if (seen.has(messageId)) throw new Error("Canonical message tree contains a cycle");
		if (seen.size >= MAX_ENQUEUE_TREE_NODES)
			throw new Error("Canonical message tree exceeds eager response limit");
		const nextSeen = new Set(seen).add(messageId);
		const message = tx.select().from(messages).where(eq(messages.id, messageId)).get();
		if (!message || message.narratorId !== narratorId)
			throw new Error("Delivery projection points to missing message");
		const toolCalls = tx
			.select()
			.from(narratorToolCalls)
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.messageId, messageId),
				),
			)
			.all();
		const toolUseIds = toolCalls.map((call) => call.toolUseId);
		const children = toolUseIds.length
			? tx
					.select({ message: messages, ref: messageRefs })
					.from(messageRefs)
					.innerJoin(messages, eq(messageRefs.messageId, messages.id))
					.where(
						and(
							eq(messageRefs.narratorId, narratorId),
							eq(messages.narratorId, narratorId),
							inArray(messages.parentToolUseId, toolUseIds),
						),
					)
					.orderBy(messageRefs.seq)
					.all()
					.map(({ message: child, ref: childRef }) => build(child.id, childRef, nextSeen))
			: [];
		return {
			...message,
			seq: ref.seq,
			deliveryId: ref.deliveryId,
			deliveryKind: ref.deliveryKind,
			deliveryState: ref.deliveryState,
			children,
			toolCalls,
		};
	};
	return build(projection.message.id, projection.ref, new Set());
}

/** Update the canonical content, cloning the message when another narrator ref shares it. */
export function updateCanonicalMessageTx(
	tx: DbTx,
	input: {
		narratorId: string;
		deliveryId: string;
		contentJson: unknown;
		contentText: string;
		commandText?: string | null;
	},
): CanonicalMessageProjection | null {
	const projection = findCanonicalProjectionTx(tx, input.narratorId, input.deliveryId);
	if (!projection) return null;
	const refs = tx
		.select({ id: messageRefs.id })
		.from(messageRefs)
		.where(eq(messageRefs.messageId, projection.message.id))
		.limit(2)
		.all();
	const values = {
		contentJson: input.contentJson,
		contentText: input.contentText,
		commandText: input.commandText ?? null,
	};
	let messageId = projection.message.id;
	if (refs.length > 1) {
		messageId = generateId();
		tx.insert(messages)
			.values({
				...projection.message,
				...values,
				id: messageId,
				narratorId: input.narratorId,
			})
			.run();
		const toolCalls = tx
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.messageId, projection.message.id))
			.all();
		for (const call of toolCalls) {
			tx.insert(narratorToolCalls)
				.values({
					...call,
					id: generateId(),
					messageId,
					executionOriginToolCallId: call.executionOriginToolCallId ?? call.id,
				})
				.run();
		}
		tx.update(messageRefs)
			.set({ messageId })
			.where(
				and(
					eq(messageRefs.id, projection.ref.id),
					eq(messageRefs.narratorId, input.narratorId),
					eq(messageRefs.messageId, projection.message.id),
				),
			)
			.run();
	} else {
		tx.update(messages).set(values).where(eq(messages.id, messageId)).run();
	}
	tx.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(narrators.id, input.narratorId))
		.run();
	const updated = tx.select().from(messages).where(eq(messages.id, messageId)).get();
	const ref = tx.select().from(messageRefs).where(eq(messageRefs.id, projection.ref.id)).get();
	if (!updated || !ref) return null;
	return { message: updated, ref, seq: ref.seq };
}

/** Remove one pending recipient ref and its now-unreferenced canonical message. */
export function deleteCanonicalProjectionTx(
	tx: DbTx,
	narratorId: string,
	refId: string,
): { removedRef: boolean; removedMessage: boolean } {
	const ref = tx
		.select()
		.from(messageRefs)
		.where(and(eq(messageRefs.id, refId), eq(messageRefs.narratorId, narratorId)))
		.get();
	if (!ref) return { removedRef: false, removedMessage: false };
	const deletedRef = tx
		.delete(messageRefs)
		.where(and(eq(messageRefs.id, refId), eq(messageRefs.narratorId, narratorId)))
		.returning({ id: messageRefs.id })
		.all().length;
	if (!deletedRef) return { removedRef: false, removedMessage: false };
	tx.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			messageCount: sql`MAX(COALESCE(${narrators.messageCount}, 0) - 1, 0)`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(narrators.id, narratorId))
		.run();
	const refsLeft = tx
		.select({ id: messageRefs.id })
		.from(messageRefs)
		.where(eq(messageRefs.messageId, ref.messageId))
		.limit(1)
		.get();
	if (refsLeft) return { removedRef: true, removedMessage: false };
	const toolCall = tx
		.select({ id: narratorToolCalls.id })
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.messageId, ref.messageId))
		.limit(1)
		.get();
	if (toolCall) return { removedRef: true, removedMessage: false };
	const removedMessage = tx
		.delete(messages)
		.where(eq(messages.id, ref.messageId))
		.returning({ id: messages.id })
		.all().length;
	return { removedRef: true, removedMessage: removedMessage > 0 };
}
