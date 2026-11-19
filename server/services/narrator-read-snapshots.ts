import type { Database } from "bun:sqlite";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { clearedToolOutputSql } from "@shared/narrator-blocks/retention";
import {
	type AnyColumn,
	and,
	eq,
	getTableColumns,
	inArray,
	isNotNull,
	isNull,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { narratorMessageRefs, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { NARRATOR_MESSAGE_SOURCE_MAX_BYTES } from "../lib/db-worker/domain-limits";
import { DbReadError } from "../lib/db-worker/errors";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { boundedBodyText, hasBlockStorage } from "../lib/narrator-bodies";
import { isSubagentVariant } from "../lib/narrator-utils";

function reader(database: Database) {
	return drizzle(database, { schema });
}
type MessageTx = ReturnType<typeof reader>;
const METADATA_BYTES = FILE_CHANGE_LIMITS.metadataBytes;
function storedRowBytes(columns: AnyColumn[]): SQL<number> {
	return sql<number>`${sql.join(
		columns
			.filter((column) => !column.generated)
			.map((column) => sql`coalesce(octet_length(${column}), 0)`),
		sql` + `,
	)}`;
}

const historyToolMetadataColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
};

interface SubagentActivityOwner {
	parentToolUseId: string;
	subagentNarratorId: string;
	model: string | null;
	reasoningEffort: string | null;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "Send"]);

const AGGREGATE_METADATA_LIMIT = 500;

const AGGREGATE_BODY_BYTE_LIMIT = 4 * 1024 * 1024;

