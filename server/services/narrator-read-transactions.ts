import type { Database } from "bun:sqlite";
import { parseCompactMessageBlock } from "@shared/compact-message";
import { contextBlockViews, injectionBlockViews } from "@shared/native-injection";
import {
	MAX_SUBAGENT_SUMMARY_INPUT_BYTES,
	MAX_SUBAGENT_SUMMARY_VALUE_CHARS,
	SUBAGENT_SUMMARY_INPUT_KEYS,
} from "@shared/subagent-tool-summary";
import {
	type AnyColumn,
	and,
	desc,
	eq,
	getTableColumns,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import {
	apiRequests,
	knowledgeInjectionEvents,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { isSubagentVariant } from "../lib/narrator-utils";
import { toolCallWithExecutionTargets } from "../lib/tool-execution-target-projection";
import { toolEditPreviewColumns } from "./narrator-read-tool-preview";
import type { RevertScope } from "./snapshot-revert";

type MessageTx = BunSQLiteDatabase<typeof schema & typeof relations>;

export type NarratorReadTransactionParams = {
	kind: "narrator-read-transaction-v1";
	narratorId: string;
} & (
	| { operation: "aggregateScope" | "aggregateRefs" | "latestSubagentToolCalls"; ids: string[] }
	| { operation: "toolDetail" | "toolPreview"; toolUseId: string; reference?: ToolDetailReference }
	| { operation: "compactSummary"; messageId: string }
	| { operation: "blockDeletionPlan"; grouped: [string, number[]][]; options?: BlockDeleteOptions }
	| {
			operation: "rangeDeletionPlan";
			messageId: string;
			inclusive: boolean;
			options?: BlockDeleteOptions;
	  }
);

export function runNarratorReadTransaction(
	sqlite: Database,
	params: NarratorReadTransactionParams,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const database = drizzle(sqlite, { schema: { ...schema, ...relations } });
	return database.transaction((tx) => {
		switch (params.operation) {
			case "aggregateScope":
				return resolveAggregateScopeTxImpl(tx, params.narratorId, params.ids);
			case "aggregateRefs":
				return loadAggregateRefMessagesTx(tx, params.narratorId, params.ids);
			case "latestSubagentToolCalls":
				return loadLatestSubagentToolCallsTx(tx, params.ids, signal);
			case "toolDetail":
				return getToolCallDetailTx(tx, params.narratorId, params.toolUseId, params.reference);
			case "compactSummary":
				return getCompactSummaryTx(tx, params.narratorId, params.messageId);
			case "toolPreview":
				return getToolCallPreviewTx(tx, params.narratorId, params.toolUseId, params.reference);
			case "blockDeletionPlan":
				return planBlockDeletions(tx, params.narratorId, new Map(params.grouped), params.options);
			case "rangeDeletionPlan":
				return planMessageRangeDeletion(
					tx,
					params.narratorId,
					params.messageId,
					params.inclusive,
					params.options,
				);
		}
	});
}

/**
 * SQL projection of the whitelisted short input keys for one activity row.
 *
 * WHY IN SQL AND NOT IN JS
 * `input_json` is deliberately NOT selected by this query: for Write/Edit it can
 * hold a whole file (observed max 180KB across 835k rows). Selecting it to read a
 * 40-char path would pull the blob into JS and re-parse it on the main thread,
 * which CLAUDE.md forbids on summary paths. `json_extract` keeps the parse inside
 * SQLite and returns only the short leaves.
 *
 * TWO GUARDS, BOTH LOAD-BEARING:
 *
 *  1. `json_valid` — NOT a nicety. A single malformed row makes `json_extract`
 *     raise "malformed JSON" and abort the ENTIRE statement, so one bad row would
 *     blank every card's activity list rather than just its own. (Measured: the
 *     unguarded query throws; the guarded one returns all rows.)
 *
 *  2. `octet_length` — bounds the parse for a pathological blob. The ceiling is
 *     256KB rather than a tighter number on purpose: a 32KB cap would have
 *     suppressed the summary for a large-file `Write`, i.e. exactly the case where
 *     `file_path` is the only useful label. Both guards sit in front of the
 *     extract so an oversized row costs a length check, not a parse.
 *
 * Each value is capped with `substr` so a multi-KB `description` cannot inflate
 * the response.
 */
function subagentSummarySql(): SQL<string | null> {
	const paths = SUBAGENT_SUMMARY_INPUT_KEYS.map(
		(key) =>
			sql`substr(json_extract(${narratorToolCalls.inputJson}, ${`$.${key}`}), 1, ${MAX_SUBAGENT_SUMMARY_VALUE_CHARS})`,
	);
	// json_object(k1, v1, k2, v2, ...) — one row-shaped JSON string instead of ten
	// result columns, so adding a key later does not reshape the row type.
	const pairs: SQL[] = [];
	SUBAGENT_SUMMARY_INPUT_KEYS.forEach((key, index) => {
		pairs.push(sql`${key}, ${paths[index]}`);
	});
	return sql<string | null>`CASE
		WHEN ${narratorToolCalls.inputJson} IS NOT NULL
			AND octet_length(${narratorToolCalls.inputJson}) <= ${MAX_SUBAGENT_SUMMARY_INPUT_BYTES}
			AND json_valid(${narratorToolCalls.inputJson})
		THEN json_object(${sql.join(pairs, sql`, `)})
	END`;
}

export function loadLatestSubagentToolCallsTx(
	tx: MessageTx,
	narratorIds: string[],
	signal?: AbortSignal,
) {
	const ids = [...new Set(narratorIds)];
	assertAggregateBudget(ids.length);
	// Each indexed owner query retains its own Top-K; only this phase shares a snapshot.
	return ids.map((narratorId) => {
		signal?.throwIfAborted();
		const rows = tx
			.select({
				toolCallId: narratorToolCalls.id,
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
				status: narratorToolCalls.status,
				createdAt: narratorToolCalls.createdAt,
				streamStartedAt: narratorToolCalls.streamStartedAt,
				streamCompletedAt: narratorToolCalls.streamCompletedAt,
				permissionStartedAt: narratorToolCalls.permissionStartedAt,
				executionStartedAt: narratorToolCalls.executionStartedAt,
				completedAt: narratorToolCalls.completedAt,
				durationMs: narratorToolCalls.durationMs,
				// Short whitelisted input keys only — never the `input_json` blob.
				inputSummary: subagentSummarySql(),
			})
			.from(narratorToolCalls)
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.isFileHistoryCheckpoint, false),
					toolMessageRefExists(narratorId),
				),
			)
			.orderBy(desc(narratorToolCalls.createdAt), desc(narratorToolCalls.id))
			.limit(3)
			.all();
		return { narratorId, rows: rows.reverse() };
	});
}

