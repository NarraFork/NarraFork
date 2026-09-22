import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { alias } from "drizzle-orm/pg-core";
import { withPgRetry } from "../../db/pg-retry";
import {
	narratorMessages as messages,
	narrators,
	narratorToolCalls,
	narratorMessageRefs as refs,
	users,
} from "../../db/postgres-schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { isNarratorSeqFloorHealed, markNarratorSeqFloorHealed } from "./seq-store";

/** After a PG write section commits: mark this process as having raised the narrator floor. */
export function markPgNarratorSeqFloorHealed(narratorId: string): void {
	markNarratorSeqFloorHealed(narratorId);
}

import type {
	NarratorMessageRefsPort,
	RefMessage,
	RefMessageInput,
	RefOperationOptions,
} from "./port";

export type PgNarratorRefsTx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE = 400;
function check(options?: RefOperationOptions) {
	options?.signal?.throwIfAborted();
}

/** Reject oversized/deep inputs before JSON.stringify can monopolize the event loop. */
function validateMessage(message: RefMessageInput): void {
	let bytes = 0;
	let nodes = 0;
	function visit(value: unknown, depth: number): void {
		if (++nodes > 50_000 || depth > 64) throw new Error("Message JSON complexity limit exceeded");
		if (typeof value === "string") {
			if (value.length > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 2 MiB write budget");
			bytes += Buffer.byteLength(value);
		} else if (value && typeof value === "object") {
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				visit(key, depth + 1);
				visit(Reflect.get(value, key), depth + 1);
			}
		} else bytes += 8;
		if (bytes > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 2 MiB write budget");
	}
	visit(message, 0);
	if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES)
		throw new Error("Message exceeds 2 MiB write budget");
}
function seqValue(value: number) {
	if (!Number.isSafeInteger(value) || value < 0 || value > 2147483646)
		throw new Error("Invalid ref seq");
}
function pageSize(value: number) {
	if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE)
		throw new Error("Invalid refs page size");
	return value;
}

/** Same row lock is mandatory before any append/shift/copy read, not just before its write. */
export async function lockPgNarratorRefs(tx: PgNarratorRefsTx, ids: string[]): Promise<void> {
	for (const id of [...new Set(ids)].sort()) {
		const [row] = await tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.id, id))
			.for("update");
		if (!row) throw new Error(`Narrator not found: ${id}`);
	}
}

/**
 * Pure counter claim. Floor repair is the choke point's job: call
 * `initializePgRefSeqFloor` in the same transaction when unhealed, and
 * `markNarratorSeqFloorHealed` only after that transaction commits.
 */
export async function claimNextPgRefSeq(tx: PgNarratorRefsTx, narratorId: string): Promise<number> {
	const [row] = await tx
		.update(narrators)
		.set({ nextSeq: sql`${narrators.nextSeq} + 1` })
		.where(eq(narrators.id, narratorId))
		.returning({ nextSeq: narrators.nextSeq });
	if (!row) throw new Error(`Narrator not found: ${narratorId}`);
	return row.nextSeq - 1;
}

/** In-tx floor raise for unhealed narrators (caller marks after commit). */
export async function raisePgSeqFloorForClaim(
	tx: PgNarratorRefsTx,
	narratorId: string,
): Promise<void> {
	if (isNarratorSeqFloorHealed(narratorId)) return;
	await initializePgRefSeqFloor(tx, narratorId);
}

export async function claimPgShiftInsertSlot(
	tx: PgNarratorRefsTx,
	narratorId: string,
	fromSeq: number,
): Promise<void> {
	seqValue(fromSeq);
	// Floor first (same contract as SQLite claimShiftInsertSlot): shift + greatest
	// next_seq/fromSeq alone does not guarantee next_seq > historical MAX(refs.seq).
	// Callers that already raised in this section hit the healed/in-tx no-op path.
	await raisePgSeqFloorForClaim(tx, narratorId);
	await tx
		.update(narrators)
		.set({ nextSeq: sql`greatest(${narrators.nextSeq}, ${fromSeq})` })
		.where(eq(narrators.id, narratorId));
	await claimNextPgRefSeq(tx, narratorId);
	await tx
		.update(refs)
		.set({ seq: sql`${refs.seq} + 1` })
		.where(and(eq(refs.narratorId, narratorId), gte(refs.seq, fromSeq)));
}

