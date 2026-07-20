/**
 * message-segments.ts — Pre-processing layer that converts a flat message list
 * into a sequence of RenderSegments.  The renderer simply iterates segments
 * without any grouping / splitting logic of its own.
 */

import { isEmptyReasoningBlock } from "@shared/reasoning-content";
import type { SideCarRecord } from "../../lib/api";
import type { ContentBlock, NarratorMsg, ToolCallRow } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// Legacy tool name mapping
// ---------------------------------------------------------------------------

const LEGACY_TOOL_NAMES: Record<string, string> = {
	Task: "Agent",
	CheckBackgroundTask: "TaskOutput",
	CancelBackgroundTask: "Agent",
	TaskStop: "Agent",
};

function normalizeToolName(name: string): string {
	return LEGACY_TOOL_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single item inside a tool-run segment. */
export type ToolRunItem = {
	kind: "tool";
	msg: NarratorMsg;
	blockIndex: number;
	tc: ToolCallData;
	children: NarratorMsg[];
	isSubagent: boolean;
};

/** A render segment — the minimal unit the renderer works with. */
export type RenderSegment =
	| {
			kind: "message";
			msg: NarratorMsg;
			visibleBlockIndices?: number[];
	  }
	| {
			kind: "tool-run";
			items: ToolRunItem[];
			sourceMessages: NarratorMsg[];
	  }
	| {
			kind: "prune-divider";
			label?: string;
	  };

// ---------------------------------------------------------------------------
// Block classification helpers (pure, no side effects)
// ---------------------------------------------------------------------------

function isVisibleContentBlock(b: ContentBlock): boolean {
	if (b.type === "text") return !!b.text?.trim();
	if (b.type === "image") return true;
	if (b.type === "text_file") return true;
	if (b.type === "web_search") return true;
	if (b.type === "image_generation") return true;
	if (b.type === "reasoning" || b.type === "thinking") return !isEmptyReasoningBlock(b);
	return false;
}

export function hasToolUse(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "tool_use");
}

/**
 * True when the message has at least one visible *content* block (text, image,
 * reasoning, etc.) and therefore yields a separate content/message segment that
 * `MessageBubble` renders. Used by the tool-run renderer to decide whether a
 * source message's `user_message` side-cars are already rendered elsewhere
 * (via MessageBubble) or need to be surfaced inside the tool-run itself
 * (pure-tool messages never reach MessageBubble).
 */
export function messageHasVisibleContentBlock(msg: NarratorMsg): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => isVisibleContentBlock(b));
}

/** True when every visible block is either tool_use or blank text. */
export function isToolOnlyMessage(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		blocks.length > 0 &&
		blocks.every(
			(b: ContentBlock) =>
				b.type === "tool_use" ||
				b.type === "reasoning" ||
				b.type === "thinking" ||
				b.type === "redacted_thinking" ||
				(b.type === "text" && !b.text?.trim()),
		)
	);
}

// ---------------------------------------------------------------------------
// Tool call resolution (from contentJson blocks → ToolCallData)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseToolTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || !value) return undefined;
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function nativeWebSearchInput(block: ContentBlock): Record<string, unknown> {
	const action = asRecord(block.action);
	const query = typeof block.query === "string" ? block.query : action?.query;
	const queries = Array.isArray(block.queries) ? block.queries : action?.queries;
	const url = typeof action?.url === "string" ? action.url : undefined;
	const pattern = typeof action?.pattern === "string" ? action.pattern : undefined;
	const actionType = typeof action?.type === "string" ? action.type : "search";
	const summary =
		(typeof query === "string" && query) ||
		(Array.isArray(queries) && queries.length > 0 ? queries.map(String).join(", ") : "") ||
		(actionType === "find_in_page"
			? [pattern ? `'${pattern}'` : null, url].filter(Boolean).join(" in ")
			: url) ||
		"Web search";

	return {
		query: summary,
		...(typeof query === "string" && query ? { originalQuery: query } : {}),
		...(Array.isArray(queries) && queries.length > 0 ? { queries } : {}),
		...(actionType ? { action: actionType } : {}),
		...(url ? { url } : {}),
		...(pattern ? { pattern } : {}),
	};
}

