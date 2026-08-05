/**
 * Layered message projection for the External API v1.
 *
 * Pure functions only: every input is already-fetched row data, so the tiering
 * rules can be tested without a database and the query layer stays free to
 * decide which columns it is willing to read for a given tier.
 *
 * The division of labour matters for the main-thread rules in CLAUDE.md. This
 * module never decides what to SELECT — the caller does, and at the `skeleton`
 * tier it must not select `content_json` / `input_json` / `output_json` at all.
 * What this module guarantees is the opposite direction: given rows fetched for a
 * higher tier, it never emits more than the requested tier allows.
 */
import {
	EXTERNAL_MESSAGE_MAX_REASONING_STEPS,
	EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS,
	EXTERNAL_MESSAGE_MAX_TOOL_ITEMS,
	EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS,
	EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS,
	EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS,
	EXTERNAL_TOOL_DETAIL_LEAF_BUDGET,
	EXTERNAL_TOOL_DETAIL_TOTAL_BUDGET,
	EXTERNAL_TOOL_PAYLOAD_LEAF_BUDGET,
	EXTERNAL_TOOL_PAYLOAD_TOTAL_BUDGET,
	type ExternalMessageDetail,
	type ExternalMessageNode,
	type ExternalMessageReasoning,
	type ExternalMessageReasoningStep,
	type ExternalMessageSubagentItem,
	type ExternalMessageSubagents,
	type ExternalMessageToolItem,
	type ExternalMessageTools,
	type ExternalMessageUsage,
	type ExternalToolCallDetail,
	externalMessageDetailAtLeast,
} from "@shared/external/message-detail";
import { parseReasoningSegments } from "@shared/pretext-layout/reasoning-segments";
import { hasTruncatedLeaf, projectToolIO } from "@shared/pretext-layout/tool-io-projection";
import {
	normalizeSubagentToolInputSummary,
	SUBAGENT_SUMMARY_INPUT_KEYS,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";

/** Tool names whose child messages form a subagent rather than an inline result. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task", "Send"]);

/**
 * Key preference order for the single short `target` string.
 *
 * Ordered by how specifically the key identifies what the call acted on, so a
 * `Bash` call labels with its command rather than its `description`, and a file
 * tool labels with its path. This is only a display label; the authoritative
 * input is the drill-down endpoint.
 */
const TARGET_KEY_PRIORITY: readonly (keyof SubagentToolInputSummary)[] = [
	"file_path",
	"command",
	"pattern",
	"url",
	"query",
	"description",
	"subagent_type",
	"type",
	"mode",
	"id",
];

/** Row shape the projection needs for one message. Mirrors the narrow SELECT. */
export interface ExternalMessageRow {
	id: string;
	seq: number;
	role: string;
	createdAt: string;
	/** length(content_text) computed in SQL; never the text itself at `skeleton`. */
	textChars: number;
	/** Present from `summary` upward. */
	contentText?: string | null;
	reasoningTokens: number | null;
	/**
	 * Reasoning block bodies, each already length-capped in SQL. Present from
	 * `summary` upward; an empty array means "no reasoning", while `undefined`
	 * means the tier did not ask for it.
	 */
	reasoningBlocks?: readonly string[];
	/**
	 * The message's content column was too large (or unparseable) for the reasoning
	 * scan guard, so blocks could not be extracted. Surfaces as
	 * `reasoning.unavailable` instead of a silently empty step list.
	 */
	reasoningUnavailable?: boolean;
	/** True when this system row is a context-compaction marker. */
	isCompact: boolean;
	usage?: ExternalMessageUsage;
}

/** Row shape the projection needs for one tool call. */
export interface ExternalToolCallRow {
	messageId: string;
	toolUseId: string;
	toolName: string;
	status: string;
	durationMs: number | null;
	errorMessage: string | null;
	/** octet_length(input_json), computed in SQL. */
	inputBytes: number | null;
	/** octet_length(output_json), computed in SQL. */
	outputBytes: number | null;
	/**
	 * SQL-side whitelist projection of the short input keys (see
	 * buildSubagentSummarySqlExpr). A JSON string, or null when the guards
	 * suppressed it.
	 */
	inputSummaryJson?: string | null;
	/** Full payloads. Selected only for the `full` tier. */
	inputJson?: unknown;
	outputJson?: unknown;
	/** Subagent metadata, when this call spawned one. */
	subagentNarratorId?: string | null;
	subagentTitle?: string | null;
	subagentRecentCallCount?: number;
}

function truncateTitle(value: string): string {
	const trimmed = value.trim();
	return trimmed.length <= EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS
		? trimmed
		: trimmed.slice(0, EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS);
}

function parseInputSummary(json: string | null | undefined): SubagentToolInputSummary | null {
	if (!json) return null;
	try {
		return normalizeSubagentToolInputSummary(JSON.parse(json));
	} catch {
		// The SQL expression already guards with json_valid; a parse failure here
		// means the projection itself was malformed, which is a missing label rather
		// than a reason to fail the whole page.
		return null;
	}
}

/** Pick one short display target from the whitelisted projection. */
export function resolveExternalToolTarget(row: ExternalToolCallRow): string | null {
	const summary = parseInputSummary(row.inputSummaryJson);
	if (!summary) return null;
	for (const key of TARGET_KEY_PRIORITY) {
		const value = summary[key];
		if (value) return value;
	}
	// TARGET_KEY_PRIORITY is asserted to cover every whitelisted key by the unit
	// test, so this is unreachable in practice; kept so a future key addition
	// degrades to "some label" instead of silently dropping to null.
	for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
		const value = summary[key];
		if (value) return value;
	}
	return null;
}

