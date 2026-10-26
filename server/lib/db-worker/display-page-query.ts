import type { Database } from "bun:sqlite";
import { blockBodies, bodyBytesSql, bodySql } from "../narrator-bodies";
import {
	DisplayJsonAllocationBudget,
	storedDisplayAllocationBudget,
} from "./display-page-json-budget";
import { projectDisplayToolCall, projectNarratorDisplayMessage } from "./display-page-projection";
import {
	type DISPLAY_FIXTURE_LIMITS,
	DISPLAY_PAGE_LIMITS,
	type DisplayPageMessagesParams,
	type DisplayPageMessagesResult,
	DisplayPageReadError,
	type NarratorDisplayMessage,
	type NarratorDisplayToolCall,
	validateDisplayPageRequest,
} from "./display-page-protocol";

export interface DisplayColumn {
	column: string;
	field: string;
	json: boolean;
	boolean: boolean;
}

function columns(fields: string, jsonFields: string, booleanFields = ""): DisplayColumn[] {
	const json = new Set(jsonFields.split(" "));
	const booleans = new Set(booleanFields.split(" "));
	return fields
		.trim()
		.split(/\s+/)
		.map((field) => ({
			column:
				field === "messageUuid"
					? "sdk_message_uuid"
					: field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/([a-z])(\d)/g, "$1_$2"),
			field,
			json: json.has(field),
			boolean: booleans.has(field),
		}));
}

/** Explicit DTO allowlists: no relation aggregation/json_group_array, no arbitrary SQL. */
export const DISPLAY_MESSAGE_COLUMNS = [
	...columns(
		`id narratorId messageUuid parentToolUseId role contentJson bodyRevision contentText
	contextCharsJson tokensIn costUsd costStatus costMissingFields turnUsageJson provider credentialId
	model outputTokens cachedInputTokens cacheCreationInputTokens cacheCreation5mTokens
	cacheCreation1hTokens reasoningTokens ttftMs durationMs contextPercent meterUsage meterUnit
	commitSha treeHashAfter snapshotCommitSha commandText createdBy origin originLabel editedAt
	editedBy originalContentJson compactPending bodyFormat turnId authorNarratorId causeBlockId
	providerResponseId bodyBytes stateRevision bodyRowsOnly blocksContentHash createdAt`,
		"contentJson contextCharsJson costMissingFields turnUsageJson originalContentJson",
	),
	{ column: "composer_document", field: "hasComposerDocument", json: false, boolean: true },
];

export const DISPLAY_TOOL_COLUMNS = columns(
	`id narratorId messageId toolUseId toolName modelRevision inputJson outputJson inputChars outputChars
	executionDeviceId executionCwd executionPathFlavor resolvedFilePath canonicalFilePath runtimeGeneration
	executionTargetsJson deviceSelectionSource status durationMs streamStartedAt streamCompletedAt
	permissionStartedAt executionStartedAt completedAt startedAt errorMessage permissionDecidedBy
	permissionDecidedAt permissionDenyMessage permissionDecisionReason permissionSuggestions isBackground
	executionIdentityVersion executionOriginToolCallId executionAttempt executionSegmentId fileChangeOperationId
	isFileHistoryCheckpoint treeHashBefore treeHashAfter ownedPathsJson inputTokens outputTokens
	cacheCreationTokens cacheReadTokens cacheCreation5mTokens cacheCreation1hTokens inputCost outputCost
	cacheCreationCost cacheReadCost totalCost costStatus costMissingFields provider model resultMessageId
	blockId isInternal createdAt`,
	"inputJson outputJson executionTargetsJson permissionSuggestions ownedPathsJson costMissingFields",
	"isBackground isFileHistoryCheckpoint isInternal",
);

const CREATOR_COLUMNS = columns("id username avatarColor avatarImageId", "");
type Limits = typeof DISPLAY_PAGE_LIMITS | typeof DISPLAY_FIXTURE_LIMITS;

function selection(
	alias: string,
	descriptors: readonly DisplayColumn[],
	fromBlocks = false,
): string {
	return descriptors
		.map(({ column, field }) => {
			if (field === "contentJson" && fromBlocks) return `${bodySql(alias, true)} AS "${field}"`;
			return `${field === "hasComposerDocument" ? `(${alias}."${column}" IS NOT NULL)` : `${alias}."${column}"`} AS "${field}"`;
		})
		.join(", ");
}

function storedBytes(
	alias: string,
	descriptors: readonly DisplayColumn[],
	fromBlocks = false,
): string {
	return descriptors
		.map(({ column, field }) => {
			if (field === "hasComposerDocument") return "1";
			if (field === "contentJson" && fromBlocks) return `coalesce(${bodyBytesSql(alias, true)}, 0)`;
			return `coalesce(length(CAST(${alias}."${column}" AS BLOB)), 0)`;
		})
		.join(" + ");
}