export function getToolCallPreviewTx(
	tx: MessageTx,
	narratorId: string,
	toolUseId: string,
	reference?: ToolDetailReference,
) {
	const selected = selectVisibleToolCallTx(tx, narratorId, toolUseId, reference);
	const row = tx
		.select(toolEditPreviewColumns)
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!row) throw new NotFoundError("ToolCall", toolUseId);
	return row;
}

export function storedRowBytes(columns: AnyColumn[]): SQL<number> {
	return sql<number>`${sql.join(
		columns
			.filter((column) => !column.generated)
			.map((column) => sql`coalesce(octet_length(${column}), 0)`),
		sql` + `,
	)}`;
}

export const historyToolMetadataColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
};

export const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "Send"]);

export interface SubagentActivityOwner {
	parentToolUseId: string;
	subagentNarratorId: string;
	model: string | null;
	reasoningEffort: string | null;
}

export const AGGREGATE_METADATA_LIMIT = 500;

export const AGGREGATE_BODY_BYTE_LIMIT = 4 * 1024 * 1024;

export function assertAggregateBudget(rows: number, bytes = 0): void {
	if (rows > AGGREGATE_METADATA_LIMIT || bytes > AGGREGATE_BODY_BYTE_LIMIT) {
		throw new AppError(
			"History aggregation exceeds its safety budget; request a smaller history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	}
}

export function resolveAggregateScopeTxImpl(
	tx: MessageTx,
	narratorId: string,
	toolUseIds: string[],
) {
	const ids = [...new Set(toolUseIds)];
	assertAggregateBudget(ids.length);
	const parentRows =
		ids.length > 0
			? tx
					.select({
						...historyToolMetadataColumns,
						executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
						executionAttempt: narratorToolCalls.executionAttempt,
						executionSegmentId: narratorToolCalls.executionSegmentId,
						executionStartedAt: narratorToolCalls.executionStartedAt,
						createdAt: narratorToolCalls.createdAt,
						completedAt: narratorToolCalls.completedAt,
						callerSeq: sql<
							number | null
						>`(SELECT aggregate_ref.seq FROM narrator_message_refs aggregate_ref
			WHERE aggregate_ref.narrator_id = ${narratorId}
			AND aggregate_ref.message_id = narrator_tool_calls.message_id
			AND aggregate_ref.segment_compact_id IS NULL)`,
					})
					.from(narratorToolCalls)
					.where(
						and(
							inArray(narratorToolCalls.toolUseId, ids),
							eq(narratorToolCalls.isFileHistoryCheckpoint, false),
							sql`EXISTS (SELECT 1 FROM narrator_message_refs aggregate_ref
								WHERE aggregate_ref.narrator_id = ${narratorId}
								AND aggregate_ref.message_id = narrator_tool_calls.message_id
								AND aggregate_ref.segment_compact_id IS NULL)`,
						),
					)
					.limit(AGGREGATE_METADATA_LIMIT + 1)
					.all()
			: [];
	assertAggregateBudget(parentRows.length);
	const parentGroups = new Map<string, typeof parentRows>();
	for (const row of parentRows) {
		if (row.callerSeq === null || row.isFileHistoryCheckpoint) continue;
		const group = parentGroups.get(row.toolUseId) ?? [];
		group.push(row);
		parentGroups.set(row.toolUseId, group);
	}
	// The output protocol keys by provider ID. Multiple visible parent rows must
	// remain unknown rather than attaching one row's child to another row.
	const parents = new Map(
		[...parentGroups].flatMap(([id, group]) =>
			group.length === 1 ? [[id, group[0]] as const] : [],
		),
	);
	// COW origins need not be caller-referenced. Fetch them by immutable PK, not
	// provider ID; they validate ancestry but never participate in visible uniqueness.
	const visibleIds = new Set(parentRows.map((row) => row.id));
	const originIds = [
		...new Set(
			[...parents.values()].flatMap((parent) =>
				parent.executionOriginToolCallId && !visibleIds.has(parent.executionOriginToolCallId)
					? [parent.executionOriginToolCallId]
					: [],
			),
		),
	];
	const originRows = originIds.length
		? tx
				.select({
					...historyToolMetadataColumns,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
				})
				.from(narratorToolCalls)
				.where(inArray(narratorToolCalls.id, originIds))
				.limit(AGGREGATE_METADATA_LIMIT + 1)
				.all()
		: [];
	assertAggregateBudget(parentRows.length + originRows.length);
	const originals = new Map([...parentRows, ...originRows].map((row) => [row.id, row]));
	const callerChildRef = sql<boolean>`EXISTS (SELECT 1 FROM narrator_message_refs aggregate_ref
		WHERE aggregate_ref.narrator_id = ${narratorId}
		AND aggregate_ref.message_id = narrator_messages.id
		AND aggregate_ref.segment_compact_id IS NULL)`;
	const childScopes: Array<SQL | undefined> = [];
	const ownerScopes: Array<SQL | undefined> = [];
	const parentByOrigin = new Map<string, string | null>();
	for (const parent of parents.values()) {
		if (!SUBAGENT_TOOL_NAMES.has(parent.toolName)) {
			childScopes.push(and(eq(narratorMessages.parentToolUseId, parent.toolUseId), callerChildRef));
			continue;
		}
		const originId = parent.executionOriginToolCallId ?? parent.id;
		const original = originals.get(originId);
		if (
			(parent.toolName !== "Agent" && parent.toolName !== "Task") ||
			parent.executionIdentityVersion !== 1 ||
			(original &&
				(original.executionOriginToolCallId !== null ||
					original.executionIdentityVersion !== 1 ||
					original.isFileHistoryCheckpoint ||
					original.toolUseId !== parent.toolUseId ||
					(original.toolName !== "Agent" && original.toolName !== "Task")))
		)
			continue;
		// A deleted original cannot validate conflicting provider IDs on COW copies.
		// Do not let the last copy bind an owner's EXISTS proof to another group.
		parentByOrigin.set(originId, parentByOrigin.has(originId) ? null : parent.toolUseId);
		ownerScopes.push(
			and(
				eq(narrators.originToolCallId, originId),
				eq(narrators.type, "subagent"),
				sql`${narrators.variant} GLOB 'subagent:*'`,
				original
					? eq(narrators.parentNarratorId, original.narratorId)
					: isNotNull(narrators.parentNarratorId),
				// Author refs prove that this owner still has real child history, but
				// EXISTS never materializes its transcript merely to identify the owner.
				sql`EXISTS (SELECT 1 FROM narrator_messages aggregate_child
					INNER JOIN narrator_message_refs aggregate_author_ref
					ON aggregate_author_ref.message_id = aggregate_child.id
					AND aggregate_author_ref.narrator_id = ${narrators.id}
					AND aggregate_author_ref.segment_compact_id IS NULL
					WHERE aggregate_child.narrator_id = ${narrators.id}
					AND aggregate_child.parent_tool_use_id = ${parent.toolUseId})`,
			),
		);
	}
	// Budget distinct owner entities separately from caller-referenced inline rows.
	// A child with a long transcript must not exhaust either metadata budget.
	const ownerRows = ownerScopes.length
		? tx
				.select({
					id: narrators.id,
					originToolCallId: narrators.originToolCallId,
					parentNarratorId: narrators.parentNarratorId,
					variant: narrators.variant,
					model: narrators.model,
					reasoningEffort: narrators.reasoningEffort,
				})
				.from(narrators)
				.where(or(...ownerScopes))
				.limit(AGGREGATE_METADATA_LIMIT + 1)
				.all()
		: [];
	assertAggregateBudget(ownerRows.length);
	const childRows =
		childScopes.length > 0
			? tx
					.select({
						id: narratorMessages.id,
						narratorId: narratorMessages.narratorId,
						parentToolUseId: narratorMessages.parentToolUseId,
						callerSeq: sql<
							number | null
						>`(SELECT aggregate_ref.seq FROM narrator_message_refs aggregate_ref
			WHERE aggregate_ref.narrator_id = ${narratorId}
			AND aggregate_ref.message_id = narrator_messages.id
			AND aggregate_ref.segment_compact_id IS NULL)`,
					})
					.from(narratorMessages)
					.innerJoin(narrators, eq(narrators.id, narratorMessages.narratorId))
					.where(or(...childScopes))
					.limit(AGGREGATE_METADATA_LIMIT + 1)
					.all()
			: [];
	assertAggregateBudget(childRows.length);
	const inlineRows: Array<{
		id: string;
		narratorId: string;
		parentToolUseId: string;
		seq: number;
	}> = [];
	const ownerGroups = new Map<string, Map<string, SubagentActivityOwner>>();
	for (const row of childRows) {
		if (!row.parentToolUseId) continue;
		const parent = parents.get(row.parentToolUseId);
		if (!parent) continue;
		// Legacy inline responses remain readable only with an actual caller ref.
		if (!SUBAGENT_TOOL_NAMES.has(parent.toolName) && row.callerSeq !== null)
			inlineRows.push({
				id: row.id,
				narratorId: row.narratorId,
				parentToolUseId: row.parentToolUseId,
				seq: row.callerSeq,
			});
	}
	for (const row of ownerRows) {
		const parentToolUseId = row.originToolCallId && parentByOrigin.get(row.originToolCallId);
		if (!parentToolUseId || !row.parentNarratorId || !isSubagentVariant(row.variant)) continue;
		const group = ownerGroups.get(parentToolUseId) ?? new Map<string, SubagentActivityOwner>();
		const parent = parents.get(parentToolUseId);
		if (!parent) continue;
		group.set(row.id, {
			parentToolUseId,
			subagentNarratorId: row.id,
			model: row.model,
			reasoningEffort: row.reasoningEffort,
		});
		ownerGroups.set(parentToolUseId, group);
	}
	const owners = [...ownerGroups.values()].flatMap((group) =>
		group.size === 1 ? [...group.values()] : [],
	);
	return { parents, inlineRows, owners };
}

export function loadAggregateRefMessagesTx(
	tx: MessageTx,
	narratorId: string,
	messageIds: string[],
) {
	const ids = [...new Set(messageIds)];
	assertAggregateBudget(ids.length);
	if (ids.length === 0) return [];
	const refs = tx
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inArray(narratorMessageRefs.messageId, ids),
				isNull(narratorMessageRefs.segmentCompactId),
			),
		)
		.orderBy(narratorMessageRefs.messageId)
		.limit(AGGREGATE_METADATA_LIMIT + 1)
		.all();
	if (refs.length !== ids.length)
		throw new AppError(
			"History aggregation references changed; reload the history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	// Payload/attempt byte limits are checked by the off-main reader before decoding.
	return refs;
}

export const TOOL_DETAIL_CANDIDATE_LIMIT = 200;

export const TOOL_DETAIL_METADATA_ROW_LIMIT = 1_000;

export const TOOL_DETAIL_PAYLOAD_BYTE_LIMIT = 32 * 1024 * 1024;

export type ToolDetailReference = { toolCallId?: string; messageId?: string };

export function toolDetailSelectionRequired(): AppError {
	return new AppError(
		"Tool detail selection is ambiguous or exceeds the metadata budget; specify toolCallId or messageId.",
		409,
		"TOOL_CALL_DETAIL_SELECTION_REQUIRED",
	);
}

export function toolMessageRefExists(narratorId: string | AnyColumn): SQL<boolean> {
	// Keep the outer table qualification literal. Drizzle strips Column qualifiers
	// in single-table projections, which would correlate message_id to detail_ref
	// itself and accidentally authorize every tool whenever any caller ref exists.
	return sql<boolean>`EXISTS (
		SELECT 1 FROM narrator_message_refs detail_ref
		WHERE detail_ref.narrator_id = ${narratorId}
			AND detail_ref.message_id = narrator_tool_calls.message_id
	)`;
}

export function selectVisibleToolCallTx(
	tx: MessageTx,
	narratorId: string,
	toolUseId: string,
	reference?: ToolDetailReference,
) {
	for (const value of [reference?.toolCallId, reference?.messageId]) {
		if (
			value !== undefined &&
			(typeof value !== "string" || value.length === 0 || value.length > 128)
		) {
			throw new ValidationError(
				"Tool detail references must be non-empty IDs of at most 128 characters",
			);
		}
	}
	let metadataRows = 0;
	const admit = (length: number) => {
		metadataRows += length;
		if (length > TOOL_DETAIL_CANDIDATE_LIMIT || metadataRows > TOOL_DETAIL_METADATA_ROW_LIMIT) {
			throw toolDetailSelectionRequired();
		}
	};
	const parentColumns = {
		...historyToolMetadataColumns,
		executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
		directRef: toolMessageRefExists(narratorId),
	};
	const candidates = tx
		.select({
			...parentColumns,
			messageNarratorId: narratorMessages.narratorId,
			parentToolUseId: narratorMessages.parentToolUseId,
			authorType: narrators.type,
			authorVariant: narrators.variant,
			authorParentNarratorId: narrators.parentNarratorId,
			authorOriginToolCallId: narrators.originToolCallId,
			authorRef: toolMessageRefExists(narratorMessages.narratorId),
		})
		.from(narratorToolCalls)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
		.innerJoin(narrators, eq(narrators.id, narratorMessages.narratorId))
		.where(
			and(
				eq(narratorToolCalls.toolUseId, toolUseId),
				reference?.toolCallId !== undefined
					? eq(narratorToolCalls.id, reference.toolCallId)
					: undefined,
				reference?.messageId !== undefined
					? eq(narratorToolCalls.messageId, reference.messageId)
					: undefined,
			),
		)
		.limit(TOOL_DETAIL_CANDIDATE_LIMIT + 1)
		.all();
	admit(candidates.length);
	const childVisibility = new Map<string, boolean>();
	const visible = candidates.filter((candidate) => {
		if (candidate.directRef) return true;
		// A provider-supplied parentToolUseId is only a consistency check after the
		// real subagent identity and original tool-call PK have established ancestry.
		if (
			candidate.authorType !== "subagent" ||
			!isSubagentVariant(candidate.authorVariant) ||
			!candidate.authorOriginToolCallId ||
			!candidate.authorParentNarratorId ||
			!candidate.parentToolUseId ||
			!candidate.authorRef ||
			candidate.narratorId !== candidate.messageNarratorId
		)
			return false;
		const originId = candidate.authorOriginToolCallId;
		const key = JSON.stringify([candidate.messageNarratorId, originId, candidate.parentToolUseId]);
		const cached = childVisibility.get(key);
		if (cached !== undefined) return cached;
		const isAgent = (call: {
			toolName: string;
			executionIdentityVersion: number;
			isFileHistoryCheckpoint: boolean;
		}) =>
			(call.toolName === "Agent" || call.toolName === "Task") &&
			call.executionIdentityVersion === 1 &&
			!call.isFileHistoryCheckpoint;
		const original = tx
			.select(parentColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, originId))
			.get();
		admit(original ? 1 : 0);
		if (
			original &&
			(!isAgent(original) ||
				original.executionOriginToolCallId !== null ||
				original.narratorId !== candidate.authorParentNarratorId ||
				original.toolUseId !== candidate.parentToolUseId)
		) {
			childVisibility.set(key, false);
			return false;
		}
		if (original?.directRef) {
			childVisibility.set(key, true);
			return true;
		}
		// The original may have been removed after COW. Its immutable PK survives
		// in the copy; neither a shared provider ID nor an author's identity alone
		// is enough. The requesting narrator must still reference that exact copy.
		const parentCopies = tx
			.select(parentColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.toolUseId, candidate.parentToolUseId))
			.limit(TOOL_DETAIL_CANDIDATE_LIMIT + 1)
			.all();
		admit(parentCopies.length);
		const allowed = parentCopies.some(
			(parent) =>
				parent.directRef && isAgent(parent) && parent.executionOriginToolCallId === originId,
		);
		childVisibility.set(key, allowed);
		return allowed;
	});
	if (visible.length === 0) throw new NotFoundError("ToolCall", toolUseId);
	if (visible.length !== 1) throw toolDetailSelectionRequired();
	return visible[0];
}