function nativeWebSearchStatus(block: ContentBlock): string {
	const status = typeof block.status === "string" ? block.status : "completed";
	return status === "completed" ? "completed" : "running";
}

function nativeWebSearchToolCall(block: ContentBlock): ToolCallData | null {
	if (typeof block.id !== "string" || !block.id) return null;
	return {
		id: `native:${block.id}`,
		toolName: "WebSearch",
		toolUseId: block.id,
		inputJson: nativeWebSearchInput(block),
		status: nativeWebSearchStatus(block),
		_metadata: {
			native: true,
			nativeStatus: typeof block.status === "string" ? block.status : "completed",
		},
	};
}

export function resolveAllToolCallsFromMsg(
	msg: NarratorMsg,
	opts: Pick<SegmentOptions, "nativeWebSearchAsTool"> = {},
): ToolCallData[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const results: ToolCallData[] = [];
	for (const block of blocks) {
		if (opts.nativeWebSearchAsTool && block.type === "web_search") {
			const tc = nativeWebSearchToolCall(block);
			if (tc) results.push(tc);
			continue;
		}
		if (block.type !== "tool_use") continue;
		const isEnriched = block.status !== undefined;
		const matchingTc = msg.toolCalls?.find((t: ToolCallRow) => t.toolUseId === (block.id ?? ""));
		const tc = isEnriched ? null : matchingTc;
		const status = block.status ?? tc?.status ?? "running";
		const createdAt = block.tcCreatedAt ?? matchingTc?.createdAt;
		const persistedStartedAt = (matchingTc as (ToolCallRow & { startedAt?: unknown }) | undefined)
			?.startedAt;
		let startedAt = parseToolTimestamp(block.startedAt) ?? parseToolTimestamp(persistedStartedAt);
		if (
			startedAt === undefined &&
			(status === "running" || status === "pending" || status === "initializing")
		) {
			startedAt =
				parseToolTimestamp(block.streamStartedAt ?? matchingTc?.streamStartedAt) ??
				parseToolTimestamp(createdAt) ??
				parseToolTimestamp(block.permissionStartedAt ?? matchingTc?.permissionStartedAt) ??
				parseToolTimestamp(block.executionStartedAt ?? matchingTc?.executionStartedAt) ??
				parseToolTimestamp(block.permissionDecidedAt ?? matchingTc?.permissionDecidedAt);
		}
		results.push({
			id: block.tcId ?? tc?.id,
			toolName: normalizeToolName(block.name ?? ""),
			toolUseId: block.id,
			inputJson: block.inputJson ?? tc?.inputJson ?? block.input,
			outputJson: block.outputJson ?? tc?.outputJson,
			status,
			durationMs: block.durationMs ?? tc?.durationMs,
			streamStartedAt: block.streamStartedAt ?? matchingTc?.streamStartedAt,
			permissionStartedAt: block.permissionStartedAt ?? matchingTc?.permissionStartedAt,
			executionStartedAt: block.executionStartedAt ?? matchingTc?.executionStartedAt,
			completedAt: block.completedAt ?? matchingTc?.completedAt,
			createdAt,
			errorMessage: block.errorMessage ?? tc?.errorMessage,
			permissionDenyMessage: block.permissionDenyMessage ?? tc?.permissionDenyMessage,
			permissionDecisionReason: block.permissionDecisionReason ?? tc?.permissionDecisionReason,
			permissionDecidedBy: block.permissionDecidedBy ?? tc?.permissionDecidedBy,
			permissionSuggestions: block.permissionSuggestions ?? tc?.permissionSuggestions,
			startedAt,
			resultMessageId:
				(block.resultMessageId as string) ?? (tc?.resultMessageId as string) ?? undefined,
			// Sidecar system injections attached to this tool result. The backend
			// enriches the tool_use block with sideCars (see enrichToolUseBlocks),
			// and the live WS path (mergeFieldsByIndex) writes sideCars onto both
			// the block and the toolCalls row, so read block first then fall back.
			sideCars: Array.isArray(block.sideCars) ? (block.sideCars as SideCarRecord[]) : tc?.sideCars,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_metadata: block._metadata ?? (tc as any)?._metadata,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_longRunning: block._longRunning ?? (tc as any)?._longRunning,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_streamingOutput: block._streamingOutput ?? (tc as any)?._streamingOutput,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_timeoutMs: block._timeoutMs ?? (tc as any)?._timeoutMs,
			_subagentActivity: block._subagentActivity,
		});
	}
	return results;
}

