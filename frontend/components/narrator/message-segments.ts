/**
 * message-segments.ts — Pre-processing layer that converts a flat message list
 * into a sequence of RenderSegments.  The renderer simply iterates segments
 * without any grouping / splitting logic of its own.
 *
 * Design goals:
 *  - Never mutate or clone contentJson arrays — reference original blocks by index.
 *  - Eliminate _blockOriginalIndices / _noMerge hacks.
 *  - Handle reasoning blocks as first-class citizens (not patches).
 *  - Keep streaming chunks integration trivial (just append to message list).
 */

import type { ContentBlock, NarratorMsg, ToolCallRow } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// Legacy tool name mapping
// ---------------------------------------------------------------------------

const LEGACY_TOOL_NAMES: Record<string, string> = {
	Task: "Agent",
	TodoWrite: "TaskCreate",
	CheckBackgroundTask: "TaskOutput",
	CancelBackgroundTask: "TaskStop",
};

function normalizeToolName(name: string): string {
	return LEGACY_TOOL_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single item inside a tool-run segment. */
export type ToolRunItem =
	| {
			kind: "reasoning";
			msg: NarratorMsg;
			blockIndex: number;
			text: string;
			translatedText?: string;
	  }
	| {
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
			/** When set, only these block indices should be rendered (the rest belong to a tool-run). */
			visibleBlockIndices?: number[];
	  }
	| {
			kind: "tool-run";
			items: ToolRunItem[];
			/** All source messages that contributed items to this run (for target-id collection). */
			sourceMessages: NarratorMsg[];
	  }
	| {
			kind: "prune-divider";
			label?: string;
	  };

// ---------------------------------------------------------------------------
// Block classification helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/** Extract reasoning text from a block (handles both reasoning and legacy thinking). */
function getReasoningText(b: ContentBlock): string {
	if (b.type === "reasoning") return b.text ?? "";
	if (b.type === "thinking") return (b as { thinking?: string }).thinking ?? "";
	return "";
}

/** Check if a block is a reasoning/thinking block with content. */
function isReasoningBlock(b: ContentBlock): boolean {
	return !!getReasoningText(b).trim();
}

/** Check if a block is visible user-facing content (text, image, etc.) — NOT tool_use or reasoning. */
function isVisibleContentBlock(b: ContentBlock): boolean {
	if (b.type === "text") return !!b.text?.trim();
	if (b.type === "image") return true;
	if (b.type === "text_file") return true;
	if (b.type === "web_search") return true;
	return false;
}

export function hasToolUse(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "tool_use");
}

export function hasReasoningBlock(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => isReasoningBlock(b));
}

/** True when every visible block is either tool_use, reasoning, or blank text. */
export function isToolOnlyMessage(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		blocks.length > 0 &&
		blocks.every(
			(b: ContentBlock) =>
				b.type === "tool_use" || isReasoningBlock(b) || (b.type === "text" && !b.text?.trim()),
		)
	);
}

// ---------------------------------------------------------------------------
// Tool call resolution (from contentJson blocks → ToolCallData)
// ---------------------------------------------------------------------------

