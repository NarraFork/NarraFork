import { backgroundTasks, narrators } from "@server/db/schema";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { readQuery } from "../db/worker-read";
import {
	BackgroundOccupancyIndex,
	isOccupancyNarratorSeed,
	isOccupancyTaskActive,
	type OccupancyActiveTaskOptions,
	type OccupancyNarrator,
	type OccupancySnapshot,
	type OccupancyTask,
} from "./background-occupancy-index";

const PAGE_SIZE = 128;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_FIELD_BYTES = 1024;
const SLOW_MAINTENANCE_MS = 50;
const SLOW_LOG_INTERVAL_MS = 30_000;

/** Scalar aggregates for one serial maintenance pass, never one log per page. */
interface OccupancyMaintenanceObservation {
	workerReadElapsedMs: number;
	workerReadCount: number;
	rows: number;
	bytes: number;
	validationSyncMs: number;
	yieldWaitMs: number;
	ancestorSyncMs: number;
	rebuildSyncMs: number;
	pruneSyncMs: number;
	rebuildSourceNarratorRows: number;
	rebuildSourceTaskRows: number;
}

function observeMaintenanceSync<T>(
	observation: OccupancyMaintenanceObservation,
	field: "ancestorSyncMs" | "rebuildSyncMs" | "pruneSyncMs",
	work: () => T,
): T {
	const started = performance.now();
	try {
		return work();
	} finally {
		observation[field] += performance.now() - started;
	}
}

/** Injectable small-column port; tests never have to open the production DB. */
export interface BackgroundOccupancySource {
	scanNarrators(after: string | null, limit: number): Promise<OccupancyNarrator[]>;
	scanTasks(after: string | null, limit: number): Promise<OccupancyTask[]>;
	getNarrators(ids: string[]): Promise<OccupancyNarrator[]>;
	getTasks(ids: string[]): Promise<OccupancyTask[]>;
	getProjections(childId: string, after: string | null, limit: number): Promise<OccupancyTask[]>;
}

const narratorColumns = {
	id: narrators.id,
	createdAt: narrators.createdAt,
	parentNarratorId: narrators.parentNarratorId,
	type: narrators.type,
	status: narrators.status,
	backgroundStatus: narrators.backgroundStatus,
	isBackground: narrators.isBackground,
	legacySubagent: sql<boolean>`coalesce(${narrators.variant} like 'subagent:%', 0)`.mapWith(
		Boolean,
	),
	takenOver: sql<boolean>`instr(${narrators.substatus}, '"taken_over"') > 0`.mapWith(Boolean),
	// Keep both scopes explicitly qualified. Drizzle's single-table SELECT mode
	// strips interpolated column qualifiers, turning this into an id=id probe.
	hasProjection: sql<boolean>`exists(select 1 from background_tasks as occupancy_projection where
		occupancy_projection.id = narrators.id or
		(occupancy_projection.type = 'agent' and occupancy_projection.subagent_narrator_id = narrators.id))`.mapWith(
		Boolean,
	),
};
const taskColumns = {
	id: backgroundTasks.id,
	createdAt: backgroundTasks.createdAt,
	parentNarratorId: backgroundTasks.parentNarratorId,
	type: backgroundTasks.type,
	status: backgroundTasks.status,
	backgroundKind: backgroundTasks.backgroundKind,
	subagentNarratorId: backgroundTasks.subagentNarratorId,
};

