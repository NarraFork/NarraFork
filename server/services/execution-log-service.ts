/**
 * Global execution log: every narrator's tool calls in one time-ordered view.
 *
 * `narrator_tool_calls` is large (measured: 561k rows inside a 6.6 GB database) and
 * two of its columns — `input_json`, `output_json` — are wide (mean output ~2.9 KB,
 * observed max 92 KB). Every query here is therefore built around three rules that
 * the backend main-thread policy makes non-negotiable:
 *
 *  1. Order only by the indexed `started_at` generated column, never by a raw
 *     `coalesce(...)` expression. An unindexed `ORDER BY … LIMIT 51` over this table
 *     measured 3826 ms of blocked event loop.
 *  2. Paginate with a keyset cursor written as a row-value comparison, so SQLite
 *     SEEKs (0.07 ms/page) instead of scanning the index (28 ms and growing).
 *  3. Never select the payload columns in a list query. They are read only by
 *     `getRecord`, and even there they are byte-capped.
 */
import { db } from "@server/db";
import { chapters, narrators, narratorToolCalls, projects } from "@server/db/schema";
import { toolRegistry } from "@server/lib/agent/tool-registry";
import {
	type ExecutionLogCursor,
	encodeExecutionLogCursor,
} from "@server/lib/execution-log-cursor";
import {
	redactExecutionLogPayload,
	redactExecutionLogText,
} from "@server/lib/execution-log-redaction";
import {
	type ApiExecutionTarget,
	toolCallWithExecutionTargets,
} from "@server/lib/tool-execution-target-projection";
import { and, desc, eq, gte, isNotNull, lte, or, type SQL, sql } from "drizzle-orm";
import { summarizeSubagentToolCall } from "./subagent-activity";

/** Longest free-text / model needle we compare per row. */
const TEXT_FILTER_MAX_LENGTH = 128;

/** Hard ceiling on rows returned by one list page. */
export const MAX_EXECUTION_LOG_LIMIT = 100;

/**
 * How far back a payload search is allowed to read.
 *
 * `input_json`/`output_json` have no full-text index, and adding one is not an
 * option: those columns are ~1.5 GB here, so a trigram FTS would multiply database
 * size and startup integrity-check cost. An unbounded `LIKE` over them measured
 * 470 ms (and a miss always reads every candidate row), so payload search is
 * confined to the newest N rows by `started_at`, which the index turns into a
 * SEARCH: measured 27 ms for the same miss. Callers are told when the window
 * truncated their search rather than being silently shown partial results.
 */
export const PAYLOAD_SEARCH_WINDOW_ROWS = 20_000;

/** Byte cap applied to each payload column in the detail view. */
export const MAX_PAYLOAD_DETAIL_BYTES = 256 * 1024;

/** How many recent rows the tool-name facet samples. */
const FACET_WINDOW_ROWS = 20_000;

/** Bounded, JSON-safe extraction of one small input field. Mirrors subagent-activity. */
const SUMMARY_FIELD_MAX_LENGTH = 160;

function boundedJsonText(path: string) {
	return sql<string | null>`CASE
		WHEN json_valid(${narratorToolCalls.inputJson})
		THEN substr(CAST(json_extract(${narratorToolCalls.inputJson}, ${path}) AS TEXT), 1, ${SUMMARY_FIELD_MAX_LENGTH})
		ELSE NULL
	END`;
}

/**
 * Escape a user needle for `LIKE … ESCAPE '\'` and cap its length.
 *
 * Without escaping, a `%` typed into a free-text box silently widens the match
 * beyond what the user asked for; without the cap, a pathological input makes the
 * per-row comparison expensive on a filter that is already known to scan.
 */
function normalizeLikeNeedle(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, TEXT_FILTER_MAX_LENGTH).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type ExecutionLogStatus = "initializing" | "pending" | "running" | "success" | "fail";

