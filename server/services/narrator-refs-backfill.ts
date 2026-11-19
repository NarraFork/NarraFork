/** Contiguous, bounded materialization of lazy fork history. Never retain sparse COW patches. */
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { narratorMessageRefs, narrators, narratorToolCalls } from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { dbTransactionWithSeqFloor } from "./narrator-refs/seq-floor-tx";
import { initializeRefSeqFloor } from "./narrator-refs/seq-store";
import { assertNarratorNotReverting, withNarratorWorkAdmission } from "./narrator-session-state";

const BACKFILL_WINDOW_REFS = 400;
const MAX_PAGE_ROWS = 2000;
const MAX_LINEAGE_DEPTH = 32;
const MAX_CHILDREN = 1000;

export interface RefsBackfillOptions {
	signal?: AbortSignal;
	/** Absolute Date.now() deadline, including time spent on ancestors and children. */
	deadlineAt?: number;
	maxRows?: number;
	maxPages?: number;
	pageSize?: number;
}
type Budget = Required<Omit<RefsBackfillOptions, "signal">> & {
	signal?: AbortSignal;
	rows: number;
	pages: number;
};
type MessageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RefsReader = Pick<MessageTx, "query" | "select">;
type ActiveLazyState = { parentNarratorId: string; cursor: number };
type LazyRefsState = { refsInheritedFrom: string | null; refsBackfillCursor: number | null };

function failure(code: string, message: string): AppError {
	return new AppError(message, 409, `HISTORY_REFS_${code}`);
}
function budget(options: RefsBackfillOptions): Budget {
	if (db.$client.inTransaction)
		throw failure(
			"AMBIENT_TRANSACTION",
			"Inherited history preparation cannot await inside a transaction",
		);
	const result = {
		signal: options.signal,
		deadlineAt: options.deadlineAt ?? Date.now() + 10_000,
		maxRows: options.maxRows ?? 20_000,
		maxPages: options.maxPages ?? 1000,
		pageSize: options.pageSize ?? BACKFILL_WINDOW_REFS,
		rows: 0,
		pages: 0,
	};
	for (const value of [result.maxRows, result.maxPages, result.pageSize])
		if (!Number.isSafeInteger(value) || value < 1)
			throw failure("BUDGET_EXCEEDED", "Invalid inherited history preparation budget");
	if (!Number.isFinite(result.deadlineAt))
		throw failure("BUDGET_EXCEEDED", "Inherited history preparation needs a finite deadline");
	result.pageSize = Math.min(result.pageSize, MAX_PAGE_ROWS);
	return result;
}
function check(work: Budget): void {
	work.signal?.throwIfAborted();
	if (Date.now() >= work.deadlineAt)
		throw failure("TIMEOUT", "Inherited history preparation timed out");
}
function reserve(work: Budget, rows: number): void {
	check(work);
	if (work.pages >= work.maxPages || work.rows + rows > work.maxRows)
		throw failure("BUDGET_EXCEEDED", "Inherited history preparation exceeds its budget");
	work.pages++;
	work.rows += rows;
}
async function yieldPage(work: Budget): Promise<void> {
	await yieldToEventLoop(0, undefined, { signal: work.signal });
	check(work);
}