export function getToolCallDetailTx(
	tx: MessageTx,
	narratorId: string,
	toolUseId: string,
	reference?: ToolDetailReference,
) {
	const selected = selectVisibleToolCallTx(tx, narratorId, toolUseId, reference);
	// Even a unique authorized row has a response budget. Never truncate it and
	// claim it is complete, or parse a large payload just to discover its length.
	const size = tx
		.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!size) throw new NotFoundError("ToolCall", toolUseId);
	if (size.bytes > TOOL_DETAIL_PAYLOAD_BYTE_LIMIT) {
		throw new AppError(
			"Tool detail exceeds the payload byte limit",
			413,
			"TOOL_CALL_DETAIL_TOO_LARGE",
		);
	}
	const detail = tx
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!detail) throw new NotFoundError("ToolCall", toolUseId);
	return toolCallWithExecutionTargets(detail);
}

export function getCompactSummaryTx(tx: MessageTx, narratorId: string, messageId: string) {
	const msg = tx.query.narratorMessages
		.findFirst({
			where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
		})
		.sync();
	const ref = tx.query.narratorMessageRefs
		.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
			columns: { seq: true, isCompact: true },
		})
		.sync();
	if (!msg || !ref) throw new NotFoundError("Message", messageId);

	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
	if (!compactBlock) throw new NotFoundError("CompactSummary", messageId);
	const latestCompactRows = tx
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1)
		.all();
	const latestCompactSeq = latestCompactRows[0]?.seq ?? null;
	const canRetry =
		compactBlock.status === "failed" &&
		ref.isCompact === 0 &&
		(latestCompactSeq == null || ref.seq > latestCompactSeq);
	const latestAttempt = compactBlock.attempts?.at(-1);
	return {
		status: compactBlock.status,
		summary: typeof compactBlock.summary === "string" ? compactBlock.summary : "",
		...{
			model: latestAttempt?.model,
			startedAt: latestAttempt?.startedAt,
			finishedAt: latestAttempt?.finishedAt,
		},
		error:
			typeof compactBlock.error === "string"
				? compactBlock.error
				: latestAttempt?.status === "failed"
					? latestAttempt.error
					: undefined,
		mode: compactBlock.mode,
		trigger: compactBlock.trigger,
		contextPercentBefore: compactBlock.contextPercentBefore,
		contextPercentAfter: compactBlock.contextPercentAfter,
		attempts: compactBlock.attempts ?? [],
		canRetry,
	};
}