/**
 * Project reasoning for one message.
 *
 * `skeleton` gets scalars only. Higher tiers parse the persisted text into steps
 * with `parseReasoningSegments` — the same pure parser the UI trace uses, so an
 * external client's step list matches what NarraFork itself shows. Bodies appear
 * only at `full`, under both a per-step and a per-message character ceiling.
 */
export function projectExternalReasoning(
	row: ExternalMessageRow,
	detail: ExternalMessageDetail,
): ExternalMessageReasoning {
	const base: ExternalMessageReasoning = { tokens: row.reasoningTokens ?? null };
	if (!externalMessageDetailAtLeast(detail, "summary")) return base;
	if (row.reasoningUnavailable) return { ...base, steps: [], unavailable: true };

	// Each stored reasoning block is parsed independently. Concatenating them first
	// would let one block's trailing prose merge into the next block's leading step,
	// producing a step boundary the model never emitted.
	const segments = (row.reasoningBlocks ?? []).flatMap((block) =>
		block ? parseReasoningSegments(block) : [],
	);
	if (segments.length === 0) return { ...base, steps: [] };

	const stepsTruncated = segments.length > EXTERNAL_MESSAGE_MAX_REASONING_STEPS;
	const visible = stepsTruncated
		? segments.slice(0, EXTERNAL_MESSAGE_MAX_REASONING_STEPS)
		: segments;
	const wantBodies = externalMessageDetailAtLeast(detail, "full");

	let remainingBodyBudget = EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS;
	const steps: ExternalMessageReasoningStep[] = visible.map((segment) => {
		const step: ExternalMessageReasoningStep = {
			title: segment.title == null ? null : truncateTitle(segment.title),
			chars: segment.body.length,
		};
		if (!wantBodies) return step;
		const perStepBudget = Math.max(
			0,
			Math.min(EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS, remainingBodyBudget),
		);
		if (segment.body.length <= perStepBudget) {
			remainingBodyBudget -= segment.body.length;
			step.body = segment.body;
			return step;
		}
		remainingBodyBudget -= perStepBudget;
		step.body = segment.body.slice(0, perStepBudget);
		step.bodyTruncated = true;
		return step;
	});

	return { ...base, steps, ...(stepsTruncated ? { stepsTruncated: true } : {}) };
}

