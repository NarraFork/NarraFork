/**
 * Layered message-detail contract for the External API v1.
 *
 * The internal vlist paginates by cursor like this API does, but every page has
 * ONE shape: the message structure rendering needs, with `contentJson` and
 * byte-budgeted tool payloads. The server does not vary it by what the caller
 * intends to show; `RenderLod` (1..6) only picks between "card / trace row /
 * count line" once the client already holds that page.
 *
 * An external client cannot be served that way: the LOD levels are render
 * concepts (L5's "most recent two run segments expanded" is position-dependent,
 * L1's clamp is a CSS height), and that per-page shape carries tool payloads
 * unconditionally — so a client that only wants a tool COUNT would still have to
 * receive every command's output. What follows is therefore a disclosure
 * dimension ORTHOGONAL to pagination: paging picks which messages, `detail`
 * picks how much of each. Three STABLE tiers, least to most disclosure:
 *
 *  - `text`     — the pre-existing bounded plain-text projection. Unchanged, and
 *                 still the default so existing clients see no difference.
 *  - `skeleton` — bounded scalars only: text length, tool counts, reasoning
 *                 tokens. Nothing that requires reading a large JSON column.
 *  - `summary`  — structure with identity: assistant text, reasoning step
 *                 titles, per-tool name/target/status. No payload bodies.
 *  - `full`     — adds reasoning bodies and byte-budgeted tool input/output.
 *
 * PURITY: no DOM, no server imports, no zod. Both the server projection and a
 * third-party TypeScript client consume this file, so it stays type-only plus
 * plain arithmetic.
 */

/** Wire values for the `detail` query parameter, ordered least → most disclosure. */
export const EXTERNAL_MESSAGE_DETAIL_LEVELS = ["text", "skeleton", "summary", "full"] as const;
export type ExternalMessageDetail = (typeof EXTERNAL_MESSAGE_DETAIL_LEVELS)[number];

/**
 * Ordering used to resolve the effective tier from several independent ceilings
 * (requested tier ∩ scope ∩ client policy). Index = disclosure rank.
 *
 * `text` and `skeleton` are deliberately BOTH below `summary` even though they
 * expose different things (`text` gives the whole message body, `skeleton` gives
 * none of it). They are not comparable by disclosure of prose, so the order here
 * is by *structural* disclosure, which is what the scope/policy ceilings gate.
 * A caller that wants the old text projection asks for it explicitly; the
 * clamping helpers below never silently promote `skeleton` to `text`.
 */
const DETAIL_RANK: Readonly<Record<ExternalMessageDetail, number>> = {
	text: 0,
	skeleton: 1,
	summary: 2,
	full: 3,
};

/** The stricter (lower-disclosure) of two tiers. */
export function stricterExternalMessageDetail(
	a: ExternalMessageDetail,
	b: ExternalMessageDetail,
): ExternalMessageDetail {
	return DETAIL_RANK[a] <= DETAIL_RANK[b] ? a : b;
}

/** True when `detail` discloses at least as much structure as `atLeast`. */
export function externalMessageDetailAtLeast(
	detail: ExternalMessageDetail,
	atLeast: ExternalMessageDetail,
): boolean {
	return DETAIL_RANK[detail] >= DETAIL_RANK[atLeast];
}

/**
 * Map the internal render LOD onto a wire tier, for clients that mirror the
 * NarraFork UI's detail slider.
 *
 * Advisory only: the server never consumes an LOD, so changing the UI's level
 * semantics cannot break the external contract. The mapping follows where the
 * DATA needs actually change (see docs/OPEN_API.md §7.6):
 *  - L1 clamps prose and folds activity to counts → `skeleton`
 *  - L2-L4 need full prose but only titles/headers/counts for the rest → `summary`
 *  - L5-L6 expand tool bodies and reasoning prose → `full`
 */
export function messageDetailForLod(lod: number): ExternalMessageDetail {
	const clamped = Math.min(6, Math.max(1, Math.round(lod)));
	if (clamped <= 1) return "skeleton";
	if (clamped <= 4) return "summary";
	return "full";
}

// ── Per-tier response limits ────────────────────────────────────────────────

/**
 * Page size ceilings per tier. A `full` page carries projected tool payloads, so
 * its ceiling is an order of magnitude smaller than a scalar-only page: 50 full
 * messages × 64 tools × a 4KB leaf would be a multi-megabyte response built on
 * the request path, which the backend main-thread rules forbid.
 */
