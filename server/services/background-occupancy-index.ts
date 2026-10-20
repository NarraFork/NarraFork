import {
	BACKGROUND_TASK_ACTIVE_LIMIT,
	type BackgroundTaskActiveCounts,
} from "@shared/background-task-list";

/** Deliberately excludes message, output, title and other unbounded columns. */
export interface OccupancyNarrator {
	id: string;
	parentNarratorId: string | null;
	type: string;
	status: string;
	backgroundStatus: string | null;
	isBackground: boolean | null;
	legacySubagent: boolean;
	takenOver: boolean;
	hasProjection: boolean;
	createdAt?: string;
}

export interface OccupancyTask {
	id: string;
	parentNarratorId: string;
	type: string;
	status: string;
	backgroundKind: string | null;
	subagentNarratorId: string | null;
	createdAt?: string;
}

export interface OccupancyActiveTaskOptions {
	/** undefined: all active tasks; false: work only; true: bash services only. */
	serviceOnly?: boolean;
	limit?: number;
}

export interface OccupancyRemoval {
	/** Surviving children/projections whose post-transaction ownership must be read. */
	narratorIds: Set<string>;
	taskIds: Set<string>;
	/** Indexed removed nodes and old owners, never all unindexed historical ids. */
	affectedIds: Set<string>;
}

export interface OccupancySnapshot {
	counts: Map<string, BackgroundTaskActiveCounts>;
	childCounts: Map<string, number>;
	/** Only requested ids, not a copy of the entire live closure. */
	occupied: Set<string>;
}

export function isOccupancyTaskActive(task: OccupancyTask): boolean {
	return task.status === "running" || task.status === "paused";
}

export function isOccupancyNarratorSeed(row: OccupancyNarrator): boolean {
	return (
		row.status === "working" ||
		row.status === "waiting" ||
		row.takenOver ||
		(row.backgroundStatus === "running" && !row.hasProjection)
	);
}

function isService(task: OccupancyTask): boolean {
	return task.type === "bash" && task.backgroundKind === "service";
}

function childId(task: OccupancyTask): string {
	return task.subagentNarratorId ?? task.id;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	let values = map.get(key);
	if (!values) {
		values = new Set();
		map.set(key, values);
	}
	values.add(value);
}

/** Materialize ordering once per maintenance batch, never during list reads. */
function orderedBuckets(
	buckets: Map<string, Set<string>>,
	createdAt: (id: string) => string | undefined,
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const [parent, ids] of buckets) {
		result.set(
			parent,
			[...ids].sort((left, right) => {
				const a = createdAt(left) ?? "";
				const b = createdAt(right) ?? "";
				if (a !== b) return a > b ? -1 : 1;
				return left === right ? 0 : left > right ? -1 : 1;
			}),
		);
	}
	return result;
}

function limitedIds(ids: string[] | undefined, limit: number | undefined): string[] {
	return ids?.slice(0, limit === undefined ? undefined : Math.max(0, Math.trunc(limit))) ?? [];
}

/**
 * Maintained, work-seeded graph. Only mutation batches traverse this graph; all
 * reads use materialized maps. Rebuilding reachability from seeds (rather than
 * reference-counting occupied neighbours) lets even a closed cycle go idle.
 * The coordinator supplies only active seeds, their ancestors and projections.
 */
export class BackgroundOccupancyIndex {
	constructor(private readonly maxSourceRows = 100_000) {}

	private narrators = new Map<string, OccupancyNarrator>();
	private tasks = new Map<string, OccupancyTask>();
	private projectionTasks = new Map<string, Set<string>>();
	private runtimeLive = new Set<string>();
	private occupied = new Set<string>();
	private parents = new Map<string, Set<string>>();
	private occupiedChildren = new Map<string, string[]>();
	private activeTasks = new Map<string, string[]>();
	private activeWorkTasks = new Map<string, string[]>();
	private activeServiceTasks = new Map<string, string[]>();
	private activeLegacy = new Map<string, string[]>();
	private counts = new Map<string, BackgroundTaskActiveCounts>();
	private wakeWorkCounts = new Map<string, number>();
	private childCounts = new Map<string, number>();

