/**
 * Native session timeline: shared categories, wire types and the partition algorithm.
 *
 * One agent (a narrator) has exactly one lane per turn. A lane is CONTINUOUS: every
 * millisecond between its start and end belongs to exactly one segment, so waiting for
 * the user, reviews and pure scheduling overhead are counted instead of left as gaps.
 *
 * The server turns tool-call lifecycle stamps and model request timings into raw,
 * possibly overlapping intervals; `partitionTimeline` resolves overlaps by category
 * priority and fills the remainder with `overhead`. It lives here (not in the server)
 * so the frontend tests and the server share one definition of "what wins".
 */

/** Segment categories, in rendering-legend order. */
export const TIMELINE_CATEGORIES = [
	"model_wait",
	"model_output",
	"tool",
	"permission_wait",
	"user_reply_wait",
	"review",
	"subagent_wait",
	"compact",
	"overhead",
	"after_turn",
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

/**
 * Lower wins. Waiting on a human beats everything: while a permission prompt is open
 * the agent is blocked no matter what else is technically in flight. `overhead` and
 * `after_turn` are never raw intervals; they only fill what nothing covers.
 */
export const TIMELINE_CATEGORY_PRIORITY: Record<TimelineCategory, number> = {
	user_reply_wait: 1,
	permission_wait: 2,
	review: 3,
	subagent_wait: 4,
	tool: 5,
	compact: 6,
	model_output: 7,
	model_wait: 8,
	overhead: 9,
	after_turn: 10,
};

/** Upper bound of segments per lane; denser lanes merge their shortest slivers. */
export const TIMELINE_MAX_SEGMENTS = 2000;

/** A raw interval produced from one source row. Intervals may overlap freely. */
export interface TimelineInterval {
	category: Exclude<TimelineCategory, "overhead" | "after_turn">;
	startMs: number;
	endMs: number;
	/** Key into `TurnTimelineResponse.items`. */
	itemId: string;
}

export interface TimelineSegment {
	category: TimelineCategory;
	startMs: number;
	endMs: number;
	/** Items of the winning category covering this segment (parallel tools > 1). */
	itemIds: string[];
}

export type TimelineTotals = Partial<Record<TimelineCategory, number>>;

export interface PartitionResult {
	segments: TimelineSegment[];
	totals: TimelineTotals;
	/** True when slivers were merged to respect {@link TIMELINE_MAX_SEGMENTS}. */
	truncated: boolean;
}

export interface PartitionInput {
	startMs: number;
	endMs: number;
	intervals: readonly TimelineInterval[];
	/** Fill `[endMs, padEndMs]` with `after_turn` (the primary lane past its turn end). */
	padEndMs?: number;
	maxSegments?: number;
}

interface SweepEvent {
	at: number;
	delta: 1 | -1;
	interval: TimelineInterval;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Merge segments shorter than a growing threshold into their predecessor. */
function capSegments(segments: TimelineSegment[], max: number): TimelineSegment[] {
	let current = segments;
	let threshold = 1;
	while (current.length > max && threshold < Number.MAX_SAFE_INTEGER / 2) {
		const next: TimelineSegment[] = [];
		for (const segment of current) {
			const previous = next[next.length - 1];
			if (previous && segment.endMs - segment.startMs < threshold) {
				previous.endMs = segment.endMs;
				continue;
			}
			next.push({ ...segment });
		}
		current = next;
		threshold *= 2;
	}
	return current;
}

/**
 * Partition `[startMs, endMs]` into contiguous, non-overlapping segments.
 *
 * Sweep over interval endpoints; between two consecutive endpoints the active interval
 * with the best priority names the segment. Uncovered time is `overhead`. Adjacent
 * segments with the same category and the same item set are merged.
 */
export function partitionTimeline(input: PartitionInput): PartitionResult {
	const { startMs, endMs } = input;
	const segments: TimelineSegment[] = [];
	if (endMs > startMs) {
		const events: SweepEvent[] = [];
		for (const interval of input.intervals) {
			const from = Math.max(startMs, interval.startMs);
			const to = Math.min(endMs, interval.endMs);
			if (!(to > from)) continue;
			events.push({ at: from, delta: 1, interval }, { at: to, delta: -1, interval });
		}
		// Ends before starts at the same instant so a hand-off does not double count.
		events.sort((a, b) => a.at - b.at || a.delta - b.delta);

		const active = new Map<TimelineCategory, Map<string, number>>();
		const push = (category: TimelineCategory, from: number, to: number, itemIds: string[]) => {
			if (!(to > from)) return;
			const last = segments[segments.length - 1];
			if (
				last &&
				last.category === category &&
				last.endMs === from &&
				sameIds(last.itemIds, itemIds)
			) {
				last.endMs = to;
				return;
			}
			segments.push({ category, startMs: from, endMs: to, itemIds });
		};
		const winner = (): { category: TimelineCategory; itemIds: string[] } => {
			let best: TimelineCategory | null = null;
			for (const [category, items] of active) {
				if (items.size === 0) continue;
				if (!best || TIMELINE_CATEGORY_PRIORITY[category] < TIMELINE_CATEGORY_PRIORITY[best]) {
					best = category;
				}
			}
			if (!best) return { category: "overhead", itemIds: [] };
			return { category: best, itemIds: [...(active.get(best)?.keys() ?? [])].sort() };
		};

		let cursor = startMs;
		let index = 0;
		while (index < events.length) {
			const at = events[index].at;
			if (at > cursor) {
				const { category, itemIds } = winner();
				push(category, cursor, at, itemIds);
				cursor = at;
			}
			while (index < events.length && events[index].at === at) {
				const { delta, interval } = events[index];
				let items = active.get(interval.category);
				if (!items) {
					items = new Map();
					active.set(interval.category, items);
				}
				const count = (items.get(interval.itemId) ?? 0) + delta;
				if (count > 0) items.set(interval.itemId, count);
				else items.delete(interval.itemId);
				index++;
			}
		}
		if (endMs > cursor) {
			const { category, itemIds } = winner();
			push(category, cursor, endMs, itemIds);
		}
	}

	const max = input.maxSegments ?? TIMELINE_MAX_SEGMENTS;
	let truncated = false;
	let result = segments;
	if (result.length > max) {
		result = capSegments(result, max);
		truncated = true;
	}

	const padStart = Math.max(startMs, endMs);
	if (input.padEndMs !== undefined && input.padEndMs > padStart) {
		result.push({ category: "after_turn", startMs: padStart, endMs: input.padEndMs, itemIds: [] });
	}

	const totals: TimelineTotals = {};
	for (const segment of result) {
		totals[segment.category] = (totals[segment.category] ?? 0) + (segment.endMs - segment.startMs);
	}
	return { segments: result, totals, truncated };
}

// ── Wire types ──────────────────────────────────────────────────────────────

export type TimelineTurnStatus = "running" | "completed" | "interrupted" | "failed";

export interface TimelineTurnSummary {
	id: string;
	/** 1-based position among the narrator's turns (newest has the highest index). */
	index: number;
	status: TimelineTurnStatus;
	startedAt: string;
	endedAt: string | null;
	stopReason: string | null;
	/** First characters of the input that started the turn, when known. */
	triggerExcerpt: string | null;
	/** True when the turn was derived from user messages (no `narrator_turns` row). */
	derived: boolean;
}

export interface TimelineTurnsResponse {
	narratorId: string;
	turns: TimelineTurnSummary[];
	hasMore: boolean;
}

export interface TimelineToolItem {
	kind: "tool";
	id: string;
	toolUseId: string;
	toolName: string;
	summary: string | null;
	status: string;
	isBackground: boolean;
	executionDeviceId: string | null;
	errorMessage: string | null;
	permissionDecidedBy: string | null;
	streamStartedAt: string | null;
	permissionStartedAt: string | null;
	permissionDecidedAt: string | null;
	executionStartedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	/** Child narrator spawned by this call (Agent/Task). */
	childNarratorId: string | null;
}

export interface TimelineModelItem {
	kind: "model";
	id: string;
	requestKind: string;
	model: string | null;
	startedAt: string;
	endedAt: string;
	ttftMs: number | null;
	durationMs: number | null;
	inputTokens: number;
	outputTokens: number;
	errorMessage: string | null;
}

export type TimelineItem = TimelineToolItem | TimelineModelItem;

export interface TimelineLane {
	narratorId: string;
	title: string | null;
	type: "primary" | "subagent";
	subagentType: string | null;
	depth: number;
	parentNarratorId: string | null;
	/** Parent tool item (Agent call) this lane branches from. */
	spawnItemId: string | null;
	/** Moment on the parent lane the branch starts. */
	spawnAtMs: number | null;
	startMs: number;
	endMs: number;
	/** Still producing activity (running turn / unfinished spawn call). */
	live: boolean;
	segments: TimelineSegment[];
	totals: TimelineTotals;
	truncated: boolean;
}

export interface TurnTimelineResponse {
	narratorId: string;
	turn: TimelineTurnSummary | null;
	nowMs: number;
	/** Overall window: turn start to the latest lane end. */
	startMs: number;
	endMs: number;
	/** Primary lane first, then each child depth-first after its parent. */
	lanes: TimelineLane[];
	items: Record<string, TimelineItem>;
	/** Child lanes omitted because of the lane cap. */
	omittedLanes: number;
}