export interface ExecutionLogFilters {
	narratorId?: string;
	/** Also include tool calls made by the narrator's subagents. */
	includeSubagents?: boolean;
	chapterId?: string;
	projectId?: string;
	toolName?: string;
	status?: ExecutionLogStatus;
	/** "local" for the NarraFork server, otherwise a remote_devices.id. */
	executionDeviceId?: string;
	provider?: string;
	/** Substring match, escaped and length-capped. */
	model?: string;
	/** Only calls that recorded an error message. */
	onlyErrors?: boolean;
	isBackground?: boolean;
	/**
	 * Hide internal file-history checkpoint clones. Defaults to true: these rows are
	 * an implementation detail of the snapshot system, not calls the model made.
	 */
	hideFileHistoryCheckpoints?: boolean;
	/** Inclusive lower/upper bounds on `startedAt`. */
	startDate?: string;
	endDate?: string;
	/** Free-text needle. Matches small columns only unless `searchPayload` is set. */
	q?: string;
	/** Extend `q` to input/output JSON, within the bounded window. */
	searchPayload?: boolean;
}

export interface ExecutionLogRecord {
	id: string;
	narratorId: string;
	toolUseId: string;
	toolName: string;
	status: ExecutionLogStatus;
	/** Indexed execution-start moment (the generated fallback chain). */
	startedAt: string;
	createdAt: string;
	streamStartedAt: string | null;
	streamCompletedAt: string | null;
	permissionStartedAt: string | null;
	executionStartedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	executionDeviceId: string | null;
	executionCwd: string | null;
	isBackground: boolean;
	errorMessage: string | null;
	provider: string | null;
	model: string | null;
	permissionDecidedBy: string | null;
	permissionDecidedAt: string | null;
	/** Small, non-sensitive one-line description built from bounded input fields. */
	summary: string | null;
	narratorTitle: string | null;
	narratorType: string | null;
	subagentType: string | null;
	chapterId: string | null;
	chapterTitle: string | null;
	projectId: string | null;
	projectName: string | null;
}

export interface ExecutionLogListResult {
	records: ExecutionLogRecord[];
	hasMore: boolean;
	nextCursor: string | null;
	limit: number;
	/** True when a payload search was confined to the bounded window. */
	payloadSearchTruncated: boolean;
	/** Oldest `startedAt` a payload search could see, when it was windowed. */
	payloadSearchWindowStart: string | null;
}

export interface ExecutionLogDetail extends ExecutionLogRecord {
	messageId: string;
	inputJson: unknown;
	outputJson: unknown;
	inputTruncated: boolean;
	outputTruncated: boolean;
	inputBytes: number | null;
	outputBytes: number | null;
	permissionDenyMessage: string | null;
	permissionDecisionReason: string | null;
	isFileHistoryCheckpoint: boolean;
	treeHashBefore: string | null;
	treeHashAfter: string | null;
	resolvedFilePath: string | null;
	canonicalFilePath: string | null;
	deviceSelectionSource: "explicit" | "session_default" | "local_default" | null;
	executionPathFlavor: "posix" | "windows" | "spec" | null;
	executionTarget: ApiExecutionTarget | null;
	executionTargets: ApiExecutionTarget[];
	executionPlan: Record<string, unknown> | null;
}

export interface ExecutionLogFacets {
	/** Tool names known to the running build, plus any seen in the recent window. */
	toolNames: string[];
	statuses: ExecutionLogStatus[];
	/** Distinct providers observed in the recent window. */
	providers: string[];
	/** Whether the tool-name list was sampled rather than exhaustive. */
	toolNamesSampled: boolean;
}

const EXECUTION_LOG_STATUSES: ExecutionLogStatus[] = [
	"initializing",
	"pending",
	"running",
	"success",
	"fail",
];

