/**
 * segment-adapter.ts — Maps the app's message data model to vlist element specs.
 *
 * Bridges `message-segments.ts` RenderSegments + content blocks onto the
 * registry's element kinds + their measure input `data`. PretextMessageList
 * iterates segments → adapter → `measureElement(kind, data, …)` → heights.
 *
 * This mirrors the proven dispatch in MessageRenderer.tsx / message-segments.ts
 * (which lane a block belongs to, how a tool-run groups) but emits plain data
 * specs instead of React elements — keeping the mapping pure, testable, and DOM-
 * free. It intentionally does NOT import MessageRenderer/MessageBubble (that
 * would violate the isolation guard); it re-derives the classification locally.
 *
 * Scope note: this is the classification + light field-extraction layer. A few
 * kinds (tool-call detail payloads, permission option trees) carry rich data
 * that the caller enriches; the adapter marks those with the element kind + the
 * raw block/tool so the render layer can pull details lazily.
 */

import { type ProgressPhase, shouldShowThinkingChars } from "../progress-phase";
import type { VListElementKind } from "./element-kinds";
import type { RenderLod } from "./prepared-block";
import {
	type ContentBlockLike,
	groupReasoningRuns,
	hasStructuredReasoning,
	parseReasoningSegments,
	type ReasoningSegment,
} from "./reasoning-segments";
import {
	buildReflectionNoticeData,
	getPermissionReflectionSuggestion,
	normalizeReflectionAfterToolStatus,
	type ReflectionNoticeData,
	reflectionTitleKeyPrefix,
	reflectionTitleKeySuffix,
} from "./reflection";
import { classifyToolDetail, isTruncated } from "./tool-detail";
import { collectTruncatedLeaves, hasTruncatedLeaf, readLeafText } from "./tool-io-projection";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal structural mirrors of the app types (avoid importing app modules here
// so the adapter stays inside the vlist isolation boundary and unit-testable).
// The caller passes real NarratorMsg/RenderSegment values that structurally
// satisfy these.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterContentBlock {
	type: string;
	text?: string | null;
	thinking?: string | null;
	translatedText?: string | null;
	query?: string | null;
	queries?: string[] | null;
	status?: string | null;
	revisedPrompt?: string | null;
	result?: string | null;
	width?: number | null;
	height?: number | null;
	filename?: string | null;
	mediaType?: string | null;
	imageId?: string | null;
	previewUrl?: string | null;
	/**
	 * image_generation: the server-side file the generated image was saved to.
	 *
	 * This — NOT `result` — is the normal image source: the event handler writes the
	 * base64 payload to disk and persists only the path (`result` survives only when
	 * that write failed). Dropping it from the media payload is what left the vlist
	 * with a correctly reserved but permanently empty image box.
	 */
	savedPath?: string | null;
	/** image_generation: partial-preview file path while the image streams in. */
	partialSavedPath?: string | null;
	subtype?: string | null;
	summary?: string | null;
	/** error block: the error message (chunk reads errorBlock.message). */
	message?: string | null;
	/** spec_goal_added / spec_continuation: the task text (chunk reads block.task). */
	task?: string | null;
	/** spec_goal_added: whether the goal is newly added vs already existed. */
	added?: boolean | null;
	/** spec_*: whether the task is a protected commitment. */
	protected?: boolean | null;
	/** command block (bash_command): the shell command body. */
	command?: string | null;
	/** spec_fork_carryover / spec_context_cleared summary counts. */
	total?: number | null;
	open?: number | null;
	protectedOpen?: number | null;
	/** segment_compact_failed: the failure detail (chunk reads block.error). */
	error?: string | null;
	/** compact / segment_compact: live char count streamed while compacting. */
	outputChars?: number | null;
	/** compact / segment_compact: which live count the label features. */
	progressPhase?: ProgressPhase | null;
	/** compact / segment_compact: live thinking-channel char count. */
	thinkingChars?: number | null;
	/** segment_compact: number of messages folded into the segment summary. */
	messageCount?: number | null;
	[key: string]: unknown;
}