export function requireSqliteLazyRefsBackfill(
	operation: string = "Lazy narrator refs fallback",
	backend: string = activeDatabaseBackend,
): void {
	if (backend === "postgres")
		throw new AppError(
			`${operation} is not yet supported on the PostgreSQL backend`,
			503,
			"POSTGRES_UNSUPPORTED",
		);
}
function toActive(state: LazyRefsState | undefined): ActiveLazyState | null {
	if (!state) throw failure("INCOMPLETE", "Inherited narrator no longer exists");
	if (state.refsInheritedFrom === null && state.refsBackfillCursor === null) return null;
	if (
		state.refsInheritedFrom === null ||
		state.refsBackfillCursor === null ||
		!Number.isSafeInteger(state.refsBackfillCursor) ||
		state.refsBackfillCursor < 0
	)
		throw failure("INCOMPLETE", "Inherited history cursor is invalid");
	return { parentNarratorId: state.refsInheritedFrom, cursor: state.refsBackfillCursor };
}
function readLazyState(narratorId: string, tx: RefsReader = db): ActiveLazyState | null {
	return toActive(
		tx.query.narrators
			.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { refsInheritedFrom: true, refsBackfillCursor: true },
			})
			.sync(),
	);
}
export type LineageStep = {
	narratorId: string;
	parentNarratorId: string;
	upperBoundSeq: number;
};
export async function resolveLazyLineage(narratorId: string): Promise<LineageStep[]> {
	requireSqliteLazyRefsBackfill();
	const steps: LineageStep[] = [];
	const seen = new Set([narratorId]);
	let currentId = narratorId;
	let bound = Number.POSITIVE_INFINITY;
	for (;;) {
		const state = readLazyState(currentId);
		if (!state) return steps;
		if (seen.has(state.parentNarratorId))
			throw failure("LINEAGE_CYCLE", "Inherited history contains a lineage cycle");
		if (steps.length >= MAX_LINEAGE_DEPTH)
			throw failure("BUDGET_EXCEEDED", "Inherited history lineage is too deep");
		bound = Math.min(bound, state.cursor);
		steps.push({
			narratorId: currentId,
			parentNarratorId: state.parentNarratorId,
			upperBoundSeq: bound,
		});
		seen.add(state.parentNarratorId);
		currentId = state.parentNarratorId;
	}
}
export async function hasUnmaterializedRefsBelow(
	narratorId: string,
	seq: number,
): Promise<boolean> {
	for (const step of await resolveLazyLineage(narratorId)) {
		const older = db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, step.parentNarratorId),
					lt(narratorMessageRefs.seq, Math.min(step.upperBoundSeq, seq)),
				),
			)
			.limit(1)
			.get();
		if (older) return true;
	}
	return false;
}