export type DeletableBlock = { type: string; id?: string; text?: string };

export type BlockDeleteOptions = {
	skipRevert?: boolean;
	skipNarratorUpdate?: boolean;
	preserveConversationId?: boolean;
	scope?: RevertScope;
};

export type BlockDeletionPlan = {
	message: typeof narratorMessages.$inferSelect;
	ref: typeof narratorMessageRefs.$inferSelect;
	indices: number[];
	remaining: DeletableBlock[];
	removed: DeletableBlock[];
	isShared: boolean;
	toolCalls: Array<typeof narratorToolCalls.$inferSelect>;
	checkpointToolCalls: Array<typeof narratorToolCalls.$inferSelect>;
};

export const BLOCK_DELETE_ROW_LIMIT = 5_000;

export const BLOCK_DELETE_BYTE_LIMIT = 4 * 1024 * 1024;

export function isCheckpointWorthyCall(call: typeof narratorToolCalls.$inferSelect): boolean {
	return (
		call.status === "success" &&
		(call.toolName === "Write" ||
			call.toolName === "Edit" ||
			!!(call.treeHashBefore && call.treeHashAfter && call.treeHashBefore !== call.treeHashAfter))
	);
}

export type HistoryBudget = (rows: number, bytes?: number) => void;

export type HistoryWarning = {
	code: "DERIVED_HISTORY_RETAINED";
	reason: "legacy_origin_unverified" | "shared_parent" | "referenced";
	toolCallId?: string;
	toolUseId?: string;
	messageId?: string;
};

