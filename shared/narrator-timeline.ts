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

/** Item ids a merged segment keeps for its detail view. */
export const TIMELINE_MERGED_MAX_ITEMS = 20;

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
	/**
	 * Set when this segment stands for a run of slivers merged to respect the segment cap:
	 * `category` is the run's dominant category and `totals` its exact composition.
	 */
	merged?: { count: number; totals: TimelineTotals };
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

function addTotals(totals: TimelineTotals, segment: TimelineSegment): void {
	const ms = segment.endMs - segment.startMs;
	if (segment.merged) {
		for (const [category, value] of Object.entries(segment.merged.totals)) {
			const key = category as TimelineCategory;
			totals[key] = (totals[key] ?? 0) + (value ?? 0);
		}
	} else {
		totals[segment.category] = (totals[segment.category] ?? 0) + ms;
	}
}

/**
 * Coarsen to at most `max` segments in one pass. Segments at least `width` long are kept;
 * consecutive shorter ones are accumulated into runs that close once they reach `width`.
 * Kept segments and closed runs are each ≥ `width`, so together at most `span / width`; runs
 * cut short by a kept segment add at most as many again, plus the tail. With
 * `width = 2·span / (max − 1)` the result never exceeds `max`, whatever the distribution.
 */
function coarsenSegments(segments: TimelineSegment[], max: number): TimelineSegment[] {
	const first = segments[0];
	const last = segments[segments.length - 1];
	if (!first || !last) return segments;
	const width = (2 * (last.endMs - first.startMs)) / Math.max(1, max - 1);
	const out: TimelineSegment[] = [];
	let run: TimelineSegment[] = [];
	const flush = () => {
		if (run.length === 1) out.push(run[0]);
		else if (run.length > 1) {
			const totals: TimelineTotals = {};
			for (const segment of run) addTotals(totals, segment);
			let dominant: TimelineCategory = run[0].category;
			for (const category of TIMELINE_CATEGORIES) {
				if ((totals[category] ?? 0) > (totals[dominant] ?? 0)) dominant = category;
			}
			const itemIds = new Set<string>();
			for (const segment of run) {
				if (segment.category !== dominant) continue;
				for (const id of segment.itemIds) {
					if (itemIds.size >= TIMELINE_MERGED_MAX_ITEMS) break;
					itemIds.add(id);
				}
			}
			out.push({
				category: dominant,
				startMs: run[0].startMs,
				endMs: run[run.length - 1].endMs,
				itemIds: [...itemIds].sort(),
				merged: { count: run.length, totals },
			});
		}
		run = [];
	};
	for (const segment of segments) {
		if (segment.endMs - segment.startMs >= width) {
			flush();
			out.push(segment);
			continue;
		}
		run.push(segment);
		if (segment.endMs - run[0].startMs >= width) flush();
	}
	flush();
	return out;
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

	const padStart = Math.max(startMs, endMs);
	if (input.padEndMs !== undefined && input.padEndMs > padStart) {
		segments.push({
			category: "after_turn",
			startMs: padStart,
			endMs: input.padEndMs,
			itemIds: [],
		});
	}

	// Totals come from the exact partition, so coarsening never skews the proportions.
	const totals: TimelineTotals = {};
	for (const segment of segments) addTotals(totals, segment);
	const max = Math.max(2, input.maxSegments ?? TIMELINE_MAX_SEGMENTS);
	if (segments.length <= max) return { segments, totals, truncated: false };
	return { segments: coarsenSegments(segments, max), totals, truncated: true };
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

/** Detail of one tool call; its timing is already expressed by the segments. */
export interface TimelineToolItem {
	kind: "tool";
	id: string;
	toolName: string;
	summary: string | null;
	status: string;
	isBackground: boolean;
	executionDeviceId: string | null;
	errorMessage: string | null;
	permissionDecidedBy: string | null;
	durationMs: number | null;
	/** Child narrator spawned by this call (Agent/Task). */
	childNarratorId: string | null;
}

export interface TimelineModelItem {
	kind: "model";
	id: string;
	requestKind: string;
	model: string | null;
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
	/** Slivers were merged, or the lane hit its row cap (see `coveredUntilMs`). */
	truncated: boolean;
	/**
	 * Set when the lane's activity exceeded its row cap: segments stop here, and the rest of
	 * `[coveredUntilMs, endMs]` is unknown rather than idle.
	 */
	coveredUntilMs: number | null;
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
	/** Details of the items some segment references, so the payload scales with segments. */
	items: Record<string, TimelineItem>;
	/** Child lanes omitted because of the lane cap. */
	omittedLanes: number;
}
