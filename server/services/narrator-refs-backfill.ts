/** Contiguous, bounded materialization of lazy fork history. Never retain sparse COW patches. */
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { narratorMessageRefs, narrators, narratorToolCalls } from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { dbTransactionWithSeqFloor } from "./narrator-refs/seq-floor-tx";
import { initializeRefSeqFloor } from "./narrator-refs/seq-store";
import { assertNarratorNotReverting, withNarratorWorkAdmission } from "./narrator-session-state";
import {
	type NarratorSurfaceReadBudget,
	narratorSurfaceReadOptions,
} from "./narrator-surface-reads";

const BACKFILL_WINDOW_REFS = 400;
const MAX_PAGE_ROWS = 2000;
const MAX_LINEAGE_DEPTH = 32;
const MAX_CHILDREN = 1000;

export interface RefsBackfillOptions {
	signal?: AbortSignal;
	/** Absolute Date.now() deadline, including time spent on ancestors and children. */
	deadlineAt?: number;
	timeoutMs?: number;
	maxRows?: number;
	maxPages?: number;
	pageSize?: number;
}
type Budget = Required<Omit<RefsBackfillOptions, "signal" | "timeoutMs">> & {
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
		deadlineAt: Math.min(
			options.deadlineAt ?? Number.POSITIVE_INFINITY,
			Date.now() + Math.min(options.timeoutMs ?? 10_000, 30_000),
		),
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
function readOptions(work?: Budget, maxRows = 1) {
	if (work) check(work);
	return {
		executionPolicy: "worker-required" as const,
		maxRows,
		signal: work?.signal,
		deadlineAt: work?.deadlineAt,
		timeoutMs: work ? Math.max(1, Math.min(30_000, work.deadlineAt - Date.now())) : 30_000,
	};
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
function readLazyStateTx(narratorId: string, tx: RefsReader): ActiveLazyState | null {
	return toActive(
		tx.query.narrators
			.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { refsInheritedFrom: true, refsBackfillCursor: true },
			})
			.sync(),
	);
}
async function readLazyState(narratorId: string, work?: Budget): Promise<ActiveLazyState | null> {
	return toActive(
		await readQueryFirst(
			db.query.narrators.findMany({
				limit: 1,
				where: eq(narrators.id, narratorId),
				columns: { refsInheritedFrom: true, refsBackfillCursor: true },
			}),
			readOptions(work),
		),
	);
}
export type LineageStep = {
	narratorId: string;
	parentNarratorId: string;
	upperBoundSeq: number;
};
async function readLineage(
	narratorId: string,
	work?: Budget,
	options: Pick<RefsBackfillOptions, "signal" | "deadlineAt" | "timeoutMs"> = {},
): Promise<LineageStep[]> {
	requireSqliteLazyRefsBackfill();
	const source = sql`(WITH RECURSIVE lineage(id, refs_inherited_from, refs_backfill_cursor, depth) AS (
		SELECT id, refs_inherited_from, refs_backfill_cursor, 0 FROM narrators WHERE id = ${narratorId}
		UNION ALL SELECT n.id, n.refs_inherited_from, n.refs_backfill_cursor, l.depth + 1
		FROM narrators n JOIN lineage l ON n.id = l.refs_inherited_from WHERE l.depth < ${MAX_LINEAGE_DEPTH}
	) SELECT * FROM lineage)`;
	const rows = await readQuery(
		db
			.select({
				id: sql<string>`id`,
				refsInheritedFrom: sql<string | null>`refs_inherited_from`,
				refsBackfillCursor: sql<number | null>`refs_backfill_cursor`,
			})
			.from(source)
			.limit(MAX_LINEAGE_DEPTH + 1),
		work ? readOptions(work, MAX_LINEAGE_DEPTH + 1) : narratorSurfaceReadOptions(options),
	);
	const states = new Map(rows.map((row) => [row.id, row]));
	const steps: LineageStep[] = [];
	const seen = new Set([narratorId]);
	let currentId = narratorId;
	let bound = Number.POSITIVE_INFINITY;
	for (;;) {
		const state = toActive(states.get(currentId));
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
export async function resolveLazyLineage(
	narratorId: string,
	options: NarratorSurfaceReadBudget = {},
): Promise<LineageStep[]> {
	return readLineage(narratorId, undefined, options);
}
export async function hasUnmaterializedRefsBelow(
	narratorId: string,
	seq: number,
	options: NarratorSurfaceReadBudget = {},
): Promise<boolean> {
	const readBudget = narratorSurfaceReadOptions(options);
	const clauses = (await resolveLazyLineage(narratorId, readBudget)).flatMap((step) => {
		const ceiling = Math.min(step.upperBoundSeq, seq);
		return ceiling > 0
			? [
					and(
						eq(narratorMessageRefs.narratorId, step.parentNarratorId),
						lt(narratorMessageRefs.seq, ceiling),
					),
				]
			: [];
	});
	if (!clauses.length) return false;
	return !!(await readQueryFirst(
		db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(or(...clauses))
			.limit(1),
		narratorSurfaceReadOptions(readBudget),
	));
}

/** The whole same-seq group is checked against the actual row budget before any insert. */
function copyWindow(narratorId: string, parentId: string, target: number, work: Budget): void {
	const started = performance.now();
	dbTransactionWithSeqFloor(narratorId, (tx) => {
		check(work);
		assertNarratorNotReverting(narratorId);
		const current = readLazyStateTx(narratorId, tx);
		if (!current || current.parentNarratorId !== parentId || current.cursor <= target) return;
		const parentState = readLazyStateTx(parentId, tx);
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
	const initial = await readLazyState(narratorId, work);
	if (!initial || (initial.cursor <= target && initial.cursor !== 0)) return;
	await withNarratorWorkAdmission(narratorId, async () => {
		for (;;) {
			check(work);
			assertNarratorNotReverting(narratorId);
			const current = await readLazyState(narratorId, work);
			if (!current) return;
			if (current.cursor === 0) {
				dbTransactionWithSeqFloor(narratorId, (tx) => {
					check(work);
					assertNarratorNotReverting(narratorId);
					if (readLazyStateTx(narratorId, tx)?.cursor !== 0) return;
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
			const after = await readLazyState(narratorId, work);
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
	if (((await readLazyState(narratorId, work))?.cursor ?? 0) > target)
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
	const initial = await readLazyState(narratorId, work);
	if (!initial || (initial.cursor <= targetSeq && initial.cursor !== 0)) return;
	await readLineage(narratorId, work);
	await coverSeq(narratorId, targetSeq, work);
}
async function coverMessage(narratorId: string, messageId: string, work: Budget): Promise<void> {
	check(work);
	const local = await readQueryFirst(
		db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			)
			.limit(1),
		readOptions(work),
	);
	if (local) {
		await coverSeq(narratorId, local.seq, work);
		return;
	}
	for (const step of await readLineage(narratorId, work)) {
		check(work);
		const ref = await readQueryFirst(
			db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, step.parentNarratorId),
						eq(narratorMessageRefs.messageId, messageId),
						isNull(narratorMessageRefs.segmentCompactId),
					),
				)
				.limit(1),
			readOptions(work),
		);
		if (ref && ref.seq < step.upperBoundSeq) {
			await coverSeq(narratorId, ref.seq, work);
			const copied = await readQueryFirst(
				db
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1),
				readOptions(work),
			);
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
			const tool = await readQueryFirst(
				db
					.select({ messageId: narratorToolCalls.messageId })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.id, id))
					.limit(1),
				readOptions(work),
			);
			if (tool) await coverMessage(narratorId, tool.messageId, work);
			if (++lookedUp % BACKFILL_WINDOW_REFS === 0) {
				reserve(work, 0);
				await yieldPage(work);
			}
		}
	}
	check(work);
}

function lazyChildrenQuery(tx: RefsReader, parentId: string, minSeq: number) {
	return tx
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
		.limit(MAX_CHILDREN + 1);
}
function checkChildrenBudget(children: readonly { id: string }[]): void {
	if (children.length > MAX_CHILDREN)
		throw failure("BUDGET_EXCEEDED", "Too many derived history readers");
}
function assertNoLazyChildren(children: readonly { id: string }[]): void {
	checkChildrenBudget(children);
	for (const child of children) assertNarratorNotReverting(child.id);
	if (children.length)
		throw new AppError(
			"Derived history readers changed; prepare the history selection again",
			409,
			"HISTORY_LAZY_DEPENDENCY_CHANGED",
		);
}
export function assertNoLazyChildrenForHistoryRewriteTx(
	tx: RefsReader,
	parentNarratorId: string,
	minAffectedSeq: number,
): void {
	assertNoLazyChildren(lazyChildrenQuery(tx, parentNarratorId, minAffectedSeq).all());
}
export async function prepareLazyChildrenForHistoryRewrite(
	parentNarratorId: string,
	minAffectedSeq: number,
	options: RefsBackfillOptions = {},
): Promise<void> {
	requireSqliteLazyRefsBackfill();
	const work = budget(options);
	check(work);
	const children = await readQuery(
		lazyChildrenQuery(db, parentNarratorId, minAffectedSeq),
		readOptions(work, MAX_CHILDREN + 1),
	);
	checkChildrenBudget(children);
	for (const child of children) {
		assertNarratorNotReverting(child.id);
		await coverSeq(child.id, minAffectedSeq, work);
	}
	check(work);
	assertNoLazyChildren(
		await readQuery(
			lazyChildrenQuery(db, parentNarratorId, minAffectedSeq),
			readOptions(work, MAX_CHILDREN + 1),
		),
	);
}
export async function materializeChildrenOf(
	parentNarratorId: string,
	options: RefsBackfillOptions = {},
): Promise<string[]> {
	requireSqliteLazyRefsBackfill("Materializing inherited narrator refs");
	const work = budget(options);
	const children = await readQuery(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.refsInheritedFrom, parentNarratorId))
			.limit(MAX_CHILDREN + 1),
		readOptions(work, MAX_CHILDREN + 1),
	);
	if (children.length > MAX_CHILDREN)
		throw failure("BUDGET_EXCEEDED", "Too many inherited history readers");
	for (const child of children) await coverSeq(child.id, 0, work);
	check(work);
	return children.map((child) => child.id);
}
