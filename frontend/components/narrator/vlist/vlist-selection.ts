/**
 * vlist-selection.ts — Pure, DOM-free selection index for PretextMessageList.
 *
 * This replicates the message-selection core that ChunkedMessageList keeps as
 * private module functions (buildSelectionIndex / entriesToBlockMeta /
 * entriesToMessageIds / entriesToText + helpers, ChunkedMessageList.tsx
 * ~L295-515). We intentionally do NOT export/import those from
 * ChunkedMessageList: the selection core must not sit in the legacy list's
 * module graph (the vlist is lazily loaded; see vlist-isolation.guard.test.ts).
 *
 * Differences from the ChunkedMessageList version, all behavior-preserving:
 *  - Input is a FLAT NarratorMsg[] (the shell already flattens chunks), not
 *    ChunkData[]. `chunkIndex` is a monotonic traversal ordinal — it is only a
 *    tiebreaker for entry metadata; the pure range computation keys on
 *    seq + blockIndex, never on chunkIndex.
 *  - The DOM / async fallbacks (readMountedBlockMeta, api.getToolCallDetail)
 *    stay in the shell; this module is pure and unit-tested.
 *
 * Drift guard: vlist-selection.test.ts hard-codes expected values against the
 * same fixtures so any divergence from the documented semantics is caught.
 */

import { cleanAssistantText } from "@shared/citations";
import type { FileReference } from "@shared/file-reference";
import { fileReferenceLabel } from "@shared/file-reference-display";
import {
	contextBlockViews,
	injectionBlockViews,
	isNativeModelContextBlock,
} from "@shared/native-injection";
import { readCommunicationInjection } from "@shared/pretext-layout/segment-adapter";
import { stringifyForDisplay } from "@shared/pretext-layout/tool-io-projection";
import type { BlockMeta, CollectedSelectedText } from "../message/MessageSelectionCtx";
import {
	MAX_COLLECTED_SELECTED_TEXT_CHARS,
	makeMessageBlockSelectionId,
} from "../message/MessageSelectionCtx";
import { filterChildrenByToolUse } from "../message/message-segments";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import { groupReasoningRuns } from "../trace/reasoning-segments";

export interface SelectionEntry extends BlockMeta {
	seq: number;
	chunkIndex: number;
	/** All original indices represented by this visual entry. */
	blockIndices: number[];
	copyText: string;
}

export interface SelectionIndex {
	entries: SelectionEntry[];
	byBlockId: Map<string, SelectionEntry>;
}

