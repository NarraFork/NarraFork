/**
 * render-units.ts — Group render segments into render-units for the L1/L2
 * unified activity fold. Pure logic (no React / no heavy imports) so it stays
 * unit-testable outside the Vite/bundler environment.
 *
 * At L1/L2, reasoning blocks and adjacent inactive tool-run segments merge
 * into activity render-units (rendered as shared CollapsibleTrace blocks), while
 * visible answer content remains in chronological position. At L3+ the mapping
 * is the identity — rendering is byte-for-byte unchanged.
 */

import type { ActivityInput } from "./ActivityTrace";
import type { RenderSegment, ToolRunItem } from "./message-segments";
import type { NarratorMsg } from "./narrator-panel-types";
import { isReasoningBlock } from "./reasoning-segments";

export type RenderUnit =
	| { kind: "segment"; seg: RenderSegment }
	| {
			kind: "activity";
			items: ActivityInput[];
			sourceMessages: NarratorMsg[];
			sourceSegments: RenderSegment[];
	  };

export type ToolRunLodGroup =
	| { kind: "active"; item: ToolRunItem; index: number }
	| { kind: "folded"; items: ToolRunItem[]; startIndex: number };

/** True when a single tool item is mid-flight (running / pending / initializing). */
export function isActiveToolItem(item: ToolRunItem): boolean {
	const s = item.tc.status;
	return s === "running" || s === "pending" || s === "initializing";
}

/**
 * Split a mixed tool run into chronological low-LOD groups. Completed tools are
 * folded in contiguous batches, while active tools remain standalone at their
 * original positions. This prevents the live card from jumping above earlier
 * completed calls when the run is partially folded.
 */
export function groupToolRunItemsForLod(items: ToolRunItem[]): ToolRunLodGroup[] {
	const groups: ToolRunLodGroup[] = [];
	let pendingFolded: ToolRunItem[] = [];
	let pendingStartIndex = 0;

	const flushFolded = () => {
		if (pendingFolded.length === 0) return;
		groups.push({ kind: "folded", items: pendingFolded, startIndex: pendingStartIndex });
		pendingFolded = [];
	};

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (isActiveToolItem(item)) {
			flushFolded();
			groups.push({ kind: "active", item, index });
			continue;
		}
		if (pendingFolded.length === 0) pendingStartIndex = index;
		pendingFolded.push(item);
	}
	flushFolded();
	return groups;
}

type MessageActivityPart =
	| { kind: "reasoning"; items: ActivityInput[] }
	| { kind: "content"; segment: Extract<RenderSegment, { kind: "message" }> };

/**
 * Split a completed assistant message segment into chronological reasoning and
 * visible-content runs. `message-segments` intentionally groups adjacent content
 * blocks, so a segment may contain both reasoning and answer text. Low LOD must
 * absorb the reasoning blocks without moving or hiding the surrounding text.
 */
function splitMessageSegmentForActivity(
	seg: Extract<RenderSegment, { kind: "message" }>,
): MessageActivityPart[] | null {
	if (seg.msg.role !== "assistant") return null;
	if (seg.msg.id === "__streaming__") return null; // streaming stays live, never folded

	const blocks = Array.isArray(seg.msg.contentJson) ? seg.msg.contentJson : [];
	const indices = seg.visibleBlockIndices ?? blocks.map((_, i) => i);
	if (indices.length === 0 || !indices.some((bi) => blocks[bi] && isReasoningBlock(blocks[bi]))) {
		return null;
	}

	const parts: MessageActivityPart[] = [];
	let pendingReasoning: ActivityInput[] = [];
	let pendingContentIndices: number[] = [];

	const flushReasoning = () => {
		if (pendingReasoning.length === 0) return;
		parts.push({ kind: "reasoning", items: pendingReasoning });
		pendingReasoning = [];
	};
	const flushContent = () => {
		if (pendingContentIndices.length === 0) return;
		parts.push({
			kind: "content",
			segment: { ...seg, visibleBlockIndices: pendingContentIndices },
		});
		pendingContentIndices = [];
	};

	for (const blockIndex of indices) {
		const block = blocks[blockIndex];
		if (block && isReasoningBlock(block)) {
			flushContent();
			pendingReasoning.push({
				kind: "reasoning",
				msg: seg.msg,
				blockIndex,
				block,
			});
		} else {
			flushReasoning();
			pendingContentIndices.push(blockIndex);
		}
	}
	flushReasoning();
	flushContent();
	return parts;
}

/** True when a tool-run segment has no in-flight tool (safe to fold). */
function isInactiveToolRunSegment(seg: Extract<RenderSegment, { kind: "tool-run" }>): boolean {
	return (
		!seg.items.some((it) => isActiveToolItem(it)) &&
		!seg.sourceMessages.some((m) => m.id === "__streaming__")
	);
}

/** Fold a tool-run segment into tool activity items. */
function toolItemsFromToolRunSegment(
	seg: Extract<RenderSegment, { kind: "tool-run" }>,
): ActivityInput[] {
	return seg.items.map((it) => ({
		kind: "tool" as const,
		msg: it.msg,
		blockIndex: it.blockIndex,
		tc: it.tc,
	}));
}

/**
 * Group segments into render-units. At L1/L2 (`enabled`), reasoning runs and
 * adjacent inactive tool-run segments merge into activity units. Visible answer
 * content, user messages, active tools, and streaming output remain plain
 * segment units and preserve their chronological positions. Item order is
 * preserved, and item-level keys (toolUseId / msg.id+blockIndex) are stable so
 * future animated LOD transitions can track individual rows across the fold.
 */
export function groupRenderUnits(segments: RenderSegment[], enabled: boolean): RenderUnit[] {
	if (!enabled) return segments.map((seg) => ({ kind: "segment", seg }));

	const units: RenderUnit[] = [];
	let pending: ActivityInput[] = [];
	let pendingMessages: NarratorMsg[] = [];
	let pendingSegments: RenderSegment[] = [];

	const flush = () => {
		if (pending.length === 0) return;
		units.push({
			kind: "activity",
			items: pending,
			sourceMessages: pendingMessages,
			sourceSegments: pendingSegments,
		});
		pending = [];
		pendingMessages = [];
		pendingSegments = [];
	};
	const absorb = (items: ActivityInput[], msgs: NarratorMsg[], seg: RenderSegment) => {
		pending.push(...items);
		pendingSegments.push(seg);
		for (const m of msgs) {
			if (!pendingMessages.includes(m)) pendingMessages.push(m);
		}
	};

	for (const seg of segments) {
		if (seg.kind === "message") {
			const parts = splitMessageSegmentForActivity(seg);
			if (parts) {
				for (const part of parts) {
					if (part.kind === "reasoning") {
						absorb(part.items, [seg.msg], seg);
					} else {
						flush();
						units.push({ kind: "segment", seg: part.segment });
					}
				}
				continue;
			}
		}
		if (seg.kind === "tool-run" && isInactiveToolRunSegment(seg)) {
			absorb(toolItemsFromToolRunSegment(seg), seg.sourceMessages, seg);
			continue;
		}
		// Boundary: flush the pending activity group, then render this segment.
		flush();
		units.push({ kind: "segment", seg });
	}
	flush();
	return units;
}