	upsertNarrator(row: OccupancyNarrator): void {
		if (!this.narrators.has(row.id)) this.assertSourceCapacity();
		this.narrators.set(row.id, row);
	}

	private assertSourceCapacity(): void {
		if (this.narrators.size + this.tasks.size >= this.maxSourceRows) {
			throw new Error("Background occupancy active graph source limit exceeded");
		}
	}

	upsertTask(row: OccupancyTask): void {
		if (!this.tasks.has(row.id)) this.assertSourceCapacity();
		this.deleteTask(row.id);
		this.tasks.set(row.id, row);
		if (row.type === "agent") add(this.projectionTasks, childId(row), row.id);
	}

	getProjectionTaskIds(id: string): string[] {
		const ids = new Set(this.projectionTasks.get(id));
		if (this.tasks.has(id)) ids.add(id);
		return [...ids];
	}

	replaceRuntimeLive(ids: Iterable<string>): void {
		this.runtimeLive = new Set(ids);
	}

	getNarrator(id: string): OccupancyNarrator | undefined {
		return this.narrators.get(id);
	}

	getTask(id: string): OccupancyTask | undefined {
		return this.tasks.get(id);
	}

	getNarratorIds(): string[] {
		return [...this.narrators.keys()];
	}

	getTaskIds(): string[] {
		return [...this.tasks.keys()];
	}

	deleteTask(id: string): void {
		const task = this.tasks.get(id);
		if (task?.type === "agent") {
			const child = childId(task);
			const ids = this.projectionTasks.get(child);
			ids?.delete(id);
			if (ids?.size === 0) this.projectionTasks.delete(child);
		}
		this.tasks.delete(id);
	}

	deleteNarrator(id: string): void {
		this.deleteNarrators(new Set([id]));
	}

	/** One pass over live sources, independent of the number of cold deleted ids. */
	deleteNarrators(ids: ReadonlySet<string>): OccupancyRemoval {
		const result: OccupancyRemoval = {
			narratorIds: new Set(),
			taskIds: new Set(),
			affectedIds: new Set(),
		};
		if (ids.size === 0) return result;
		for (const [id, row] of this.narrators) {
			if (ids.has(id)) {
				result.affectedIds.add(id);
				if (
					row.parentNarratorId &&
					(row.type === "subagent" || row.isBackground || row.legacySubagent)
				)
					result.affectedIds.add(row.parentNarratorId);
				this.narrators.delete(id);
			} else if (row.parentNarratorId && ids.has(row.parentNarratorId)) {
				result.narratorIds.add(id);
			}
		}
		for (const [id, task] of this.tasks) {
			if (
				!ids.has(task.parentNarratorId) &&
				!(task.subagentNarratorId && ids.has(task.subagentNarratorId))
			)
				continue;
			result.taskIds.add(id);
			result.affectedIds.add(task.parentNarratorId);
			if (task.type === "agent" && !ids.has(childId(task))) result.narratorIds.add(childId(task));
			this.deleteTask(id);
		}
		for (const id of ids) {
			if (this.runtimeLive.delete(id)) result.affectedIds.add(id);
		}
		return result;
	}

	setRuntimeLive(id: string, live: boolean): void {
		if (live) this.runtimeLive.add(id);
		else this.runtimeLive.delete(id);
	}