/** Injectable DB handle also exercises the real SQL against an isolated in-memory DB. */
export function createDatabaseBackgroundOccupancySource(
	readDatabase: () => Promise<Pick<BunSQLiteDatabase, "select">>,
): BackgroundOccupancySource {
	return {
		async scanNarrators(after, limit) {
			const db = await readDatabase();
			return readQuery(
				db
					.select(narratorColumns)
					.from(narrators)
					.where(after === null ? undefined : gt(narrators.id, after))
					.orderBy(asc(narrators.id))
					.limit(limit),
				{ executionPolicy: "worker-required" },
			);
		},
		async scanTasks(after, limit) {
			const db = await readDatabase();
			return readQuery(
				db
					.select(taskColumns)
					.from(backgroundTasks)
					.where(after === null ? undefined : gt(backgroundTasks.id, after))
					.orderBy(asc(backgroundTasks.id))
					.limit(limit),
				{ executionPolicy: "worker-required" },
			);
		},
		async getNarrators(ids) {
			const db = await readDatabase();
			return readQuery(
				db
					.select(narratorColumns)
					.from(narrators)
					.where(inArray(narrators.id, ids))
					.limit(PAGE_SIZE),
				{ executionPolicy: "worker-required" },
			);
		},
		async getTasks(ids) {
			const db = await readDatabase();
			return readQuery(
				db
					.select(taskColumns)
					.from(backgroundTasks)
					.where(inArray(backgroundTasks.id, ids))
					.limit(PAGE_SIZE),
				{ executionPolicy: "worker-required" },
			);
		},
		async getProjections(childId, after, limit) {
			const db = await readDatabase();
			return readQuery(
				db
					.select(taskColumns)
					.from(backgroundTasks)
					.where(
						and(
							or(
								eq(backgroundTasks.id, childId),
								and(
									eq(backgroundTasks.type, "agent"),
									eq(backgroundTasks.subagentNarratorId, childId),
								),
							),
							after === null ? undefined : gt(backgroundTasks.id, after),
						),
					)
					.orderBy(asc(backgroundTasks.id))
					.limit(limit),
				{ executionPolicy: "worker-required" },
			);
		},
	};
}

/** Lazy import avoids session/service cycles and never opens a DB in pure graph tests. */
export const databaseBackgroundOccupancySource = createDatabaseBackgroundOccupancySource(
	async () => (await import("@server/db")).db,
);

class OccupancyGenerationCancelled extends Error {}

/**
 * Serial, coalescing maintenance queue. Initial reads populate a shadow graph;
 * events arriving while any page is in flight are replayed before publication.
 * Readers never query SQL, and never trigger another scan of historical rows.
 */