function getMessageSeq(msg: NarratorMsg | null | undefined): number | null {
	const seq = msg?.seq;
	return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function stableStringify(value: unknown, maxChars = 4000): string {
	if (value == null) return "";
	// `stringifyForDisplay` renders any truncated LEAF as its preview text instead
	// of dumping the wrapper's own `{_truncated,preview,fullLength}` structure into
	// what the user copies.
	const text = typeof value === "string" ? value : stringifyForDisplay(value);
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Copy text for one block.
 *
 * `assistant` enables citation cleanup: a historical assistant text block may
 * still embed provider-internal `citeturn…` markers, and copying them would
 * paste machine-only identifiers into the user's document. User blocks never opt
 * in — quoting the marker is legitimate there.
 */
function getBlockCopyText(block: ContentBlock, assistant = false): string {
	if (block.type === "file_reference") {
		return block.reference ? fileReferenceLabel(block.reference as FileReference) : "";
	}
	if (typeof block.text === "string") {
		return assistant ? cleanAssistantText(block.text).text : block.text;
	}
	if (typeof block.thinking === "string") return block.thinking;
	if (block.type === "text_file") {
		return [block.filename, typeof block.size === "number" ? `${block.size} bytes` : null]
			.filter(Boolean)
			.join(" ");
	}
	if (block.type === "web_search") {
		const query = typeof block.query === "string" ? block.query : undefined;
		const queries = Array.isArray(block.queries) ? block.queries.map(String).join(", ") : undefined;
		return ["Web search", query ?? queries, block.status].filter(Boolean).join(": ");
	}
	if (block.type === "image_generation") {
		return ["Image generation", block.revisedPrompt, block.savedPath ?? block.partialSavedPath]
			.filter(Boolean)
			.join("\n");
	}
	if (block.type === "image") return "[Image]";
	if (block.type === "tool_use") {
		return [`Tool: ${block.name ?? block.id ?? "unknown"}`, stableStringify(block.input)]
			.filter(Boolean)
			.join("\n");
	}
	return stableStringify(block);
}

function isSubagentTool(msg: NarratorMsg, block: ContentBlock): boolean {
	if (block.type !== "tool_use" || typeof block.id !== "string") return false;
	if (block.name === "Agent") return true;
	const children = filterChildrenByToolUse(msg.children ?? [], block.id);
	return children.length > 0;
}

function isSelectableBlock(block: ContentBlock): boolean {
	if (block.type === "text") return !!block.text?.trim();
	if (block.type === "reasoning" || block.type === "thinking") {
		return !!(block.text?.trim() || block.thinking?.trim());
	}
	return block.type === "web_search" || block.type === "tool_use";
}

function getReasoningRunCopyText(blocks: ContentBlock[]): string {
	return blocks
		.map((block) => block.text || block.thinking || "")
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function getUserMessageCopyText(msg: NarratorMsg): string {
	if (msg.contentText?.trim()) return msg.contentText;
	const parts: string[] = [];
	for (const block of (msg.contentJson ?? []) as ContentBlock[]) {
		if (block.type === "text" && block.text?.trim()) parts.push(block.text);
		else if (block.type === "file_reference") parts.push(getBlockCopyText(block));
	}
	return parts.join("\n\n");
}

function addSelectionAlias(
	index: SelectionIndex,
	alias: string | undefined,
	entry: SelectionEntry,
) {
	if (alias) index.byBlockId.set(alias, entry);
}

/**
 * Build the selection index from a FLAT, seq-ordered message list. Mirrors
 * ChunkedMessageList.buildSelectionIndex; `chunkIndex` is the traversal ordinal.
 */
export function buildSelectionIndex(
	messages: readonly NarratorMsg[],
	resolveChunkIndex?: (seq: number) => number,
): SelectionIndex {
	const index: SelectionIndex = { entries: [], byBlockId: new Map() };
	let traversalIndex = 0;
	for (const msg of messages) {
		const seq = getMessageSeq(msg);
		if (!msg.id || seq == null || !Array.isArray(msg.contentJson)) {
			traversalIndex++;
			continue;
		}
		// A communication row has two projections of ONE message: model text and the
		// reader-facing injection. Register the visible block, not a hidden text row at
		// index zero. The paired model text participates in deletion/selection too.
		const contextViews = Array.from(
			new Map(
				[...contextBlockViews(msg.contentJson), ...injectionBlockViews(msg.contentJson)].map(
					(view) => [view.blockIndex, view],
				),
			).values(),
		).sort((a, b) => a.blockIndex - b.blockIndex);
		const canUseContext =
			(msg.role === "user" &&
				(msg as NarratorMsg & { origin?: string | null }).origin !== "user") ||
			msg.role === "sys" ||
			msg.role === "system" ||
			msg.role === "disp";
		if (canUseContext && contextViews.length > 0) {
			for (const view of contextViews) {
				const inbound = readCommunicationInjection(view.block);
				const copyText = inbound?.text ?? view.block.modelText ?? "";
				if (!copyText.trim() && !isNativeModelContextBlock(view.block)) continue;
				const blockId = makeMessageBlockSelectionId(msg.id, view.blockIndex);
				const entry: SelectionEntry = {
					blockId,
					messageId: msg.id,
					blockIndex: view.blockIndex,
					blockIndices: view.sourceIndices,
					seq,
					chunkIndex: resolveChunkIndex?.(seq) ?? traversalIndex,
					copyText,
				};
				index.entries.push(entry);
				for (const pairedIndex of view.sourceIndices) {
					index.byBlockId.set(makeMessageBlockSelectionId(msg.id, pairedIndex), entry);
				}
			}
			traversalIndex++;
			continue;
		}
		const userCopyText = msg.role === "user" ? getUserMessageCopyText(msg) : "";
		const reasoningGrouping =
			msg.role === "user"
				? { runs: [], skip: new Set<number>() }
				: groupReasoningRuns(msg.contentJson);
		const reasoningRunByStart = new Map(
			reasoningGrouping.runs.map((run) => [run.startIndex, run] as const),
		);
		for (let blockIndex = 0; blockIndex < msg.contentJson.length; blockIndex++) {
			if (reasoningGrouping.skip.has(blockIndex)) continue;
			const block = msg.contentJson[blockIndex] as ContentBlock;
			if (!block || typeof block !== "object") continue;
			if (msg.role === "user" && blockIndex > 0) continue;

			const reasoningRun = reasoningRunByStart.get(blockIndex);
			const blockIndices = reasoningRun?.indices ?? [blockIndex];
			const representedBlocks = blockIndices.map((i) => msg.contentJson[i] as ContentBlock);
			if (
				msg.role !== "user" &&
				!(reasoningRun
					? representedBlocks.some((candidate) => isSelectableBlock(candidate))
					: isSelectableBlock(block))
			)
				continue;

			const isTool = block.type === "tool_use" && typeof block.id === "string";
			const primaryId = isTool
				? isSubagentTool(msg, block)
					? `sa-${block.id}`
					: `tc-${block.id}`
				: makeMessageBlockSelectionId(msg.id, blockIndex);
			const entry: SelectionEntry = {
				blockId: primaryId,
				messageId: msg.id,
				blockIndex,
				blockIndices,
				seq,
				chunkIndex: resolveChunkIndex?.(seq) ?? traversalIndex,
				copyText:
					msg.role === "user"
						? userCopyText
						: reasoningRun
							? getReasoningRunCopyText(representedBlocks)
							: getBlockCopyText(block, msg.role === "assistant"),
			};
			index.entries.push(entry);
			index.byBlockId.set(primaryId, entry);
			index.byBlockId.set(makeMessageBlockSelectionId(msg.id, blockIndex), entry);
			if (isTool) {
				addSelectionAlias(index, `tc-${block.id}`, entry);
				addSelectionAlias(index, `sa-${block.id}`, entry);
			}
		}
		traversalIndex++;
	}
	index.entries.sort((a, b) => a.seq - b.seq || a.blockIndex - b.blockIndex);
	return index;
}

export function entriesToBlockMeta(
	entries: readonly SelectionEntry[],
	selectedIds: Set<string>,
): BlockMeta[] {
	const seen = new Set<string>();
	const out: BlockMeta[] = [];
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId)) continue;
		for (const blockIndex of entry.blockIndices) {
			const key = `${entry.messageId}:${blockIndex}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ blockId: entry.blockId, messageId: entry.messageId, blockIndex });
		}
	}
	return out;
}

export function entriesToMessageIds(
	entries: readonly SelectionEntry[],
	selectedIds: Set<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId) || seen.has(entry.messageId)) continue;
		seen.add(entry.messageId);
		out.push(entry.messageId);
	}
	return out;
}

export function entriesToText(
	entries: readonly SelectionEntry[],
	selectedIds: Set<string>,
): CollectedSelectedText {
	const parts: string[] = [];
	let remaining = MAX_COLLECTED_SELECTED_TEXT_CHARS;
	let truncated = false;
	for (const entry of entries) {
		if (!selectedIds.has(entry.blockId)) continue;
		const text = entry.copyText.trim();
		if (!text) continue;
		const separator = parts.length > 0 ? "\n\n" : "";
		const available = remaining - separator.length;
		if (available <= 0) {
			truncated = true;
			break;
		}
		parts.push(separator);
		if (text.length > available) {
			parts.push(text.slice(0, available));
			truncated = true;
			break;
		}
		parts.push(text);
		remaining -= separator.length + text.length;
	}
	return { text: parts.join(""), truncated };
}

/**
 * Pure range selection: given anchor + target entries, collect every entry's
 * blockId within [start, end] ordered by seq then blockIndex. Mirrors
 * ChunkedMessageList.resolveSelectionRange's synchronous set logic (L1413-1426),
 * without the async chunk-loading / confirm / notification side effects (which
 * stay in the shell). Returns null when the range is empty.
 */
export function computeSelectedRange(
	index: SelectionIndex,
	anchor: SelectionEntry,
	target: SelectionEntry,
): Set<string> | null {
	const anchorBeforeTarget =
		anchor.seq < target.seq ||
		(anchor.seq === target.seq && anchor.blockIndex <= target.blockIndex);
	const start = anchorBeforeTarget ? anchor : target;
	const end = anchorBeforeTarget ? target : anchor;
	const selected = new Set<string>();
	for (const entry of index.entries) {
		if (entry.seq < start.seq || entry.seq > end.seq) continue;
		if (entry.seq === start.seq && entry.blockIndex < start.blockIndex) continue;
		if (entry.seq === end.seq && entry.blockIndex > end.blockIndex) continue;
		selected.add(entry.blockId);
	}
	return selected.size > 0 ? selected : null;
}