	/** Called once per complete maintenance batch, never from snapshot(). */
	rebuild(): void {
		const parents = new Map<string, Set<string>>();
		const children = new Map<string, Set<string>>();
		const seeds = new Set(this.runtimeLive);
		const ownWork = new Map<string, number>();
		const link = (parent: string | null, child: string) => {
			if (!parent || parent === child) return;
			add(parents, child, parent);
			add(children, parent, child);
		};
		for (const row of this.narrators.values()) {
			// A primary's parent is fork provenance, not team ownership.
			if (row.type === "subagent") link(row.parentNarratorId, row.id);
			if (isOccupancyNarratorSeed(row)) seeds.add(row.id);
		}
		for (const task of this.tasks.values()) {
			if (task.type === "agent") {
				link(task.parentNarratorId, childId(task));
				if (isOccupancyTaskActive(task)) seeds.add(childId(task));
			} else if (isOccupancyTaskActive(task) && !isService(task)) {
				seeds.add(task.parentNarratorId);
				ownWork.set(task.parentNarratorId, (ownWork.get(task.parentNarratorId) ?? 0) + 1);
			}
		}
		const occupied = new Set(seeds);
		const queue = [...seeds];
		for (let i = 0; i < queue.length; i++) {
			for (const parent of parents.get(queue[i]) ?? []) {
				if (occupied.has(parent)) continue;
				occupied.add(parent);
				queue.push(parent);
			}
		}
		const occupiedChildren = new Map<string, Set<string>>();
		const childCounts = new Map(ownWork);
		for (const [parent, ids] of children) {
			for (const id of ids) {
				if (!occupied.has(id)) continue;
				add(occupiedChildren, parent, id);
				childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
			}
		}
		const work = new Map<string, number>();
		const services = new Map<string, number>();
		const wakeWork = new Map<string, number>();
		const activeTasks = new Map<string, Set<string>>();
		const activeWorkTasks = new Map<string, Set<string>>();
		const activeServiceTasks = new Map<string, Set<string>>();
		const activeLegacy = new Map<string, Set<string>>();
		// Narrators that themselves have work whose terminal commit publishes a wake.
		// Used to tell "this legacy subagent is still doing wake-capable work" apart
		// from "it is only occupied because a transfer seeded it".
		const directWakeIds = new Set<string>();
		for (const task of this.tasks.values()) {
			if (!isOccupancyTaskActive(task) && !(task.type === "agent" && occupied.has(childId(task))))
				continue;
			add(activeTasks, task.parentNarratorId, task.id);
			add(isService(task) ? activeServiceTasks : activeWorkTasks, task.parentNarratorId, task.id);
			const bucket = isService(task) ? services : work;
			bucket.set(task.parentNarratorId, (bucket.get(task.parentNarratorId) ?? 0) + 1);
			// Wake-work counts only a task that is still going to publish a wake.
			// A completed agent row kept alive because its child is occupied must
			// not count: that publication already happened, and the child's
			// remaining occupancy may be a transfer, which never publishes. Counting
			// it would suppress a done with nothing left to re-raise it. Transfers
			// and services never publish a parent wake either.
			if (isOccupancyTaskActive(task) && !isService(task) && task.type !== "transfer") {
				wakeWork.set(task.parentNarratorId, (wakeWork.get(task.parentNarratorId) ?? 0) + 1);
				directWakeIds.add(task.parentNarratorId);
				if (task.type === "agent") directWakeIds.add(childId(task));
			}
		}
		for (const row of this.narrators.values()) {
			if (
				row.parentNarratorId &&
				!row.hasProjection &&
				(row.isBackground || row.legacySubagent) &&
				occupied.has(row.id)
			) {
				add(activeLegacy, row.parentNarratorId, row.id);
				work.set(row.parentNarratorId, (work.get(row.parentNarratorId) ?? 0) + 1);
				// A projection-less background narrator wakes its parent when THAT
				// narrator completes (background session, in-flight turn, or its own
				// wake-capable task). Occupancy that exists only because a transfer
				// seeded the row does not: the transfer's terminal commit skips
				// publication, so counting it swallows the parent's done for good.
				if (
					isOccupancyNarratorSeed(row) ||
					directWakeIds.has(row.id) ||
					this.runtimeLive.has(row.id)
				) {
					wakeWork.set(row.parentNarratorId, (wakeWork.get(row.parentNarratorId) ?? 0) + 1);
				}
			}
		}
		const counts = new Map<string, BackgroundTaskActiveCounts>();
		for (const id of new Set([...work.keys(), ...services.keys()])) {
			const activeWorkCount = Math.min(work.get(id) ?? 0, BACKGROUND_TASK_ACTIVE_LIMIT);
			const activeServiceCount = Math.min(services.get(id) ?? 0, BACKGROUND_TASK_ACTIVE_LIMIT);
			counts.set(id, {
				activeCount: activeWorkCount + activeServiceCount,
				activeWorkCount,
				activeServiceCount,
			});
		}
		this.occupied = occupied;
		this.parents = parents;
		const taskCreatedAt = (id: string) => this.tasks.get(id)?.createdAt;
		const narratorCreatedAt = (id: string) => this.narrators.get(id)?.createdAt;
		this.occupiedChildren = orderedBuckets(occupiedChildren, narratorCreatedAt);
		this.activeTasks = orderedBuckets(activeTasks, taskCreatedAt);
		this.activeWorkTasks = orderedBuckets(activeWorkTasks, taskCreatedAt);
		this.activeServiceTasks = orderedBuckets(activeServiceTasks, taskCreatedAt);
		this.activeLegacy = orderedBuckets(activeLegacy, narratorCreatedAt);
		this.counts = counts;
		this.wakeWorkCounts = wakeWork;
		this.childCounts = childCounts;
	}