export async function initializePgRefSeqFloor(
	tx: PgNarratorRefsTx,
	narratorId: string,
	reservedFloor = 0,
): Promise<number> {
	await lockPgNarratorRefs(tx, [narratorId]);
	const [top] = await tx
		.select({ seq: refs.seq })
		.from(refs)
		.where(eq(refs.narratorId, narratorId))
		.orderBy(desc(refs.seq))
		.limit(1);
	const floor = Math.max(reservedFloor, (top?.seq ?? -1) + 1);
	const [row] = await tx
		.update(narrators)
		.set({ nextSeq: sql`greatest(${narrators.nextSeq}, ${floor})` })
		.where(eq(narrators.id, narratorId))
		.returning({ nextSeq: narrators.nextSeq });
	return row.nextSeq;
}

/** Identities a committed message/ref append produced, plus the inserted row itself. */
export interface PgPersistedMessageRef {
	messageId: string;
	refId: string;
	seq: number;
	message: RefMessage;
	/** True when this section raised the narrator seq floor; mark healed after commit. */
	needsSeqFloorMark?: boolean;
}

/**
 * THE named transaction-local message/ref append section.
 *
 * Runs INSIDE a caller-owned PostgreSQL transaction — the refs port's own
 * `narratorRefs.insert` section and the PG mailbox materializer seam
 * (`createPgPlacedMessageMaterializer` in `server/services/narrator-persistence.ts`)
 * both compose it, which is why it is a named domain operation and not a generic
 * transaction callback: the set of things that may happen between BEGIN and COMMIT
 * stays enumerable here.
 *
 * In order, in the caller's `tx`:
 *   1. resolve the parent tool_call's narrator (when `parentToolUseId` is set);
 *   2. lock the recipient narrator row (and the parent's) FOR UPDATE;
 *   3. claim the next seq from the narrators counter — or, with
 *      `beforeMessageId`, reserve and shift open the insertion slot;
 *   4. insert the message row and its ref;
 *   5. bump the recipient's messageVersion/messageCount (and structureVersion for
 *      a shift insert), then the parent narrator's messageVersion.
 *
 * A throw anywhere rolls the whole section back: the claimed seq, both inserts and
 * every counter bump. Callers needing whole-section replay wrap this in
 * `withPgRetry` around `db.transaction(...)` — never retry a single statement.
 */
export async function persistPgMessageWithRef(
	tx: PgNarratorRefsTx,
	message: RefMessageInput,
	options: { beforeMessageId?: string; bumpMessageVersion?: boolean } = {},
): Promise<PgPersistedMessageRef> {
	validateMessage(message);
	const [parent] = message.parentToolUseId
		? await tx
				.select({ narratorId: narratorToolCalls.narratorId })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.toolUseId, message.parentToolUseId))
				.limit(1)
		: [];
	await lockPgNarratorRefs(tx, [message.narratorId, ...(parent ? [parent.narratorId] : [])]);
	// First-write floor repair when the process has not healed this narrator yet.
	const needsFloor = !isNarratorSeqFloorHealed(message.narratorId);
	if (needsFloor) await initializePgRefSeqFloor(tx, message.narratorId);
	let seq: number;
	if (options.beforeMessageId !== undefined) {
		const [target] = await tx
			.select({ seq: refs.seq })
			.from(refs)
			.where(
				and(eq(refs.narratorId, message.narratorId), eq(refs.messageId, options.beforeMessageId)),
			)
			.limit(1);
		if (!target) throw new Error("Before message ref not found");
		seq = target.seq;
		await claimPgShiftInsertSlot(tx, message.narratorId, seq);
	} else seq = await claimNextPgRefSeq(tx, message.narratorId);
	const [created] = await tx.insert(messages).values(message).returning();
	const refId = generateId();
	await tx
		.insert(refs)
		.values({ id: refId, narratorId: message.narratorId, messageId: created.id, seq });
	const bumpMessageVersion = options.bumpMessageVersion !== false;
	await tx
		.update(narrators)
		.set({
			...(bumpMessageVersion ? { messageVersion: sql`${narrators.messageVersion} + 1` } : {}),
			messageCount: sql`coalesce(${narrators.messageCount}, 0) + 1`,
			...(options.beforeMessageId === undefined
				? {}
				: { messageStructureVersion: sql`${narrators.messageStructureVersion} + 1` }),
		})
		.where(eq(narrators.id, message.narratorId));
	if (parent && bumpMessageVersion)
		await tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, parent.narratorId));
	return {
		messageId: created.id,
		refId,
		seq,
		message: {
			...created,
			costStatus: created.costStatus as "complete" | "partial" | "unknown" | null,
			costMissingFields: Array.isArray(created.costMissingFields)
				? created.costMissingFields.filter((field): field is string => typeof field === "string")
				: null,
			role: message.role,
			origin: message.origin ?? null,
			seq,
		},
		/** Caller must mark healed only after this section's transaction commits. */
		needsSeqFloorMark: needsFloor,
	};
}