export type HistoryToolMetadata = Pick<
	typeof narratorToolCalls.$inferSelect,
	keyof typeof historyToolMetadataColumns
>;

export type DerivedHistorySeed = { call: HistoryToolMetadata; seq: number; shared: boolean };

export function createHistoryBudget(): HistoryBudget {
	let rows = 0;
	let bytes = 0;
	return (additionalRows, additionalBytes = 0) => {
		rows += additionalRows;
		bytes += additionalBytes;
		if (rows > BLOCK_DELETE_ROW_LIMIT || bytes > BLOCK_DELETE_BYTE_LIMIT) {
			throw new AppError(
				"History deletion exceeds the safety budget; select fewer messages or blocks.",
				409,
				"HISTORY_DELETE_TOO_LARGE",
			);
		}
	};
}

export function loadHistoryToolsTx(tx: MessageTx, messageIds: string[], reserve: HistoryBudget) {
	if (messageIds.length === 0) return [];
	const rows = tx
		.select({
			...historyToolMetadataColumns,
			bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))),
		})
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.messageId, messageIds))
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	reserve(
		rows.length * 2,
		rows.reduce((sum, row) => sum + row.bytes, 0),
	);
	return rows;
}

export function checkpointGroupsTx(
	tx: MessageTx,
	refs: Array<{ messageId: string; seq: number }>,
	reserve: HistoryBudget,
): FileHistoryCheckpointGroup[] {
	if (refs.length === 0) return [];
	// loadHistoryToolsTx (or the block planner) already admitted every row's bytes.
	const rows = tx
		.select()
		.from(narratorToolCalls)
		.where(
			and(
				inArray(
					narratorToolCalls.messageId,
					refs.map((ref) => ref.messageId),
				),
				eq(narratorToolCalls.status, "success"),
				checkpointWorthyToolCall(),
			),
		)
		.orderBy(narratorToolCalls.createdAt, narratorToolCalls.id)
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	const groups = new Map<string, FileHistoryCheckpointGroup>();
	const seqs = new Map(refs.map((ref) => [ref.messageId, ref.seq]));
	for (const call of rows) {
		const group = groups.get(call.messageId) ?? {
			messageId: call.messageId,
			seq: seqs.get(call.messageId) ?? 0,
			toolCalls: [],
		};
		group.toolCalls.push(call);
		groups.set(call.messageId, group);
	}
	reserve(rows.length + groups.size * 2);
	return [...groups.values()];
}

