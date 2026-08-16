/**
 * render-units.ts — Group render segments into render-units for the L1/L2
 * unified activity fold. Pure logic (no React / no heavy imports) so it stays
 * unit-testable outside the Vite/bundler environment.
 *
 * At L1/L2, reasoning blocks and adjacent tool-run segments merge into activity
 * render-units (rendered as shared CollapsibleTrace blocks), while visible answer
 * content remains in chronological position. At L3+ the mapping is the identity —
 * rendering is byte-for-byte unchanged.
 *
 * ── Why LIVE content folds here too ─────────────────────────────────────────
 *
 * Streaming reasoning and in-flight tools used to be excluded from the fold
 * ("streaming stays live, never folded"), so at L1/L2 they rendered as FULL cards
 * and then, the instant they persisted, were replaced by trace rows. That swap is
 * not a style change, it is a change of element identity: a card is a bordered
 * Paper whose icon is a 16px chip at x=10 (card padding), a row is a borderless
 * 18.8px line whose icon is a 14px chip at x=18 (chevron slot + gap). Nothing is
 * shared, so React necessarily unmounts one and mounts the other and the reader
 * sees the icon jump 8px sideways and shrink, with the frame vanishing under it.
 *
 * Folding live content the same way removes the swap instead of trying to animate
 * it: a tool's row key is `tool-<toolUseId>`, which is IDENTICAL on both sides of
 * the hand-off (the same id `dropPersistedStreamingTools` matches on), so the
 * persisted row reuses the live row's DOM node and the transition is a no-op —
 * only the shimmer stops and the status glyph settles. Reasoning rows are keyed by
 * their ordinal inside the unit for the same reason (see `stableKeyBase`).
 *
 * The one exception is a tool AWAITING A PERMISSION DECISION: its approve/deny
 * form can only be hosted by a full card, and the shape change that follows the
 * decision is the direct result of a user action rather than an unprompted jump.
 */

import type { ActivityInput } from "./ActivityTrace";
import type { RenderSegment, ToolRunItem } from "./message-segments";
import type { NarratorMsg } from "./narrator-panel-types";
import { isReasoningBlock } from "./reasoning-segments";

/** Id of the synthetic live row (mirrors buildStreamingMsg / STREAMING_MESSAGE_ID). */
const STREAMING_MESSAGE_ID = "__streaming__";

export type RenderUnit =
	| { kind: "segment"; seg: RenderSegment }
	| {
			kind: "activity";
			items: ActivityInput[];
			sourceMessages: NarratorMsg[];
			sourceSegments: RenderSegment[];
	  };

/**
 * A tool awaiting the user's permission decision.
 *
 * `status === "pending"` IS that state: `narrator-permission.ts` writes it when it
 * creates the request and moves off it once the decision lands. Such a tool keeps
 * its full card at every LOD because the approve/deny form has nowhere else to
 * live — `PERMISSION_HOST_KINDS` only admits `tool-call` / `subagent-card`, so a
 * folded row would silently drop the controls the narrator is blocked on.
 */
export function isPermissionAwaitingToolItem(item: ToolRunItem): boolean {
	return item.tc.status === "pending";
}

export type ToolRunLodGroup =
	| { kind: "active"; item: ToolRunItem; index: number }
	| { kind: "folded"; items: ToolRunItem[]; startIndex: number };

/** True when a single tool item is mid-flight (running / pending / initializing). */
export function isActiveToolItem(item: ToolRunItem): boolean {
	const s = item.tc.status;
	return s === "running" || s === "pending" || s === "initializing";
}

/**
 * True when a tool item IS the most recent spec://tasks.json call, identified by
 * the shared `latestSpecTasksToolUseId` rule (the same id the task-board spinner
 * keys on). Such a card is kept fully expanded at every LOD — see
 * `groupToolRunItemsForLod`'s second parameter.
 */