/** Pure database effects only. Cancellation rolls back at the next checkpoint (in-flight SQL <=5s). */
export function createPostgresNarratorMessageRefsPort(db: BunSQLDatabase): NarratorMessageRefsPort {
	async function atomic<T>(
		label: string,
		options: RefOperationOptions | undefined,
		fn: (tx: PgNarratorRefsTx) => Promise<T>,
	): Promise<T> {
		const started = performance.now();
		const section = async (tx: PgNarratorRefsTx): Promise<T> => {
			check(options);
			await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
			await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
			await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '10s'`);
			const result = await fn(tx);
			check(options);
			return result;
		};
		try {
			// BunSQL's transaction awaits this Promise; unlike bun:sqlite it keeps BEGIN open.
			return await withPgRetry(() => db.transaction((tx) => section(tx)), { label, maxRetries: 3 });
		} finally {
			const durationMs = performance.now() - started;
			if (durationMs > 1000) logger.warn("Slow narrator refs operation", { label, durationMs });
		}
	}
	async function insert(
		message: RefMessageInput,
		beforeMessageId: string | undefined,
		options?: RefOperationOptions,
	): Promise<RefMessage> {
		// No user I/O or broadcasting inside the replay boundary. IDs/timestamps are caller-owned.
		check(options);
		return atomic("narratorRefs.insert", options, async (tx) => {
			const persisted = await persistPgMessageWithRef(tx, message, {
				...(beforeMessageId === undefined ? {} : { beforeMessageId }),
				bumpMessageVersion: options?.bumpMessageVersion !== false,
			});
			return persisted;
		}).then((persisted) => {
			if (persisted.needsSeqFloorMark) markNarratorSeqFloorHealed(message.narratorId);
			return persisted.message;
		});
	}
	return {
		async creator(userId) {
			return atomic("narratorRefs.creator", undefined, async (tx) => {
				const [row] = await tx
					.select({
						id: users.id,
						username: users.username,
						avatarColor: users.avatarColor,
						avatarImageId: users.avatarImageId,
					})
					.from(users)
					.where(eq(users.id, userId))
					.limit(1);
				return row ?? null;
			});
		},
		append: (message, options) => insert(message, undefined, options),
		insertBefore: (message, beforeMessageId, options) => insert(message, beforeMessageId, options),
		async copyRefs(input, options) {
			seqValue(input.fromSeq);
			seqValue(input.untilSeq);
			if (input.sourceId === input.targetId || input.untilSeq < input.fromSeq)
				throw new Error("Invalid inherited ref window");
			const limit = pageSize(input.limit ?? MAX_PAGE);
			return atomic("narratorRefs.copy", options, async (tx) => {
				await lockPgNarratorRefs(tx, [input.sourceId, input.targetId]);
				const [source] = await tx
					.select({ version: narrators.messageStructureVersion })
					.from(narrators)
					.where(eq(narrators.id, input.sourceId));
				const [target] = await tx
					.select({ version: narrators.messageStructureVersion })
					.from(narrators)
					.where(eq(narrators.id, input.targetId));
				if (
					input.cursor &&
					(input.cursor.sourceStructureVersion !== source.version ||
						input.cursor.targetStructureVersion !== target.version)
				)
					throw new Error("Inherited refs changed between copy windows");
				const rows = await tx
					.select({
						messageId: refs.messageId,
						seq: refs.seq,
						isCompact: refs.isCompact,
						segmentCompactId: refs.segmentCompactId,
						id: refs.id,
					})
					.from(refs)
					.innerJoin(messages, eq(messages.id, refs.messageId))
					.where(
						and(
							eq(refs.narratorId, input.sourceId),
							eq(messages.compactPending, 0),
							gte(refs.seq, input.fromSeq),
							lt(refs.seq, input.untilSeq),
							input.cursor
								? or(
										gt(refs.seq, input.cursor.seq),
										and(eq(refs.seq, input.cursor.seq), gt(refs.id, input.cursor.id)),
									)
								: undefined,
							isNull(refs.segmentCompactId),
						),
					)
					.orderBy(asc(refs.seq), asc(refs.id))
					.limit(limit + 1);
				const selected = rows.slice(0, limit);
				let copied = 0;
				if (selected.length) {
					const original = alias(refs, "original");
					const [collision] = await tx
						.select({ id: refs.id })
						.from(refs)
						.where(
							and(
								eq(refs.narratorId, input.targetId),
								inArray(
									refs.seq,
									selected.map((row) => row.seq),
								),
								notExists(
									tx
										.select({ id: original.id })
										.from(original)
										.where(
											and(
												eq(original.narratorId, input.sourceId),
												eq(original.messageId, refs.messageId),
												eq(original.seq, refs.seq),
											),
										),
								),
							),
						)
						.limit(1);
					if (collision) throw new Error("Inherited ref window overlaps target-owned history");
					const inserted = await tx
						.insert(refs)
						.values(
							selected.map(({ id: _id, ...row }) => ({
								...row,
								id: generateId(),
								narratorId: input.targetId,
							})),
						)
						.onConflictDoNothing({ target: [refs.narratorId, refs.messageId] })
						.returning({ id: refs.id });
					copied = inserted.length;
				}
				// Reserve the entire inherited window before allowing an append between copy pages.
				const nextSeq = await initializePgRefSeqFloor(tx, input.targetId, input.untilSeq);
				if (copied)
					await tx
						.update(narrators)
						.set({
							messageVersion: sql`${narrators.messageVersion} + 1`,
							messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
							messageCount: sql`coalesce(${narrators.messageCount}, 0) + ${copied}`,
						})
						.where(eq(narrators.id, input.targetId));
				const last = selected.at(-1);
				return {
					copied,
					nextSeq,
					needsSeqFloorMark: true,
					nextCursor:
						rows.length > limit && last
							? {
									seq: last.seq,
									id: last.id,
									sourceStructureVersion: source.version,
									targetStructureVersion: target.version + (copied ? 1 : 0),
								}
							: null,
				};
			}).then((result) => {
				if (result.needsSeqFloorMark) markNarratorSeqFloorHealed(input.targetId);
				return result;
			});
		},
		async page(narratorId, cursor, requestedLimit = 100, options) {
			const limit = pageSize(requestedLimit);
			if (cursor) seqValue(cursor.seq);
			return atomic("narratorRefs.page", options, async (tx) => {
				const rows = await tx
					.select({
						id: refs.id,
						messageId: refs.messageId,
						seq: refs.seq,
						role: messages.role,
						createdAt: messages.createdAt,
					})
					.from(refs)
					.innerJoin(messages, eq(messages.id, refs.messageId))
					.where(
						and(
							eq(refs.narratorId, narratorId),
							cursor
								? or(
										gt(refs.seq, cursor.seq),
										and(eq(refs.seq, cursor.seq), gt(refs.id, cursor.id)),
									)
								: undefined,
						),
					)
					.orderBy(asc(refs.seq), asc(refs.id))
					.limit(limit + 1);
				const page = rows.slice(0, limit);
				const last = page.at(-1);
				return {
					rows: page,
					nextCursor: rows.length > limit && last ? { seq: last.seq, id: last.id } : null,
				};
			});
		},
	};
}