/** Columns cheap enough for a list page. Deliberately excludes input/output JSON. */
const LIST_COLUMNS = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	status: narratorToolCalls.status,
	startedAt: narratorToolCalls.startedAt,
	createdAt: narratorToolCalls.createdAt,
	streamStartedAt: narratorToolCalls.streamStartedAt,
	streamCompletedAt: narratorToolCalls.streamCompletedAt,
	permissionStartedAt: narratorToolCalls.permissionStartedAt,
	executionStartedAt: narratorToolCalls.executionStartedAt,
	completedAt: narratorToolCalls.completedAt,
	durationMs: narratorToolCalls.durationMs,
	executionDeviceId: narratorToolCalls.executionDeviceId,
	executionCwd: narratorToolCalls.executionCwd,
	isBackground: narratorToolCalls.isBackground,
	errorMessage: narratorToolCalls.errorMessage,
	provider: narratorToolCalls.provider,
	model: narratorToolCalls.model,
	permissionDecidedBy: narratorToolCalls.permissionDecidedBy,
	permissionDecidedAt: narratorToolCalls.permissionDecidedAt,
	narratorTitle: narrators.title,
	narratorType: narrators.type,
	subagentType: narrators.subagentType,
	chapterId: narrators.chapterId,
	chapterTitle: chapters.title,
	projectId: chapters.projectId,
	projectName: projects.name,
} as const;

/** The bounded input fields the summary is built from. */
const SUMMARY_HINT_COLUMNS = {
	description: boundedJsonText("$.description"),
	filePath: boundedJsonText("$.file_path"),
	path: boundedJsonText("$.path"),
	pattern: boundedJsonText("$.pattern"),
	query: boundedJsonText("$.query"),
	url: boundedJsonText("$.url"),
	mode: boundedJsonText("$.mode"),
	action: boundedJsonText("$.action"),
	targetId: boundedJsonText("$.id"),
	targetName: boundedJsonText("$.name"),
	awaitType: boundedJsonText("$.type"),
	subagentTypeHint: boundedJsonText("$.subagent_type"),
	skillName: boundedJsonText("$.skill"),
	device: boundedJsonText("$.device"),
	direction: boundedJsonText("$.direction"),
	localPath: boundedJsonText("$.localPath"),
	remotePath: boundedJsonText("$.remotePath"),
	questionHeader: boundedJsonText("$.questions[0].header"),
	resourceId: boundedJsonText("$.entryId"),
} as const;

type SummaryHintRow = { [K in keyof typeof SUMMARY_HINT_COLUMNS]: string | null };

/**
 * One-line summary for the list view, credential-masked.
 *
 * The hint columns are bounded but not innocent: `$.url` routinely carries a
 * signed query string and `$.description` is free text the model wrote. The list
 * endpoint is read far more often than the detail one, so leaving it unmasked
 * would put credentials on the first screen an administrator sees.
 */
function buildSummary(toolName: string, row: SummaryHintRow): string | null {
	const summary =
		summarizeSubagentToolCall(toolName, {
			description: row.description,
			filePath: row.filePath,
			path: row.path,
			pattern: row.pattern,
			query: row.query,
			url: row.url,
			mode: row.mode,
			action: row.action,
			targetId: row.targetId,
			targetName: row.targetName,
			awaitType: row.awaitType,
			subagentType: row.subagentTypeHint,
			skillName: row.skillName,
			device: row.device,
			direction: row.direction,
			localPath: row.localPath,
			remotePath: row.remotePath,
			questionHeader: row.questionHeader,
			resourceId: row.resourceId,
		}) ?? null;
	return summary == null ? null : redactExecutionLogText(summary);
}

/** Serialized byte length of a stored JSON value, or null when unmeasurable. */
const textEncoder = new TextEncoder();

function serializedBytes(value: unknown): number | null {
	if (value == null) return null;
	try {
		return textEncoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
	} catch {
		return null;
	}
}