export interface AdapterMessage {
	id?: string;
	role: string;
	contentJson: AdapterContentBlock[];
	createdAt?: string;
	/**
	 * Slash command the user typed, when this user message was produced by one.
	 *
	 * The server EXPANDS a command into its full prompt template before storing
	 * it, so `contentJson`'s text block holds the whole (often multi-thousand
	 * character) expansion while this field keeps the short `/name args` the user
	 * actually wrote. Rendering the expansion as the bubble body is what turned a
	 * one-line command into a screen-filling wall of text in the virtual list;
	 * the bubble shows this line and folds the expansion away instead.
	 */
	commandText?: string | null;
	/** Owning narrator — the upload scope fallback for a user message's images. */
	narratorId?: string | null;
	creator?: {
		id?: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	/**
	 * Who authored the content, independent of `role`. System- and AI-injected
	 * turns are stored as `role: "user"` because providers treat the trailing user
	 * message as the current turn and the continuation scheduler only resumes from
	 * user/assistant — so this is what distinguishes them. Null on rows written
	 * before the column existed, which means "user". See `@shared/message-origin`.
	 */
	origin?: string | null;
	/** Display-only source label (`sourceKey` or `sourceKey:detail`). */
	originLabel?: string | null;
}

/** A tool-run item (structural subset of message-segments ToolRunItem).
 * NOTE: the real `tc` is ToolCallData — it has toolName/status/inputJson but NO
 * `summary` field (a display summary is derived downstream from inputJson). */
export interface AdapterToolItem {
	blockIndex: number;
	isSubagent: boolean;
	/** Owning assistant message (present on real ToolRunItem). */
	msg?: AdapterMessage;
	tc: {
		toolName: string;
		status?: string | null;
		inputJson?: unknown;
		outputJson?: unknown;
		toolUseId?: string;
		/** Subagent activity summary (drives recent-calls rows on subagent cards). */
		_subagentActivity?: {
			latestToolCalls?: unknown[];
			model?: string | null;
			/** Effective thinking tier, already resolved through the global default. */
			reasoningEffort?: string | null;
			/**
			 * Child narrator id. Height-bearing: the recent-calls title row only
			 * carries the "open full session" button once a child exists (the taller
			 * compact-xs row), exactly like SubagentCard gates it.
			 */
			subagentNarratorId?: string | null;
		} | null;
		[key: string]: unknown;
	};
}

/** Terminal tool statuses (subagent card gates its result preview on this). */
const TERMINAL_TOOL_STATUSES = new Set(["success", "fail", "cancelled", "error", "completed"]);

function isTerminalStatus(status?: string | null): boolean {
	return status != null && TERMINAL_TOOL_STATUSES.has(status);
}

/**
 * Header display summary for a tool call.
 *
 * Prefers the AUTHORITATIVE resolver injected by the shell (tool-display's
 * `getSummary`, the same function the chunked ToolCallCard header uses), so both
 * render paths show identical text. The local fallback is only a deterministic
 * stand-in for unit tests and callers that inject nothing.
 *
 * The fallback deliberately reads raw fields off `inputJson`, which means it
 * yields "" for a `{_truncated:true, preview, _hints}` wrapper — exactly the case
 * that made Edit/Write headers render with no target path. `getSummary` resolves
 * those through `_hints` / a preview scan, hence the injection.
 */
function toolSummary(tc: AdapterToolItem["tc"], ctx?: AdapterContext): string {
	const resolved = ctx?.resolveToolSummary?.(tc);
	if (typeof resolved === "string") return resolved;
	const input = (tc.inputJson ?? {}) as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
		const v = input[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return "";
}

/** Narrow an unknown JSON value to a plain record (empty object otherwise). */
function asObject(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Read a non-empty string field from a record; undefined otherwise. */
function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
	const v = record[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Read a string field that field-level projection may have wrapped.
 *
 * `readNonEmptyString` narrows with `typeof === "string"`, which a truncated leaf
 * (`{_truncated, preview}`) fails — so the field silently vanishes from the card.
 * This keeps it visible as its preview instead.
 */
function readLeafString(record: Record<string, unknown>, key: string): string | undefined {
	const text = readLeafText(record[key]);
	return text != null && text.length > 0 ? text : undefined;
}

/** Trim a possibly-null string; undefined when absent or blank. */
function nonEmptyTrimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

export type AdapterSegment =
	| { kind: "message"; msg: AdapterMessage; visibleBlockIndices?: number[] }
	| { kind: "tool-run"; items: AdapterToolItem[]; sourceMessages: AdapterMessage[] }
	| { kind: "prune-divider"; label?: string };

export type AdapterActivityInput =
	| {
			kind: "reasoning";
			msg?: AdapterMessage;
			blockIndex?: number;
			block?: AdapterContentBlock;
	  }
	| {
			kind: "tool";
			msg?: AdapterMessage;
			blockIndex?: number;
			tc?: AdapterToolItem["tc"];
	  };

/**
 * The selection / menu coordinates of one folded trace row. Carried so the
 * renderer can wrap the row in an interaction surface; **height-neutral** —
 * exactly like `toolName` / `category` / `iconColor`, the measure layer only
 * passes it through and never reads it for layout.
 */
export interface AdapterTraceRowIdentity {
	/** Owning message id. */
	messageId: string;
	/**
	 * Primary block index. For a REASONING row this is its reasoning RUN's START
	 * index, not the row's own block index — the activity fold walks reasoning
	 * blocks one by one while the selection index only registers a run's start, so
	 * a row must identify itself by the start to match an existing entry.
	 */
	blockIndex: number;
	/** Every source block index this row represents (a reasoning run spans many). */
	blockIndices?: readonly number[];
	/**
	 * Tool rows: the tool-call id. The integration layer turns this into the
	 * authoritative `tc-`/`sa-` blockId by looking the entry up in the selection
	 * index (which registers both aliases), so the adapter never has to guess the
	 * prefix — it has no access to the child messages that decide it.
	 */
	toolUseId?: string;
	/** Tool rows: the raw tool name. */
	toolName?: string;
}

interface AdapterTraceItem {
	title: string;
	hasIcon?: boolean;
	iconColor?: string;
	/** Tool name for the real category glyph (renderer only, height-neutral). */
	toolName?: string;
	/** Resolved tool category for the glyph (renderer only, height-neutral). */
	category?: string;
	bodyText?: string | null;
	shimmer?: boolean;
	key?: string;
	/** Selection / menu coordinates (renderer only, height-neutral). */
	identity?: AdapterTraceRowIdentity;
}

export type AdapterRenderUnit =
	| { kind: "segment"; seg: AdapterSegment }
	| {
			kind: "activity";
			key: string;
			items: AdapterActivityInput[];
			sourceMessages: AdapterMessage[];
	  };

/** One element to measure/render: which registry kind + its measure input. */
export interface ElementSpec {
	kind: VListElementKind;
	/** Stable key for React / virtualization. */
	key: string;
	/** Measure input `data` for `measureElement(kind, data, …)`. */
	data: unknown;
	/** Per-kind measure extras (expand state / labels / viewportHeight). */
	opts?: Record<string, unknown>;
	/**
	 * True for the FIRST spec produced by a render-unit (a message segment, a
	 * whole tool-run, an activity trace, or a divider). Marks a top-level boundary
	 * so the layout can open a larger gap BEFORE this item (i.e. after the
	 * previous unit) while keeping intra-message content blocks and in-run tool
	 * cards tight. Height-neutral; consumed only by the gap resolver.
	 */
	unitStart?: boolean;
}

export interface AdapterContext {
	lod: RenderLod;
	/** Explicit interaction override; undefined preserves the measure's default. */
	isExpanded?: (key: string) => boolean | undefined;
	/** L4 / old-L5 explicit click override, separate from normal opened state. */
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/**
	 * Reader asked for the ORIGINAL text of a translated body (reasoning runs).
	 *
	 * Height-affecting, so it must be resolved during adaptation like every other
	 * interaction state: the two languages wrap differently, and the exact path
	 * paints at the predicted geometry.
	 */
	showOriginal?: (key: string) => boolean;
	/**
	 * Reader opened a subagent card's PROMPT body.
	 *
	 * A separate channel from `isExpanded`, which folds the card as a whole: the
	 * chunked SubagentCard keeps its own `showPrompt` state, and reusing one key
	 * would make opening a card also unfold its prompt. Height-affecting, so it is
	 * resolved here like every other interaction state.
	 */
	isPromptOpen?: (key: string) => boolean;
	/** L5 recency window. Undefined preserves the old "all recent" fallback. */
	recentMessageIds?: ReadonlySet<string>;
	/** Viewport height for isPlan tool-call cap (0.85×). */
	viewportHeight?: number;
	/** i18n labels for system cards / traces, passed through to measures. */
	labels?: Record<string, string>;
	/** Pure resolvers injected by the shell; deterministic fallbacks keep tests simple. */
	resolveReasoningSegments?: (text: string) => ReasoningSegment[];
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	resolveToolTitle?: (tc: AdapterToolItem["tc"]) => string;
	/**
	 * Authoritative header summary (tool-display's `getSummary`), injected by the
	 * shell so the vlist header text matches the chunked ToolCallCard exactly.
	 *
	 * Without it the adapter can only read plain fields off `inputJson`, so any
	 * tool whose input was truncated server-side (`{_truncated:true, preview,
	 * _hints}`) renders a header with no target — the path/command lives in
	 * `_hints` or inside the preview JSON, which only `getSummary` decodes.
	 * Height-neutral: the header is one truncated single-line slot.
	 */
	resolveToolSummary?: (tc: AdapterToolItem["tc"]) => string;
	/**
	 * True when a tool/subagent item currently has a pending permission request
	 * (injected by the shell from the live WS permission list). Forces the card
	 * expanded (lodExempt) so its permission form area is visible. The form itself
	 * is mounted by the integration layer (vlist-permission-bridge) and measured
	 * after paint; this flag only governs the expand decision + a revision string
	 * so the card re-measures when the permission appears/disappears.
	 */
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	/**
	 * Full (un-truncated) tool input / output for a tool use, once the shell has
	 * fetched it.
	 *
	 * Large payloads arrive as `{_truncated:true, preview}` wrappers, so an expanded
	 * card could only ever show the preview — the chunked path swaps in the full
	 * body via `useToolCallDetail`. These resolvers are that swap: the shell fetches
	 * on demand and hands the result back here, and the new Map identity rebuilds
	 * the document (the measure cache keys on the body length, so the taller card is
	 * re-measured rather than served stale).
	 */
	resolveFullToolInput?: (toolUseId: string | undefined) => unknown;
	resolveFullToolOutput?: (toolUseId: string | undefined) => unknown;
	/**
	 * A LIVE pending permission's `suggestions`, which win over the tool call's
	 * persisted `permissionSuggestions` when resolving a reflection gate (same
	 * precedence as the chunked `getToolCallReflection`). Reflection state is
	 * otherwise already present in the loaded message tree, so this resolver only
	 * covers the in-flight window.
	 */
	resolvePendingPermissionSuggestions?: (toolUseId: string | undefined) => unknown[] | undefined;
	/**
	 * Plan body carried by a pending permission request, when the tool call itself
	 * has none yet.
	 *
	 * File-based ExitPlanMode plans are resolved server-side into the permission
	 * payload but never enter the streamed `tool_use` input, so `tc.inputJson.plan`
	 * stays empty until a reload rehydrates it from the DB. Without this fallback
	 * a freshly submitted file-based plan renders an empty body (the chunked card
	 * solves it the same way — see ToolCallCard's pendingPlanFallback).
	 *
	 * The shell must derive this resolver from the live pending-permission list so
	 * its identity changes when the plan text arrives; the document rebuild is what
	 * makes the new text observable.
	 */
	resolvePendingPlan?: (toolUseId: string | undefined) => string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block classification (mirrors message-segments.classifyBlock content lane).
// ─────────────────────────────────────────────────────────────────────────────

/** System/message subtype → system-simple vs system-text vs plan/card kinds. */
const SYSTEM_SIMPLE_SUBTYPES = new Set([
	"compact",
	"segment_compact",
	"merge_summary",
	"review_feedback",
	"spec_continuation",
	"spec_blocked_continuation",
]);
const SYSTEM_TEXT_SUBTYPES = new Set([
	"info",
	"error",
	"bash_command",
	"tool_loaded",
	"tool_unloaded",
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
]);
/** Extra recognized system block types beyond the simple/text sets. */
const SYSTEM_OTHER_TYPES = new Set(["knowledge_hint", "ask_in_passing", "subagent_recovery"]);
/**
 * Block types that make a role=user message render as a SYSTEM card rather than a
 * chat bubble (parity with MessageBubble's user branch, which checks these before
 * building a bubble).
 *
 * `/bash` (bash_command) and the tool load/unload notices are persisted with
 * role=user so the model sees them, but they carry no text block — the bubble
 * branch would paint an empty indigo box with just a header.
 */
const USER_SYSTEM_CARD_TYPES = new Set(["bash_command", "tool_loaded", "tool_unloaded"]);

/** True when a block type is a recognized system-card block (used to locate the
 * meaningful block within a system message, which may not be blocks[0]). */
function isRecognizedSystemBlockType(type: string): boolean {
	return (
		SYSTEM_SIMPLE_SUBTYPES.has(type) ||
		SYSTEM_TEXT_SUBTYPES.has(type) ||
		SYSTEM_OTHER_TYPES.has(type)
	);
}

/** Map a single content block to an element kind (content lane only). */
export function classifyContentBlock(block: AdapterContentBlock): VListElementKind | null {
	switch (block.type) {
		case "text":
			return block.text?.trim() ? "markdown" : null;
		case "image":
		case "text_file":
		case "image_generation":
			return "media";
		case "reasoning":
		case "thinking":
			return "reasoning";
		case "web_search":
			return "web-search";
		default:
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Data extraction per kind.
// ─────────────────────────────────────────────────────────────────────────────

function markdownData(block: AdapterContentBlock): string {
	return block.text ?? "";
}

function reasoningData(blocks: AdapterContentBlock[], isStreaming: boolean) {
	const text = blocks
		.map((block) => block.thinking ?? block.text ?? "")
		.filter((value) => value.length > 0)
		.join("\n\n");
	const translatedParts = blocks.map((block) => block.translatedText).filter(Boolean) as string[];
	const translatedText =
		translatedParts.length ===
		blocks.filter((block) => (block.thinking ?? block.text ?? "").length > 0).length
			? translatedParts.join("\n\n")
			: null;
	const displayText = translatedText ?? text;
	return {
		text,
		translatedText,
		isStreaming,
		stepCount: blocks.length,
		charCount: displayText.length,
	};
}

function truncateTitle(raw: string): string {
	return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

function reasoningStepTitle(segment: ReasoningSegment): string {
	if (segment.title) return truncateTitle(segment.title);
	const firstLine = segment.body.split("\n").find((line) => line.trim().length > 0) ?? "";
	return truncateTitle(firstLine.trim());
}

function reasoningStepsData(
	segments: ReasoningSegment[],
	isStreaming: boolean,
	ctx: AdapterContext,
) {
	return {
		steps: segments.map((segment, index) => ({
			title: reasoningStepTitle(segment),
			body: segment.isEmpty ? null : segment.body,
			shimmer: isStreaming && index === segments.length - 1,
			key: `seg${index}`,
		})),
		headerLabel: sysLabel(ctx, "reasoning"),
		headerCount: countLabel(ctx, "reasoningSteps", segments.length),
	};
}

function webSearchData(block: AdapterContentBlock) {
	return {
		query: block.query ?? null,
		queries: block.queries ?? null,
		status: block.status ?? null,
	};
}

/**
 * Attachment payload for a user bubble's image / text_file block. Only `type`
 * is height-relevant (image → fixed box, text_file → single row); the rest are
 * render-only fields the integration layer needs to resolve a blob src.
 *
 * `uploadNarratorId` falls back to the message's own narrator, matching
 * MessageBubble's `block.uploadNarratorId ?? message.narratorId ?? narratorId`.
 */
function userAttachmentData(block: AdapterContentBlock, msg: AdapterMessage) {
	const uploadNarratorId = readNonEmptyString(block, "uploadNarratorId") ?? msg.narratorId;
	return {
		type: block.type,
		imageId: block.imageId ?? null,
		previewUrl: block.previewUrl ?? null,
		filename: block.filename ?? null,
		mediaType: block.mediaType ?? null,
		size: typeof block.size === "number" ? block.size : null,
		uploadNarratorId: uploadNarratorId ?? null,
	};
}

/**
 * Localized header text of an image_generation block, mirroring MessageBubble's
 * `imageGenerating / imageGenerationPreparing / imageGenerated` ternary.
 *
 * MEASURED: the header line wraps together with the revised prompt, so the
 * wording belongs to the adapter (ctx.labels) rather than the render layer. A
 * persisted block carries no `status` at all (the event handler stores only the
 * saved path + size), which correctly reads as "generated".
 */
function imageGenerationStatusText(ctx: AdapterContext, status: string | null | undefined): string {
	if (!status || status === "completed") return sysLabel(ctx, "imageGenerated");
	return sysLabel(ctx, status === "generating" ? "imageGenerating" : "imageGenerationPreparing");
}

function mediaData(block: AdapterContentBlock, ctx: AdapterContext) {
	// measureMedia dispatches on `type`.
	return {
		type: block.type,
		imageId: block.imageId ?? null,
		previewUrl: block.previewUrl ?? null,
		filename: block.filename ?? null,
		mediaType: block.mediaType ?? null,
		status: block.status ?? null,
		revisedPrompt: block.revisedPrompt ?? null,
		// The image SOURCE fields. `savedPath` is the normal one (the base64 payload
		// is written to disk and only the path persisted); `result` survives only when
		// that write failed, and `partialSavedPath` is the streaming preview.
		result: block.result ?? null,
		savedPath: block.savedPath ?? null,
		partialSavedPath: block.partialSavedPath ?? null,
		width: block.width ?? null,
		height: block.height ?? null,
		...(block.type === "image_generation"
			? { statusText: imageGenerationStatusText(ctx, block.status) }
			: {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: segment → ElementSpec[]
// ─────────────────────────────────────────────────────────────────────────────

/** Adapt one RenderSegment to a list of element specs (measure-ready). */
export function adaptSegment(seg: AdapterSegment, ctx: AdapterContext): ElementSpec[] {
	switch (seg.kind) {
		case "prune-divider":
			return [{ kind: "prune-divider", key: "prune", data: { label: seg.label } }];
		case "message":
			return adaptMessage(seg.msg, seg.visibleBlockIndices, ctx);
		case "tool-run":
			return adaptToolRun(seg.items, ctx);
	}
}

function adaptMessage(
	msg: AdapterMessage,
	visibleBlockIndices: number[] | undefined,
	ctx: AdapterContext,
): ElementSpec[] {
	const specs: ElementSpec[] = [];
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const indices = visibleBlockIndices ?? blocks.map((_, i) => i);
	const idBase = msg.id ?? "msg";

	// user messages: a single bubble with plain pre-wrap text (not markdown) plus
	// its attachments (images / text files), which live INSIDE the same bubble —
	// mirroring MessageBubble, which maps every block of a user message rather
	// than only the text ones. Dropping them here is what made an image the user
	// sent silently disappear in the virtual list.
	if (msg.role === "user") {
		// Some user-role messages are not chat bubbles at all: `/bash`, tool load /
		// unload notices are persisted with role=user but carry ONLY a system block
		// and no text, so the bubble branch would paint an empty indigo box. Route
		// them to the same system card the classic renderer uses.
		const systemCardBlock = blocks.find((b) => USER_SYSTEM_CARD_TYPES.has(b.type));
		if (systemCardBlock) {
			return [adaptSystemBlock(systemCardBlock.type, systemCardBlock, idBase, msg, ctx)];
		}
		// Turns stored as role=user for protocol/scheduling reasons that no human
		// wrote (auto-continuation, review kickoff, AI-initiated sends). Painting
		// them as user bubbles is what made authorship ambiguous, so they get the
		// low-contrast origin card instead — matching MessageBubble.
		if (msg.origin === "system" || msg.origin === "assistant") {
			const bodyText = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			return [
				{
					kind: "system-text",
					key: `${idBase}-origin`,
					data: {
						kind: "origin_notice",
						text: bodyText,
						title: originHeadingLabel(ctx, msg.origin, msg.originLabel),
						timeLabel: formatOriginNoticeTime(msg.createdAt),
						origin: msg.origin,
						originLabel: msg.originLabel ?? null,
					},
				},
			];
		}
		const visible = indices.map((i) => blocks[i]).filter((b): b is AdapterContentBlock => !!b);
		const text = visible
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
		const attachments = visible
			.filter((b) => b.type === "image" || b.type === "text_file")
			.map((b) => userAttachmentData(b, msg));
		const key = `${idBase}-bubble`;
		const commandText =
			typeof msg.commandText === "string" && msg.commandText.length > 0 ? msg.commandText : null;
		return [
			{
				kind: "message-bubble",
				key,
				// measure reads role/text/hasHeader + the attachment list (each
				// attachment reserves a fixed box); creator/createdAt are
				// height-neutral fields the render layer uses to paint the header.
				data: {
					role: "user",
					text,
					hasHeader: true,
					creator: msg.creator ?? null,
					createdAt: msg.createdAt ?? null,
					...(commandText ? { commandText } : {}),
					...(attachments.length > 0 ? { attachments } : {}),
				},
				// A command bubble folds its expansion away by default, so the expand
				// state must reach the measure layer (it decides whether the body's
				// wrapped height counts). Only emitted for command bubbles so plain
				// bubbles keep an empty `opts` and their existing cache keys.
				...(commandText
					? {
							opts: {
								expanded: ctx.isExpanded?.(key) ?? false,
								...(ctx.labels?.showExpandedPrompt
									? { showLabel: ctx.labels.showExpandedPrompt }
									: {}),
								...(ctx.labels?.hideExpandedPrompt
									? { hideLabel: ctx.labels.hideExpandedPrompt }
									: {}),
							},
						}
					: {}),
			},
		];
	}

	// system messages: SCAN for the recognized system block (mirrors
	// MessageBubble's blocks.find(b => b.type === ...)). The meaningful block is
	// NOT necessarily blocks[0] — a leading text block can precede it (e.g.
	// [{text}, {knowledge_hint}]). Falls back to blocks[0] when none recognized.
	if (msg.role === "system" || msg.role === "sys" || msg.role === "disp") {
		const sysBlock = blocks.find((b) => isRecognizedSystemBlockType(b.type)) ??
			blocks[0] ?? { type: "info" };
		specs.push(adaptSystemBlock(sysBlock.type, sysBlock, idBase, msg, ctx));
		return specs;
	}

	// assistant messages: dispatch each visible block, merging adjacent reasoning
	// blocks into the same run as MessageBubble/ReasoningStepsTrace does.
	const streaming = msg.id === "__streaming__";
	const parseReasoning = ctx.resolveReasoningSegments ?? parseReasoningSegments;
	for (let position = 0; position < indices.length; position++) {
		const bi = indices[position];
		if (bi == null) continue;
		const block = blocks[bi];
		if (!block) continue;
		const kind = classifyContentBlock(block);
		if (kind === null) continue;
		const key = `${idBase}-b${bi}`;
		if (kind === "reasoning") {
			const reasoningBlocks = [block];
			let nextPosition = position + 1;
			while (nextPosition < indices.length) {
				const nextIndex = indices[nextPosition];
				if (nextIndex == null) break;
				const next = blocks[nextIndex];
				if (!next || classifyContentBlock(next) !== "reasoning") break;
				reasoningBlocks.push(next);
				nextPosition++;
			}
			const data = reasoningData(reasoningBlocks, streaming);
			// A translated run displays its translation by default; the reader can flip
			// it back to the original. Resolved HERE (not at paint time) because the two
			// languages wrap to different heights and the exact path paints at the
			// predicted geometry.
			const hasBothTexts = !!data.translatedText && data.text.length > 0;
			const showOriginal = hasBothTexts && (ctx.showOriginal?.(key) ?? false);
			// The structured/plain choice is made on the DEFAULT text on purpose: only
			// the plain card carries the language toggle, so letting the flip change the
			// element kind could swap in a trace with no way back.
			const displayText = data.translatedText ?? data.text;
			const parsed = parseReasoning(displayText);
			const structured = !data.isStreaming && hasStructuredReasoning(parsed);
			if (structured || (data.isStreaming && hasStructuredReasoning(parsed))) {
				specs.push({
					kind: "reasoning-steps",
					key,
					data: reasoningStepsData(parsed, streaming, ctx),
					opts: {
						titlesOnly: !streaming && (ctx.lod === 3 || ctx.lod === 4),
						showEarlier: ctx.showEarlier?.(key) ?? false,
						expandedIndices: ctx.expandedRows?.(key) ?? [],
					},
				});
			} else {
				specs.push({
					kind,
					key,
					data,
					opts: { expanded: ctx.isExpanded?.(key), showOriginal },
				});
			}
			position = nextPosition - 1;
			continue;
		}
		switch (kind) {
			case "markdown":
				specs.push({ kind, key, data: markdownData(block) });
				break;
			case "web-search":
				specs.push({ kind, key, data: webSearchData(block) });
				break;
			case "media":
				specs.push({ kind, key, data: mediaData(block, ctx) });
				break;
			default:
				break;
		}
	}
	return specs;
}

/**
 * English fallbacks for the height-neutral chrome labels the system cards paint
 * (badges / buttons / composed body prefixes). The shell injects the localized
 * strings via `ctx.labels`; these keep the pure adapter self-contained + unit-
 * testable. Keys mirror MessageBubble's i18n keys (narrator namespace).
 */
const SYSTEM_LABEL_FALLBACKS: Record<string, string> = {
	specProtectedBadge: "Protected",
	specGoalAddedBadge: "Goal added",
	specGoalExistsBadge: "Already tracked",
	specGoalViewTasks: "View tasks",
	specContinuation: "Task",
	specBlockedContinuation: "Blocked",
	segmentCompactFailed: "Compaction failed",
	segmentCompactFailedDesc: "Segment compaction failed.",
	dismiss: "Dismiss",
	unknownError: "Unknown error",
	specForkCarryover: "Fork carryover",
	specContextCleared: "Context cleared",
	specViewTasks: "View tasks",
	specClearTasks: "Clear",
	specResetTasks: "Reset",
	mergeSummaryLabel: "Merge",
	reviewFeedbackLabel: "Review",
	// Message-origin attribution (see @shared/message-origin). The heading row of
	// an origin_notice card, and the name shown on a user bubble whose author is
	// not a NarraFork account.
	originKindSystem: "System",
	originKindAssistant: "AI",
	originSourceAutoContinuation: "Auto-continuation",
	originSourceReview: "Review",
	originSourceRebase: "Rebase",
	originSourceBatchMerge: "Batch merge",
	originSourceScheduledTask: "Scheduled task",
	originSourceForkNarrator: "Forked by AI",
	originSourceChatGroup: "Group chat",
	originSourceGateway: "IM gateway",
	originSourceOauth: "External app",
	originSourceRecovery: "Session recovery",
	// Slash-command bubble fold control (a measured text row inside the bubble).
	showExpandedPrompt: "Show expanded prompt",
	hideExpandedPrompt: "Hide expanded prompt",
	// Read-only AskUserQuestion replay: these prefixes WRAP together with the
	// answer text, so they are measured (adapter labels) rather than painted by the
	// render layer.
	askAnswerPrefix: "Answer:",
	askCustomAnswerPrefix: "Custom answer:",
	// image_generation header status line (wraps with the revised prompt, so it is
	// measured and therefore an adapter label).
	imageGenerated: "Generated image",
	imageGenerating: "Generating image…",
	imageGenerationPreparing: "Preparing image generation…",
	// Trace / count-line chrome (CollapsibleTrace headers + ToolRun/Reasoning
	// count lines). Interpolated entries keep literal {count}/{reasoning}/{tools}
	// placeholders that the composers substitute with live values.
	reasoning: "Reasoning",
	reasoningSteps: "{count} steps",
	toolCalls: "Tool calls",
	toolCallsCount: "{count}",
	activityTraceLabel: "Activity",
	activityTraceCount: "{reasoning} reasoning · {tools} tools",
	reasoningCount: "{count} reasoning steps",
	toolGeneric: "Tool",
	compacting: "Compacting context…",
	compacted: "Context compacted",
	compactFailed: "Compact failed",
	compactOutputChars: "{count} chars",
	compactThinking: "thinking",
	compactThinkingChars: "{count} chars",
	segmentCompacting: "Segment compacting…",
	segmentCompacted: "Segment compacted ({count} messages)",
	subagentRecoveryTitle: "Subagents stopped with an error",
	subagentRecoveryDescription: "{count} subagent(s) did not finish. Pick the ones to restart.",
	subagentRecoveryToBackground: "to background",
	subagentRecoveryResumeAndNotify: "Resume and notify",
	subagentRecoveryResumeAndWait: "Resume and wait",
	subagentRecoveryResolvedNotify:
		"Restarted {count} subagent(s); the narrator was told to await them.",
	subagentRecoveryResolvedWait: "Restarted {count} subagent(s) and waited for every result.",
	// Reflection notice titles: `${kind}Reflection${Status}` (see
	// reflectionTitleKeyPrefix / reflectionTitleKeySuffix). The title participates
	// in the measured height, so it must flow through the adapter, not the render
	// layer.
	dangerReflectionRunning: "Checking a risky operation…",
	dangerReflectionAwaitingUser: "Risky operation needs your decision",
	dangerReflectionConfirmed: "Risky operation approved",
	dangerReflectionCancelled: "Risky operation cancelled",
	dangerReflectionAborted: "Risk check interrupted",
	dangerReflectionResolved: "Risk check finished",
	planReflectionRunning: "Reviewing the plan…",
	planReflectionAwaitingUser: "Plan needs your decision",
	planReflectionConfirmed: "Plan approved",
	planReflectionCancelled: "Plan rejected",
	planReflectionAborted: "Plan review interrupted",
	planReflectionResolved: "Plan review finished",
	questionReflectionRunning: "Reviewing the question…",
	questionReflectionAwaitingUser: "Question needs your answer",
	questionReflectionConfirmed: "Question answered",
	questionReflectionCancelled: "Question dismissed",
	questionReflectionAborted: "Question review interrupted",
	questionReflectionResolved: "Question review finished",
	taskReflectionRunning: "Reviewing the task list…",
	taskReflectionAwaitingUser: "Task list needs your decision",
	taskReflectionConfirmed: "Task list approved",
	taskReflectionCancelled: "Task list rejected",
	taskReflectionAborted: "Task review interrupted",
	taskReflectionResolved: "Task review finished",
	reflectionNextSteps: "Next: {nextSteps}",
};

/** Resolve a system-card chrome label (injected i18n → English fallback). */
function sysLabel(ctx: AdapterContext, key: string): string {
	return ctx.labels?.[key] ?? SYSTEM_LABEL_FALLBACKS[key] ?? key;
}

/**
 * Format an origin_notice timestamp: today → `HH:mm`, otherwise `MM/DD HH:mm`.
 *
 * Plain arithmetic rather than `Intl`, because this runs inside the pure adapter
 * (no locale imports) and the result is height-neutral chrome — it sits in a
 * fixed single-line heading row, so its width can never change a measured height.
 */
function formatOriginNoticeTime(createdAt: string | null | undefined): string {
	if (!createdAt) return "";
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return isToday ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

/** Recognized origin sources, mirroring `@shared/message-origin`. */
const ORIGIN_SOURCE_LABEL_KEYS: Record<string, string> = {
	autoContinuation: "originSourceAutoContinuation",
	review: "originSourceReview",
	rebase: "originSourceRebase",
	batchMerge: "originSourceBatchMerge",
	scheduledTask: "originSourceScheduledTask",
	forkNarrator: "originSourceForkNarrator",
	chatGroup: "originSourceChatGroup",
	gateway: "originSourceGateway",
	oauth: "originSourceOauth",
	recovery: "originSourceRecovery",
};

/**
 * Heading for an origin_notice card / the display name of a non-account author.
 *
 * Kept local rather than importing `@shared/message-origin`'s React-free helpers
 * so the label lookup stays inside the adapter's own i18n mechanism, which is
 * what makes the heading measurable.
 */
export function originHeadingLabel(
	ctx: AdapterContext,
	origin: string | null | undefined,
	originLabel: string | null | undefined,
): string {
	const raw = originLabel ?? "";
	const sep = raw.indexOf(":");
	const head = sep === -1 ? raw : raw.slice(0, sep);
	const detail = sep === -1 ? "" : raw.slice(sep + 1).trim();
	const labelKey = ORIGIN_SOURCE_LABEL_KEYS[head];
	if (labelKey) {
		const name = sysLabel(ctx, labelKey);
		return detail ? `${name} · ${detail}` : name;
	}
	if (raw) return raw;
	return sysLabel(ctx, origin === "assistant" ? "originKindAssistant" : "originKindSystem");
}

/**
 * Resolve a label carrying a single `{count}` placeholder and substitute the live
 * value. The shell injects the localized template with the placeholder kept
 * literal (see PretextExactMessageList's countPlaceholder), so pluralization is
 * resolved by i18next at injection time for the generic case while the number
 * itself stays dynamic.
 */
function countLabel(ctx: AdapterContext, key: string, count: number): string {
	return sysLabel(ctx, key).replace(/\{count\}/g, String(count));
}

/**
 * Compose the fork-carryover / context-cleared description text. Mirrors
 * MessageBubble's `t("specForkCarryoverDesc", { count, open, protectedOpen })`
 * shape without importing i18n — a plain summary line whose wrapped height the
 * measure layer then predicts. Uses the injected localized template when the
 * shell provides one (with {count}/{open}/{protectedOpen} placeholders).
 */
function carryoverDescription(ctx: AdapterContext, block: AdapterContentBlock): string {
	const total = typeof block.total === "number" ? block.total : 0;
	const open = typeof block.open === "number" ? block.open : 0;
	const protectedOpen = typeof block.protectedOpen === "number" ? block.protectedOpen : 0;
	const template = ctx.labels?.specForkCarryoverDesc;
	if (template) {
		return template
			.replace(/\{count\}/g, String(total))
			.replace(/\{open\}/g, String(open))
			.replace(/\{protectedOpen\}/g, String(protectedOpen));
	}
	// Fallback English summary line.
	return `Carried over ${total} spec task${total === 1 ? "" : "s"} (${open} open, ${protectedOpen} protected).`;
}

/**
 * Compose the compact / segment_compact indicator line by status, mirroring
 * MessageBubble's CompactIndicator / SegmentCompactIndicator — which ALWAYS
 * synthesize the label from status (never from block.text/summary). The compact
 * block carries no display `text`; while `compacting` it only has a live
 * `outputChars`, and once `compacted` it holds the full `summary` (which must
 * NOT be shown on the one-line indicator). Reproducing that here keeps the vlist
 * card in parity: a running compact shows "…compacting · N chars" and a finished
 * one shows the terse "compacted" / "segment compacted (N messages)" label.
 */
function composeCompactText(
	ctx: AdapterContext,
	opts: {
		isSegment: boolean;
		status: "compacting" | "compacted" | "failed";
		phase?: ProgressPhase | null;
		thinkingChars?: number | null;
		outputChars?: number | null;
		messageCount?: number | null;
	},
): string {
	if (opts.status === "compacting") {
		// Thinking phase: the summary model has not produced visible output yet, so
		// feature the thinking count instead of a stuck "0 chars". A count below the
		// display threshold shows the bare label (see `@shared/progress-phase`).
		if (opts.phase === "thinking") {
			const label = sysLabel(ctx, opts.isSegment ? "segmentCompacting" : "compacting");
			const chars = typeof opts.thinkingChars === "number" ? opts.thinkingChars : 0;
			const thinkingLabel = sysLabel(ctx, "compactThinking");
			if (!shouldShowThinkingChars(chars)) return `${label} · ${thinkingLabel}`;
			const charsLabel = sysLabel(ctx, "compactThinkingChars").replace(/\{count\}/g, String(chars));
			return `${label} · ${thinkingLabel} · ${charsLabel}`;
		}
		const label = sysLabel(ctx, opts.isSegment ? "segmentCompacting" : "compacting");
		const chars = typeof opts.outputChars === "number" ? opts.outputChars : 0;
		const charsLabel = sysLabel(ctx, "compactOutputChars").replace(/\{count\}/g, String(chars));
		return `${label} · ${charsLabel}`;
	}
	if (opts.status === "failed") {
		// Only context compact reaches this composer when failed (segment failed
		// routes to the system-text card upstream).
		return sysLabel(ctx, "compactFailed");
	}
	if (opts.isSegment) {
		const count = typeof opts.messageCount === "number" ? opts.messageCount : 0;
		return sysLabel(ctx, "segmentCompacted").replace(/\{count\}/g, String(count));
	}
	return sysLabel(ctx, "compacted");
}

/**
 * While a compact marker is `compacting`, its live `outputChars` changes the
 * one-line label text but NOT its height (single clamped line). The measure
 * cache keys on (spec.key, kind, width, lod, opts, dataRevision) and the compact
 * block's dataRevision only tracks `status` — which stays "compacting" for the
 * whole run — so a bare rebuild would return the stale cached text. Folding the
 * live count into `opts.progress` makes the opts digest (and therefore the cache
 * key) change on each progress tick, forcing a re-measure that re-composes the
 * label. The measure fn ignores `progress` (height is constant), so this only
 * affects cache identity, never layout geometry. Returns `{}` when not
 * compacting so completed/failed markers keep a stable, cacheable key.
 */
function compactProgressOpts(
	status: "compacting" | "compacted" | "failed",
	outputChars?: number | null,
	phase?: ProgressPhase | null,
	thinkingChars?: number | null,
): { opts?: Record<string, unknown> } {
	if (status !== "compacting") return {};
	// The phase and the thinking count belong in the digest for the same reason
	// the output count does: they change the composed label while the height (a
	// single clamped line) never moves.
	return {
		opts: {
			progress: typeof outputChars === "number" ? outputChars : 0,
			phase: phase === "thinking" ? "thinking" : "output",
			thinking: typeof thinkingChars === "number" ? thinkingChars : 0,
		},
	};
}

function adaptSystemBlock(
	blockType: string,
	block: AdapterContentBlock,
	idBase: string,
	msg: AdapterMessage,
	ctx: AdapterContext,
): ElementSpec {
	// The message's leading text block is the chunk renderer's `contentText`
	// fallback (goalBlock.task ?? message.contentText, etc.).
	const contentText =
		msg.contentJson.find((b) => b.type === "text" && (b.text ?? "").trim().length > 0)?.text ?? "";

	if (blockType === "compact" && block.subtype === "plan") {
		return {
			kind: "plan-card",
			key: `${idBase}-plan`,
			data: { summary: block.summary ?? block.text ?? "" },
		};
	}
	if (blockType === "knowledge_hint") {
		return {
			kind: "knowledge-hint",
			key: `${idBase}-kh`,
			data: { heading: block.summary ?? "", entries: (block.entries as unknown[]) ?? [] },
		};
	}
	if (blockType === "ask_in_passing") {
		// Mirror MessageBubble: pending iff status==="pending", otherwise resolved
		// (any non-pending status — resolved/answered/etc — renders the resolved card).
		const pending = block.status === "pending";
		return {
			kind: "ask-in-passing",
			key: `${idBase}-aip`,
			data: { kind: pending ? "pending" : "resolved", question: block.text ?? "" },
		};
	}
	if (blockType === "subagent_recovery") {
		// Mirror MessageBubble: pending unless the server already flipped the block
		// to resolved after the user picked a resume mode.
		const resolved = block.status === "resolved";
		const rows = Array.isArray(block.subagents) ? (block.subagents as unknown[]) : [];
		const resumedCount = typeof block.resumedCount === "number" ? block.resumedCount : rows.length;
		const key = `${idBase}-sr`;
		return {
			kind: "subagent-recovery",
			key,
			// The row toggle state reuses the generic per-row index set, which starts
			// EMPTY. The card defaults to "everything selected", so the set tracks
			// DESELECTED rows rather than selected ones.
			opts: { deselected: ctx.expandedRows?.(key) ?? [] },
			data: {
				kind: resolved ? "resolved" : "pending",
				title: sysLabel(ctx, "subagentRecoveryTitle"),
				description: countLabel(ctx, "subagentRecoveryDescription", rows.length),
				subagents: rows,
				summary: countLabel(
					ctx,
					block.mode === "await"
						? "subagentRecoveryResolvedWait"
						: "subagentRecoveryResolvedNotify",
					resumedCount,
				),
				notifyLabel: sysLabel(ctx, "subagentRecoveryResumeAndNotify"),
				waitLabel: sysLabel(ctx, "subagentRecoveryResumeAndWait"),
				backgroundBadge: sysLabel(ctx, "subagentRecoveryToBackground"),
			},
		};
	}

	// ── segment_compact: compacting/compacted → simple; failed → system-text card.
	if (blockType === "segment_compact") {
		if (block.status === "failed") {
			return {
				kind: "system-text",
				key: `${idBase}-sys`,
				data: {
					kind: "segment_compact_failed",
					text: block.error ?? block.summary ?? sysLabel(ctx, "segmentCompactFailedDesc"),
					title: sysLabel(ctx, "segmentCompactFailed"),
					buttons: [sysLabel(ctx, "dismiss")],
					color: "red",
				},
			};
		}
		const segStatus = block.status === "compacting" ? "compacting" : "compacted";
		return {
			kind: "system-simple",
			key: `${idBase}-sys`,
			data: {
				kind: "segment_compact",
				// The label is synthesized from status (parity with
				// SegmentCompactIndicator); block.text/summary are never shown here.
				text: composeCompactText(ctx, {
					isSegment: true,
					status: segStatus,
					phase: block.progressPhase,
					thinkingChars: block.thinkingChars,
					outputChars: block.outputChars,
					messageCount: block.messageCount,
				}),
				status: segStatus,
				...(typeof block.outputChars === "number" ? { outputChars: block.outputChars } : {}),
			},
			...compactProgressOpts(
				segStatus,
				block.outputChars,
				block.progressPhase,
				block.thinkingChars,
			),
		};
	}

	if (SYSTEM_SIMPLE_SUBTYPES.has(blockType)) {
		return {
			kind: "system-simple",
			key: `${idBase}-sys`,
			data: adaptSystemSimpleData(blockType, block, contentText, ctx),
			...(blockType === "compact" && block.status === "compacting"
				? compactProgressOpts(
						"compacting",
						block.outputChars,
						block.progressPhase,
						block.thinkingChars,
					)
				: {}),
		};
	}
	if (SYSTEM_TEXT_SUBTYPES.has(blockType)) {
		return {
			kind: "system-text",
			key: `${idBase}-sys`,
			data: adaptSystemTextData(blockType, block, contentText, ctx),
		};
	}
	// fallback: treat as info text.
	return {
		kind: "system-text",
		key: `${idBase}-sys`,
		data: { kind: "info", text: block.text ?? "" },
	};
}

/** Compose the single-line system-simple card data (height-neutral chrome +
 * the clamped display line). Mirrors MessageBubble's per-subtype field reads. */
function adaptSystemSimpleData(
	blockType: string,
	block: AdapterContentBlock,
	contentText: string,
	ctx: AdapterContext,
): Record<string, unknown> {
	switch (blockType) {
		case "compact": {
			const compactStatus =
				block.status === "compacting"
					? "compacting"
					: block.status === "failed"
						? "failed"
						: "compacted";
			return {
				kind: "compact",
				// The label is synthesized from status (parity with CompactIndicator);
				// block.text/summary are never shown on the one-line indicator.
				text: composeCompactText(ctx, {
					isSegment: false,
					status: compactStatus,
					phase: block.progressPhase,
					thinkingChars: block.thinkingChars,
					outputChars: block.outputChars,
				}),
				status: compactStatus,
				...(typeof block.outputChars === "number" ? { outputChars: block.outputChars } : {}),
			};
		}
		case "merge_summary":
			return {
				kind: "merge_summary",
				text: block.text ?? block.summary ?? sysLabel(ctx, "mergeSummaryLabel"),
				color: "indigo",
				hasAvatar: true,
			};
		case "review_feedback":
			return {
				kind: "review_feedback",
				text: block.text ?? block.summary ?? sysLabel(ctx, "reviewFeedbackLabel"),
				color: "gray",
			};
		case "spec_continuation":
		case "spec_blocked_continuation": {
			const isBlocked = blockType === "spec_blocked_continuation";
			return {
				kind: blockType,
				// chunk: specBlock.task ?? message.contentText
				text: block.task ?? block.text ?? contentText,
				color: isBlocked ? "orange" : "indigo",
				badgeLabel: sysLabel(ctx, isBlocked ? "specBlockedContinuation" : "specContinuation"),
				protected: block.protected === true,
			};
		}
		default:
			return { kind: blockType, text: block.text ?? block.summary ?? "" };
	}
}

/** Compose the multi-line system-text card data (wrapping body drives height +
 * height-neutral chrome). Mirrors MessageBubble's per-subtype field reads. */
function adaptSystemTextData(
	blockType: string,
	block: AdapterContentBlock,
	contentText: string,
	ctx: AdapterContext,
): Record<string, unknown> {
	switch (blockType) {
		case "error":
			return {
				kind: "error",
				text: block.message ?? block.text ?? sysLabel(ctx, "unknownError"),
				color: "red",
				actions: true,
			};
		case "bash_command":
			return {
				kind: "bash_command",
				text: block.command ?? block.text ?? "",
				command: block.command ?? undefined,
			};
		case "tool_loaded":
		case "tool_unloaded":
			return { kind: blockType, text: block.text ?? block.summary ?? "" };
		case "spec_goal_added": {
			const added = block.added !== false;
			return {
				kind: "spec_goal_added",
				// chunk: goalBlock.task ?? message.contentText
				text: block.task ?? block.text ?? contentText,
				added,
				color: "indigo",
				badges: [
					sysLabel(ctx, "specProtectedBadge"),
					sysLabel(ctx, added ? "specGoalAddedBadge" : "specGoalExistsBadge"),
				],
				buttons: [sysLabel(ctx, "specGoalViewTasks")],
			};
		}
		case "spec_fork_carryover":
		case "spec_context_cleared": {
			const isCleared = blockType === "spec_context_cleared";
			return {
				kind: blockType,
				text: carryoverDescription(ctx, block),
				color: "indigo",
				variant: isCleared ? "contextCleared" : "fork",
				badges: [sysLabel(ctx, isCleared ? "specContextCleared" : "specForkCarryover")],
				buttons: [
					sysLabel(ctx, "specViewTasks"),
					sysLabel(ctx, "specClearTasks"),
					sysLabel(ctx, "specResetTasks"),
				],
			};
		}
		default:
			return { kind: "info", text: block.text ?? "" };
	}
}

// ── Within-tool-run LOD folding (mirrors render-units + MessageRenderer's
// ToolRunLodGate). Vlist-local copies of the pure helpers keep the adapter
// self-contained (no app import). Semantics locked by segment-adapter.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** True when a tool item is mid-flight (running / pending / initializing). */
export function isActiveToolItem(item: AdapterToolItem): boolean {
	const s = item.tc.status;
	return s === "running" || s === "pending" || s === "initializing" || isStreamingToolItem(item);
}

/** Synthetic tool inputs stream before their persisted status catches up. */
export function isStreamingToolItem(item: AdapterToolItem): boolean {
	const input = item.tc.inputJson;
	return (
		typeof input === "object" &&
		input !== null &&
		(input as { _streamingChars?: unknown })._streamingChars != null
	);
}

type ToolLodGroup =
	| { kind: "active"; item: AdapterToolItem; index: number }
	| { kind: "folded"; items: AdapterToolItem[]; startIndex: number };

/** Split a tool run into chronological groups: active items stay standalone,
 * completed items fold in contiguous batches. Mirrors groupToolRunItemsForLod. */
export function groupToolItemsForLod(items: AdapterToolItem[]): ToolLodGroup[] {
	const groups: ToolLodGroup[] = [];
	let pending: AdapterToolItem[] = [];
	let pendingStart = 0;
	const flush = () => {
		if (pending.length === 0) return;
		groups.push({ kind: "folded", items: pending, startIndex: pendingStart });
		pending = [];
	};
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		if (isActiveToolItem(item)) {
			flush();
			groups.push({ kind: "active", item, index: i });
			continue;
		}
		if (pending.length === 0) pendingStart = i;
		pending.push(item);
	}
	flush();
	return groups;
}

function toolItemKey(item: AdapterToolItem): string {
	const fallback = `${item.msg?.id ?? "msg"}-${item.blockIndex}`;
	return `tool-${item.tc.toolUseId ?? fallback}`;
}

function isRecentToolItem(item: AdapterToolItem, ctx: AdapterContext): boolean {
	if (!ctx.recentMessageIds) return true;
	return item.msg?.id != null && ctx.recentMessageIds.has(item.msg.id);
}

interface ToolRunContext {
	inRun: boolean;
	isLast: boolean;
	isSoleSubagent: boolean;
}

/** Adapt a single tool item to its full card (tool-call or subagent-card). */
function adaptToolItemFull(
	item: AdapterToolItem,
	ctx: AdapterContext,
	runContext: ToolRunContext = { inRun: false, isLast: true, isSoleSubagent: false },
): ElementSpec {
	const key = toolItemKey(item);
	const opened = ctx.isExpanded?.(key);
	const defaultOpened =
		opened === undefined && item.isSubagent && runContext.isSoleSubagent ? true : opened;
	const lodUserOverride = ctx.isLodUserOverride?.(key) ?? false;
	const hasPendingPermission = ctx.resolveHasPendingPermission?.(item.tc.toolUseId) ?? false;
	const opts = {
		isRecent: isRecentToolItem(item, ctx),
		...(defaultOpened === undefined ? {} : { opened: defaultOpened }),
		lodUserOverride,
		viewportHeight: ctx.viewportHeight,
		inRun: runContext.inRun,
		isLast: runContext.isLast,
		// Pending-permission cards stay expanded and re-measure when the request
		// appears/disappears (the boolean folds into the measure cache key).
		...(hasPendingPermission ? { hasPendingPermission: true } : {}),
		collapsesByLod:
			!hasPendingPermission &&
			!isActiveToolItem(item) &&
			(ctx.lod === 4 || (ctx.lod === 5 && !isRecentToolItem(item, ctx))),
	};
	if (item.isSubagent) {
		// Map height-relevant SubagentCardData fields (NOT `status` — that field
		// doesn't exist on SubagentCardData; it uses isTerminal + recentCallCount).
		const activity = item.tc._subagentActivity;
		const recentCalls = activity?.latestToolCalls ?? [];
		// Names and timings are derived from the SAME filtered list so index i lines
		// up in both arrays — the renderer pairs them positionally per row.
		const namedRecentCalls = recentCalls
			.filter(
				(call): call is Record<string, unknown> =>
					call != null &&
					typeof call === "object" &&
					typeof (call as { toolName?: unknown }).toolName === "string" &&
					((call as { toolName: string }).toolName?.length ?? 0) > 0,
			)
			.slice(0, 3);
		const recentCallNames = namedRecentCalls.map((call) => call.toolName as string);
		const recentCallTimings = namedRecentCalls.map((call) => ({
			...(typeof call.status === "string" ? { status: call.status } : {}),
			...recentCallTiming(call),
		}));
		const resultText = typeof item.tc.outputJson === "string" ? item.tc.outputJson : undefined;
		const isActive = !isTerminalStatus(item.tc.status);
		// ── Fields carried by the persisted tool call (mirrors SubagentCard.tsx
		// derivations). prompt/isBackground/agentType live on inputJson; Send tools
		// carry the prompt on `message` and imply agentType "send".
		//
		// `withFullInput` so a prompt the server had to truncate is replaced by the
		// real body once the shell fetched it (the fetch itself is gated on the
		// reader OPENING the prompt — see the shell's promptExpandedToolUseIds).
		const input = asObject(withFullInput(item, ctx));
		const isSend = item.tc.toolName === "Send";
		// `readLeafString` (not readNonEmptyString): a truncated prompt arrives as a
		// `{_truncated, preview}` wrapper, which a plain string check would drop —
		// making the whole prompt block disappear instead of showing its preview.
		const promptField = readLeafString(input, "prompt");
		const prompt = promptField ?? (isSend ? readLeafString(input, "message") : undefined);
		// Whether that prompt is still only a PREVIEW. Drives the shell's on-demand
		// fetch; height-neutral (the prompt body is capped either way).
		const promptTruncated =
			hasTruncatedLeaf(input.prompt) || (isSend && hasTruncatedLeaf(input.message));
		const isBackground = input.background === true || input.run_in_background === true;
		const agentType =
			readNonEmptyString(input, "subagent_type") ?? (isSend ? "send" : item.tc.toolName);
		// Thinking-effort badge. Same precedence as SubagentCard.tsx minus the live
		// narrator query (which the adapter has no access to): the activity summary
		// already carries the child narrator's EFFECTIVE tier, so it wins over the
		// requested tool input. `reasoning_effort` is the canonical persisted key;
		// `reasoningEffort` covers legacy/alternate Agent callers.
		const reasoningEffort =
			nonEmptyTrimmed(activity?.reasoningEffort) ??
			readNonEmptyString(input, "reasoning_effort") ??
			readNonEmptyString(input, "reasoningEffort");
		// Description mirrors chunk's `input.description ?? (prompt-derived)`; falls
		// back to the generic tool summary when neither is present.
		const description =
			readNonEmptyString(input, "description") ??
			(prompt ? (prompt.includes("\n") ? prompt.slice(0, 80) : prompt) : toolSummary(item.tc, ctx));
		return {
			kind: "subagent-card",
			key,
			data: {
				agentType,
				description,
				// Identity passthrough (height-neutral) so the shell can bind the
				// on-demand prompt fetch to this exact tool call.
				...(item.tc.toolUseId ? { toolUseId: item.tc.toolUseId } : {}),
				model: activity?.model ?? undefined,
				...(reasoningEffort === undefined ? {} : { reasoningEffort }),
				...(prompt === undefined ? {} : { prompt }),
				// The prompt block's own fold state (independent of the card's), so the
				// measure layer reserves the body only when the reader opened it.
				...(prompt !== undefined && ctx.isPromptOpen?.(key) === true ? { promptOpen: true } : {}),
				// Still a preview → the shell may fetch the real body while it is open.
				...(promptTruncated ? { promptTruncated: true } : {}),
				isBackground,
				recentCallCount: recentCallNames.length,
				recentCallNames,
				// Mirrors SubagentCard: the recent-calls header offers "open full
				// session" only once the activity summary knows the child narrator.
				// Height-bearing (compact-xs button row > plain xs text row).
				hasRecentCallsButton: !!nonEmptyTrimmed(activity?.subagentNarratorId),
				isTerminal: isTerminalStatus(item.tc.status),
				isActive,
				// Raw terminal status → render-only status glyph (success/fail/cancelled).
				// Height-neutral (a single 12px header slot).
				status: item.tc.status ?? undefined,
				// ── Header timing (height-neutral; feeds the portaled popover) ────────
				// The card's own stamps, plus one entry per recent-call ROW positionally
				// aligned with `recentCallNames`. SubagentCard renders a ToolTimingArea in
				// both places (SubagentCard.tsx:623 / :684); without these the vlist copy
				// had no timing at all.
				timing: cardTiming(item.tc),
				recentCallTimings,
				resultText,
				resultPreview: resultText?.slice(0, 120),
			},
			opts: {
				...opts,
				isActive,
				inRun: runContext.inRun,
				isLast: runContext.isLast,
			},
		};
	}
	// category drives measure-tool-call's default-open (→ height). Resolved
	// via the injected authoritative resolver; "generic" when absent.
	const category = ctx.resolveToolCategory?.(item.tc.toolName, item.tc.inputJson) ?? "generic";
	const isStreaming = isStreamingToolItem(item);
	const metadata =
		(item.tc.outputJson as { _metadata?: unknown } | null | undefined)?._metadata ??
		(item.tc as { _metadata?: unknown })._metadata;
	// Truncated payloads are replaced by the full ones once the shell has fetched
	// them (same injection pattern as resolvePendingPlan), so the expanded card can
	// show the real body instead of a preview.
	const inputJson = withFullInput(item, ctx);
	const outputJson = withFullOutput(item, ctx);
	const errorMessage = readNonEmptyString(item.tc, "errorMessage");
	return {
		kind: "tool-call",
		key,
		data: {
			toolName: item.tc.toolName,
			summary: toolSummary(item.tc, ctx),
			status: item.tc.status ?? "success",
			isStreaming,
			inRun: runContext.inRun,
			isLast: runContext.isLast,
			category,
			// ── Header timing / identity passthrough (all height-neutral) ──────────
			...(item.tc.toolUseId ? { toolUseId: item.tc.toolUseId } : {}),
			...(errorMessage ? { errorMessage } : {}),
			...toolTimingFields(item.tc, category, metadata),
			// How much of this payload is STILL a preview (the full one has not been
			// fetched). Counted AFTER the substitutions above, so a fetched payload
			// reports zero — which is what makes the summary row disappear and the
			// card shrink once the user loads the full content.
			//
			// A COUNT plus a byte total rather than a boolean: field-level truncation
			// can cut several fields of one call, and the notice reports both.
			// Height-affecting (it decides whether the notice row is reserved).
			...truncatedPayloadFields(inputJson, outputJson),
			// Reflection notice (danger / plan / task / question gate). Replaces the
			// permission area, and is MEASURED — the row's height is final on first
			// paint instead of being corrected by a ResizeObserver afterwards.
			reflection: resolveToolReflection(item, ctx, hasPendingPermission),
			// Expanded detail region height model (line counts / body lines / px).
			// null when the tool call has no meaningful detail body.
			detail: classifyToolDetail({
				toolName: item.tc.toolName,
				category,
				status: item.tc.status,
				inputJson: applyPendingPlanFallback(inputJson, item, ctx),
				outputJson,
				metadata,
				isStreaming,
				...(errorMessage ? { errorMessage } : {}),
				hasPendingPermission,
				// Only MEASURED chrome strings (the ask replay's answer prefixes) —
				// render-layer chrome is injected through renderLabels instead.
				...(ctx.labels ? { labels: ctx.labels } : {}),
			}),
		},
		opts,
	};
}

/** Chunk parity: Bash falls back to a 120s deadline (ToolCallCard.tsx:1327). */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Chunk parity: Await falls back to a 600s deadline (ToolCallCard.tsx:1328). */
const DEFAULT_AWAIT_TIMEOUT_MS = 600_000;

/**
 * Effective header timeout, mirroring ToolCallCard's `effectiveTimeoutMs` (:1831).
 *
 * Only bash / await tools show a `/ timeout` suffix at all. An explicit value
 * always wins (`_timeoutMs` written by the `timeout_updated` WS event, else the
 * tool input). A BACKGROUND bash has no wall-clock deadline, so it deliberately
 * resolves to undefined rather than the default — showing "/ 2m" on a task that
 * will never be killed is the divergence this reproduces correctly.
 */
function effectiveTimeoutMs(tc: AdapterToolItem["tc"], category: string): number | undefined {
	if (category !== "bash" && category !== "await") return readFiniteNumber(tc._timeoutMs);
	const explicit =
		readFiniteNumber(tc._timeoutMs) ?? readFiniteNumber(asObject(tc.inputJson).timeout);
	if (explicit != null) return explicit;
	if (category === "bash" && asObject(tc.inputJson).run_in_background === true) return undefined;
	return category === "await" ? DEFAULT_AWAIT_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS;
}

/**
 * The five lifecycle stamps behind the header's timing popover, as epoch ms.
 *
 * Height-neutral by construction: they are only ever read by the popover BODY,
 * which lives in a portal. Extracted separately from `toolTimingFields` so the
 * subagent branch (whose recent-call rows carry the same shape, nested under
 * `timing`) can reuse the exact same normalization.
 */
function toolTimingStamps(source: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	const startedAt = parseEpochMs(source.startedAt);
	const streamStartedAt = parseEpochMs(source.streamStartedAt);
	const permissionStartedAt = parseEpochMs(source.permissionStartedAt);
	const executionStartedAt = parseEpochMs(source.executionStartedAt);
	const completedAt = parseEpochMs(source.completedAt);
	const createdAt = parseEpochMs(source.createdAt);
	if (startedAt != null) out.startedAt = startedAt;
	if (streamStartedAt != null) out.streamStartedAt = streamStartedAt;
	if (permissionStartedAt != null) out.permissionStartedAt = permissionStartedAt;
	if (executionStartedAt != null) out.executionStartedAt = executionStartedAt;
	if (completedAt != null) out.completedAt = completedAt;
	if (createdAt != null) out.createdAt = createdAt;
	return out;
}

/**
 * A subagent card's own timing record: lifecycle stamps plus the resolved final
 * duration (explicit, else derived from the start/complete pair — same fallback
 * the tool header uses).
 */
function cardTiming(tc: AdapterToolItem["tc"]): Record<string, number> {
	const stamps = toolTimingStamps(tc);
	const durationMs = readFiniteNumber(tc.durationMs) ?? deriveDuration(tc);
	return durationMs != null ? { ...stamps, durationMs } : stamps;
}

/**
 * Normalize ONE recent-call header from a subagent activity summary.
 *
 * The wire shape (`SubagentToolCallHeader`) nests the stamps under `timing` but
 * keeps `createdAt` at the top level, so flatten both into the same stamp record
 * the card header uses. `durationMs` also lives on `timing`, which is why it is
 * lifted here rather than read off the row object.
 */
function recentCallTiming(call: Record<string, unknown>): Record<string, number> {
	const timing = asObject(call.timing);
	const stamps = toolTimingStamps({ ...timing, createdAt: call.createdAt ?? timing.createdAt });
	const durationMs = readFiniteNumber(timing.durationMs) ?? readFiniteNumber(call.durationMs);
	return durationMs != null ? { ...stamps, durationMs } : stamps;
}

/**
 * Header timing fields (duration / start / timeout / lifecycle stamps). All
 * HEIGHT-NEUTRAL: the duration and timeout are painted inside the card's single
 * fixed header row, and the lifecycle stamps only feed the portaled timing
 * popover. Mirrors the chunked header's resolveToolFinalDurationMs /
 * getBashExecDurationMs / effectiveTimeoutMs.
 */
function toolTimingFields(
	tc: AdapterToolItem["tc"],
	category: string,
	metadata: unknown,
): Record<string, number | undefined> {
	const meta = asObject(metadata);
	const durationMs = readFiniteNumber(tc.durationMs) ?? deriveDuration(tc);
	const execDurationMs = readFiniteNumber(meta.execDurationMs);
	const stamps = toolTimingStamps(tc);
	// `startedAt` keeps its historical precedence (explicit → execution → created)
	// so the live elapsed counter is unaffected by the new stamp passthrough.
	const startedAt = stamps.startedAt ?? stamps.executionStartedAt ?? stamps.createdAt;
	const timeoutMs = effectiveTimeoutMs(tc, category);
	const out: Record<string, number | undefined> = { ...stamps };
	if (durationMs != null) out.durationMs = durationMs;
	if (execDurationMs != null) out.execDurationMs = execDurationMs;
	if (startedAt != null) out.startedAt = startedAt;
	if (timeoutMs != null) out.timeoutMs = timeoutMs;
	return out;
}

/** Duration from the start/complete stamps when no explicit `durationMs` exists. */
function deriveDuration(tc: AdapterToolItem["tc"]): number | undefined {
	const start = parseEpochMs(tc.startedAt) ?? parseEpochMs(tc.executionStartedAt);
	const end = parseEpochMs(tc.completedAt);
	return start != null && end != null ? Math.max(0, end - start) : undefined;
}

/** A finite number, else undefined. */
function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from a number or an ISO string, else undefined. */
function parseEpochMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Resolve the reflection notice a tool card should show, mirroring the chunked
 * precedence (ToolCallCard.tsx:5419):
 *
 *   1. a reflection that is NOT awaiting_user → the notice
 *   2. otherwise (awaiting_user / none)       → the permission form path
 *
 * The gate's state ships with the message tree (`enrichToolUseBlocks` copies
 * `permissionSuggestions` onto every tool_use block), so this is a pure read —
 * the notice's height is therefore known at LAYOUT time and never corrected
 * after paint.
 */
function resolveToolReflection(
	item: AdapterToolItem,
	ctx: AdapterContext,
	hasPendingPermission: boolean,
): ReflectionNoticeData | null {
	const suggestions = item.tc.permissionSuggestions;
	const live = ctx.resolvePendingPermissionSuggestions?.(item.tc.toolUseId);
	const parsed = getPermissionReflectionSuggestion({
		suggestions: Array.isArray(live) ? live : null,
		permissionSuggestions: Array.isArray(suggestions) ? suggestions : null,
	});
	const reflection = normalizeReflectionAfterToolStatus(
		parsed,
		item.tc.status ?? undefined,
		hasPendingPermission,
	);
	// `awaiting_user` deliberately falls through: the gate handed the decision back
	// to the user, so the approve/deny form is the correct UI.
	if (!reflection || reflection.status === "awaiting_user") return null;
	const titleKey = `${reflectionTitleKeyPrefix(reflection.kind)}Reflection${reflectionTitleKeySuffix(
		reflection.status,
	)}`;
	const data = buildReflectionNoticeData(
		reflection,
		sysLabel(ctx, titleKey),
		readNonEmptyString(item.tc, "permissionDecisionReason") ??
			readNonEmptyString(item.tc, "errorMessage"),
		// Takeover target: the gate's own requestId wins; otherwise the tool-call row
		// id, exactly like the chunked notice's fallback chain.
		readNonEmptyString(item.tc, "tcId") ?? readNonEmptyString(item.tc, "id"),
	);
	// The advisory line is a template with a {nextSteps} placeholder.
	if (data.nextSteps) {
		data.nextSteps = sysLabel(ctx, "reflectionNextSteps").replace("{nextSteps}", data.nextSteps);
	}
	return data;
}

/**
 * `truncatedLeafCount` / `truncatedTotalBytes` for a tool call's payloads, or `{}`
 * when nothing is truncated (so the fields stay absent for the common case).
 */
function truncatedPayloadFields(
	inputJson: unknown,
	outputJson: unknown,
): { truncatedLeafCount?: number; truncatedTotalBytes?: number } {
	const leaves = [...collectTruncatedLeaves(inputJson), ...collectTruncatedLeaves(outputJson)];
	if (leaves.length === 0) return {};
	let totalBytes = 0;
	for (const leaf of leaves) totalBytes += leaf.fullLength;
	return { truncatedLeafCount: leaves.length, truncatedTotalBytes: totalBytes };
}

/**
 * Full (un-truncated) tool input once the shell has fetched it.
 *
 * The gate is `hasTruncatedLeaf`, NOT a root-level `isTruncated`: truncation is
 * field-level, so an object payload's root is a plain object and a root probe
 * would report "complete". That silently disabled the whole feature — the shell
 * fetched the full payload and it was never substituted, so "load full content"
 * appeared to do nothing.
 *
 * The substitution is a WHOLE-PAYLOAD replacement: `getToolCallDetail` returns the
 * un-projected row straight from the database, i.e. the authoritative version of
 * the entire tree, so merging leaf-by-leaf would only add a reconciliation step
 * with nothing to gain. The `??` keeps the projected payload when no fetch landed.
 */
function withFullInput(item: AdapterToolItem, ctx: AdapterContext): unknown {
	if (!ctx.resolveFullToolInput || !hasTruncatedLeaf(item.tc.inputJson)) return item.tc.inputJson;
	return ctx.resolveFullToolInput(item.tc.toolUseId) ?? item.tc.inputJson;
}

/** Full (un-truncated) tool output once the shell has fetched it. */
function withFullOutput(item: AdapterToolItem, ctx: AdapterContext): unknown {
	if (!ctx.resolveFullToolOutput || !hasTruncatedLeaf(item.tc.outputJson))
		return item.tc.outputJson;
	return ctx.resolveFullToolOutput(item.tc.toolUseId) ?? item.tc.outputJson;
}

/**
 * Tool input for detail classification, with a pending permission's plan body
 * substituted when the streamed input has none (see ctx.resolvePendingPlan).
 * Returns the original reference whenever no substitution applies, so the common
 * path allocates nothing.
 */
function applyPendingPlanFallback(
	input: unknown,
	item: AdapterToolItem,
	ctx: AdapterContext,
): unknown {
	if (!ctx.resolvePendingPlan) return input;
	// A payload that IS a truncated leaf (a bare-string input) has no fields to
	// merge into — spreading a wrapper would produce `{_truncated, preview, plan}`.
	// An OBJECT payload with truncated leaves is still a normal object here.
	if (isTruncated(input)) return input;
	// `readLeafText` so a truncated `plan` still counts as present: the streamed
	// prefix is the plan, and overwriting it with the pending copy would swap real
	// content for a fallback.
	const existing = readLeafText(asObject(input).plan);
	if (existing !== undefined && existing.trim().length > 0) return input;
	const pendingPlan = ctx.resolvePendingPlan(item.tc.toolUseId);
	if (!pendingPlan?.trim()) return input;
	return { ...asObject(input), plan: pendingPlan };
}

/**
 * Selection / menu identity for a folded TOOL row. Streaming output has no
 * committed message, so it stays non-selectable (undefined).
 */
function toolRowIdentity(item: AdapterToolItem): AdapterTraceRowIdentity | undefined {
	const messageId = item.msg?.id;
	if (!messageId || messageId === "__streaming__") return undefined;
	if (!item.tc.toolUseId) return undefined;
	return {
		messageId,
		blockIndex: item.blockIndex,
		blockIndices: [item.blockIndex],
		toolUseId: item.tc.toolUseId,
		toolName: item.tc.toolName,
	};
}

function toolTraceItem(item: AdapterToolItem, ctx: AdapterContext) {
	const summary = toolSummary(item.tc, ctx);
	const name = item.tc.toolName === "Task" ? "Agent" : item.tc.toolName;
	const rawTitle = ctx.resolveToolTitle?.(item.tc) ?? (summary ? `${name} · ${summary}` : name);
	return {
		title: truncateTitle(rawTitle),
		hasIcon: true,
		iconColor: ctx.resolveToolColor?.(item.tc.toolName, item.tc.inputJson),
		toolName: item.tc.toolName,
		category: ctx.resolveToolCategory?.(item.tc.toolName, item.tc.inputJson),
		key: toolItemKey(item),
		summary,
		status: item.tc.status ?? null,
		identity: toolRowIdentity(item),
	};
}

function foldedToolItems(items: AdapterToolItem[], ctx: AdapterContext): unknown[] {
	return items.map((item) => toolTraceItem(item, ctx));
}

/**
 * Adapt a tool-run to element specs, LOD-aware (mirrors ToolRunLodGate):
 *   - L≥4: every item renders as a full card (per-card LOD handled by measure).
 *   - L3 : completed batches fold into `tool-run-summary`; active stay standalone.
 *   - L≤2: completed batches fold into `tool-run-count`; active stay standalone.
 * (The cross-segment reasoning+tool→activity fold is applied earlier by the
 * caller's groupRenderUnits, producing an "activity" unit — see adaptActivityUnit.)
 */
function adaptToolRun(items: AdapterToolItem[], ctx: AdapterContext): ElementSpec[] {
	const isMultiRun = items.length >= 2;
	const isSoleSubagent = items.filter((item) => item.isSubagent).length === 1;
	if (ctx.lod >= 4) {
		return items.map((item, index) =>
			adaptToolItemFull(item, ctx, {
				inRun: isMultiRun,
				isLast: index === items.length - 1,
				isSoleSubagent,
			}),
		);
	}
	const groups = groupToolItemsForLod(items);
	const specs: ElementSpec[] = [];
	for (const group of groups) {
		if (group.kind === "active") {
			specs.push(
				adaptToolItemFull(group.item, ctx, {
					inRun: false,
					isLast: true,
					isSoleSubagent,
				}),
			);
			continue;
		}
		const first = group.items[0];
		if (!first) continue;
		const traceKey = toolItemKey(first);
		if (ctx.lod === 3) {
			specs.push({
				kind: "tool-run-summary",
				key: `toolrun-summary-${traceKey}`,
				data: {
					items: foldedToolItems(group.items, ctx),
					headerLabel: sysLabel(ctx, "toolCalls"),
					headerCount: countLabel(ctx, "toolCallsCount", group.items.length),
				},
				opts: {
					showEarlier: ctx.showEarlier?.(`toolrun-summary-${traceKey}`) ?? false,
					expandedIndices: ctx.expandedRows?.(`toolrun-summary-${traceKey}`) ?? [],
				},
			});
		} else {
			specs.push({
				kind: "tool-run-count",
				key: `toolrun-count-${traceKey}`,
				data: {
					count: group.items.length,
					headerLabel: sysLabel(ctx, "toolCalls"),
					headerCount: countLabel(ctx, "toolCallsCount", group.items.length),
				},
			});
		}
	}
	return specs;
}

/**
 * ⚠️ Selection / menu identity for a folded REASONING row, mapped to its
 * reasoning RUN's start index.
 *
 * The activity fold pushes reasoning blocks ONE BY ONE, but the selection index
 * merges adjacent reasoning blocks with `groupReasoningRuns` and registers an
 * entry only for the run's START index (absorbed indices are skipped entirely).
 * Identifying a row by its own blockIndex would therefore mint a blockId that
 * matches no entry, and every selection action on that row would silently do
 * nothing. So resolve the owning run and use its start.
 *
 * Streaming output has no committed message → non-selectable (undefined).
 */
function reasoningRowIdentity(
	item: Extract<AdapterActivityInput, { kind: "reasoning" }>,
): AdapterTraceRowIdentity | undefined {
	const messageId = item.msg?.id;
	if (!messageId || messageId === "__streaming__") return undefined;
	const blockIndex = item.blockIndex ?? 0;
	const blocks = item.msg?.contentJson;
	if (Array.isArray(blocks) && blocks.length > 0) {
		// AdapterContentBlock allows null on text/thinking, so it is not structurally
		// assignable to ContentBlockLike; grouping only reads `type`, which matches.
		const { runs } = groupReasoningRuns(blocks as unknown as ContentBlockLike[]);
		for (const run of runs) {
			if (run.indices.includes(blockIndex)) {
				return {
					messageId,
					blockIndex: run.startIndex,
					blockIndices: run.indices,
				};
			}
		}
	}
	return { messageId, blockIndex, blockIndices: [blockIndex] };
}

function adaptActivityItems(
	items: AdapterActivityInput[],
	ctx: AdapterContext,
): {
	traceItems: AdapterTraceItem[];
	reasoningCount: number;
	toolCount: number;
} {
	let reasoningCount = 0;
	let toolCount = 0;
	const traceItems: AdapterTraceItem[] = [];
	for (const item of items) {
		if (item.kind === "reasoning") {
			const block = item.block;
			const text = block?.thinking ?? block?.text ?? "";
			const parsed = (ctx.resolveReasoningSegments ?? parseReasoningSegments)(text);
			const rows =
				parsed.length > 0
					? parsed
					: [{ title: null, body: text, isEmpty: text.trim().length === 0 }];
			reasoningCount += rows.length;
			const identity = reasoningRowIdentity(item);
			traceItems.push(
				...rows.map(
					(row, index): AdapterTraceItem => ({
						title: reasoningStepTitle(row),
						hasIcon: true,
						iconColor: "grape",
						key: `r-${item.msg?.id ?? "msg"}-${item.blockIndex ?? 0}-step-${index}`,
						shimmer: item.msg?.id === "__streaming__" && index === rows.length - 1,
						identity,
					}),
				),
			);
			continue;
		}
		toolCount++;
		if (!item.tc || typeof item.tc !== "object") {
			traceItems.push({
				title: sysLabel(ctx, "toolGeneric"),
				hasIcon: true,
				iconColor: "gray",
				key: `tool-${toolCount}`,
			});
			continue;
		}
		traceItems.push(
			toolTraceItem(
				{
					...item,
					msg: item.msg,
					blockIndex: item.blockIndex ?? 0,
					isSubagent: false,
					tc: item.tc,
				},
				ctx,
			),
		);
	}
	return { traceItems, reasoningCount, toolCount };
}

/** Adapt a cross-segment activity unit. The input is typed so source order and
 * message ownership survive the fold, including L5 recency and stable toggles. */
export function adaptActivityUnit(
	items: AdapterActivityInput[],
	key: string,
	ctx: AdapterContext,
): ElementSpec {
	const activity = adaptActivityItems(items, ctx);
	return {
		kind: "activity-trace",
		key,
		data: {
			items: activity.traceItems,
			headerLabel: sysLabel(ctx, "activityTraceLabel"),
			headerCount: sysLabel(ctx, "activityTraceCount")
				.replace(/\{reasoning\}/g, String(activity.reasoningCount))
				.replace(/\{tools\}/g, String(activity.toolCount)),
		},
		opts: {
			collapsed: ctx.lod === 1,
			itemsOpened: ctx.isExpanded?.(key) ?? false,
			showEarlier: ctx.showEarlier?.(key) ?? false,
			expandedIndices: ctx.expandedRows?.(key) ?? [],
		},
	};
}

/** Flag the first spec of a unit as a top-level boundary (mutates in place). */
function markUnitStart(specs: ElementSpec[], unitFirstIndex: number): void {
	const first = specs[unitFirstIndex];
	if (first) first.unitStart = true;
}

/** Adapt a whole render-unit list to a flat element-spec list. */
export function adaptRenderUnits(
	units: readonly AdapterRenderUnit[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const unit of units) {
		const unitFirstIndex = out.length;
		if (unit.kind === "activity") out.push(adaptActivityUnit(unit.items, unit.key, ctx));
		else out.push(...adaptSegment(unit.seg, ctx));
		markUnitStart(out, unitFirstIndex);
	}
	return out;
}

/** Adapt a plain segment list (used by unit tests and compatibility callers). */
export function adaptSegments(
	segments: readonly AdapterSegment[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const seg of segments) {
		const unitFirstIndex = out.length;
		out.push(...adaptSegment(seg, ctx));
		markUnitStart(out, unitFirstIndex);
	}
	return out;
}