export function planDerivedHistoryCleanup(
	tx: MessageTx,
	seeds: DerivedHistorySeed[],
	explicitMessageIds: Set<string>,
	skipRevert: boolean,
	reserve: HistoryBudget,
) {
	const warnings: HistoryWarning[] = [];
	const messageIds: string[] = [];
	const toolCallIds: string[] = [];
	const checkpoints: FileHistoryCheckpointGroup[] = [];
	const observations: unknown[] = [];
	const warned = new Set<string>();
	const warn = (
		call: HistoryToolMetadata,
		reason: HistoryWarning["reason"],
		messageId?: string,
	) => {
		const warning: HistoryWarning = {
			code: "DERIVED_HISTORY_RETAINED",
			reason,
			toolCallId: call.id,
			...(messageId ? { messageId } : {}),
		};
		const key = JSON.stringify(warning);
		if (warned.has(key)) return;
		warned.add(key);
		warnings.push(warning);
	};
	const pending = seeds.map((seed) => ({ ...seed, depth: 0 }));
	const seenCalls = new Set<string>();
	const seenMessages = new Set(explicitMessageIds);
	/**
	 * Subagents whose origin Agent/Task tool call is part of this deletion.
	 * Their card is disappearing from the parent timeline, so they must be
	 * interrupted and archived after the history mutation commits — even when
	 * their own messages are retained (shared_parent / referenced).
	 */
	const subagentNarratorIds: string[] = [];
	const childNarratorsByParent = new Map<
		string,
		Array<{ id: string; type: string; variant: string; originToolCallId: string | null }>
	>();
	for (let index = 0; index < pending.length; index++) {
		const { call, seq, shared, depth } = pending[index];
		if (seenCalls.has(call.id) || call.isFileHistoryCheckpoint) continue;
		seenCalls.add(call.id);
		// Legacy inline messages belong to the original narrator, not a proven child.
		const inline = tx
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.narratorId, call.narratorId),
					eq(narratorMessages.parentToolUseId, call.toolUseId),
				),
			)
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(inline.length);
		observations.push(inline);
		for (const row of inline) {
			if (!explicitMessageIds.has(row.id)) warn(call, "legacy_origin_unverified", row.id);
		}
		if (call.toolName !== "Agent" && call.toolName !== "Task") continue;
		if (shared || call.executionOriginToolCallId) {
			warn(call, "shared_parent");
			continue;
		}
		// A COW copy can outlive its original row. The provider ID only bounds this
		// lookup; only the exact immutable origin PK can prove a retained copy.
		const copies = tx
			.select(historyToolMetadataColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.toolUseId, call.toolUseId))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(copies.length);
		observations.push(copies);
		if (
			copies.some(
				(copy) =>
					copy.executionOriginToolCallId === call.id && !explicitMessageIds.has(copy.messageId),
			)
		) {
			warn(call, "shared_parent");
			continue;
		}
		let children = childNarratorsByParent.get(call.narratorId);
		if (!children) {
			// LIMIT before filtering origin: there is an index on parentNarratorId,
			// but no origin index. Refuse a huge sibling set instead of scanning it.
			children = tx
				.select({
					id: narrators.id,
					type: narrators.type,
					variant: narrators.variant,
					originToolCallId: narrators.originToolCallId,
				})
				.from(narrators)
				.where(eq(narrators.parentNarratorId, call.narratorId))
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(children.length);
			childNarratorsByParent.set(call.narratorId, children);
			observations.push(children);
		}
		for (const child of children) {
			if (child.type !== "subagent" || !isSubagentVariant(child.variant)) continue;
			if (!child.originToolCallId) {
				warn(call, "legacy_origin_unverified");
				continue;
			}
			if (child.originToolCallId !== call.id) continue;
			// Proven ancestry: this card is being deleted, so retire the subagent.
			// Collected before message retention checks — a referenced/shared child
			// still must not keep waking from @all members after its card is gone.
			if (!subagentNarratorIds.includes(child.id)) subagentNarratorIds.push(child.id);
			if (depth >= 32)
				throw new AppError(
					"Derived history exceeds the nesting safety budget",
					409,
					"HISTORY_DELETE_TOO_LARGE",
				);
			const rows = tx
				.select({
					id: narratorMessages.id,
					parentToolUseId: narratorMessages.parentToolUseId,
					bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))),
				})
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, child.id))
				.orderBy(narratorMessages.createdAt)
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(rows.length);
			observations.push(rows);
			if (rows.length === 0) continue;
			const refs = tx
				.select({
					id: narratorMessageRefs.id,
					messageId: narratorMessageRefs.messageId,
					narratorId: narratorMessageRefs.narratorId,
				})
				.from(narratorMessageRefs)
				.where(
					inArray(
						narratorMessageRefs.messageId,
						rows.map((row) => row.id),
					),
				)
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(refs.length);
			observations.push(refs);
			const referenced = new Set(refs.map((ref) => ref.messageId));
			for (const row of rows) {
				if (seenMessages.has(row.id)) continue;
				seenMessages.add(row.id);
				if (row.parentToolUseId !== call.toolUseId) {
					warn(call, "legacy_origin_unverified", row.id);
					continue;
				}
				if (referenced.has(row.id)) {
					warn(call, "referenced", row.id);
					// A retained child is a traversal boundary. Its own children are not selected.
					continue;
				}
				reserve(1, row.bytes);
				const childTools = loadHistoryToolsTx(tx, [row.id], reserve);
				observations.push(childTools);
				if (!skipRevert && childTools.length > 0) {
					throw new AppError(
						"Child tool history requires a complete rollback selection",
						409,
						"HISTORY_DERIVED_SELECTION_REQUIRED",
					);
				}
				assertNoRunningCompactMessagesTx(tx, [row.id]);
				messageIds.push(row.id);
				toolCallIds.push(...childTools.map((tool) => tool.id));
				if (skipRevert)
					checkpoints.push(...checkpointGroupsTx(tx, [{ messageId: row.id, seq }], reserve));
				pending.push(
					...childTools.map((tool) => ({ call: tool, seq, shared: false, depth: depth + 1 })),
				);
			}
		}
	}
	return { messageIds, toolCallIds, checkpoints, warnings, observations, subagentNarratorIds };
}

export function assertNoRunningCompactMessagesTx(tx: MessageTx, messageIds: string[]) {
	if (messageIds.length === 0) return [];
	// All selected message bytes have already been admitted by the caller.
	const rows = tx
		.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(inArray(narratorMessages.id, messageIds))
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	const toolBlocks: Array<{ messageId: string; toolUseId: string }> = [];
	for (const row of rows) {
		const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
		if (blocks.some((block) => parseCompactMessageBlock(block)?.status === "compacting")) {
			throw new AppError(
				"A running compact must be cancelled before its message can be deleted",
				409,
				"COMPACT_IN_PROGRESS",
			);
		}
		for (const block of blocks as DeletableBlock[]) {
			if (block.type === "tool_use" && block.id)
				toolBlocks.push({ messageId: row.id, toolUseId: block.id });
		}
	}
	return toolBlocks;
}

export function missingToolHistoryWarnings(
	blocks: Array<{ messageId: string; toolUseId: string }>,
	calls: HistoryToolMetadata[],
): HistoryWarning[] {
	const known = new Set(calls.map((call) => JSON.stringify([call.messageId, call.toolUseId])));
	return blocks
		.filter((block) => !known.has(JSON.stringify([block.messageId, block.toolUseId])))
		.map((block) => ({
			code: "DERIVED_HISTORY_RETAINED",
			reason: "legacy_origin_unverified",
			...block,
		}));
}