/**
 * Cap a payload for transport, preserving valid JSON semantics.
 *
 * Over-cap values become a string preview rather than a partial object: a
 * half-serialized object would be worse than useless to a client, while a preview
 * plus `*Truncated` and the true byte count tells the reader exactly what was
 * withheld and how much.
 *
 * Redaction runs BEFORE the cap, and `bytes` reports the ORIGINAL size:
 *  - redacting first means a secret can never survive by sitting inside the
 *    truncated tail of a preview string, and means the cap applies to what is
 *    actually sent rather than to something larger that gets rewritten after;
 *  - the byte count deliberately describes the stored row, not the masked copy,
 *    because it exists to tell the reader how much of the real payload they are
 *    not seeing. Masking shifts that number by an amount nobody can act on.
 */
function capPayload(value: unknown): { value: unknown; truncated: boolean; bytes: number | null } {
	const bytes = serializedBytes(value);
	const redacted = redactExecutionLogPayload(value);
	if (bytes == null || bytes <= MAX_PAYLOAD_DETAIL_BYTES) {
		return { value: redacted ?? null, truncated: false, bytes };
	}
	const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
	return {
		value: text.slice(0, MAX_PAYLOAD_DETAIL_BYTES),
		truncated: true,
		bytes,
	};
}

export class ExecutionLogService {
	private readonly payloadSearchWindowRows: number;

	/**
	 * `payloadSearchWindowRows` is injectable so the truncation path can be tested
	 * without seeding 20k rows; production always uses the measured default.
	 */
	constructor(
		private readonly database: typeof db = db,
		options: { payloadSearchWindowRows?: number } = {},
	) {
		this.payloadSearchWindowRows = options.payloadSearchWindowRows ?? PAYLOAD_SEARCH_WINDOW_ROWS;
	}