export function decodeDisplayRow(
	row: Record<string, unknown>,
	descriptors: readonly DisplayColumn[],
	budget: DisplayJsonAllocationBudget,
): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const descriptor of descriptors) {
		const value = row[descriptor.field];
		if (descriptor.json && value !== null) {
			if (typeof value !== "string")
				throw new DisplayPageReadError(
					"DISPLAY_PAGE_INVALID_JSON",
					`Invalid stored display field: ${descriptor.field}`,
				);
			budget.reserveJson(value);
			try {
				decoded[descriptor.field] = JSON.parse(value);
			} catch {
				// Do not put malformed/raw content or credentials in a transport error.
				throw new DisplayPageReadError(
					"DISPLAY_PAGE_INVALID_JSON",
					`Invalid stored display JSON: ${descriptor.field}`,
				);
			}
		} else {
			decoded[descriptor.field] = descriptor.boolean && value !== null ? Boolean(value) : value;
		}
	}
	return decoded;
}

function budgetError(reason: string): never {
	throw new DisplayPageReadError(
		"DISPLAY_PAGE_BUDGET_EXCEEDED",
		`Display page exceeded ${reason}; request a smaller history window`,
	);
}

/**
 * Worker-only reader. A read transaction pins byte checks and payload reads to one snapshot.
 * In-memory tests may call it explicitly with the MUCH smaller fixture limits.
 * This module never opens a connection, authorizes a caller or imports application/model runtime.
 */