export function planBlockDeletions(
	tx: MessageTx,
	narratorId: string,
	grouped: Map<string, number[]>,
	opts?: BlockDeleteOptions,
) {
	const narrator = tx.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: { messageVersion: true } })
		.sync();
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	let rowCount = 0;
	let byteCount = 0;
	const reserve = (rows: number, bytes = 0) => {
		rowCount += rows;
		byteCount += bytes;
		if (rowCount > BLOCK_DELETE_ROW_LIMIT || byteCount > BLOCK_DELETE_BYTE_LIMIT) {
			throw new AppError(
				"Block deletion exceeds the history safety budget; select fewer blocks.",
				409,
				"HISTORY_DELETE_TOO_LARGE",
			);
		}
	};
	const plans: BlockDeletionPlan[] = [];
	for (const [messageId, indices] of grouped) {
		const ref = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			})
			.sync();
		if (!ref) throw new NotFoundError("Message", messageId);
		const size = tx
			.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))) })
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get();
		if (!size) throw new NotFoundError("Message", messageId);
		// Check bytes in SQL before materializing any large JSON/text field.
		reserve(4, size.bytes);
		const message = tx.query.narratorMessages
			.findFirst({ where: eq(narratorMessages.id, messageId) })
			.sync();
		if (!message) throw new NotFoundError("Message", messageId);
		const blocks = Array.isArray(message.contentJson)
			? (message.contentJson as DeletableBlock[])
			: [];
		if (blocks.some((block) => parseCompactMessageBlock(block)?.status === "compacting")) {
			throw new AppError(
				"A running compact must be cancelled before its message can be deleted",
				409,
				"COMPACT_IN_PROGRESS",
			);
		}
		for (const index of indices) {
			if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
				throw new ValidationError(
					`Block index ${index} out of range (0..${blocks.length - 1}) for message ${messageId}`,
				);
			}
		}
		const selected = new Set(indices);
		const injectionViews = injectionBlockViews(blocks);
		const contextViews = contextBlockViews(blocks);
		for (const index of indices) {
			const view =
				injectionViews.find((candidate) => candidate.blockIndex === index) ??
				contextViews.find((candidate) => candidate.blockIndex === index);
			for (const sourceIndex of view?.sourceIndices ?? []) selected.add(sourceIndex);
		}
		const remaining = blocks.filter((_, index) => !selected.has(index));
		const removed = [...selected].map((index) => blocks[index]);

		const removedToolIds = new Set(
			removed
				.filter(
					(block): block is DeletableBlock & { id: string } =>
						block.type === "tool_use" && !!block.id,
				)
				.map((block) => block.id),
		);
		if (
			remaining.some((block) => block.type === "tool_use" && removedToolIds.has(block.id ?? ""))
		) {
			throw new ValidationError("Selected and retained blocks share a tool-use identity");
		}
		const otherRef = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.messageId, messageId),
					ne(narratorMessageRefs.narratorId, narratorId),
				),
				columns: { id: true },
			})
			.sync();
		const toolSizes = tx
			.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.messageId, messageId))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(
			toolSizes.length * 2,
			toolSizes.reduce((sum, row) => sum + row.bytes, 0),
		);
		const toolCalls = tx
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.messageId, messageId))
			.orderBy(narratorToolCalls.id)
			.limit(BLOCK_DELETE_ROW_LIMIT)
			.all();
		if (
			!opts?.skipRevert &&
			remaining.length === 0 &&
			toolCalls.some((call) => !removedToolIds.has(call.toolUseId))
		) {
			throw new ValidationError("Message contains tool calls outside the selected block set");
		}
		const checkpointToolCalls = opts?.skipRevert
			? toolCalls.filter(
					(call) =>
						(remaining.length === 0 || removedToolIds.has(call.toolUseId)) &&
						isCheckpointWorthyCall(call),
				)
			: [];
		plans.push({
			message,
			ref,
			indices,
			remaining,
			removed,
			isShared: !!otherRef,
			toolCalls,
			checkpointToolCalls,
		});
	}
	const derived = planDerivedHistoryCleanup(
		tx,
		plans.flatMap((plan) => {
			const removed = new Set(
				plan.removed.filter((block) => block.type === "tool_use").map((block) => block.id),
			);
			return plan.toolCalls
				.filter((call) => removed.has(call.toolUseId))
				.map((call) => ({
					call,
					seq: plan.ref.seq,
					shared: plan.isShared || call.narratorId !== narratorId,
				}));
		}),
		new Set(grouped.keys()),
		!!opts?.skipRevert,
		reserve,
	);
	derived.warnings.push(
		...missingToolHistoryWarnings(
			plans.flatMap((plan) =>
				plan.removed
					.filter(
						(block): block is DeletableBlock & { id: string } =>
							block.type === "tool_use" && !!block.id,
					)
					.map((block) => ({ messageId: plan.message.id, toolUseId: block.id })),
			),
			plans.flatMap((plan) => plan.toolCalls),
		),
	);
	const deletedMessageIds = [
		...plans
			.filter((plan) => !plan.isShared && plan.remaining.length === 0)
			.map((plan) => plan.message.id),
		...derived.messageIds,
	];
	const deletedToolIds = plans.flatMap((plan) => {
		const removed = new Set(
			plan.removed.filter((block) => block.type === "tool_use").map((block) => block.id),
		);
		return [
			...(!plan.isShared
				? plan.toolCalls
						.filter((call) => plan.remaining.length === 0 || removed.has(call.toolUseId))
						.map((call) => call.id)
				: []),
		];
	});
	const associations = collectHistoryDeleteAssociations(
		tx,
		deletedMessageIds,
		[...deletedToolIds, ...derived.toolCallIds],
		reserve,
	);
	return { messageVersion: narrator.messageVersion, plans, derived, associations };
}