	async listCursor(
		filters: ExecutionLogFilters,
		limit = 50,
		cursor?: ExecutionLogCursor,
	): Promise<ExecutionLogListResult> {
		const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
		const boundedLimit = Math.min(Math.max(requestedLimit, 1), MAX_EXECUTION_LOG_LIMIT);

		// A payload search needs its window resolved BEFORE the where clause is
		// built, because the window is itself a `startedAt` predicate — that is what
		// keeps the LIKE bounded.
		const window = filters.q && filters.searchPayload ? await this.resolvePayloadWindow() : null;

		const conditions = this.buildWhereConditions(filters, window);
		if (cursor) {
			// Row-value comparison, not the equivalent `A < ? OR (A = ? AND id < ?)`:
			// only this form is planned as a SEARCH against idx_toolcalls_started_at.
			conditions.push(
				sql`(${narratorToolCalls.startedAt}, ${narratorToolCalls.id}) < (${cursor.startedAt}, ${cursor.id})`,
			);
		}

		const rows = await this.database
			.select({ ...LIST_COLUMNS, ...SUMMARY_HINT_COLUMNS })
			.from(narratorToolCalls)
			.leftJoin(narrators, eq(narratorToolCalls.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(projects, eq(chapters.projectId, projects.id))
			.where(and(...conditions))
			.orderBy(desc(narratorToolCalls.startedAt), desc(narratorToolCalls.id))
			.limit(boundedLimit + 1);

		const hasMore = rows.length > boundedLimit;
		const page = hasMore ? rows.slice(0, boundedLimit) : rows;
		const lastRow = page[page.length - 1];

		return {
			records: page.map((row) => this.mapListRecord(row)),
			hasMore,
			nextCursor:
				hasMore && lastRow?.startedAt
					? encodeExecutionLogCursor({ startedAt: lastRow.startedAt, id: lastRow.id })
					: null,
			limit: boundedLimit,
			payloadSearchTruncated: !!window,
			payloadSearchWindowStart: window,
		};
	}

	async getRecord(id: string): Promise<ExecutionLogDetail | null> {
		const [row] = await this.database
			.select({
				...LIST_COLUMNS,
				...SUMMARY_HINT_COLUMNS,
				messageId: narratorToolCalls.messageId,
				inputJson: narratorToolCalls.inputJson,
				outputJson: narratorToolCalls.outputJson,
				permissionDenyMessage: narratorToolCalls.permissionDenyMessage,
				permissionDecisionReason: narratorToolCalls.permissionDecisionReason,
				isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
				treeHashBefore: narratorToolCalls.treeHashBefore,
				treeHashAfter: narratorToolCalls.treeHashAfter,
				resolvedFilePath: narratorToolCalls.resolvedFilePath,
				canonicalFilePath: narratorToolCalls.canonicalFilePath,
				executionPathFlavor: narratorToolCalls.executionPathFlavor,
				deviceSelectionSource: narratorToolCalls.deviceSelectionSource,
				executionTargetsJson: narratorToolCalls.executionTargetsJson,
				runtimeGeneration: narratorToolCalls.runtimeGeneration,
			})
			.from(narratorToolCalls)
			.leftJoin(narrators, eq(narratorToolCalls.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(projects, eq(chapters.projectId, projects.id))
			.where(eq(narratorToolCalls.id, id))
			.limit(1);

		if (!row) return null;

		const input = capPayload(row.inputJson);
		const output = capPayload(row.outputJson);
		const withTargets = toolCallWithExecutionTargets({
			executionTargetsJson: row.executionTargetsJson,
			executionDeviceId: row.executionDeviceId,
			executionCwd: row.executionCwd,
			executionPathFlavor: row.executionPathFlavor,
			resolvedFilePath: row.resolvedFilePath,
			canonicalFilePath: row.canonicalFilePath,
			runtimeGeneration: row.runtimeGeneration,
			deviceSelectionSource: row.deviceSelectionSource,
		});

		return {
			...this.mapListRecord(row),
			messageId: row.messageId,
			inputJson: input.value,
			outputJson: output.value,
			inputTruncated: input.truncated,
			outputTruncated: output.truncated,
			inputBytes: input.bytes,
			outputBytes: output.bytes,
			permissionDenyMessage: row.permissionDenyMessage,
			permissionDecisionReason: row.permissionDecisionReason,
			isFileHistoryCheckpoint: !!row.isFileHistoryCheckpoint,
			treeHashBefore: row.treeHashBefore,
			treeHashAfter: row.treeHashAfter,
			resolvedFilePath: row.resolvedFilePath,
			canonicalFilePath: row.canonicalFilePath,
			deviceSelectionSource: row.deviceSelectionSource,
			executionPathFlavor: row.executionPathFlavor,
			executionTarget: withTargets.executionTarget,
			executionTargets: withTargets.executionTargets,
			executionPlan: withTargets.executionPlan,
		};
	}

	/**
	 * Filter options for the UI.
	 *
	 * Tool names come from the running build's registry, not a `GROUP BY` over the
	 * table: the exhaustive version measured 489 ms of blocked event loop for a
	 * dropdown. Names actually present in the recent window are merged in so
	 * plugin-provided and retired tools still appear — which also means the list
	 * stays correct if the registry has not been populated yet (as in a unit test
	 * that never imports the agent tools module).
	 */
	async listFacets(): Promise<ExecutionLogFacets> {
		const registered = new Set(toolRegistry.all().map((tool) => tool.name));

		const observed = await this.database
			.select({
				toolName: sql<string | null>`tool_name`,
				provider: sql<string | null>`provider`,
			})
			.from(
				sql`(SELECT ${narratorToolCalls.toolName} AS tool_name, ${narratorToolCalls.provider} AS provider
					FROM ${narratorToolCalls}
					ORDER BY ${narratorToolCalls.startedAt} DESC, ${narratorToolCalls.id} DESC
					LIMIT ${FACET_WINDOW_ROWS}) AS recent`,
			)
			.groupBy(sql`tool_name`, sql`provider`);

		const providers = new Set<string>();
		for (const row of observed) {
			if (row.toolName) registered.add(row.toolName);
			if (row.provider?.trim()) providers.add(row.provider);
		}

		return {
			toolNames: [...registered].sort((a, b) => a.localeCompare(b)),
			statuses: EXECUTION_LOG_STATUSES,
			providers: [...providers].sort((a, b) => a.localeCompare(b)),
			toolNamesSampled: true,
		};
	}

	/**
	 * Oldest `startedAt` a payload search may read, or null when the table is
	 * smaller than the window (in which case the search is already exhaustive).
	 */
	private async resolvePayloadWindow(): Promise<string | null> {
		const [boundary] = await this.database
			.select({ startedAt: narratorToolCalls.startedAt })
			.from(narratorToolCalls)
			.orderBy(desc(narratorToolCalls.startedAt), desc(narratorToolCalls.id))
			.limit(1)
			.offset(this.payloadSearchWindowRows);
		return boundary?.startedAt ?? null;
	}

	private mapListRecord(row: SummaryHintRow & Record<string, unknown>): ExecutionLogRecord {
		return {
			id: row.id as string,
			narratorId: row.narratorId as string,
			toolUseId: row.toolUseId as string,
			toolName: row.toolName as string,
			status: row.status as ExecutionLogStatus,
			// `startedAt` is generated from a chain ending in the NOT NULL `createdAt`,
			// so it cannot be null in practice; the fallback keeps the type honest for
			// rows read through a stale connection that lacks the generated column.
			startedAt: (row.startedAt as string | null) ?? (row.createdAt as string),
			createdAt: row.createdAt as string,
			streamStartedAt: (row.streamStartedAt as string | null) ?? null,
			streamCompletedAt: (row.streamCompletedAt as string | null) ?? null,
			permissionStartedAt: (row.permissionStartedAt as string | null) ?? null,
			executionStartedAt: (row.executionStartedAt as string | null) ?? null,
			completedAt: (row.completedAt as string | null) ?? null,
			durationMs: (row.durationMs as number | null) ?? null,
			executionDeviceId: (row.executionDeviceId as string | null) ?? null,
			executionCwd: (row.executionCwd as string | null) ?? null,
			isBackground: !!row.isBackground,
			errorMessage: (row.errorMessage as string | null) ?? null,
			provider: (row.provider as string | null) ?? null,
			model: (row.model as string | null) ?? null,
			permissionDecidedBy: (row.permissionDecidedBy as string | null) ?? null,
			permissionDecidedAt: (row.permissionDecidedAt as string | null) ?? null,
			summary: buildSummary(row.toolName as string, row),
			narratorTitle: (row.narratorTitle as string | null) ?? null,
			narratorType: (row.narratorType as string | null) ?? null,
			subagentType: (row.subagentType as string | null) ?? null,
			chapterId: (row.chapterId as string | null) ?? null,
			chapterTitle: (row.chapterTitle as string | null) ?? null,
			projectId: (row.projectId as string | null) ?? null,
			projectName: (row.projectName as string | null) ?? null,
		};
	}

	private buildWhereConditions(
		filters: ExecutionLogFilters,
		payloadWindowStart: string | null,
	): SQL[] {
		const conditions: SQL[] = [];

		if (filters.narratorId) {
			// Both branches must be predicates on `narrator_tool_calls.narrator_id` so
			// SQLite can still use its narrator indexes; putting the joined
			// `narrators.parent_narrator_id` in the OR instead would defeat them.
			conditions.push(
				filters.includeSubagents
					? (or(
							eq(narratorToolCalls.narratorId, filters.narratorId),
							sql`${narratorToolCalls.narratorId} IN (SELECT ${narrators.id} FROM ${narrators} WHERE ${narrators.parentNarratorId} = ${filters.narratorId})`,
						) as SQL)
					: (eq(narratorToolCalls.narratorId, filters.narratorId) as SQL),
			);
		}
		if (filters.chapterId) conditions.push(eq(narrators.chapterId, filters.chapterId) as SQL);
		if (filters.projectId) conditions.push(eq(chapters.projectId, filters.projectId) as SQL);

		const toolName = filters.toolName?.trim();
		if (toolName) conditions.push(eq(narratorToolCalls.toolName, toolName) as SQL);
		if (filters.status) conditions.push(eq(narratorToolCalls.status, filters.status) as SQL);

		const deviceId = filters.executionDeviceId?.trim();
		if (deviceId) conditions.push(eq(narratorToolCalls.executionDeviceId, deviceId) as SQL);

		const provider = filters.provider?.trim();
		if (provider) conditions.push(eq(narratorToolCalls.provider, provider) as SQL);

		const model = normalizeLikeNeedle(filters.model);
		if (model) {
			conditions.push(sql`${narratorToolCalls.model} LIKE ${`%${model}%`} ESCAPE '\\'`);
		}

		if (filters.onlyErrors) {
			conditions.push(
				and(
					isNotNull(narratorToolCalls.errorMessage),
					sql`trim(${narratorToolCalls.errorMessage}) <> ''`,
				) as SQL,
			);
		}
		if (filters.isBackground !== undefined) {
			conditions.push(eq(narratorToolCalls.isBackground, filters.isBackground) as SQL);
		}
		// Default-on: checkpoint clones are snapshot bookkeeping, not model activity.
		if (filters.hideFileHistoryCheckpoints !== false) {
			conditions.push(eq(narratorToolCalls.isFileHistoryCheckpoint, false) as SQL);
		}

		if (filters.startDate) {
			conditions.push(gte(narratorToolCalls.startedAt, filters.startDate) as SQL);
		}
		if (filters.endDate) {
			conditions.push(lte(narratorToolCalls.startedAt, filters.endDate) as SQL);
		}

		const needle = normalizeLikeNeedle(filters.q);
		if (needle) {
			const like = `%${needle}%`;
			const branches: SQL[] = [
				sql`${narratorToolCalls.toolName} LIKE ${like} ESCAPE '\\'`,
				sql`${narratorToolCalls.resolvedFilePath} LIKE ${like} ESCAPE '\\'`,
				sql`${narratorToolCalls.errorMessage} LIKE ${like} ESCAPE '\\'`,
				sql`${narratorToolCalls.executionCwd} LIKE ${like} ESCAPE '\\'`,
				// The same bounded summary fields the list already displays, so what the
				// user searches matches what they can see.
				sql`${SUMMARY_HINT_COLUMNS.description} LIKE ${like} ESCAPE '\\'`,
				sql`${SUMMARY_HINT_COLUMNS.filePath} LIKE ${like} ESCAPE '\\'`,
				sql`${SUMMARY_HINT_COLUMNS.path} LIKE ${like} ESCAPE '\\'`,
				sql`${SUMMARY_HINT_COLUMNS.pattern} LIKE ${like} ESCAPE '\\'`,
				sql`${SUMMARY_HINT_COLUMNS.query} LIKE ${like} ESCAPE '\\'`,
				sql`${SUMMARY_HINT_COLUMNS.url} LIKE ${like} ESCAPE '\\'`,
			];
			if (filters.searchPayload) {
				branches.push(
					sql`${narratorToolCalls.inputJson} LIKE ${like} ESCAPE '\\'`,
					sql`${narratorToolCalls.outputJson} LIKE ${like} ESCAPE '\\'`,
				);
				// The window bound is what keeps the payload LIKE from reading the whole
				// table; it must be a plain `startedAt` predicate to stay indexable.
				if (payloadWindowStart) {
					conditions.push(gte(narratorToolCalls.startedAt, payloadWindowStart) as SQL);
				}
			}
			conditions.push(or(...branches) as SQL);
		}

		return conditions;
	}
}

export const executionLogService = new ExecutionLogService();