/** The whole same-seq group is checked against the actual row budget before any insert. */
function copyWindow(narratorId: string, parentId: string, target: number, work: Budget): void {
	const started = performance.now();
	dbTransactionWithSeqFloor(narratorId, (tx) => {
		check(work);
		assertNarratorNotReverting(narratorId);
		const current = readLazyState(narratorId, tx);
		if (!current || current.parentNarratorId !== parentId || current.cursor <= target) return;
		const parentState = readLazyState(parentId, tx);
		if (parentState && parentState.cursor > target)
			throw failure("INCOMPLETE", "Ancestor history changed during preparation");
		// Page/budget all indexed refs, including hidden ones. Filtering them before
		// LIMIT could otherwise scan an unbounded compacted prefix on the main thread.
		const range = and(
			eq(narratorMessageRefs.narratorId, parentId),
			gte(narratorMessageRefs.seq, target),
			lt(narratorMessageRefs.seq, current.cursor),
		);
		const page = tx
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(range)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(work.pageSize)
			.all();
		const fromSeq = page.length === work.pageSize ? page[page.length - 1].seq : target;
		const remaining = Math.min(work.maxRows - work.rows, MAX_PAGE_ROWS);
		const actual = tx
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(and(range, gte(narratorMessageRefs.seq, fromSeq)))
			.limit(remaining + 1)
			.all();
		if (actual.length > remaining)
			throw failure(
				"BUDGET_EXCEEDED",
				"A complete inherited sequence group exceeds its row budget",
			);
		reserve(work, actual.length);
		tx.run(sql`
			INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, segment_compact_id)
			SELECT lower(hex(randomblob(16))), ${narratorId}, refs.message_id, refs.seq, refs.is_compact, refs.segment_compact_id
			FROM narrator_message_refs AS refs
			WHERE refs.narrator_id = ${parentId} AND refs.seq >= ${fromSeq}
				AND refs.seq < ${current.cursor} AND refs.segment_compact_id IS NULL
			ON CONFLICT (narrator_id, message_id) DO NOTHING
		`);
		const missing = tx.get<{ id: string }>(sql`
			SELECT refs.id FROM narrator_message_refs refs
			WHERE refs.narrator_id = ${parentId} AND refs.seq >= ${fromSeq} AND refs.seq < ${current.cursor}
				AND refs.segment_compact_id IS NULL AND NOT EXISTS (
					SELECT 1 FROM narrator_message_refs local WHERE local.narrator_id = ${narratorId}
					AND local.message_id = refs.message_id AND local.seq = refs.seq
				) LIMIT 1
		`);
		if (missing) throw failure("INCOMPLETE", "Inherited history window was not fully copied");
		initializeRefSeqFloor(tx, narratorId);
		const older = tx
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, parentId), lt(narratorMessageRefs.seq, fromSeq)),
			)
			.limit(1)
			.get();
		// Never clear and then asynchronously relink: an intermediate fork retains its
		// source until its entire visible range is safely copied in this same transaction.
		const complete = fromSeq === 0 || (!older && !parentState);
		tx.update(narrators)
			.set({
				refsInheritedFrom: complete ? null : parentId,
				refsBackfillCursor: complete ? null : fromSeq,
				// Loading an immutable inherited view is a cache change, not a semantic edit.
				messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId))
			.run();
	});
	const durationMs = performance.now() - started;
	if (durationMs >= 25)
		logger.warn("Slow inherited history preparation page", {
			narratorId,
			parentId,
			durationMs,
			rows: work.rows,
			pages: work.pages,
		});
}
async function coverSeq(
	narratorId: string,
	target: number,
	work: Budget,
	ancestors = new Set<string>(),
): Promise<void> {
	check(work);
	if (ancestors.has(narratorId))
		throw failure("LINEAGE_CYCLE", "Inherited history contains a lineage cycle");
	if (ancestors.size > MAX_LINEAGE_DEPTH)
		throw failure("BUDGET_EXCEEDED", "Inherited history lineage is too deep");
	const nextAncestors = new Set(ancestors).add(narratorId);
	const initial = readLazyState(narratorId);
	if (!initial || (initial.cursor <= target && initial.cursor !== 0)) return;
	await withNarratorWorkAdmission(narratorId, async () => {
		for (;;) {
			check(work);
			assertNarratorNotReverting(narratorId);
			const current = readLazyState(narratorId);
			if (!current) return;
			if (current.cursor === 0) {
				dbTransactionWithSeqFloor(narratorId, (tx) => {
					check(work);
					assertNarratorNotReverting(narratorId);
					if (readLazyState(narratorId, tx)?.cursor !== 0) return;
					reserve(work, 0);
					tx.update(narrators)
						.set({
							refsInheritedFrom: null,
							refsBackfillCursor: null,
							messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
						})
						.where(eq(narrators.id, narratorId))
						.run();
				});
				await yieldPage(work);
				continue;
			}
			if (current.cursor <= target) return;
			await coverSeq(current.parentNarratorId, target, work, nextAncestors);
			copyWindow(narratorId, current.parentNarratorId, target, work);
			const after = readLazyState(narratorId);
			if (
				after &&
				after.parentNarratorId === current.parentNarratorId &&
				after.cursor >= current.cursor
			)
				throw failure("NO_PROGRESS", "Inherited history preparation made no progress");
			await yieldPage(work);
		}
	});
	check(work);
	if ((readLazyState(narratorId)?.cursor ?? 0) > target)
		throw failure("INCOMPLETE", "Inherited history preparation did not cover the requested range");
}
export async function ensureRefsCoverSeq(
	narratorId: string,
	targetSeq: number,
	options: RefsBackfillOptions = {},
): Promise<void> {
	requireSqliteLazyRefsBackfill();
	if (!Number.isSafeInteger(targetSeq))
		throw failure("INCOMPLETE", "Invalid inherited history sequence");
	targetSeq = Math.max(0, targetSeq);
	const work = budget(options);
	check(work);
	const initial = readLazyState(narratorId);
	if (!initial || (initial.cursor <= targetSeq && initial.cursor !== 0)) return;
	await resolveLazyLineage(narratorId);
	await coverSeq(narratorId, targetSeq, work);
}
async function coverMessage(narratorId: string, messageId: string, work: Budget): Promise<void> {
	check(work);
	const local = db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		)
		.limit(1)
		.get();
	if (local) {
		await coverSeq(narratorId, local.seq, work);
		return;
	}
	for (const step of await resolveLazyLineage(narratorId)) {
		check(work);
		const ref = db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, step.parentNarratorId),
					eq(narratorMessageRefs.messageId, messageId),
					isNull(narratorMessageRefs.segmentCompactId),
				),
			)
			.limit(1)
			.get();
		if (ref && ref.seq < step.upperBoundSeq) {
			await coverSeq(narratorId, ref.seq, work);
			const copied = db
				.select({ id: narratorMessageRefs.id })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.limit(1)
				.get();
			if (!copied) throw failure("INCOMPLETE", "Requested inherited message could not be prepared");
			return;
		}
	}
}
export async function ensureRefsCoverMessage(
	narratorId: string,
	messageId: string,
	options: RefsBackfillOptions = {},
): Promise<void> {
	requireSqliteLazyRefsBackfill();
	await coverMessage(narratorId, messageId, budget(options));
}
export async function ensureAllRefsMaterialized(
	narratorId: string,
	options: RefsBackfillOptions = {},
): Promise<void> {
	await ensureRefsCoverSeq(narratorId, 0, options);
}