export function resolveAllToolCallsFromMsg(msg: NarratorMsg): ToolCallData[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const results: ToolCallData[] = [];
	for (const block of blocks) {
		if (block.type !== "tool_use") continue;
		const isEnriched = block.status !== undefined;
		const tc = isEnriched
			? null
			: msg.toolCalls?.find((t: ToolCallRow) => t.toolUseId === (block.id ?? ""));
		const status = block.status ?? tc?.status ?? "running";
		let startedAt: number | undefined;
		if (status === "running" || status === "pending" || status === "initializing") {
			const ts =
				block.permissionDecidedAt ?? tc?.permissionDecidedAt ?? block.tcCreatedAt ?? tc?.createdAt;
			if (ts) startedAt = new Date(ts).getTime();
		}
		results.push({
			id: block.tcId ?? tc?.id,
			toolName: normalizeToolName(block.name ?? ""),
			toolUseId: block.id,
			inputJson: block.inputJson ?? tc?.inputJson ?? block.input,
			outputJson: block.outputJson ?? tc?.outputJson,
			status,
			durationMs: block.durationMs ?? tc?.durationMs,
			errorMessage: block.errorMessage ?? tc?.errorMessage,
			permissionDenyMessage: block.permissionDenyMessage ?? tc?.permissionDenyMessage,
			permissionDecisionReason: block.permissionDecisionReason ?? tc?.permissionDecisionReason,
			permissionSuggestions: block.permissionSuggestions ?? tc?.permissionSuggestions,
			startedAt,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_metadata: block._metadata ?? (tc as any)?._metadata,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_longRunning: block._longRunning ?? (tc as any)?._longRunning,
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only fields
			_streamingOutput: block._streamingOutput ?? (tc as any)?._streamingOutput,
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
// Extract ToolRunItems from a single message
// ---------------------------------------------------------------------------

export function extractToolRunItems(msg: NarratorMsg): ToolRunItem[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const items: ToolRunItem[] = [];
	const allTcs = resolveAllToolCallsFromMsg(msg);

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (isReasoningBlock(block)) {
			items.push({
				kind: "reasoning",
				msg,
				blockIndex: i,
				text: getReasoningText(block),
				translatedText: block.translatedText,
			});
			continue;
		}

		if (block.type !== "tool_use") continue;

		const tc = allTcs.find((t) => t.toolUseId === block.id);
		if (!tc) continue;
		const children = filterChildrenByToolUse(msg.children ?? [], tc.toolUseId);
		const isSubagent = tc.toolName === "Agent" || children.length > 0;
		items.push({ kind: "tool", msg, blockIndex: i, tc, children, isSubagent });
	}
	return items;
}

// ---------------------------------------------------------------------------
// segmentMessages — the core pre-processing function
// ---------------------------------------------------------------------------

export interface SegmentOptions {
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	/**
	 * Synthetic streaming message to append to the end of the message list.
	 * When provided, it participates in segmentation just like any other message,
	 * so streaming tool_use / reasoning blocks are automatically merged into the
	 * preceding tool-run when appropriate — no special-case code needed.
	 */
	streamingMsg?: NarratorMsg | null;
}

/**
 * Classify a content block into one of three visual lanes.
 *
 * Every assistant message's blocks are sorted into canonical order:
 *   reasoning → content (text/image/…) → tool_use
 *
 * This function returns the lane so the segmenter can group them.
 */
type VisualLane = "reasoning" | "content" | "tool";

function classifyBlock(b: ContentBlock): VisualLane | null {
	if (isReasoningBlock(b)) return "reasoning";
	if (b.type === "tool_use") return "tool";
	if (isVisibleContentBlock(b)) return "content";
	// Blank text, compact markers, etc. — skip
	return null;
}

/**
 * Convert a flat message list into a sequence of RenderSegments.
 *
 * Algorithm:
 * 1. Non-assistant messages → "message" segment.
 * 2. For each assistant message, classify every block into one of three lanes:
 *    reasoning | content (text/image/…) | tool.
 *    Emit them in canonical order: reasoning → content → tool.
 * 3. Consecutive reasoning and tool atoms are merged into a single "tool-run"
 *    segment.  A content atom always breaks the run and becomes its own
 *    "message" segment.
 *
 * Because streaming messages are simply appended to the list, they participate
 * in the same merging logic with zero special-case code.
 */
export function segmentMessages(
	messages: NarratorMsg[],
	opts: SegmentOptions = {},
): RenderSegment[] {
	const { pruneBoundaryMessageId, pruneDividerLabel, streamingMsg } = opts;

	const effectiveMessages = streamingMsg != null ? [...messages, streamingMsg] : messages;

	// Phase 1 — Flatten all messages into an ordered atom list.
	//
	// An "atom" is the smallest visual unit:
	//   { lane: "reasoning" | "content" | "tool", msg, blockIndex }
	// For non-assistant messages the whole message is a single "content" atom.

	type Atom =
		| { lane: "content"; msg: NarratorMsg; blockIndex: number }
		| { lane: "content-whole"; msg: NarratorMsg }
		| { lane: "reasoning"; msg: NarratorMsg; blockIndex: number }
		| { lane: "tool"; msg: NarratorMsg; blockIndex: number };

	const atoms: Atom[] = [];
	const pruneBoundaryAtomIndices: number[] = [];

	for (const msg of effectiveMessages) {
		const atomStartIdx = atoms.length;

		if (msg.role !== "assistant") {
			atoms.push({ lane: "content-whole", msg });
		} else {
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];

			// Emit atoms in original block order — no reordering.
			// Phase 2 merging handles grouping consecutive reasoning/tool into runs.
			for (let bi = 0; bi < blocks.length; bi++) {
				const lane = classifyBlock(blocks[bi]);
				if (lane === "reasoning") atoms.push({ lane: "reasoning", msg, blockIndex: bi });
				else if (lane === "content") atoms.push({ lane: "content", msg, blockIndex: bi });
				else if (lane === "tool") atoms.push({ lane: "tool", msg, blockIndex: bi });
			}

			// If the message had no visible atoms at all (e.g. only blank text),
			// still emit a whole-message atom so it doesn't vanish.
			if (atoms.length === atomStartIdx && blocks.length > 0) {
				atoms.push({ lane: "content-whole", msg });
			}
		}

		// Track prune boundary
		if (pruneBoundaryMessageId && msg.id === pruneBoundaryMessageId) {
			pruneBoundaryAtomIndices.push(atoms.length - 1);
		}
	}

	// Phase 2 — Merge atoms into segments.
	//
	// Rules:
	// - "content" / "content-whole" atoms → "message" segment
	// - Consecutive "reasoning" and "tool" atoms → single "tool-run" segment
	// - A "content" atom always breaks a run

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

		// Content atoms → message segment
		if (atom.lane === "content-whole") {
			segments.push({ kind: "message", msg: atom.msg });
			maybeInsertPruneDivider(ai);
			ai++;
			continue;
		}

		if (atom.lane === "content") {
			// Collect consecutive content atoms from the same message
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
			// Prune divider for any consumed atom
			for (let k = ai; k < aj; k++) maybeInsertPruneDivider(k);
			ai = aj;
			continue;
		}

		// reasoning or tool → start a tool-run
		const items: ToolRunItem[] = [];
		const sourceMessagesSet = new Set<NarratorMsg>();
		const allTcsCache = new Map<NarratorMsg, ToolCallData[]>();

		const getTcs = (msg: NarratorMsg) => {
			let tcs = allTcsCache.get(msg);
			if (!tcs) {
				tcs = resolveAllToolCallsFromMsg(msg);
				allTcsCache.set(msg, tcs);
			}
			return tcs;
		};

		const runStartAtom = ai;
		while (ai < atoms.length) {
			const cur = atoms[ai];
			if (cur.lane === "reasoning") {
				const block = (Array.isArray(cur.msg.contentJson) ? cur.msg.contentJson : [])[
					cur.blockIndex
				];
				if (block) {
					items.push({
						kind: "reasoning",
						msg: cur.msg,
						blockIndex: cur.blockIndex,
						text: getReasoningText(block),
						translatedText: block.translatedText,
					});
					sourceMessagesSet.add(cur.msg);
				}
				ai++;
			} else if (cur.lane === "tool") {
				const tcs = getTcs(cur.msg);
				const block = (Array.isArray(cur.msg.contentJson) ? cur.msg.contentJson : [])[
					cur.blockIndex
				];
				const tc = block ? tcs.find((t) => t.toolUseId === block.id) : undefined;
				if (tc) {
					const children = filterChildrenByToolUse(cur.msg.children ?? [], tc.toolUseId);
					const isSubagent = tc.toolName === "Agent" || children.length > 0;
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
				// content atom → break the run
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
		// Prune dividers for consumed atoms
		for (let k = runStartAtom; k < ai; k++) maybeInsertPruneDivider(k);
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Target ID collection (for virtualization / scroll-to)
// ---------------------------------------------------------------------------

/** Collect all scrollable target IDs for a segment. */
export function collectSegmentTargetIds(seg: RenderSegment): string[] {
	if (seg.kind === "prune-divider") return [];
	if (seg.kind === "message") return seg.msg.id ? [seg.msg.id] : [];
	// tool-run: collect message IDs + tool use IDs
	const ids = new Set<string>();
	for (const item of seg.items) {
		if (item.msg.id) ids.add(item.msg.id);
		if (item.kind === "tool") {
			if (item.tc.toolUseId) ids.add(item.tc.toolUseId);
		}
	}
	// Also collect from children
	for (const srcMsg of seg.sourceMessages) {
		for (const child of srcMsg.children ?? []) {
			if (child.id) ids.add(child.id);
		}
	}
	return [...ids];
}

// ---------------------------------------------------------------------------
// Streaming message builder — creates a synthetic NarratorMsg from streaming
// state that can be passed as `streamingMsg` to `segmentMessages`.
// ---------------------------------------------------------------------------

/**
 * Build a synthetic NarratorMsg from the current streaming state.
 *
 * Returns null when there is nothing to render at all.
 *
 * All streaming content (reasoning, text, web_search, tool chunks) is combined
 * into a single message so `segmentMessages` can apply canonical ordering
 * (reasoning → content → tool) and merge tool-runs correctly.
 */
export function buildStreamingMsg(opts: {
	/** Accumulated reasoning text (from streamingReasoningRef). */
	reasoningText?: string;
	/** Accumulated streaming text (from streamingRef). */
	streamingText?: string;
	/** Web search state (from webSearchRef). */
	webSearch?: { id: string; status: string; query?: string } | null;
	/** Synthetic streaming tool chunks message (from topLevelStreamingChunks). */
	toolChunksMsg?: NarratorMsg | null;
	/** Narrator ID for synthetic messages. */
	narratorId: string;
	/** Stable createdAt for the streaming reasoning (avoids key churn). */
	reasoningCreatedAt?: string;
}): NarratorMsg | null {
	const { reasoningText, streamingText, webSearch, toolChunksMsg, narratorId, reasoningCreatedAt } =
		opts;

	const hasReasoning = !!reasoningText?.trim();
	const hasText = !!streamingText;
	const hasWebSearch = !!webSearch;
	const hasToolChunks = !!toolChunksMsg;

	if (!hasReasoning && !hasText && !hasWebSearch && !hasToolChunks) return null;

	// Build blocks in arrival order: reasoning → content (web_search, text) → tool.
	// segmentMessages preserves this order and merges consecutive reasoning/tool
	// into runs, with content breaking the run — so the visual result is correct.
	const blocks: ContentBlock[] = [];

	if (hasReasoning) {
		blocks.push({ type: "reasoning", text: reasoningText } as ContentBlock);
	}
	if (hasWebSearch) {
		blocks.push({
			type: "web_search",
			id: webSearch.id,
			status: webSearch.status,
			query: webSearch.query,
		} as ContentBlock);
	}
	if (hasText) {
		blocks.push({ type: "text", text: streamingText } as ContentBlock);
	}
	if (toolChunksMsg) {
		const chunkBlocks = Array.isArray(toolChunksMsg.contentJson) ? toolChunksMsg.contentJson : [];
		blocks.push(...chunkBlocks);
	}

	return {
		id: "__streaming__",
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls: toolChunksMsg?.toolCalls ?? [],
		createdAt: toolChunksMsg?.createdAt ?? reasoningCreatedAt ?? new Date().toISOString(),
		children: [],
	} as NarratorMsg;
}