export function collectHistoryDeleteAssociations(
	tx: MessageTx,
	deletedMessageIds: string[],
	deletedToolIds: string[],
	reserve: HistoryBudget,
) {
	// Include FK cascades / SET NULL and the boundary pointers explicitly cleared by
	// deleteOrphanedMessages. Otherwise a small selection can hide an unbounded tx.
	return [
		{ table: narrators, column: narrators.forkMessageId, ids: deletedMessageIds },
		{ table: narratorPatches, column: narratorPatches.messageId, ids: deletedMessageIds },
		{ table: apiRequests, column: apiRequests.messageId, ids: deletedMessageIds },
		{
			table: knowledgeInjectionEvents,
			column: knowledgeInjectionEvents.triggerMessageId,
			ids: deletedMessageIds,
		},
		{ table: narratorQuestions, column: narratorQuestions.toolCallId, ids: deletedToolIds },
		{
			table: narratorToolContinuations,
			column: narratorToolContinuations.toolCallId,
			ids: deletedToolIds,
		},
		{
			table: knowledgeInjectionEvents,
			column: knowledgeInjectionEvents.triggerToolCallId,
			ids: deletedToolIds,
		},
	].map(({ table, column, ids }) => {
		if (ids.length === 0) return [];
		const rows = tx
			.select({ id: table.id, bytes: storedRowBytes(Object.values(getTableColumns(table))) })
			.from(table)
			.where(inArray(column, [...new Set(ids)]))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(
			rows.length,
			rows.reduce((sum, row) => sum + row.bytes, 0),
		);
		return rows;
	});
}

export type FileHistoryToolCall = typeof narratorToolCalls.$inferSelect;

export type FileHistoryCheckpointGroup = {
	messageId: string;
	seq: number;
	toolCalls: FileHistoryToolCall[];
};

export function checkpointWorthyToolCall() {
	return or(
		sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
		and(
			isNotNull(narratorToolCalls.treeHashBefore),
			isNotNull(narratorToolCalls.treeHashAfter),
			ne(narratorToolCalls.treeHashBefore, narratorToolCalls.treeHashAfter),
		),
	);
}

export function planMessageRangeDeletion(
	tx: MessageTx,
	narratorId: string,
	messageId: string,
	inclusive: boolean,
	opts?: BlockDeleteOptions,
) {
	const reserve = createHistoryBudget();
	const narrator = tx.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: { messageVersion: true } })
		.sync();
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const boundary = tx.query.narratorMessageRefs
		.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		})
		.sync();
	if (!boundary) throw new NotFoundError("Message", messageId);
	const refs = tx
		.select({
			id: narratorMessageRefs.id,
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inclusive
					? gte(narratorMessageRefs.seq, boundary.seq)
					: gt(narratorMessageRefs.seq, boundary.seq),
				// A history-only action must retain previously detached file evidence,
				// not delete/recreate its IDs on every retry. Match only our internal
				// checkpoint shape, never all hidden/compacted refs. File rollback still
				// selects these records through the ordinary range above.
				opts?.skipRevert
					? sql`NOT EXISTS (
						SELECT 1 FROM ${narratorMessages}
						WHERE ${narratorMessages.id} = ${narratorMessageRefs.messageId}
						AND ${narratorMessageRefs.segmentCompactId} = ${narratorMessageRefs.messageId}
						AND ${narratorMessages.role} = 'disp'
						AND ${narratorMessages.contentJson} = ${JSON.stringify([{ type: "file_history_checkpoint" }])}
					)`
					: undefined,
			),
		)
		.orderBy(narratorMessageRefs.seq)
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	reserve(refs.length);
	const refIds = new Set(refs.map((ref) => ref.id));
	const messageIds = refs.map((ref) => ref.messageId);
	const messages =
		messageIds.length > 0
			? tx
					.select({
						id: narratorMessages.id,
						narratorId: narratorMessages.narratorId,
						bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))),
					})
					.from(narratorMessages)
					.where(inArray(narratorMessages.id, messageIds))
					.orderBy(narratorMessages.id)
					.limit(BLOCK_DELETE_ROW_LIMIT + 1)
					.all()
			: [];
	reserve(
		messages.length,
		messages.reduce((sum, row) => sum + row.bytes, 0),
	);
	if (messages.length !== messageIds.length)
		throw new AppError("Selected history contains a missing message", 409, "HISTORY_DELETE_STALE");
	const toolBlocks = assertNoRunningCompactMessagesTx(tx, messageIds);
	reserve(toolBlocks.length);
	const allRefs =
		messageIds.length > 0
			? tx
					.select({
						id: narratorMessageRefs.id,
						messageId: narratorMessageRefs.messageId,
						narratorId: narratorMessageRefs.narratorId,
					})
					.from(narratorMessageRefs)
					.where(inArray(narratorMessageRefs.messageId, messageIds))
					.limit(BLOCK_DELETE_ROW_LIMIT + 1)
					.all()
			: [];
	reserve(allRefs.length);
	const retainedIds = new Set(
		allRefs.filter((ref) => !refIds.has(ref.id)).map((ref) => ref.messageId),
	);
	const tools = loadHistoryToolsTx(tx, messageIds, reserve);
	const seqs = new Map(refs.map((ref) => [ref.messageId, ref.seq]));
	const derived = planDerivedHistoryCleanup(
		tx,
		tools.map((call) => ({
			call,
			seq: seqs.get(call.messageId) ?? boundary.seq,
			shared: retainedIds.has(call.messageId) || call.narratorId !== narratorId,
		})),
		new Set(messageIds),
		!!opts?.skipRevert,
		reserve,
	);
	derived.warnings.push(...missingToolHistoryWarnings(toolBlocks, tools));
	const orphanIds = [...messageIds.filter((id) => !retainedIds.has(id)), ...derived.messageIds];
	const removedTools = [
		...tools.filter((call) => !retainedIds.has(call.messageId)).map((call) => call.id),
		...derived.toolCallIds,
	];
	const checkpoints = opts?.skipRevert
		? [...checkpointGroupsTx(tx, refs, reserve), ...derived.checkpoints]
		: [];
	const associations = collectHistoryDeleteAssociations(tx, orphanIds, removedTools, reserve);
	return {
		messageVersion: narrator.messageVersion,
		boundary,
		refs,
		messages,
		allRefs,
		tools,
		derived,
		orphanIds,
		checkpoints,
		associations,
	};
}