	/** Discard historical leaves, including seedless strongly-connected components. */
	prune(): void {
		for (const id of this.narrators.keys()) {
			if (!this.occupied.has(id)) this.narrators.delete(id);
		}
		for (const [id, task] of this.tasks) {
			if (
				!isOccupancyTaskActive(task) &&
				!(task.type === "agent" && this.occupied.has(childId(task)))
			)
				this.deleteTask(id);
		}
		// Remove the now-unreachable graph edges too, not just the source rows.
		for (const id of this.parents.keys()) {
			if (!this.occupied.has(id)) this.parents.delete(id);
		}
	}

	snapshot(ids: readonly string[]): OccupancySnapshot {
		const counts = new Map<string, BackgroundTaskActiveCounts>();
		const childCounts = new Map<string, number>();
		const occupied = new Set<string>();
		for (const id of ids) {
			counts.set(id, {
				...(this.counts.get(id) ?? { activeCount: 0, activeWorkCount: 0, activeServiceCount: 0 }),
			});
			childCounts.set(id, this.childCounts.get(id) ?? 0);
			if (this.occupied.has(id)) occupied.add(id);
		}
		return { counts, childCounts, occupied };
	}

	getActiveTaskIds(parentId: string, opts: OccupancyActiveTaskOptions = {}): string[] {
		const buckets =
			opts.serviceOnly === undefined
				? this.activeTasks
				: opts.serviceOnly
					? this.activeServiceTasks
					: this.activeWorkTasks;
		return limitedIds(buckets.get(parentId), opts.limit);
	}

	/**
	 * Active per-parent count of background work whose completion WAKES the
	 * parent narrator: running/paused bash tasks and subagent projections, plus
	 * legacy projection-less narrators that are themselves still in flight.
	 * Transfers are excluded, and so is a finished agent projection that is only
	 * still indexed because a descendant (often a transfer) remains occupied —
	 * that publication already happened. Services are not work.
	 */
	getActiveWakeWorkCount(parentId: string): number {
		return this.wakeWorkCounts.get(parentId) ?? 0;
	}

	getOccupiedChildIds(parentId: string, limit?: number): string[] {
		return limitedIds(this.occupiedChildren.get(parentId), limit);
	}

	getActiveLegacyIds(parentId: string, limit?: number): string[] {
		return limitedIds(this.activeLegacy.get(parentId), limit);
	}

	getAncestorIds(id: string): string[] {
		return this.getAncestorIdsForBatch([id]);
	}

	/** Union of ancestors, excluding input ids; each live graph vertex is probed once. */
	getAncestorIdsForBatch(ids: Iterable<string>): string[] {
		const seen = new Set(ids);
		const result: string[] = [];
		const queue = [...seen];
		for (let i = 0; i < queue.length; i++) {
			for (const parent of this.parents.get(queue[i]) ?? []) {
				if (seen.has(parent)) continue;
				seen.add(parent);
				result.push(parent);
				queue.push(parent);
			}
		}
		return result;
	}
}
