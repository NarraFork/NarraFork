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

import type { VListElementKind } from "./element-kinds";
import type { RenderLod } from "./prepared-block";
import {
	hasStructuredReasoning,
	parseReasoningSegments,
	type ReasoningSegment,
} from "./reasoning-segments";
import { classifyToolDetail } from "./tool-detail";

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
	[key: string]: unknown;
}

export interface AdapterMessage {
	id?: string;
	role: string;
	contentJson: AdapterContentBlock[];
	createdAt?: string;
	creator?: { username: string } | null;
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
		_subagentActivity?: { latestToolCalls?: unknown[]; model?: string | null } | null;
		[key: string]: unknown;
	};
}

/** Terminal tool statuses (subagent card gates its result preview on this). */
const TERMINAL_TOOL_STATUSES = new Set(["success", "fail", "cancelled", "error", "completed"]);

function isTerminalStatus(status?: string | null): boolean {
	return status != null && TERMINAL_TOOL_STATUSES.has(status);
}

/** Derive a short display summary from a tool call's inputJson (a lightweight
 * stand-in for tool-display's per-tool formatting; the measure/render layer can
 * refine it). Picks the most descriptive common field. */
function toolSummary(tc: AdapterToolItem["tc"]): string {
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
}

export interface AdapterContext {
	lod: RenderLod;
	/** Explicit interaction override; undefined preserves the measure's default. */
	isExpanded?: (key: string) => boolean | undefined;
	/** L4 / old-L5 explicit click override, separate from normal opened state. */
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
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
const SYSTEM_OTHER_TYPES = new Set(["knowledge_hint", "ask_in_passing"]);

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

function reasoningStepsData(segments: ReasoningSegment[], isStreaming: boolean) {
	return {
		steps: segments.map((segment, index) => ({
			title: reasoningStepTitle(segment),
			body: segment.isEmpty ? null : segment.body,
			shimmer: isStreaming && index === segments.length - 1,
			key: `seg${index}`,
		})),
		headerLabel: "Reasoning",
		headerCount: `${segments.length} steps`,
	};
}

function webSearchData(block: AdapterContentBlock) {
	return {
		query: block.query ?? null,
		queries: block.queries ?? null,
		status: block.status ?? null,
	};
}

function mediaData(block: AdapterContentBlock) {
	// measureMedia dispatches on `type`.
	return {
		type: block.type,
		imageId: block.imageId ?? null,
		previewUrl: block.previewUrl ?? null,
		filename: block.filename ?? null,
		mediaType: block.mediaType ?? null,
		status: block.status ?? null,
		revisedPrompt: block.revisedPrompt ?? null,
		result: block.result ?? null,
		width: block.width ?? null,
		height: block.height ?? null,
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

	// user messages: a single bubble with plain pre-wrap text (not markdown).
	if (msg.role === "user") {
		const text = indices
			.map((i) => blocks[i])
			.filter((b): b is AdapterContentBlock => !!b && b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
		return [
			{
				kind: "message-bubble",
				key: `${idBase}-bubble`,
				data: { role: "user", text, hasHeader: true },
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
			const displayText = data.translatedText ?? data.text;
			const parsed = parseReasoning(displayText);
			const structured = !data.isStreaming && hasStructuredReasoning(parsed);
			if (structured || (data.isStreaming && hasStructuredReasoning(parsed))) {
				specs.push({
					kind: "reasoning-steps",
					key,
					data: reasoningStepsData(parsed, streaming),
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
					opts: { expanded: ctx.isExpanded?.(key) },
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
				specs.push({ kind, key, data: mediaData(block) });
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
};

/** Resolve a system-card chrome label (injected i18n → English fallback). */
function sysLabel(ctx: AdapterContext, key: string): string {
	return ctx.labels?.[key] ?? SYSTEM_LABEL_FALLBACKS[key] ?? key;
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
		return {
			kind: "system-simple",
			key: `${idBase}-sys`,
			data: {
				kind: "segment_compact",
				text: block.text ?? block.summary ?? "",
				status: block.status === "compacting" ? "compacting" : "compacted",
			},
		};
	}

	if (SYSTEM_SIMPLE_SUBTYPES.has(blockType)) {
		return {
			kind: "system-simple",
			key: `${idBase}-sys`,
			data: adaptSystemSimpleData(blockType, block, contentText, ctx),
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
		case "compact":
			return {
				kind: "compact",
				text: block.text ?? block.summary ?? "",
				status: block.status === "compacting" ? "compacting" : "compacted",
			};
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
	const opts = {
		isRecent: isRecentToolItem(item, ctx),
		...(defaultOpened === undefined ? {} : { opened: defaultOpened }),
		lodUserOverride,
		viewportHeight: ctx.viewportHeight,
		inRun: runContext.inRun,
		isLast: runContext.isLast,
		collapsesByLod:
			!isActiveToolItem(item) && (ctx.lod === 4 || (ctx.lod === 5 && !isRecentToolItem(item, ctx))),
	};
	if (item.isSubagent) {
		// Map height-relevant SubagentCardData fields (NOT `status` — that field
		// doesn't exist on SubagentCardData; it uses isTerminal + recentCallCount).
		const activity = item.tc._subagentActivity;
		const recentCalls = activity?.latestToolCalls ?? [];
		const recentCallNames = recentCalls
			.map((call) =>
				call &&
				typeof call === "object" &&
				typeof (call as { toolName?: unknown }).toolName === "string"
					? (call as { toolName: string }).toolName
					: "",
			)
			.filter(Boolean)
			.slice(0, 3);
		const resultText = typeof item.tc.outputJson === "string" ? item.tc.outputJson : undefined;
		const isActive = !isTerminalStatus(item.tc.status);
		// ── Fields carried by the persisted tool call (mirrors SubagentCard.tsx
		// derivations). prompt/isBackground/agentType live on inputJson; Send tools
		// carry the prompt on `message` and imply agentType "send".
		const input = asObject(item.tc.inputJson);
		const isSend = item.tc.toolName === "Send";
		const prompt =
			readNonEmptyString(input, "prompt") ??
			(isSend ? readNonEmptyString(input, "message") : undefined);
		const isBackground = input.background === true || input.run_in_background === true;
		const agentType =
			readNonEmptyString(input, "subagent_type") ?? (isSend ? "send" : item.tc.toolName);
		// Description mirrors chunk's `input.description ?? (prompt-derived)`; falls
		// back to the generic tool summary when neither is present.
		const description =
			readNonEmptyString(input, "description") ??
			(prompt ? (prompt.includes("\n") ? prompt.slice(0, 80) : prompt) : toolSummary(item.tc));
		return {
			kind: "subagent-card",
			key,
			data: {
				agentType,
				description,
				model: activity?.model ?? undefined,
				...(prompt === undefined ? {} : { prompt }),
				isBackground,
				recentCallCount: recentCallNames.length,
				recentCallNames,
				isTerminal: isTerminalStatus(item.tc.status),
				isActive,
				// Raw terminal status → render-only status glyph (success/fail/cancelled).
				// Height-neutral (a single 12px header slot).
				status: item.tc.status ?? undefined,
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
	return {
		kind: "tool-call",
		key,
		data: {
			toolName: item.tc.toolName,
			summary: toolSummary(item.tc),
			status: item.tc.status ?? "success",
			isStreaming: isStreamingToolItem(item),
			inRun: runContext.inRun,
			isLast: runContext.isLast,
			category,
			// Expanded detail region height model (line counts / body lines / px).
			// null when the tool call has no meaningful detail body.
			detail: classifyToolDetail({
				toolName: item.tc.toolName,
				category,
				status: item.tc.status,
				inputJson: item.tc.inputJson,
				outputJson: item.tc.outputJson,
				metadata:
					(item.tc.outputJson as { _metadata?: unknown } | null | undefined)?._metadata ??
					(item.tc as { _metadata?: unknown })._metadata,
			}),
		},
		opts,
	};
}

function toolTraceItem(item: AdapterToolItem, ctx: AdapterContext) {
	const summary = toolSummary(item.tc);
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
					headerLabel: "Tool calls",
					headerCount: `${group.items.length}`,
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
				data: { count: group.items.length },
			});
		}
	}
	return specs;
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
			traceItems.push(
				...rows.map(
					(row, index): AdapterTraceItem => ({
						title: reasoningStepTitle(row),
						hasIcon: true,
						iconColor: "grape",
						key: `r-${item.msg?.id ?? "msg"}-${item.blockIndex ?? 0}-step-${index}`,
						shimmer: item.msg?.id === "__streaming__" && index === rows.length - 1,
					}),
				),
			);
			continue;
		}
		toolCount++;
		if (!item.tc || typeof item.tc !== "object") {
			traceItems.push({
				title: "Tool",
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
			headerLabel: "Activity",
			headerCount: `${activity.reasoningCount} reasoning · ${activity.toolCount} tools`,
		},
		opts: {
			collapsed: ctx.lod === 1,
			itemsOpened: ctx.isExpanded?.(key) ?? false,
			showEarlier: ctx.showEarlier?.(key) ?? false,
			expandedIndices: ctx.expandedRows?.(key) ?? [],
		},
	};
}

/** Adapt a whole render-unit list to a flat element-spec list. */
export function adaptRenderUnits(
	units: readonly AdapterRenderUnit[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const unit of units) {
		if (unit.kind === "activity") out.push(adaptActivityUnit(unit.items, unit.key, ctx));
		else out.push(...adaptSegment(unit.seg, ctx));
	}
	return out;
}

/** Adapt a plain segment list (used by unit tests and compatibility callers). */
export function adaptSegments(
	segments: readonly AdapterSegment[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const seg of segments) out.push(...adaptSegment(seg, ctx));
	return out;
}