export const EXTERNAL_MESSAGE_LIMIT_BY_DETAIL: Readonly<Record<ExternalMessageDetail, number>> = {
	text: 50,
	skeleton: 50,
	summary: 30,
	full: 10,
};

/** Tool items enumerated per message before falling back to counts alone. */
export const EXTERNAL_MESSAGE_MAX_TOOL_ITEMS = 64;
/** Subagent cards enumerated per message before falling back to counts alone. */
export const EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS = 16;
/**
 * Tool calls per message that may carry an inline payload at the `full` tier.
 *
 * Far below `EXTERNAL_MESSAGE_MAX_TOOL_ITEMS` on purpose: items beyond this still
 * appear with their identity, status and byte sizes, they just carry no `input`/
 * `output` and report `hasDetail`, so the client fetches the ones it cares about
 * from the drill-down endpoint. Without this the server would read
 * `limit × 64 × payload` bytes out of SQLite on a request path.
 */
export const EXTERNAL_MESSAGE_MAX_PAYLOAD_TOOL_ITEMS = 8;
/**
 * Per-row size guard on selecting a tool payload for an inline `full` item.
 *
 * Set at 2× the per-tool projection budget: a payload larger than this cannot
 * survive projection in any useful form, so reading it would be pure cost. Such
 * rows report `hasDetail` and are fetched individually instead.
 */
export const EXTERNAL_TOOL_PAYLOAD_SELECT_MAX_BYTES = 64 * 1024;
/**
 * Aggregate payload budget for ONE `full` page, applied after projection.
 *
 * The per-row and per-message caps bound what is read; this bounds what is
 * serialized, so a page of uniformly medium payloads cannot add up to a
 * multi-megabyte response body.
 */
export const EXTERNAL_MESSAGE_PAGE_PAYLOAD_BUDGET = 512 * 1024;

/** Reasoning steps enumerated per message before `stepsTruncated` is set. */
export const EXTERNAL_MESSAGE_MAX_REASONING_STEPS = 64;
/** Reasoning blocks read per message. */
export const EXTERNAL_MESSAGE_MAX_REASONING_BLOCKS = 32;
/**
 * Characters read from one reasoning block.
 *
 * Step boundaries are found by parsing the block's own text, so this cannot be as
 * small as the per-step body cap: cutting mid-block drops the steps after the cut,
 * which is reported as `stepsTruncated`.
 */
export const EXTERNAL_MESSAGE_REASONING_SCAN_MAX_CHARS = 64 * 1024;
/** Byte guard before a message's content column is scanned for reasoning blocks. */
export const EXTERNAL_MESSAGE_REASONING_SCAN_MAX_BYTES = 256 * 1024;
/** Character cap for one reasoning step title. */
export const EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS = 80;
/** Character cap for one reasoning step body at the `full` tier. */
export const EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS = 8 * 1024;
/** Aggregate character cap for all reasoning bodies of one message. */
export const EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS = 64 * 1024;

/**
 * Per-leaf budget for a tool payload embedded in a `full` page.
 *
 * Smaller than the vlist's 8KB leaf on purpose: that number is sized so a card
 * can fill the box it already reserved on screen. An external client has no such
 * box, and the same budget multiplied by a page of tool-heavy messages is the
 * response-size problem this cap exists to prevent. Clients that need more use
 * the per-tool drill-down endpoint.
 */
export const EXTERNAL_TOOL_PAYLOAD_LEAF_BUDGET = 4 * 1024;
/** Aggregate budget for one tool's payload inside a `full` page. */
export const EXTERNAL_TOOL_PAYLOAD_TOTAL_BUDGET = 32 * 1024;
/** Per-leaf budget for the single-tool drill-down endpoint. */
export const EXTERNAL_TOOL_DETAIL_LEAF_BUDGET = 32 * 1024;
/** Aggregate budget for the single-tool drill-down endpoint. */
export const EXTERNAL_TOOL_DETAIL_TOTAL_BUDGET = 128 * 1024;

// ── Wire DTOs ───────────────────────────────────────────────────────────────

export interface ExternalMessageUsage {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	/** Share of the model context used after this turn, 0-100. */
	contextPercent?: number;
	durationMs?: number;
	ttftMs?: number;
}

/** Bounded tool-status tally. Present at every structural tier. */
export interface ExternalMessageToolCounts {
	count: number;
	running: number;
	failed: number;
	/** Tool calls blocked on a permission decision (status `pending`). */
	awaitingPermission: number;
}

