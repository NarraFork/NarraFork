/**
 * message-segments.ts — Pre-processing layer that converts a flat message list
 * into a sequence of RenderSegments.  The renderer simply iterates segments
 * without any grouping / splitting logic of its own.
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
	if (b.type === "reasoning" || b.type === "thinking") return true;
	return false;
}

export function hasToolUse(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "tool_use");
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
				(b.type === "text" && !b.text?.trim()),
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
// segmentMessages — the core pre-processing function
// ---------------------------------------------------------------------------

export interface SegmentOptions {
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	streamingMsg?: NarratorMsg | null;
}

type VisualLane = "content" | "tool";

function classifyBlock(b: ContentBlock): VisualLane | null {
	if (b.type === "tool_use") return "tool";
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
				const lane = classifyBlock(blocks[bi]);
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
				tcs = resolveAllToolCallsFromMsg(msg);
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

export function buildStreamingMsg(opts: {
	streamingText?: string;
	streamingReasoning?: string;
	webSearch?: { id: string; status: string; query?: string } | null;
	toolChunksMsg?: NarratorMsg | null;
	narratorId: string;
}): NarratorMsg | null {
	const { streamingText, streamingReasoning, webSearch, toolChunksMsg, narratorId } = opts;

	const hasText = !!streamingText;
	const hasReasoning = !!streamingReasoning;
	const hasWebSearch = !!webSearch;
	const hasToolChunks = !!toolChunksMsg;

	if (!hasText && !hasReasoning && !hasWebSearch && !hasToolChunks) return null;

	const blocks: ContentBlock[] = [];

	if (hasReasoning) {
		blocks.push({ type: "reasoning", text: streamingReasoning } as ContentBlock);
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
		createdAt: toolChunksMsg?.createdAt ?? new Date().toISOString(),
		children: [],
	} as NarratorMsg;
}