/** Caller must authorize before entering. This is preparation, never part of collector/apply. */
export async function prepareRevertRefs(
	narratorId: string,
	selector: FileChangeRevertSelector,
	options: RefsBackfillOptions = {},
): Promise<void> {
	requireSqliteLazyRefsBackfill();
	const work = budget(options);
	check(work);
	if (selector.kind === "all") await coverSeq(narratorId, 0, work);
	else if (selector.kind === "from_seq") {
		if (!Number.isSafeInteger(selector.minSeq) || selector.minSeq < 0)
			throw failure("INCOMPLETE", "Invalid inherited history sequence");
		await coverSeq(narratorId, selector.minSeq, work);
	} else if (selector.kind === "after_block")
		await coverMessage(narratorId, selector.messageId, work);
	else if (selector.kind === "messages") {
		if (selector.messageIds.length > FILE_CHANGE_LIMITS.historyMessageRefChanges)
			throw failure("BUDGET_EXCEEDED", "Too many selected history messages");
		let lookedUp = 0;
		for (const id of selector.messageIds) {
			await coverMessage(narratorId, id, work);
			if (++lookedUp % BACKFILL_WINDOW_REFS === 0) {
				reserve(work, 0);
				await yieldPage(work);
			}
		}
	} else {
		if (selector.toolCallIds.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
			throw failure("BUDGET_EXCEEDED", "Too many selected history tools");
		let lookedUp = 0;
		for (const id of selector.toolCallIds) {
			check(work);
			const tool = db
				.select({ messageId: narratorToolCalls.messageId })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, id))
				.get();
			if (tool) await coverMessage(narratorId, tool.messageId, work);
			if (++lookedUp % BACKFILL_WINDOW_REFS === 0) {
				reserve(work, 0);
				await yieldPage(work);
			}
		}
	}
	check(work);
}

function lazyChildren(tx: RefsReader, parentId: string, minSeq: number) {
	const children = tx
		.select({ id: narrators.id, cursor: narrators.refsBackfillCursor })
		.from(narrators)
		.where(
			and(
				eq(narrators.refsInheritedFrom, parentId),
				sql`${narrators.refsBackfillCursor} > ${minSeq}`,
				sql`EXISTS (
			SELECT 1 FROM narrator_message_refs refs WHERE refs.narrator_id = ${parentId}
			AND refs.seq >= ${minSeq} AND refs.seq < ${narrators.refsBackfillCursor}
			AND refs.segment_compact_id IS NULL
		)`,
			),
		)
		.orderBy(narrators.id)
		.limit(MAX_CHILDREN + 1)
		.all();
	if (children.length > MAX_CHILDREN)
		throw failure("BUDGET_EXCEEDED", "Too many derived history readers");
	return children;
}
export function assertNoLazyChildrenForHistoryRewriteTx(
	tx: RefsReader,
	parentNarratorId: string,
	minAffectedSeq: number,
): void {
	const children = lazyChildren(tx, parentNarratorId, minAffectedSeq);
	for (const child of children) assertNarratorNotReverting(child.id);
	if (children.length)
		throw new AppError(
			"Derived history readers changed; prepare the history selection again",
			409,
			"HISTORY_LAZY_DEPENDENCY_CHANGED",
		);
}
export async function prepareLazyChildrenForHistoryRewrite(
	parentNarratorId: string,
	minAffectedSeq: number,
	options: RefsBackfillOptions = {},
): Promise<void> {
	requireSqliteLazyRefsBackfill();
	const work = budget(options);
	check(work);
	const children = lazyChildren(db, parentNarratorId, minAffectedSeq);
	for (const child of children) {
		assertNarratorNotReverting(child.id);
		await coverSeq(child.id, minAffectedSeq, work);
	}
	check(work);
	assertNoLazyChildrenForHistoryRewriteTx(db, parentNarratorId, minAffectedSeq);
}
export async function materializeChildrenOf(
	parentNarratorId: string,
	options: RefsBackfillOptions = {},
): Promise<string[]> {
	requireSqliteLazyRefsBackfill("Materializing inherited narrator refs");
	const children = db
		.select({ id: narrators.id })
		.from(narrators)
		.where(eq(narrators.refsInheritedFrom, parentNarratorId))
		.limit(MAX_CHILDREN + 1)
		.all();
	if (children.length > MAX_CHILDREN)
		throw failure("BUDGET_EXCEEDED", "Too many inherited history readers");
	const work = budget(options);
	for (const child of children) await coverSeq(child.id, 0, work);
	check(work);
	return children.map((child) => child.id);
}