export interface ExternalMessageReasoningStep {
	/** Step title, or null for prose preceding the first title. */
	title: string | null;
	/** Body length in characters, always present so a client can size a control. */
	chars: number;
	/** Body markdown. `full` tier only. */
	body?: string;
	/** True when `body` was cut by a step or per-message reasoning cap. */
	bodyTruncated?: boolean;
}

export interface ExternalMessageReasoning {
	/**
	 * Reported reasoning tokens for the turn, when the provider supplied them.
	 *
	 * This is the ONLY size signal available at the `skeleton` tier. There is no
	 * character total, because computing one means walking the message's content
	 * blocks — the work the skeleton tier exists to avoid.
	 */
	tokens: number | null;
	/** Parsed steps. Absent at the `skeleton` tier. */
	steps?: ExternalMessageReasoningStep[];
	/** True when step enumeration hit `EXTERNAL_MESSAGE_MAX_REASONING_STEPS`. */
	stepsTruncated?: boolean;
	/**
	 * The tier would have returned steps, but the message's stored content exceeded
	 * the server-side scan guard, so nothing was extracted. Distinguishes "this
	 * message had no reasoning" (`steps: []`) from "reasoning exists but was not
	 * read" (`steps: []` plus this flag).
	 */
	unavailable?: boolean;
}

export interface ExternalMessageToolItem {
	toolUseId: string;
	name: string;
	/**
	 * Short human-readable target (a file path, command, url, …) projected from a
	 * fixed key whitelist. null when the input carried none of them, or when the
	 * payload exceeded the projection size guard.
	 */
	target: string | null;
	status: string;
	durationMs?: number;
	errorMessage?: string;
	/** Byte size of the persisted input payload, or null when there is none. */
	inputBytes: number | null;
	/** Byte size of the persisted output payload, or null when there is none. */
	outputBytes: number | null;
	/** True when the drill-down endpoint can return more than this item carries. */
	hasDetail: boolean;
	/** Byte-budget-projected input. `full` tier only. */
	input?: unknown;
	/** Byte-budget-projected output. `full` tier only. */
	output?: unknown;
	/** True when `input` lost content to the leaf/total budget. */
	inputTruncated?: boolean;
	/** True when `output` lost content to the leaf/total budget. */
	outputTruncated?: boolean;
}

export interface ExternalMessageTools extends ExternalMessageToolCounts {
	/** Enumerated tool calls. Absent at `skeleton`, or when over the item cap. */
	items?: ExternalMessageToolItem[];
	/** True when `items` was omitted or cut by `EXTERNAL_MESSAGE_MAX_TOOL_ITEMS`. */
	itemsTruncated?: boolean;
}

export interface ExternalMessageSubagentItem {
	toolUseId: string;
	/** Subagent type as requested by the parent narrator (explore/plan/…). */
	type: string | null;
	title: string | null;
	status: string;
	/** Bounded count of recent tool calls observed on this subagent. */
	recentCallCount: number;
}

export interface ExternalMessageSubagents {
	count: number;
	items?: ExternalMessageSubagentItem[];
	itemsTruncated?: boolean;
}

/**
 * One message at a structural tier (`skeleton` / `summary` / `full`).
 *
 * The `text` tier keeps its own pre-existing shape and is NOT this type: adding
 * these fields to it would change a response third parties already parse.
 */
export interface ExternalMessageNode {
	id: string;
	seq: number;
	role: "user" | "assistant" | "system";
	createdAt: string;
	/**
	 * `compact` marks a context-compaction boundary. System rows are surfaced only
	 * as this marker; internal system prose is never part of the external contract.
	 */
	kind: "message" | "compact";
	/** Characters of persisted assistant/user prose. */
	textChars: number;
	/** Prose body. Absent at the `skeleton` tier. */
	text?: string;
	/** True when `text` was cut by the byte ceiling. */
	textTruncated?: boolean;
	reasoning: ExternalMessageReasoning;
	tools: ExternalMessageTools;
	subagents: ExternalMessageSubagents;
	usage?: ExternalMessageUsage;
}

export interface ExternalToolCallDetail {
	toolUseId: string;
	name: string;
	status: string;
	target: string | null;
	durationMs?: number;
	errorMessage?: string;
	inputBytes: number | null;
	outputBytes: number | null;
	input: unknown;
	output: unknown;
	inputTruncated: boolean;
	outputTruncated: boolean;
	createdAt: string;
	completedAt: string | null;
}