export function isLatestSpecTasksToolItem(
	item: ToolRunItem,
	latestSpecTasksToolUseId: string | null | undefined,
): boolean {
	return latestSpecTasksToolUseId != null && item.tc.toolUseId === latestSpecTasksToolUseId;
}

/**
 * Split a mixed tool run into chronological low-LOD groups. Completed tools are
 * folded in contiguous batches, while active tools remain standalone at their
 * original positions. This prevents the live card from jumping above earlier
 * completed calls when the run is partially folded.
 *
 * `latestSpecTasksToolUseId` (optional) keeps the latest tasks.json call's card
 * out of the fold exactly like an active tool: it stays a standalone full card at
 * its original position. Omitted by the chunked path, which folds every completed
 * call as before.
 */
export function groupToolRunItemsForLod(
	items: ToolRunItem[],
	latestSpecTasksToolUseId?: string | null,
): ToolRunLodGroup[] {
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
		if (isActiveToolItem(item) || isLatestSpecTasksToolItem(item, latestSpecTasksToolUseId)) {
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

/**
 * True when ONE tool item must keep its full card instead of folding into the
 * activity trace.
 *
 * Running / streaming tools DO fold (that is what makes the hand-off invisible —
 * see the module header). Only two kinds keep their cards:
 *  - a tool blocked on a permission decision (its approve/deny form has nowhere
 *    else to live — see `isPermissionAwaitingToolItem`);
 *  - the most recent spec://tasks.json call, when the caller passes its tool-use
 *    id via `keepToolUseIds` (the vlist pins that card expanded at every LOD —
 *    the task board is the narrator's live working state).
 */
function isKeptToolItem(item: ToolRunItem, keepToolUseIds?: ReadonlySet<string>): boolean {
	if (isPermissionAwaitingToolItem(item)) return true;
	const toolUseId = item.tc.toolUseId;
	return !!toolUseId && keepToolUseIds != null && keepToolUseIds.has(toolUseId);
}

type ToolRunActivityPart = {
	/** `keep` renders as its own tool-run segment; `fold` joins the activity trace. */
	kind: "fold" | "keep";
	items: ToolRunItem[];
};

/**
 * Split a tool-run into chronological foldable / kept stretches.
 *
 * ⚠️ Per ITEM, not per segment. Excluding the whole run because ONE of its calls
 * must keep its card is what made a low LOD look like it had swallowed a tool: the
 * excluded run then reached the adapter as a plain tool-run, where L1/L2 collapse
 * its remaining completed calls into a `tool-run-count` — a bare "tool calls ×2"
 * line that names nothing. The same calls fold into the activity trace as NAMED
 * rows when no sibling is pinned, so the pin was silently downgrading its
 * neighbours from readable rows to an anonymous number.
 *
 * Source order survives the split: the caller emits the parts in sequence and
 * flushes the pending trace before a kept part, so a kept card stays exactly
 * between the calls that preceded and followed it.
 */
function splitToolRunForActivity(
	items: ToolRunItem[],
	keepToolUseIds?: ReadonlySet<string>,
): ToolRunActivityPart[] {
	const parts: ToolRunActivityPart[] = [];
	for (const item of items) {
		const kind: ToolRunActivityPart["kind"] = isKeptToolItem(item, keepToolUseIds)
			? "keep"
			: "fold";
		const last = parts[parts.length - 1];
		// Contiguous items of the same fate share one part, so a kept batch renders as
		// one run (keeping its in-run frame) and a foldable batch is absorbed at once.
		if (last && last.kind === kind) last.items.push(item);
		else parts.push({ kind, items: [item] });
	}
	return parts;
}

/**
 * The segment's own `sourceMessages`, narrowed to the messages a PART's items
 * belong to, in the segment's original order.
 *
 * Order matters: the activity unit's key and the L5 recency window are both read
 * off this list, and the renderer addresses a unit by its first message id.
 */
function sourceMessagesForPart(
	part: ToolRunActivityPart,
	sourceMessages: NarratorMsg[],
): NarratorMsg[] {
	const owners = new Set(part.items.map((item) => item.msg));
	const narrowed = sourceMessages.filter((msg) => owners.has(msg));
	// A part whose messages are not listed on the segment (defensive: the segmenter
	// always lists them) still reports its own owners rather than an empty list.
	if (narrowed.length > 0) return narrowed;
	const fallback: NarratorMsg[] = [];
	for (const msg of owners) {
		if (msg) fallback.push(msg);
	}
	return fallback;
}

/**
 * Tool-use ids owned by a PERSISTED (non-synthetic) message in these segments.
 *
 * Mirrors what `dropPersistedStreamingTools` does for the accumulator, but for the
 * fold: it is the set whose synthetic duplicates are redundant. Cheap — one pass over
 * the tool-run segments, which the caller is about to walk anyway.
 */
function collectPersistedFoldToolUseIds(segments: RenderSegment[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const seg of segments) {
		if (seg.kind !== "tool-run") continue;
		for (const item of seg.items) {
			const toolUseId = item.tc.toolUseId;
			if (toolUseId && item.msg?.id !== STREAMING_MESSAGE_ID) ids.add(toolUseId);
		}
	}
	return ids;
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
 * adjacent tool-run segments — INCLUDING live ones — merge into activity units.
 * Visible answer content and user messages remain plain segment units and preserve
 * their chronological positions.
 *
 * A tool that must keep its full card (permission-blocked, or named in
 * `keepToolUseIds`) is split out ON ITS OWN, as a one-item tool-run segment at its
 * original position; its siblings still fold. See `splitToolRunForActivity` for why
 * excluding the whole run instead made a low LOD lose a call entirely.
 *
 * Item order is preserved and item-level keys are stable ACROSS THE HAND-OFF:
 * tools key on `toolUseId` (identical live and persisted), reasoning on its
 * ordinal within the unit (`stableKeyBase`) rather than on the owning message id,
 * which changes from `__streaming__` to a real id when the turn is stored. That
 * stability is what lets React keep one DOM node for a row whose content merely
 * settled — and what a future animated LOD transition needs to pair rows against
 * their full-card counterparts.
 */
export function groupRenderUnits(
	segments: RenderSegment[],
	enabled: boolean,
	opts?: { keepToolUseIds?: ReadonlySet<string> },
): RenderUnit[] {
	if (!enabled) return segments.map((seg) => ({ kind: "segment", seg }));

	// Tool-use ids that a PERSISTED message already owns, collected over the whole
	// document before folding begins.
	//
	// Resolving the hand-off per unit is not sufficient: visible answer text flushes
	// the unit, so the persisted copy and the still-live synthetic one can land in two
	// DIFFERENT traces. Rows in separate traces are not React siblings, so that case
	// does not overlap — it lists the same call twice, which is quieter and worse.
	// A document-wide set settles it wherever the boundary happens to fall.
	const persistedToolUseIds = collectPersistedFoldToolUseIds(segments);

	const units: RenderUnit[] = [];
	let pending: ActivityInput[] = [];
	let pendingMessages: NarratorMsg[] = [];
	let pendingSegments: RenderSegment[] = [];
	/** Reasoning runs absorbed into the CURRENT unit, for `stableKeyBase`. */
	let pendingReasoningRuns = 0;

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
		pendingReasoningRuns = 0;
	};
	/**
	 * Absorb items into the current unit, collapsing the HAND-OFF pair of a tool.
	 *
	 * The hand-off has a window in which both copies of a tool exist: the persisted
	 * message has landed but `dropPersistedStreamingTools` has not yet retired the
	 * synthetic row for the same id. Before live content folded, the two lived in
	 * separate specs and `buildPretextLayoutManifest` disambiguated them (`#dup1`).
	 * Inside one trace there is no such guard, so both rows were emitted with the
	 * identical key `tool-<id>` — and because trace rows are absolutely positioned at
	 * their measured offsets, they painted ON TOP OF EACH OTHER.
	 *
	 * The PERSISTED copy wins: it carries the settled status, the real message id (so
	 * selection and the row menus work) and the final output. Keeping the synthetic one
	 * instead would make a finished call look like it were still running.
	 *
	 * ⚠️ Scoped to a synthetic/persisted PAIR on purpose. A provider RETRY can legally
	 * put the same tool-use id in two different persisted messages, and those are two
	 * real calls the reader must both see — collapsing them would hide history. They
	 * keep distinct row keys via `dedupeSuffix` instead.
	 */
	const absorb = (items: ActivityInput[], msgs: NarratorMsg[], seg: RenderSegment) => {
		for (const item of items) {
			if (item.kind === "tool" && item.tc.toolUseId) {
				const toolUseId = item.tc.toolUseId;
				const incomingIsSynthetic = item.msg?.id === STREAMING_MESSAGE_ID;
				// A synthetic copy whose tool is ALREADY persisted anywhere in the document
				// is redundant, wherever the two landed relative to a unit boundary.
				if (incomingIsSynthetic && persistedToolUseIds.has(toolUseId)) continue;
				const twinIndex = pending.findIndex(
					(candidate) =>
						candidate.kind === "tool" &&
						candidate.tc.toolUseId === toolUseId &&
						// Only the cross-kind pair collapses; persisted+persisted is a retry.
						(candidate.msg?.id === STREAMING_MESSAGE_ID) !== incomingIsSynthetic,
				);
				if (twinIndex >= 0) {
					// Replace in place when the newcomer is the persisted one, so the row keeps
					// its position and its DOM node across the hand-off.
					if (!incomingIsSynthetic) pending[twinIndex] = item;
					continue;
				}
				// A second PERSISTED copy of the same id (a retry) gets a suffix so its row
				// is distinct instead of overlapping.
				const sameIdCount = pending.reduce(
					(count, candidate) =>
						candidate.kind === "tool" && candidate.tc.toolUseId === toolUseId ? count + 1 : count,
					0,
				);
				pending.push(sameIdCount > 0 ? { ...item, dedupeSuffix: sameIdCount } : item);
				continue;
			}
			pending.push(item);
		}
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
						// One `stableKeyBase` per reasoning RUN, counted within the unit. The
						// blocks of a run share it and are distinguished by their offset, so a
						// run that persists under a different message id keeps its row keys.
						const base = `run${pendingReasoningRuns++}`;
						absorb(
							part.items.map((item, offset) => ({
								...item,
								stableKeyBase: base,
								stableKeyOffset: offset,
							})),
							[seg.msg],
							seg,
						);
					} else {
						flush();
						units.push({ kind: "segment", seg: part.segment });
					}
				}
				continue;
			}
		}
		if (seg.kind === "tool-run") {
			// Split PER ITEM: a call that must keep its card takes only itself out of
			// the fold, and its foldable neighbours still become named trace rows
			// instead of collapsing to an anonymous count line (see
			// splitToolRunForActivity).
			for (const part of splitToolRunForActivity(seg.items, opts?.keepToolUseIds)) {
				const partMessages = sourceMessagesForPart(part, seg.sourceMessages);
				if (part.kind === "fold") {
					absorb(toolItemsFromToolRunSegment({ ...seg, items: part.items }), partMessages, {
						...seg,
						items: part.items,
						sourceMessages: partMessages,
					});
					continue;
				}
				// A kept batch renders as its own tool-run segment, at its original
				// position between the folded stretches around it.
				flush();
				units.push({
					kind: "segment",
					seg: { ...seg, items: part.items, sourceMessages: partMessages },
				});
			}
			continue;
		}
		// Boundary: flush the pending activity group, then render this segment.
		flush();
		units.push({ kind: "segment", seg });
	}
	flush();
	return units;
}