export class BackgroundOccupancyStore {
	private index = new BackgroundOccupancyIndex();
	private ready = false;
	private generation = 0;
	private worker: Promise<void> | null = null;
	private failure: unknown = null;
	private dirtyTasks = new Set<string>();
	private dirtyNarrators = new Set<string>();
	private removedNarrators = new Set<string>();
	private runtimeLive = new Set<string>();
	/** Old owners must survive failed reads even after source rows were replaced. */
	private pendingAffected = new Set<string>();
	private subscribers = new Map<string, (parentIds: readonly string[]) => void>();
	private lastSlowLogAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly source: BackgroundOccupancySource = databaseBackgroundOccupancySource,
	) {}

	/** Keyed replacement survives hot-reload without accumulating callbacks. */
	subscribe(key: string, listener: (parentIds: readonly string[]) => void): void {
		this.subscribers.set(key, listener);
	}

	start(): Promise<void> {
		return this.ensureReady();
	}

	ensureReady(): Promise<void> {
		if (this.worker) return this.worker;
		if (this.ready && !this.failure) return Promise.resolve();
		return this.launch(!this.ready);
	}

	async flush(): Promise<void> {
		if (!this.ready && !this.worker)
			throw new Error("Background occupancy store is not initialized");
		await this.ensureReady();
		while (this.worker || this.hasDirty()) {
			await (this.worker ?? this.launch(false));
		}
		if (this.failure) throw this.failure;
	}

	refreshTask(id: string): void {
		if (!id) return;
		this.dirtyTasks.add(id);
		this.schedule();
	}

	refreshNarrator(id: string): void {
		if (!id) return;
		this.dirtyNarrators.add(id);
		this.schedule();
	}

	refreshNarrators(ids: readonly string[]): void {
		for (const id of ids) if (id) this.dirtyNarrators.add(id);
		this.schedule();
	}

	setRuntimeLive(id: string, live: boolean): void {
		if (!id) return;
		if (live) this.runtimeLive.add(id);
		else this.runtimeLive.delete(id);
		this.refreshNarrator(id);
	}

	/** Must be called after the delete/reparent transaction has committed. */
	removeNarrators(ids: readonly string[]): void {
		for (const id of ids) {
			this.removedNarrators.add(id);
			this.runtimeLive.delete(id);
		}
		this.schedule();
	}

	resetForTests(): void {
		this.generation++;
		this.index = new BackgroundOccupancyIndex();
		this.ready = false;
		this.worker = null;
		this.failure = null;
		this.dirtyTasks.clear();
		this.dirtyNarrators.clear();
		this.removedNarrators.clear();
		this.runtimeLive.clear();
		this.pendingAffected = new Set();
		this.lastSlowLogAt = Number.NEGATIVE_INFINITY;
	}

	snapshot(ids: readonly string[]): OccupancySnapshot {
		this.assertReadable();
		return this.index.snapshot(ids);
	}

	get isReady(): boolean {
		return this.ready && !this.failure;
	}

	getActiveTaskIds(parentId: string, opts?: OccupancyActiveTaskOptions): string[] {
		this.assertReadable();
		return this.index.getActiveTaskIds(parentId, opts);
	}

	/**
	 * Active background work whose completion wakes the parent narrator
	 * (background bash tasks and subagents — never transfers or services).
	 * The done-notification suppression keys on this count: every suppressing
	 * task kind must guarantee a compensating wake-up turn after it completes.
	 */
	countActiveWakeWork(parentId: string): number {
		this.assertReadable();
		return this.index.getActiveWakeWorkCount(parentId);
	}

	getOccupiedChildIds(parentId: string, limit?: number): string[] {
		this.assertReadable();
		return this.index.getOccupiedChildIds(parentId, limit);
	}

	getActiveLegacyIds(parentId: string, limit?: number): string[] {
		this.assertReadable();
		return this.index.getActiveLegacyIds(parentId, limit);
	}

	getAncestorIds(id: string): string[] {
		this.assertReadable();
		return this.index.getAncestorIds(id);
	}

	private assertReadable(): void {
		if (this.failure) throw this.failure;
		if (!this.ready) throw new Error("Background occupancy store is not initialized");
	}

	private hasDirty(): boolean {
		return this.dirtyTasks.size + this.dirtyNarrators.size + this.removedNarrators.size > 0;
	}

	private schedule(): void {
		// Startup is explicit. Pre-start events stay queued for shadow replay.
		if (this.ready && !this.worker) this.launch(false);
	}

	private launch(initial: boolean): Promise<void> {
		const generation = this.generation;
		const work = this.maintain(initial, generation).then((parentIds) => {
			if (parentIds.length === 0) return;
			// Run after publication AND worker settlement. A listener may call
			// flush(), so neither invoke it inline nor await its returned promise.
			setImmediate(() => {
				if (generation !== this.generation) return;
				for (const [key, listener] of this.subscribers) {
					const failed = (error: unknown) =>
						logger.error("Background occupancy subscriber failed", { key, error: String(error) });
					try {
						void Promise.resolve(listener(parentIds)).catch(failed);
					} catch (error) {
						failed(error);
					}
				}
			});
		});
		this.worker = work;
		void work
			.catch((error: unknown) => {
				if (generation !== this.generation) return;
				this.failure = error;
				logger.error("Background occupancy maintenance failed", { error: String(error) });
			})
			.finally(() => {
				if (this.worker === work) {
					this.worker = null;
					if (!this.failure && this.ready && this.hasDirty()) this.launch(false);
				}
			});
		return work;
	}

	private checkGeneration(generation: number): void {
		if (generation !== this.generation) throw new OccupancyGenerationCancelled();
	}

	private async page<T extends OccupancyNarrator | OccupancyTask>(
		label: string,
		generation: number,
		read: () => Promise<T[]>,
		observation: OccupancyMaintenanceObservation,
	): Promise<T[]> {
		this.checkGeneration(generation);
		const readStarted = performance.now();
		observation.workerReadCount++;
		let rows: T[];
		try {
			rows = await read();
		} finally {
			// End-to-end wall elapsed: includes main-thread query preparation/result mapping,
			// worker queue/execution, delivery and scheduling; not isolated SQL or CPU time.
			observation.workerReadElapsedMs += performance.now() - readStarted;
		}
		this.checkGeneration(generation);
		observation.rows += rows.length;
		const validationStarted = performance.now();
		try {
			if (rows.length > PAGE_SIZE) throw new Error(`Background occupancy ${label}: row limit`);
			let bytes = 0;
			for (const row of rows) {
				for (const value of Object.values(row)) {
					if (typeof value !== "string") continue;
					const size = Buffer.byteLength(value);
					if (size > MAX_FIELD_BYTES) throw new Error(`Background occupancy ${label}: field limit`);
					bytes += size;
				}
			}
			observation.bytes += bytes;
			if (bytes > MAX_PAGE_BYTES) throw new Error(`Background occupancy ${label}: byte limit`);
		} finally {
			observation.validationSyncMs += performance.now() - validationStarted;
		}
		// An actual macrotask, not Promise.resolve(): let HTTP/WS and cancellation run.
		const yieldStarted = performance.now();
		await new Promise<void>((resolve) => setImmediate(resolve));
		observation.yieldWaitMs += performance.now() - yieldStarted;
		this.checkGeneration(generation);
		return rows;
	}

	private async scan<T extends OccupancyNarrator | OccupancyTask>(
		label: string,
		generation: number,
		read: (after: string | null, limit: number) => Promise<T[]>,
		accept: (row: T) => void,
		observation: OccupancyMaintenanceObservation,
	): Promise<void> {
		let cursor: string | null = null;
		for (;;) {
			const after: string | null = cursor;
			const rows: T[] = await this.page<T>(
				label,
				generation,
				() => read(after, PAGE_SIZE),
				observation,
			);
			for (const row of rows) accept(row);
			if (rows.length < PAGE_SIZE) break;
			cursor = rows[rows.length - 1].id;
			if (cursor === after) throw new Error(`Background occupancy ${label}: non-advancing cursor`);
		}
	}

	private async maintain(initial: boolean, generation: number): Promise<readonly string[]> {
		const started = performance.now();
		const observation: OccupancyMaintenanceObservation = {
			workerReadElapsedMs: 0,
			workerReadCount: 0,
			rows: 0,
			bytes: 0,
			validationSyncMs: 0,
			yieldWaitMs: 0,
			ancestorSyncMs: 0,
			rebuildSyncMs: 0,
			pruneSyncMs: 0,
			rebuildSourceNarratorRows: 0,
			rebuildSourceTaskRows: 0,
		};
		let completed = false;
		const target = initial ? new BackgroundOccupancyIndex() : this.index;
		const affected = this.pendingAffected;
		const changed = new Set<string>();
		const remember = (id: string) => {
			changed.add(id);
			this.collectAffected(target, id, affected);
		};
		try {
			if (initial) {
				await this.scan(
					"narrators",
					generation,
					(after, limit) => this.source.scanNarrators(after, limit),
					(row) => {
						if (isOccupancyNarratorSeed(row) || this.runtimeLive.has(row.id))
							target.upsertNarrator(row);
					},
					observation,
				);
				await this.scan(
					"tasks",
					generation,
					(after, limit) => this.source.scanTasks(after, limit),
					(row) => {
						if (isOccupancyTaskActive(row)) target.upsertTask(row);
					},
					observation,
				);
				const roots = new Set([...target.getNarratorIds(), ...this.runtimeLive]);
				for (const id of target.getTaskIds()) {
					const task = target.getTask(id);
					if (!task) continue;
					if (!(task.type === "bash" && task.backgroundKind === "service"))
						roots.add(task.parentNarratorId);
					if (task.type === "agent") roots.add(task.subagentNarratorId ?? task.id);
				}
				await this.hydrate(target, roots, generation, remember, new Set(), observation);
				for (const id of target.getNarratorIds()) remember(id);
				for (const id of target.getTaskIds()) {
					const task = target.getTask(id);
					if (task) remember(task.parentNarratorId);
				}
			}
			// Synchronously drain the dirty sets BEFORE each read. New events land in
			// new sets, so an older in-flight read can never clear their invalidation.
			while (this.hasDirty()) {
				const tasks = this.dirtyTasks;
				const nodes = this.dirtyNarrators;
				const removed = this.removedNarrators;
				this.dirtyTasks = new Set();
				this.dirtyNarrators = new Set();
				this.removedNarrators = new Set();
				try {
					this.removeBatch(target, removed, nodes, tasks, remember);
					await this.refreshTasks(target, tasks, nodes, generation, remember, observation);
					for (const id of nodes) remember(id);
					await this.hydrate(target, nodes, generation, remember, tasks, observation);
				} catch (error) {
					// Retain invalidations for an explicit retry; never publish a partial zero.
					if (generation === this.generation) {
						for (const id of tasks) this.dirtyTasks.add(id);
						for (const id of nodes) this.dirtyNarrators.add(id);
						for (const id of removed) this.removedNarrators.add(id);
					}
					throw error;
				}
			}
			this.checkGeneration(generation);
			// Multi-source traversal visits each old/new ancestor once, including on
			// cold startup with a deep live chain (per-root BFS would be quadratic).
			observeMaintenanceSync(observation, "ancestorSyncMs", () => {
				for (const id of target.getAncestorIdsForBatch(affected)) affected.add(id);
			});
			target.replaceRuntimeLive(this.runtimeLive);
			const rebuildSourceRows = target.sourceRowCounts;
			observation.rebuildSourceNarratorRows = rebuildSourceRows.narrators;
			observation.rebuildSourceTaskRows = rebuildSourceRows.tasks;
			observeMaintenanceSync(observation, "rebuildSyncMs", () => target.rebuild());
			observeMaintenanceSync(observation, "ancestorSyncMs", () => {
				for (const id of changed) this.collectAffected(target, id, affected);
				for (const id of target.getAncestorIdsForBatch(affected)) affected.add(id);
			});
			observeMaintenanceSync(observation, "pruneSyncMs", () => target.prune());
			this.index = target;
			this.ready = true;
			this.failure = null;
			this.pendingAffected = new Set();
			completed = true;
			return Object.freeze([...affected]);
		} finally {
			const now = performance.now();
			const elapsedMs = now - started;
			if (elapsedMs >= SLOW_MAINTENANCE_MS && now - this.lastSlowLogAt >= SLOW_LOG_INTERVAL_MS) {
				this.lastSlowLogAt = now;
				// O(1) source sizes, not an extra traversal/allocation to count graph edges.
				const sourceRows = target.sourceRowCounts;
				try {
					logger.warn("Slow background occupancy maintenance", {
						initial,
						completed,
						cancelled: generation !== this.generation,
						...observation,
						sourceNarratorRows: sourceRows.narrators,
						sourceTaskRows: sourceRows.tasks,
						changedNodes: changed.size,
						affectedNodes: affected.size,
						elapsedMs,
					});
				} catch {}
			}
		}
	}

	private collectAffected(
		target: BackgroundOccupancyIndex,
		id: string,
		affected: Set<string>,
	): void {
		affected.add(id);
		const row = target.getNarrator(id);
		if (
			row?.parentNarratorId &&
			(row.type === "subagent" || row.isBackground || row.legacySubagent)
		) {
			affected.add(row.parentNarratorId);
		}
	}

	private removeBatch(
		target: BackgroundOccupancyIndex,
		removed: ReadonlySet<string>,
		nodes: Set<string>,
		tasks: Set<string>,
		remember: (id: string) => void,
	): void {
		const result = target.deleteNarrators(removed);
		for (const id of result.affectedIds) remember(id);
		for (const id of result.narratorIds) nodes.add(id);
		for (const id of result.taskIds) tasks.add(id);
		// Removed historical ids need neither hydration nor a notification each.
		for (const id of removed) nodes.delete(id);
	}

	private async refreshTasks(
		target: BackgroundOccupancyIndex,
		tasks: ReadonlySet<string>,
		nodes: Set<string>,
		generation: number,
		remember: (id: string) => void,
		observation: OccupancyMaintenanceObservation,
	): Promise<void> {
		const ids = [...tasks];
		for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
			const batch = ids.slice(offset, offset + PAGE_SIZE);
			for (const id of batch) {
				const old = target.getTask(id);
				if (old) remember(old.parentNarratorId);
				if (old?.type === "agent") nodes.add(old.subagentNarratorId ?? old.id);
				target.deleteTask(id);
			}
			const rows = await this.page(
				"dirty tasks",
				generation,
				() => this.source.getTasks(batch),
				observation,
			);
			for (const row of rows) {
				remember(row.parentNarratorId);
				target.upsertTask(row);
				if (row.type === "agent") nodes.add(row.subagentNarratorId ?? row.id);
				if (!(row.type === "bash" && row.backgroundKind === "service"))
					nodes.add(row.parentNarratorId);
			}
		}
	}

	/** Walk UP from seeds via PK + subagent-index probes, never through historical siblings. */
	private async hydrate(
		target: BackgroundOccupancyIndex,
		roots: Set<string>,
		generation: number,
		remember: (id: string) => void,
		retryTasks: Set<string>,
		observation: OccupancyMaintenanceObservation,
	): Promise<void> {
		const visited = new Set<string>();
		const removed = new Set<string>();
		let frontier = [...roots];
		while (frontier.length > 0) {
			const next = new Set<string>();
			const checked: string[] = [];
			const missing = new Set<string>();
			for (let offset = 0; offset < frontier.length; offset += PAGE_SIZE) {
				const batch = frontier.slice(offset, offset + PAGE_SIZE).filter((id) => !visited.has(id));
				if (batch.length === 0) continue;
				for (const id of batch) {
					visited.add(id);
					roots.add(id);
					checked.push(id);
				}
				const rows = await this.page(
					"ancestor narrators",
					generation,
					() => this.source.getNarrators(batch),
					observation,
				);
				const found = new Set(rows.map((row) => row.id));
				for (const id of batch) if (!found.has(id) && !removed.has(id)) missing.add(id);
				for (const row of rows) {
					remember(row.id);
					target.upsertNarrator(row);
					if (row.type === "subagent" && row.parentNarratorId && !visited.has(row.parentNarratorId))
						next.add(row.parentNarratorId);
				}
			}
			// Missing rows are a deletion batch too: collect survivors and old
			// owners before cascading, then re-read tasks that may have migrated.
			if (missing.size > 0) {
				const tasks = new Set<string>();
				const survivors = new Set<string>();
				this.removeBatch(target, missing, survivors, tasks, remember);
				for (const id of missing) removed.add(id);
				for (const id of tasks) retryTasks.add(id);
				for (const id of survivors) roots.add(id);
				await this.refreshTasks(target, tasks, survivors, generation, remember, observation);
				for (const id of survivors) {
					roots.add(id);
					if (removed.has(id)) continue;
					visited.delete(id);
					next.add(id);
				}
			}
			for (const id of checked) {
				// Replace, do not append: a projection may have been deleted or
				// reparented while the child itself remains occupied.
				for (const taskId of target.getProjectionTaskIds(id)) {
					const old = target.getTask(taskId);
					if (old) remember(old.parentNarratorId);
					target.deleteTask(taskId);
				}
				await this.scan(
					`projections:${id}`,
					generation,
					(after, limit) => this.source.getProjections(id, after, limit),
					(task) => {
						if (task.type === "agent" || isOccupancyTaskActive(task)) {
							remember(task.parentNarratorId);
							target.upsertTask(task);
						}
						if (task.type !== "agent") return;
						if (!visited.has(task.parentNarratorId)) next.add(task.parentNarratorId);
						const child = task.subagentNarratorId ?? task.id;
						if (child !== id && !visited.has(child)) next.add(child);
					},
					observation,
				);
			}
			frontier = [...next];
		}
	}
}

export const backgroundOccupancyStore = hotSafe(
	"narrafork:background-occupancy-store",
	() => new BackgroundOccupancyStore(),
);