export function filterChildrenByToolUse(
	children: NarratorMsg[],
	toolUseId: string | undefined,
): NarratorMsg[] {
	if (!toolUseId) return [];
	return children.filter((c) => c.parentToolUseId === toolUseId);
}

// ---------------------------------------------------------------------------
// segmentMessages — the core pre-processing function
// ---------------------------------------------------------------------------

export interface SegmentOptions {
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	streamingMsg?: NarratorMsg | null;
	/** Pixi-only: render provider-native web_search blocks as tool-run items. */
	nativeWebSearchAsTool?: boolean;
}

type VisualLane = "content" | "tool";

function classifyBlock(b: ContentBlock, opts: SegmentOptions): VisualLane | null {
	if (b.type === "tool_use") return "tool";
	if (opts.nativeWebSearchAsTool && b.type === "web_search" && typeof b.id === "string") {
		return "tool";
	}
	if (isVisibleContentBlock(b)) return "content";
	return null;
}

export function segmentMessages(
	messages: NarratorMsg[],
	opts: SegmentOptions = {},
): RenderSegment[] {
	const { pruneBoundaryMessageId, pruneDividerLabel, streamingMsg } = opts;

	const effectiveMessages = streamingMsg != null ? [...messages, streamingMsg] : messages;

	type Atom =
		| { lane: "content"; msg: NarratorMsg; blockIndex: number }
		| { lane: "content-whole"; msg: NarratorMsg }
		| { lane: "tool"; msg: NarratorMsg; blockIndex: number };

	const atoms: Atom[] = [];
	const pruneBoundaryAtomIndices: number[] = [];

	for (const msg of effectiveMessages) {
		const atomStartIdx = atoms.length;

		if (msg.role !== "assistant") {
			atoms.push({ lane: "content-whole", msg });
		} else {
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];

			for (let bi = 0; bi < blocks.length; bi++) {
				const lane = classifyBlock(blocks[bi], opts);
				if (lane === "content") atoms.push({ lane: "content", msg, blockIndex: bi });
				else if (lane === "tool") atoms.push({ lane: "tool", msg, blockIndex: bi });
			}

			if (atoms.length === atomStartIdx && blocks.length > 0) {
				atoms.push({ lane: "content-whole", msg });
			}
		}

		if (pruneBoundaryMessageId && msg.id === pruneBoundaryMessageId) {
			pruneBoundaryAtomIndices.push(atoms.length - 1);
		}
	}

	const segments: RenderSegment[] = [];
	const pruneBoundaryAtomSet = new Set(pruneBoundaryAtomIndices);

	const maybeInsertPruneDivider = (atomIdx: number) => {
		if (pruneBoundaryAtomSet.has(atomIdx)) {
			segments.push({ kind: "prune-divider", label: pruneDividerLabel });
		}
	};

	let ai = 0;
	while (ai < atoms.length) {
		const atom = atoms[ai];

		if (atom.lane === "content-whole") {
			segments.push({ kind: "message", msg: atom.msg });
			maybeInsertPruneDivider(ai);
			ai++;
			continue;
		}

		if (atom.lane === "content") {
			const msg = atom.msg;
			const indices: number[] = [atom.blockIndex];
			let aj = ai + 1;
			while (aj < atoms.length) {
				const next = atoms[aj];
				if (next.lane === "content" && next.msg === msg) {
					indices.push(next.blockIndex);
					aj++;
				} else {
					break;
				}
			}
			segments.push({ kind: "message", msg, visibleBlockIndices: indices });
			for (let k = ai; k < aj; k++) maybeInsertPruneDivider(k);
			ai = aj;
			continue;
		}

		// tool → start a tool-run
		const items: ToolRunItem[] = [];
		const sourceMessagesSet = new Set<NarratorMsg>();
		const allTcsCache = new Map<NarratorMsg, ToolCallData[]>();

		const getTcs = (msg: NarratorMsg) => {
			let tcs = allTcsCache.get(msg);
			if (!tcs) {
				tcs = resolveAllToolCallsFromMsg(msg, opts);
				allTcsCache.set(msg, tcs);
			}
			return tcs;
		};

		const runStartAtom = ai;
		while (ai < atoms.length) {
			const cur = atoms[ai];
			if (cur.lane === "tool") {
				const tcs = getTcs(cur.msg);
				const block = (Array.isArray(cur.msg.contentJson) ? cur.msg.contentJson : [])[
					cur.blockIndex
				];
				const tc = block ? tcs.find((t) => t.toolUseId === block.id) : undefined;
				if (tc) {
					const children = filterChildrenByToolUse(cur.msg.children ?? [], tc.toolUseId);
					const isSubagent =
						tc.toolName === "Agent" ||
						tc.toolName === "Task" ||
						tc.toolName === "Send" ||
						!!tc._subagentActivity ||
						children.length > 0;
					items.push({
						kind: "tool",
						msg: cur.msg,
						blockIndex: cur.blockIndex,
						tc,
						children,
						isSubagent,
					});
					sourceMessagesSet.add(cur.msg);
				}
				ai++;
			} else {
				break;
			}
		}

		if (items.length > 0) {
			segments.push({
				kind: "tool-run",
				items,
				sourceMessages: [...sourceMessagesSet],
			});
		}
		for (let k = runStartAtom; k < ai; k++) maybeInsertPruneDivider(k);
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Target ID collection (for virtualization / scroll-to)
// ---------------------------------------------------------------------------

export function collectSegmentTargetIds(seg: RenderSegment): string[] {
	if (seg.kind === "prune-divider") return [];
	if (seg.kind === "message") return seg.msg.id ? [seg.msg.id] : [];
	const ids = new Set<string>();
	for (const item of seg.items) {
		if (item.msg.id) ids.add(item.msg.id);
		if (item.tc.toolUseId) ids.add(item.tc.toolUseId);
	}
	for (const srcMsg of seg.sourceMessages) {
		for (const child of srcMsg.children ?? []) {
			if (child.id) ids.add(child.id);
		}
	}
	return [...ids];
}

// ---------------------------------------------------------------------------
// Streaming message builder
// ---------------------------------------------------------------------------

// Module-level cache for tool-use block reference stability.
// During streaming, buildStreamingMsg is called on every frame.
// topLevelStreamingChunks creates new block objects each time (via
// upsertStreamingToolBlock's [...prevBlocks] spread), even when the
// underlying data hasn't changed.  By caching per toolUseId and
// reusing the old reference when data is shallowly equal, we prevent
// unnecessary re-renders of ToolCallCard components that would
// otherwise receive new prop object references every frame.
const MAX_TOOL_BLOCK_CACHE_ENTRIES = 256;
const toolBlockCache = new Map<string, ContentBlock>();

function trimToolBlockCache() {
	while (toolBlockCache.size > MAX_TOOL_BLOCK_CACHE_ENTRIES) {
		const oldestKey = toolBlockCache.keys().next().value;
		if (oldestKey === undefined) return;
		toolBlockCache.delete(oldestKey);
	}
}

function stabilizeToolUseBlock(block: ContentBlock): ContentBlock {
	const id = block.id;
	if (!id || block.type !== "tool_use") return block;

	const cached = toolBlockCache.get(id);
	if (cached && shallowBlockEqual(cached, block)) {
		toolBlockCache.delete(id);
		toolBlockCache.set(id, cached);
		return cached;
	}
	toolBlockCache.set(id, block);
	trimToolBlockCache();
	return block;
}

// Shallow comparison of tool_use blocks for reference stability.
// Note: `input` uses reference equality (===). This is safe because
// upsertStreamingToolBlock creates block.input as {} once on creation
// and never mutates it — streaming input updates go to toolCalls[].inputJson
// instead.  If this invariant is ever broken, upgrade to a shallow input
// comparison (e.g. shallowEqual(a.input, b.input)).
function shallowBlockEqual(a: ContentBlock, b: ContentBlock): boolean {
	return a.type === b.type && a.id === b.id && a.name === b.name && a.input === b.input;
}

/** Clear the tool-use block reference cache (call when streaming ends). */
export function clearToolBlockCache(): void {
	toolBlockCache.clear();
}

/** A streaming block tracked in temporal order (by event arrival / provider output order). */
export type StreamingBlock =
	| { type: "reasoning"; id?: string; outputIndex?: number; text: string }
	| {
			type: "web_search";
			id: string;
			status: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
	  }
	| {
			type: "image_generation";
			id: string;
			status: string;
			revisedPrompt?: string;
			result?: string;
			partialImageIndex?: number;
			partialSavedPath?: string;
			savedPath?: string;
			width?: number;
			height?: number;
			outputIndex?: number;
	  }
	| { type: "text"; text: string; outputIndex?: number };

/** Read a streaming block's provider output index, if any. */
export function getStreamingBlockOutputIndex(block: StreamingBlock): number | undefined {
	return "outputIndex" in block && typeof block.outputIndex === "number"
		? block.outputIndex
		: undefined;
}

/**
 * Find the array index at which a new streaming block with the given output
 * index should be inserted so blocks stay ordered by provider output index.
 * Blocks without an output index always append to the end.
 */
export function findStreamingInsertIndex(
	blocks: StreamingBlock[],
	outputIndex: number | undefined,
): number {
	if (outputIndex == null) return blocks.length;
	for (let i = 0; i < blocks.length; i++) {
		const currentOrder = getStreamingBlockOutputIndex(blocks[i]);
		if (currentOrder != null && currentOrder > outputIndex) return i;
	}
	return blocks.length;
}

export type StreamingWebSearchBlock = Extract<StreamingBlock, { type: "web_search" }>;
export type StreamingImageGenerationBlock = Extract<StreamingBlock, { type: "image_generation" }>;

export interface StreamingWebSearchUpdate {
	id: string;
	status: string;
	query?: string;
	queries?: string[];
	outputIndex?: number;
}

export interface StreamingImageGenerationUpdate {
	id: string;
	status: string;
	revisedPrompt?: string;
	result?: string;
	partialImageIndex?: number;
	partialSavedPath?: string;
	savedPath?: string;
	width?: number;
	height?: number;
	outputIndex?: number;
}

function replaceOrInsertStreamingBlock(
	blocks: StreamingBlock[],
	idx: number,
	next: StreamingBlock,
) {
	if (idx === -1) {
		blocks.splice(findStreamingInsertIndex(blocks, getStreamingBlockOutputIndex(next)), 0, next);
		return;
	}

	const current = blocks[idx];
	const currentOrder = getStreamingBlockOutputIndex(current);
	const nextOrder = getStreamingBlockOutputIndex(next);
	if (currentOrder === nextOrder) {
		blocks[idx] = next;
		return;
	}

	blocks.splice(idx, 1);
	blocks.splice(findStreamingInsertIndex(blocks, nextOrder), 0, next);
}

export function upsertStreamingWebSearchBlock(
	blocks: StreamingBlock[],
	update: StreamingWebSearchUpdate,
): void {
	if (!update.id) return;
	const idx = blocks.findIndex((block) => block.type === "web_search" && block.id === update.id);
	const existing = idx === -1 ? null : blocks[idx];
	const next: StreamingWebSearchBlock = {
		...(existing?.type === "web_search" ? existing : {}),
		type: "web_search",
		id: update.id,
		status: update.status,
	};
	if (update.query !== undefined) next.query = update.query;
	if (update.queries !== undefined) next.queries = update.queries;
	if (update.outputIndex !== undefined) next.outputIndex = update.outputIndex;
	replaceOrInsertStreamingBlock(blocks, idx, next);
}

export function upsertStreamingImageGenerationBlock(
	blocks: StreamingBlock[],
	update: StreamingImageGenerationUpdate,
): void {
	if (!update.id) return;
	const idx = blocks.findIndex(
		(block) => block.type === "image_generation" && block.id === update.id,
	);
	const existing = idx === -1 ? null : blocks[idx];
	const next: StreamingImageGenerationBlock = {
		...(existing?.type === "image_generation" ? existing : {}),
		type: "image_generation",
		id: update.id,
		status: update.status,
	};
	if (update.revisedPrompt !== undefined) next.revisedPrompt = update.revisedPrompt;
	if (update.result !== undefined) next.result = update.result;
	if (update.partialImageIndex !== undefined) next.partialImageIndex = update.partialImageIndex;
	if (update.partialSavedPath !== undefined) next.partialSavedPath = update.partialSavedPath;
	if (update.savedPath !== undefined) next.savedPath = update.savedPath;
	if (update.width !== undefined) next.width = update.width;
	if (update.height !== undefined) next.height = update.height;
	if (update.outputIndex !== undefined) next.outputIndex = update.outputIndex;
	replaceOrInsertStreamingBlock(blocks, idx, next);
}

/** Locate an existing streaming block matching a snapshot block's identity. */
function findMatchingStreamingBlockIndex(
	blocks: StreamingBlock[],
	incoming: StreamingBlock,
): number {
	if (incoming.type === "web_search" || incoming.type === "image_generation") {
		return blocks.findIndex((b) => b.type === incoming.type && b.id === incoming.id);
	}
	if (incoming.type === "reasoning") {
		const incomingOutputIndex = getStreamingBlockOutputIndex(incoming);
		return blocks.findIndex((b) => {
			if (b.type !== "reasoning") return false;
			if (incoming.id) return b.id === incoming.id;
			if (incomingOutputIndex != null)
				return getStreamingBlockOutputIndex(b) === incomingOutputIndex;
			return !b.id && getStreamingBlockOutputIndex(b) == null;
		});
	}
	// text — prefer the provider output index, but legacy/providers without one
	// still keep a single live text block that must merge with a reconnect snapshot
	// instead of being inserted again and rendered twice.
	const incomingOutputIndex = getStreamingBlockOutputIndex(incoming);
	return blocks.findIndex((b) => {
		if (b.type !== "text") return false;
		const existingOutputIndex = getStreamingBlockOutputIndex(b);
		if (incomingOutputIndex != null) return existingOutputIndex === incomingOutputIndex;
		return existingOutputIndex == null;
	});
}

/**
 * Merge a server streaming snapshot into the live streaming blocks in place.
 *
 * A snapshot can arrive slightly after a realtime delta on the same subscription
 * (e.g. right after reconnect / a second message-layer subscriber mounts). Blindly
 * replacing the live blocks would let the UI regress to a shorter/older value, so
 * this fills gaps and refreshes web_search / image_generation state while keeping
 * whichever text/reasoning is already longer. Returns true when anything changed.
 */
export function mergeStreamingSnapshotBlocks(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): boolean {
	let changed = false;
	for (const incoming of snapshotBlocks) {
		const idx = findMatchingStreamingBlockIndex(blocks, incoming);
		if (idx === -1) {
			blocks.splice(findStreamingInsertIndex(blocks, getStreamingBlockOutputIndex(incoming)), 0, {
				...incoming,
			});
			changed = true;
			continue;
		}
		const existing = blocks[idx];
		if (
			(existing.type === "text" && incoming.type === "text") ||
			(existing.type === "reasoning" && incoming.type === "reasoning")
		) {
			// Keep whichever text is longer so a late snapshot cannot truncate live text.
			if (incoming.text.length > existing.text.length) {
				existing.text = incoming.text;
				if (incoming.type === "reasoning" && existing.type === "reasoning" && incoming.id) {
					existing.id = incoming.id;
				}
				changed = true;
			}
		} else {
			// web_search / image_generation: adopt the fresher snapshot status/fields.
			blocks[idx] = { ...existing, ...incoming };
			changed = true;
		}
	}
	return changed;
}

export function buildStreamingMsg(opts: {
	streamingBlocks?: StreamingBlock[] | null;
	toolChunksMsg?: NarratorMsg | null;
	narratorId: string;
}): NarratorMsg | null {
	const { streamingBlocks, toolChunksMsg, narratorId } = opts;

	const hasStreamingBlocks = !!streamingBlocks && streamingBlocks.length > 0;
	const hasToolChunks = !!toolChunksMsg;

	if (!hasStreamingBlocks && !hasToolChunks) return null;

	const blocks: ContentBlock[] = [];

	if (hasStreamingBlocks) {
		for (const [index, sb] of streamingBlocks.entries()) {
			if (sb.type === "reasoning") {
				blocks.push({
					type: "reasoning",
					id:
						sb.id ??
						(sb.outputIndex != null
							? `streaming:reasoning:${sb.outputIndex}`
							: `streaming:reasoning:${index}`),
					text: sb.text,
				} as ContentBlock);
			} else if (sb.type === "web_search") {
				blocks.push({
					type: "web_search",
					id: sb.id,
					status: sb.status,
					query: sb.query,
					queries: sb.queries,
				} as ContentBlock);
			} else if (sb.type === "image_generation") {
				blocks.push({
					type: "image_generation",
					id: sb.id,
					status: sb.status,
					revisedPrompt: sb.revisedPrompt,
					result: sb.result,
					partialImageIndex: sb.partialImageIndex,
					partialSavedPath: sb.partialSavedPath,
					savedPath: sb.savedPath,
					width: sb.width,
					height: sb.height,
				} as ContentBlock);
			} else if (sb.type === "text") {
				blocks.push({
					type: "text",
					id: `streaming:text:${index}`,
					text: sb.text,
					outputIndex: sb.outputIndex,
				} as ContentBlock);
			}
		}
	}

	if (toolChunksMsg) {
		const chunkBlocks = Array.isArray(toolChunksMsg.contentJson) ? toolChunksMsg.contentJson : [];
		for (const raw of chunkBlocks) {
			blocks.push(stabilizeToolUseBlock(raw));
		}
	}

	return {
		id: "__streaming__",
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls: toolChunksMsg?.toolCalls ?? [],
		createdAt: toolChunksMsg?.createdAt ?? new Date().toISOString(),
		children: [],
	} as NarratorMsg;
}

/**
 * Generate stable React keys for a list of content blocks.
 *
 * Blocks that already carry an `id` (tool_use, web_search from the API,
 * streaming blocks with synthetic ids) use that id directly.
 * For blocks without an id, the block *type* is used as the key since each
 * type typically appears at most once per message.  When multiple blocks
 * share the same type and both lack an id, a dedup counter is appended so
 * every key remains unique.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function generateBlockKeys(blocks: any[]): string[] {
	const typeCount: Record<string, number> = {};
	return blocks.map((block) => {
		if (block.id) return block.id as string;
		const t = block.type as string;
		// Known content types typically appear at most once per message,
		// so the first occurrence uses the bare type name as the key
		// (e.g. "text") for maximum stability during streaming.
		// Subsequent occurrences append a dedup counter (e.g. "text-1").
		if (
			t === "text" ||
			t === "reasoning" ||
			t === "thinking" ||
			t === "web_search" ||
			t === "image_generation" ||
			t === "image" ||
			t === "text_file"
		) {
			const count = typeCount[t] ?? 0;
			typeCount[t] = count + 1;
			return count === 0 ? t : `${t}-${count}`;
		}
		// Unknown types always include a counter (e.g. "custom-0") since
		// we cannot assume they appear at most once per message.
		const count = typeCount[t] ?? 0;
		typeCount[t] = count + 1;
		return `${t}-${count}`;
	});
}