function projectPayload(
	value: unknown,
	leafBudget: number,
	totalBudget: number,
): { value: unknown; truncated: boolean } {
	if (value == null) return { value: null, truncated: false };
	const projected = projectToolIO(value, { leafBudget, totalBudget });
	return { value: projected, truncated: hasTruncatedLeaf(projected) };
}

/** True when the drill-down endpoint could return more than a page item carries. */
function hasDrillDownDetail(row: ExternalToolCallRow): boolean {
	return (row.inputBytes ?? 0) > 0 || (row.outputBytes ?? 0) > 0;
}

export function projectExternalToolItem(
	row: ExternalToolCallRow,
	detail: ExternalMessageDetail,
): ExternalMessageToolItem {
	const item: ExternalMessageToolItem = {
		toolUseId: row.toolUseId,
		name: row.toolName,
		target: resolveExternalToolTarget(row),
		status: row.status,
		inputBytes: row.inputBytes ?? null,
		outputBytes: row.outputBytes ?? null,
		hasDetail: hasDrillDownDetail(row),
	};
	if (row.durationMs != null) item.durationMs = row.durationMs;
	if (row.errorMessage) item.errorMessage = row.errorMessage;
	if (!externalMessageDetailAtLeast(detail, "full")) return item;

	const input = projectPayload(
		row.inputJson ?? null,
		EXTERNAL_TOOL_PAYLOAD_LEAF_BUDGET,
		EXTERNAL_TOOL_PAYLOAD_TOTAL_BUDGET,
	);
	const output = projectPayload(
		row.outputJson ?? null,
		EXTERNAL_TOOL_PAYLOAD_LEAF_BUDGET,
		EXTERNAL_TOOL_PAYLOAD_TOTAL_BUDGET,
	);
	item.input = input.value;
	item.output = output.value;
	if (input.truncated) item.inputTruncated = true;
	if (output.truncated) item.outputTruncated = true;
	return item;
}

/**
 * Tally and (above `skeleton`) enumerate the non-subagent tool calls of a message.
 *
 * Counts are always exact: `itemsTruncated` reports that the ENUMERATION was cut,
 * never that the tally was, so a client can always trust `count` even when it
 * only sees the first 64 items.
 */
export function projectExternalTools(
	rows: readonly ExternalToolCallRow[],
	detail: ExternalMessageDetail,
): ExternalMessageTools {
	const counts: ExternalMessageTools = {
		count: rows.length,
		running: 0,
		failed: 0,
		awaitingPermission: 0,
	};
	for (const row of rows) {
		if (row.status === "running" || row.status === "initializing") counts.running += 1;
		else if (row.status === "fail") counts.failed += 1;
		else if (row.status === "pending") counts.awaitingPermission += 1;
	}
	if (!externalMessageDetailAtLeast(detail, "summary")) return counts;

	const itemsTruncated = rows.length > EXTERNAL_MESSAGE_MAX_TOOL_ITEMS;
	const visible = itemsTruncated ? rows.slice(0, EXTERNAL_MESSAGE_MAX_TOOL_ITEMS) : rows;
	return {
		...counts,
		items: visible.map((row) => projectExternalToolItem(row, detail)),
		...(itemsTruncated ? { itemsTruncated: true } : {}),
	};
}

export function projectExternalSubagents(
	rows: readonly ExternalToolCallRow[],
	detail: ExternalMessageDetail,
): ExternalMessageSubagents {
	const counts: ExternalMessageSubagents = { count: rows.length };
	if (!externalMessageDetailAtLeast(detail, "summary")) return counts;

	const itemsTruncated = rows.length > EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS;
	const visible = itemsTruncated ? rows.slice(0, EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS) : rows;
	const items: ExternalMessageSubagentItem[] = visible.map((row) => {
		const summary = parseInputSummary(row.inputSummaryJson);
		return {
			toolUseId: row.toolUseId,
			type: summary?.subagent_type ?? summary?.type ?? null,
			title: row.subagentTitle ?? summary?.description ?? null,
			status: row.status,
			recentCallCount: row.subagentRecentCallCount ?? 0,
		};
	});
	return { ...counts, items, ...(itemsTruncated ? { itemsTruncated: true } : {}) };
}