export function runDisplayPageQuery(
	sqlite: Database,
	input: DisplayPageMessagesParams,
	limits: Limits = DISPLAY_PAGE_LIMITS,
): DisplayPageMessagesResult {
	validateDisplayPageRequest(input, limits);
	const deadlineAt = Math.min(input.deadlineAt, Date.now() + limits.timeoutMs);
	const fromBlocks = input.bodiesFromBlocks === true;
	const maxRawBytes = Math.min(input.maxRawBytes ?? limits.maxRawBytes, limits.maxRawBytes);
	const checkDeadline = () => {
		if (Date.now() >= deadlineAt)
			throw new DisplayPageReadError(
				"DISPLAY_PAGE_DEADLINE",
				"Display page read exceeded its deadline",
			);
	};
	checkDeadline();
	if (input.messageIds.length === 0) return { messages: [], rawBytes: 0, outputBytes: 2 };
	const placeholders = input.messageIds.map(() => "?").join(", ");
	const messageWhere = `m.id IN (${placeholders})`;
	const toolsWhere = `tc.message_id IN (${placeholders})`;
	// The same exact comparator as latestToolCallAttempts, scoped by canonical MESSAGE,
	// not narrator/holder. No skipped-attempt raw bodies are selected or parsed.
	const latestWhere = `${toolsWhere} AND NOT EXISTS (
		SELECT 1 FROM narrator_tool_calls newer
		WHERE newer.message_id = tc.message_id AND newer.tool_use_id = tc.tool_use_id AND (
			coalesce(newer.execution_attempt, 0) > coalesce(tc.execution_attempt, 0) OR (
				coalesce(newer.execution_attempt, 0) = coalesce(tc.execution_attempt, 0) AND (
					newer.created_at > tc.created_at OR (newer.created_at = tc.created_at AND newer.id > tc.id)
				)
			)
		)
	)`;
	const queryRows = <T extends Record<string, unknown>>(query: string, visit: (row: T) => void) => {
		const statement = sqlite.prepare<T, string[]>(query);
		try {
			for (const row of statement.iterate(...input.messageIds)) {
				checkDeadline();
				visit(row);
			}
		} finally {
			statement.finalize();
		}
	};

	return sqlite.transaction(() => {
		let rawBytes = 0;
		let rowCount = 0;
		const addRawBytes = (bytes: number) => {
			if (!Number.isSafeInteger(bytes) || bytes < 0) budgetError("invalid storage byte accounting");
			rawBytes += bytes;
			if (rawBytes > maxRawBytes) budgetError("the raw UTF-8 byte budget");
		};
		let messageCount = 0;
		// All raw fields (including originalContentJson and small scalars) are charged,
		// and only the four PUBLIC creator fields are ever read from users.
		queryRows<{ bytes: number }>(
			`SELECT (${storedBytes("m", DISPLAY_MESSAGE_COLUMNS, fromBlocks)} + ${storedBytes("u", CREATOR_COLUMNS)}) AS bytes
			FROM narrator_messages m LEFT JOIN users u ON u.id = m.created_by
			WHERE ${messageWhere} LIMIT ${limits.maxInputIds + 1}`,
			(row) => {
				messageCount++;
				rowCount++;
				addRawBytes(row.bytes);
			},
		);
		if (messageCount !== input.messageIds.length)
			throw new DisplayPageReadError(
				"DISPLAY_PAGE_REFERENCES_CHANGED",
				"Display message references changed; reload the history window",
			);
		// Bound even the discarded-attempt metadata work. LIMIT n+1 detects overflow
		// without COUNT(*) or unbounded .all(); the deadline also covers SQL execution.
		queryRows(
			`SELECT tc.id FROM narrator_tool_calls tc WHERE ${toolsWhere} LIMIT ${limits.maxRows + 1}`,
			() => {
				if (++rowCount > limits.maxRows) budgetError("the tool row budget");
			},
		);
		let toolCount = 0;
		queryRows<{ bytes: number }>(
			`SELECT (${storedBytes("tc", DISPLAY_TOOL_COLUMNS)}) AS bytes
			FROM narrator_tool_calls tc WHERE ${latestWhere} LIMIT ${limits.maxRows + 1}`,
			(row) => {
				toolCount++;
				addRawBytes(row.bytes);
			},
		);
		checkDeadline();
		const allocation = storedDisplayAllocationBudget(
			rawBytes,
			messageCount,
			toolCount,
			DISPLAY_MESSAGE_COLUMNS.length,
			DISPLAY_TOOL_COLUMNS.length,
			deadlineAt,
			limits.maxPreparedBytes,
		);

		const byId = new Map<string, NarratorDisplayMessage>();
		// A NULL body (content_json is NOT NULL) is a block-format envelope's: assembled below.
		const blockBodied: string[] = [];
		queryRows<Record<string, unknown>>(
			`SELECT ${selection("m", DISPLAY_MESSAGE_COLUMNS, fromBlocks)},
			u.id AS _creatorId, u.username AS _creatorUsername,
			u.avatar_color AS _creatorAvatarColor, u.avatar_image_id AS _creatorAvatarImageId
			FROM narrator_messages m LEFT JOIN users u ON u.id = m.created_by
			WHERE ${messageWhere} LIMIT ${limits.maxInputIds}`,
			(row) => {
				const decoded = decodeDisplayRow(row, DISPLAY_MESSAGE_COLUMNS, allocation);
				const message: NarratorDisplayMessage = {
					...decoded,
					id: decoded.id as string,
					narratorId: decoded.narratorId as string,
					parentToolUseId: decoded.parentToolUseId as string | null,
					role: decoded.role as string,
					contentJson: decoded.contentJson,
					createdAt: decoded.createdAt as string,
					toolCalls: [],
					creator:
						row._creatorId === null
							? null
							: {
									id: row._creatorId as string,
									username: row._creatorUsername as string,
									avatarColor: row._creatorAvatarColor as string | null,
									avatarImageId: row._creatorAvatarImageId as string | null,
								},
				};
				if (fromBlocks && message.contentJson === null) blockBodied.push(message.id);
				byId.set(message.id, message);
			},
		);
		if (blockBodied.length) {
			const bodies = blockBodies(sqlite, blockBodied, (stored) => {
				checkDeadline();
				allocation.reserveJson(stored);
			});
			for (const id of blockBodied) {
				const message = byId.get(id);
				if (message) message.contentJson = bodies.get(id) ?? [];
			}
		}
		for (const [id, message] of byId)
			byId.set(id, projectNarratorDisplayMessage(message, input.ioBudget));
		queryRows<Record<string, unknown>>(
			`SELECT ${selection("tc", DISPLAY_TOOL_COLUMNS)} FROM narrator_tool_calls tc
			WHERE ${latestWhere} ORDER BY tc.created_at, tc.id LIMIT ${limits.maxRows}`,
			(row) => {
				const toolCall = decodeDisplayRow(
					row,
					DISPLAY_TOOL_COLUMNS,
					allocation,
				) as NarratorDisplayToolCall;
				byId
					.get(toolCall.messageId)
					?.toolCalls.push(projectDisplayToolCall(toolCall, input.ioBudget));
			},
		);
		const messages: NarratorDisplayMessage[] = [];
		let outputBytes = 2;
		const outputAllocation = new DisplayJsonAllocationBudget(
			limits.maxOutputPreparedBytes,
			deadlineAt,
			256,
		);
		// Incremental accumulation: never collect an unbounded output and slice it.
		for (const id of input.messageIds) {
			checkDeadline();
			const message = byId.get(id);
			if (!message)
				throw new DisplayPageReadError(
					"DISPLAY_PAGE_REFERENCES_CHANGED",
					"Display message disappeared during read",
				);
			const serialized = JSON.stringify(message);
			const bytes = Buffer.byteLength(serialized);
			outputBytes += bytes + (messages.length ? 1 : 0);
			if (outputBytes > limits.maxOutputBytes) budgetError("the projected UTF-8 byte budget");
			outputAllocation.reserveJson(serialized, bytes);
			messages.push(message);
		}
		checkDeadline();
		return { messages, rawBytes, outputBytes };
	})();
}