function assertAggregateBudget(rows: number, bytes = 0): void {
	if (rows > AGGREGATE_METADATA_LIMIT || bytes > AGGREGATE_BODY_BYTE_LIMIT) {
		throw new AppError(
			"History aggregation exceeds its safety budget; request a smaller history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	}
}

function resolveAggregateScopeTx(tx: MessageTx, narratorId: string, toolUseIds: string[]) {
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

function loadAggregateRefMessagesTx(tx: MessageTx, narratorId: string, messageIds: string[]) {
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

const TOOL_DETAIL_CANDIDATE_LIMIT = 200;

const TOOL_DETAIL_METADATA_ROW_LIMIT = 1_000;

const TOOL_DETAIL_PAYLOAD_BYTE_LIMIT = 32 * 1024 * 1024;

type ToolDetailReference = {
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: number;
};

function toolDetailSelectionRequired(): AppError {
	return new AppError(
		"Tool detail selection is ambiguous or exceeds the metadata budget; specify toolCallId or messageId.",
		409,
		"TOOL_CALL_DETAIL_SELECTION_REQUIRED",
	);
}

function toolMessageRefExists(narratorId: string | AnyColumn): SQL<boolean> {
	// Keep the outer table qualification literal. Drizzle strips Column qualifiers
	// in single-table projections, which would correlate message_id to detail_ref
	// itself and accidentally authorize every tool whenever any caller ref exists.
	return sql<boolean>`EXISTS (
		SELECT 1 FROM narrator_message_refs detail_ref
		WHERE detail_ref.narrator_id = ${narratorId}
			AND detail_ref.message_id = narrator_tool_calls.message_id
	)`;
}

function selectVisibleToolCallTx(
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
	if (
		reference?.executionAttempt !== undefined &&
		(!Number.isSafeInteger(reference.executionAttempt) || reference.executionAttempt < 0)
	)
		throw new ValidationError("Tool detail execution attempt must be a non-negative safe integer");
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
				reference?.executionAttempt !== undefined
					? eq(narratorToolCalls.executionAttempt, reference.executionAttempt)
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
function boundedText(column: AnyColumn) {
	return sql<
		string | null
	>`CASE WHEN octet_length(${column}) <= ${METADATA_BYTES} THEN ${column} ELSE NULL END`;
}
const toolEditPreviewColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	executionAttempt: narratorToolCalls.executionAttempt,
	fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
	executionDeviceId: boundedText(narratorToolCalls.executionDeviceId),
	executionCwd: boundedText(narratorToolCalls.executionCwd),
	executionPathFlavor: narratorToolCalls.executionPathFlavor,
	resolvedFilePath: boundedText(narratorToolCalls.resolvedFilePath),
	canonicalFilePath: boundedText(narratorToolCalls.canonicalFilePath),
	runtimeGeneration: narratorToolCalls.runtimeGeneration,
	treeHashBefore: boundedText(narratorToolCalls.treeHashBefore),
	treeHashAfter: boundedText(narratorToolCalls.treeHashAfter),
	locationJson: sql<string | null>`CASE
		WHEN octet_length(${narratorToolCalls.outputJson}) <= ${64 * 1024}
		THEN CASE WHEN json_valid(${narratorToolCalls.outputJson})
			THEN json_extract(${narratorToolCalls.outputJson}, '$._metadata') END
		END`,
};

export interface NarratorAggregateScopeParams {
	narratorId: string;
	toolUseIds: string[];
}
export interface NarratorAggregateRefsParams {
	narratorId: string;
	messageIds: string[];
}
export interface NarratorToolReadParams {
	narratorId: string;
	toolUseId: string;
	reference: ToolDetailReference | null;
}
export interface NarratorCompactReadParams {
	narratorId: string;
	messageId: string;
}
export type NarratorAggregateScope = ReturnType<typeof resolveAggregateScopeTx>;
export type NarratorAggregateScopeResult = Omit<NarratorAggregateScope, "parents"> & {
	parents: Array<
		[string, NarratorAggregateScope["parents"] extends Map<string, infer P> ? P : never]
	>;
};
export type NarratorAggregateRefsResult = ReturnType<typeof loadAggregateRefMessagesTx>;
export type NarratorToolDetailResult = Record<string, string | number | null | Uint8Array>;
export function readNarratorAggregateScope(
	database: Database,
	input: NarratorAggregateScopeParams,
	signal?: AbortSignal,
): NarratorAggregateScopeResult {
	check(signal);
	const value = resolveAggregateScopeTx(reader(database), input.narratorId, input.toolUseIds);
	return { ...value, parents: [...value.parents] };
}
export function readNarratorAggregateRefs(
	database: Database,
	input: NarratorAggregateRefsParams,
	signal?: AbortSignal,
): NarratorAggregateRefsResult {
	check(signal);
	return loadAggregateRefMessagesTx(reader(database), input.narratorId, input.messageIds);
}
export function readNarratorToolDetail(
	database: Database,
	input: NarratorToolReadParams,
	signal?: AbortSignal,
): NarratorToolDetailResult {
	check(signal);
	const tx = reader(database);
	const selected = selectVisibleToolCallTx(
		tx,
		input.narratorId,
		input.toolUseId,
		input.reference ?? undefined,
	);
	const size = tx
		.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!size) throw new NotFoundError("ToolCall", input.toolUseId);
	if (size.bytes > TOOL_DETAIL_PAYLOAD_BYTE_LIMIT)
		throw new AppError(
			"Tool detail exceeds the payload byte limit",
			413,
			"TOOL_CALL_DETAIL_TOO_LARGE",
		);
	// Keep JSON columns as driver strings: the 32MiB detail contract must not acquire a nested-array cap.
	const statement = database.prepare("SELECT * FROM narrator_tool_calls WHERE id = ?");
	try {
		const row = statement.get(selected.id) as NarratorToolDetailResult | undefined;
		if (!row) throw new NotFoundError("ToolCall", input.toolUseId);
		return row;
	} finally {
		statement.finalize();
	}
}
export function readNarratorToolPreview(
	database: Database,
	input: NarratorToolReadParams,
	signal?: AbortSignal,
) {
	check(signal);
	const tx = reader(database);
	const selected = selectVisibleToolCallTx(
		tx,
		input.narratorId,
		input.toolUseId,
		input.reference ?? undefined,
	);
	const row = tx
		.select({
			...toolEditPreviewColumns,
			payloadCleared: sql<boolean>`(${sql.raw(clearedToolOutputSql())})`.mapWith(Boolean),
		})
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!row) throw new NotFoundError("ToolCall", input.toolUseId);
	return row;
}
export type NarratorToolPreviewResult = ReturnType<typeof readNarratorToolPreview>;
export interface NarratorCompactReadResult {
	contentJsonText: string;
	seq: number;
	isCompact: number;
	latestCompactSeq: number | null;
}
export function readNarratorCompactSummary(
	database: Database,
	input: NarratorCompactReadParams,
	signal?: AbortSignal,
): NarratorCompactReadResult {
	check(signal);
	const statement = database.prepare(
		`SELECT m.id, r.seq, r.is_compact AS isCompact, (SELECT MAX(latest.seq) FROM narrator_message_refs latest WHERE latest.narrator_id = r.narrator_id AND latest.is_compact = 1) AS latestCompactSeq FROM narrator_messages m JOIN narrator_message_refs r ON r.message_id = m.id AND r.narrator_id = ? WHERE m.id = ? AND m.role = ? LIMIT 1`,
	);
	try {
		const row = statement.get(input.narratorId, input.messageId, "system") as
			| {
					id: string;
					seq: number;
					isCompact: number;
					latestCompactSeq: number | null;
			  }
			| undefined;
		if (!row) throw new NotFoundError("Message", input.messageId);
		const content = boundedBodyText(database, row.id, hasBlockStorage(database), {
			maxBytes: NARRATOR_MESSAGE_SOURCE_MAX_BYTES,
		});
		if (content === undefined)
			throw new DbReadError("DB_READ_BUDGET", "Compact body exceeds its source budget");
		check(signal);
		return {
			contentJsonText: content,
			seq: row.seq,
			isCompact: row.isCompact,
			latestCompactSeq: row.latestCompactSeq,
		};
	} finally {
		statement.finalize();
	}
}
function check(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Narrator snapshot read aborted");
}
function id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
export function validateNarratorAggregateScope(
	input: unknown,
): input is NarratorAggregateScopeParams {
	return (
		exact(input, ["narratorId", "toolUseIds"]) &&
		id(input.narratorId) &&
		Array.isArray(input.toolUseIds) &&
		input.toolUseIds.length <= 500 &&
		input.toolUseIds.every(id)
	);
}
export function validateNarratorAggregateRefs(
	input: unknown,
): input is NarratorAggregateRefsParams {
	return (
		exact(input, ["narratorId", "messageIds"]) &&
		id(input.narratorId) &&
		Array.isArray(input.messageIds) &&
		input.messageIds.length <= 500 &&
		input.messageIds.every(id)
	);
}
export function validateNarratorToolRead(input: unknown): input is NarratorToolReadParams {
	if (
		!exact(input, ["narratorId", "toolUseId", "reference"]) ||
		!id(input.narratorId) ||
		!id(input.toolUseId)
	)
		return false;
	if (input.reference === null) return true;
	if (!input.reference || typeof input.reference !== "object" || Array.isArray(input.reference))
		return false;
	return Object.entries(input.reference).every(([key, value]) =>
		key === "executionAttempt"
			? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			: (key === "toolCallId" || key === "messageId") &&
				typeof value === "string" &&
				value.length > 0 &&
				value.length <= 128,
	);
}
export function validateNarratorCompactRead(input: unknown): input is NarratorCompactReadParams {
	return exact(input, ["narratorId", "messageId"]) && id(input.narratorId) && id(input.messageId);
}