/** Split a message's tool calls into inline tools and subagent spawns. */
export function partitionExternalToolRows(rows: readonly ExternalToolCallRow[]): {
	tools: ExternalToolCallRow[];
	subagents: ExternalToolCallRow[];
} {
	const tools: ExternalToolCallRow[] = [];
	const subagents: ExternalToolCallRow[] = [];
	for (const row of rows) {
		if (SUBAGENT_TOOL_NAMES.has(row.toolName)) subagents.push(row);
		else tools.push(row);
	}
	return { tools, subagents };
}

/**
 * External role projection.
 *
 * Internal roles `sys` and `disp` are display-only scaffolding and never reach
 * the external contract; the query filters them out, and anything unexpected
 * lands on `system`, whose body is not exposed.
 */
function externalRole(role: string): ExternalMessageNode["role"] {
	if (role === "user" || role === "assistant") return role;
	return "system";
}

export interface ProjectExternalMessageInput {
	row: ExternalMessageRow;
	toolRows: readonly ExternalToolCallRow[];
	detail: ExternalMessageDetail;
	/** Bounded prose plus its truncation flag, resolved by the caller's byte cap. */
	text?: { text: string; truncated: boolean };
}

export function projectExternalMessage(input: ProjectExternalMessageInput): ExternalMessageNode {
	const { row, detail } = input;
	const { tools, subagents } = partitionExternalToolRows(input.toolRows);
	const role = externalRole(row.role);
	const node: ExternalMessageNode = {
		id: row.id,
		seq: row.seq,
		role,
		createdAt: row.createdAt,
		kind: row.isCompact ? "compact" : "message",
		textChars: row.textChars,
		reasoning: projectExternalReasoning(row, detail),
		tools: projectExternalTools(tools, detail),
		subagents: projectExternalSubagents(subagents, detail),
	};
	// A system row is only ever surfaced as a compaction marker, so its prose is
	// withheld at every tier — otherwise internal system scaffolding would leak
	// through the same field assistant text uses.
	if (externalMessageDetailAtLeast(detail, "summary") && input.text && role !== "system") {
		node.text = input.text.text;
		if (input.text.truncated) node.textTruncated = true;
	}
	if (row.usage) node.usage = row.usage;
	return node;
}

/** Project one tool call for the drill-down endpoint (larger budgets). */
export function projectExternalToolCallDetail(
	row: ExternalToolCallRow & { createdAt: string; completedAt: string | null },
): ExternalToolCallDetail {
	const input = projectPayload(
		row.inputJson ?? null,
		EXTERNAL_TOOL_DETAIL_LEAF_BUDGET,
		EXTERNAL_TOOL_DETAIL_TOTAL_BUDGET,
	);
	const output = projectPayload(
		row.outputJson ?? null,
		EXTERNAL_TOOL_DETAIL_LEAF_BUDGET,
		EXTERNAL_TOOL_DETAIL_TOTAL_BUDGET,
	);
	const detail: ExternalToolCallDetail = {
		toolUseId: row.toolUseId,
		name: row.toolName,
		status: row.status,
		target: resolveExternalToolTarget(row),
		inputBytes: row.inputBytes ?? null,
		outputBytes: row.outputBytes ?? null,
		input: input.value,
		output: output.value,
		inputTruncated: input.truncated,
		outputTruncated: output.truncated,
		createdAt: row.createdAt,
		completedAt: row.completedAt,
	};
	if (row.durationMs != null) detail.durationMs = row.durationMs;
	if (row.errorMessage) detail.errorMessage = row.errorMessage;
	return detail;
}
