import type { Database } from "bun:sqlite";
import {
	type ContextCharCache,
	type ContextComposition,
	type ContextSegment,
	emptyContextComposition,
	groupContextSegments,
	safeCharacters,
} from "@shared/context-composition";
import {
	type ContextInputCharacters,
	type ContextUsageSnapshot,
	parseContextUsageSnapshot,
} from "@shared/context-usage";
import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narrators } from "../db/schema";
import { hasPendingContextCharacterRefresh } from "../lib/context-characters";
import {
	boundedContextSnapshot,
	parseContextSnapshot,
	validInputCharacters,
} from "../lib/context-usage-snapshot";
import { AppError, NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	CONTEXT_COMPOSITION_LIMITS,
	readContextHistoryEntries,
	yieldContextReader,
} from "./context-composition-history";
import { readContextSegments } from "./context-composition-projection";
import { ContextNumericCache, type NumericState } from "./context-numeric-cache";

export type ContextRebuildMetrics = {
	narratorId: string;
	mode: "cold" | "incremental";
	rows: number;
	queries: number;
	retries: number;
	activeJobs: number;
	/** Running-job wall time, including cooperative timer yields; NOT CPU/blocking time. */
	activeMs: number;
	/** Time spent inside measured synchronous SQL calls (history reader and revision checks). */
	sqlMs: number;
	maxSqlMs: number;
	waitMs: number;
	elapsedMs: number;
};

const CONTEXT_REBUILD_BUDGET_MS = 10 * 60 * 1000;
class ContextRevisionChanged extends Error {}
class ContextActorRemoved extends Error {}
function profileOf(meta: Metadata): "primary" | "subagent" {
	return meta.type === "subagent" || meta.variant.startsWith("subagent:") ? "subagent" : "primary";
}
type Metadata = {
	type: string;
	variant: string;
	revision: number;
	messageVersion: number;
	systemChars: number;
	summaryChars: number;
	toolsChars: number;
	cache: string | null;
	usage: string | null;
};
function revisionOf(meta: Metadata) {
	return [
		"profile-v3",
		profileOf(meta),
		meta.type,
		meta.variant,
		meta.revision,
		meta.messageVersion,
		meta.systemChars,
		meta.summaryChars,
		meta.toolsChars,
	].join(":");
}
function cacheOf(json: string | null): ContextCharCache | null {
	try {
		if (json && json.length > 16 * 1024) return null;
		const cache = json ? JSON.parse(json) : null;
		return (
			parseContextUsageSnapshot({
				requestId: "numeric-cache",
				startedAt: "1970-01-01T00:00:00Z",
				source: "estimate",
				percentage: null,
				contextWindow: null,
				occupiedTokens: null,
				inputCharacters: null,
				composition: cache,
			})?.composition ?? null
		);
	} catch {
		return null;
	}
}

/** Dependency injection keeps tests on disposable SQLite schemas and avoids runtime reconstruction. */
export function createContextCharacterService(
	database: Database,
	options: {
		budgetMs?: number;
		debounceMs?: number;
		onMetrics?: (metrics: ContextRebuildMetrics) => void;
	} = {},
) {
	const budgetMs = options.budgetMs ?? CONTEXT_REBUILD_BUDGET_MS;
	const debounceMs = options.debounceMs ?? 100;
	const numeric = new ContextNumericCache();
	type Pending = {
		ids: Set<string> | null;
		first: number;
		due: number;
		retries: number;
		cleanup?: boolean;
	};
	const pending = new Map<string, Pending>();
	const jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let invalidations = 0;
	const slowLogged = new Map<string, number>();
	const cleaned = new Set<string>();
	let overflowCursor: string | undefined;
	const cancelled = new Set<string>();
	let cancellationBackpressureLoggedAt = -Infinity;
	let activeSweep: Promise<void> | undefined;
	let sweepEnqueueEpoch = 0;
	const metadata = (id: string) =>
		database
			.query<Metadata, [string]>(
				`SELECT type, variant, context_char_revision AS revision, message_version AS messageVersion,
		 context_system_chars AS systemChars, context_summary_chars AS summaryChars,
		 context_tools_chars AS toolsChars,
		 CASE WHEN length(context_char_cache_json) <= 16384 THEN context_char_cache_json END AS cache,
		 CASE WHEN length(context_usage_snapshot_json) <= 16384 THEN context_usage_snapshot_json END AS usage
		 FROM narrators WHERE id = ?`,
			)
			.get(id);
	async function deleteGeneration(id: string, generation: string) {
		while (true) {
			const result = database
				.query(
					`DELETE FROM narrator_context_char_pages WHERE id IN
				 (SELECT id FROM narrator_context_char_pages WHERE narrator_id = ? AND generation = ? LIMIT 64)`,
				)
				.run(id, generation);
			if (!result.changes) break;
			await yieldContextReader();
		}
	}
	async function deleteOrphanPages(id: string, buildingGeneration?: string) {
		while (true) {
			// Protect the live published pointer in the same statement as deletion.
			// A process restart can leave generations absent from every in-memory job.
			const result = database
				.query(
					`DELETE FROM narrator_context_char_pages WHERE id IN (
				 SELECT p.id FROM narrator_context_char_pages p WHERE p.narrator_id = ?
				 AND (? IS NULL OR p.generation != ?)
				 AND p.generation != coalesce((SELECT CASE
				 WHEN length(context_char_cache_json) > 16384 THEN NULL
				 WHEN json_valid(context_char_cache_json) THEN json_extract(context_char_cache_json, '$.generation')
				 END FROM narrators WHERE id = ?), '')
				 AND p.generation != coalesce((SELECT CASE
				 WHEN length(context_usage_snapshot_json) > 16384 THEN NULL
				 WHEN json_valid(context_usage_snapshot_json) THEN json_extract(context_usage_snapshot_json, '$.composition.generation')
				 END FROM narrators WHERE id = ?), '') LIMIT 64
				)`,
				)
				.run(id, buildingGeneration ?? null, buildingGeneration ?? null, id, id);
			if (!result.changes) break;
			await yieldContextReader();
		}
	}
	async function rebuild(
		id: string,
		signal: AbortSignal,
		deadline: number,
		dirty: Pending,
		metrics: ContextRebuildMetrics,
	) {
		const checkBudget = () => {
			signal.throwIfAborted();
			if (disposed) throw new DOMException("Context cache service disposed", "AbortError");
			if (performance.now() >= deadline)
				throw new Error("Context character rebuild budget exceeded");
		};
		checkBudget();
		await deleteOrphanPages(id);
		if (cleaned.size >= 32) cleaned.clear();
		cleaned.add(id);
		if (dirty.cleanup) return;
		{
			checkBudget();
			const meta = metadata(id);
			if (!meta) {
				numeric.delete(id);
				return;
			}
			const revision = revisionOf(meta);
			const previous = cacheOf(meta.cache);
			if (previous?.revision === revision) return;
			let checkedAt = 0;
			const check = (force = false) => {
				checkBudget();
				if (!force && performance.now() - checkedAt < 4) return;
				checkedAt = performance.now();
				metrics.queries++;
				const sqlStart = performance.now();
				const current = metadata(id);
				const sqlMs = performance.now() - sqlStart;
				metrics.sqlMs += sqlMs;
				metrics.maxSqlMs = Math.max(metrics.maxSqlMs, sqlMs);
				if (!current) throw new ContextActorRemoved();
				if (revisionOf(current) !== revision) throw new ContextRevisionChanged();
			};
			const generation = crypto.randomUUID();
			let page = 0;
			let segments: ContextSegment[] = [];
			const totals = groupContextSegments([]);
			let totalChars = 0;
			const flush = () => {
				if (!segments.length) return;
				database
					.query(
						`INSERT INTO narrator_context_char_pages (id,narrator_id,generation,page,segments_json) VALUES (?,?,?,?,?)`,
					)
					.run(crypto.randomUUID(), id, generation, page++, JSON.stringify(segments));
				segments = [];
			};
			const append = (segment: ContextSegment, aggregate = true) => {
				const chars = safeCharacters(segment.chars);
				if (!chars) return;
				if (aggregate) {
					totalChars += chars;
					const total = totals.find((item) => item.category === segment.category);
					if (total) total.chars += chars;
				}
				segments.push({ category: segment.category, chars });
				if (segments.length === CONTEXT_COMPOSITION_LIMITS.pageSegments) flush();
			};
			try {
				append({ category: "system", chars: meta.systemChars });
				append({ category: "summary", chars: meta.summaryChars });
				append({ category: "toolDefinition", chars: meta.toolsChars });
				const old = numeric.get(id);
				const profile = `${meta.type}:${meta.variant}:${profileOf(meta)}`;
				metrics.queries++;
				const boundary =
					database
						.query<{ seq: number }, [string, string]>(
							`SELECT r.seq FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? AND r.is_compact = 1 AND (? = 'subagent' OR m.parent_tool_use_id IS NULL) ORDER BY r.seq DESC LIMIT 1`,
						)
						.get(id, profileOf(meta))?.seq ?? -1;
				let incremental =
					!!old &&
					old.boundary === boundary &&
					old.profile === profile &&
					!!dirty.ids &&
					previous?.revision === old.revision;
				// Only a changed effective compact boundary invalidates the complete suffix.
				metrics.mode = incremental ? "incremental" : "cold";
				const state: NumericState = {
					profile,
					revision,
					boundary,
					totals: incremental
						? (old?.totals.map((item) => ({ ...item })) ?? groupContextSegments([]))
						: groupContextSegments([]),
					maxSeq: incremental ? (old?.maxSeq ?? boundary) : boundary,
					entries: incremental ? new Map(old?.entries) : new Map(),
				};
				const affected = incremental ? new Set(dirty.ids ?? []) : undefined;
				if (affected) {
					let cursor = state.maxSeq;
					while (true) {
						check();
						metrics.queries++;
						const tail = database
							.query<{ messageId: string; seq: number; compact: number }, [string, number]>(
								"SELECT message_id AS messageId, seq, is_compact AS compact FROM narrator_message_refs WHERE narrator_id = ? AND seq > ? ORDER BY seq LIMIT 64",
							)
							.all(id, cursor);
						if (!tail.length) break;
						for (const row of tail) affected.add(row.messageId);
						if (affected.size > 4096) {
							incremental = false;
							break;
						}
						cursor = tail[tail.length - 1].seq;
						await yieldContextReader();
					}
				}
				const adjustTotals = (items: ContextSegment[], direction: number) => {
					for (const segment of items) {
						const total = state.totals.find((item) => item.category === segment.category);
						if (total) total.chars += direction * safeCharacters(segment.chars);
					}
				};
				if (!incremental) {
					state.entries.clear();
					state.totals = groupContextSegments([]);
					state.maxSeq = boundary;
					metrics.mode = "cold";
				} else
					for (const messageId of affected ?? []) {
						adjustTotals(state.entries.get(messageId)?.segments ?? [], -1);
						state.entries.delete(messageId);
					}
				let cacheable = true;
				let retainedBytes = 256;
				let sliceStarted = performance.now();
				const project = async (entry: { segments: ContextSegment[] }) => {
					for (const segment of entry.segments) {
						const beforePage = page;
						append(segment, false);
						if (page !== beforePage || performance.now() - sliceStarted >= 4) {
							check();
							await yieldContextReader();
							sliceStarted = performance.now();
						}
					}
				};
				const readerDatabase = new Proxy(database, {
					get(target, property) {
						if (property === "query")
							return (sql: string) => {
								const statement = target.query(sql);
								return new Proxy(statement, {
									get(stmt, key) {
										const method = Reflect.get(stmt, key);
										if (typeof method !== "function") return method;
										return (...args: unknown[]) => {
											if (key !== "all" && key !== "get" && key !== "run")
												return Reflect.apply(method, stmt, args);
											metrics.queries++;
											const started = performance.now();
											try {
												return Reflect.apply(method, stmt, args);
											} finally {
												const elapsed = performance.now() - started;
												metrics.sqlMs += elapsed;
												metrics.maxSqlMs = Math.max(metrics.maxSqlMs, elapsed);
											}
										};
									},
								});
							};
						const value = Reflect.get(target, property);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				for await (const rawEntry of readContextHistoryEntries(readerDatabase, id, {
					profile: profileOf(meta),
					check,
					messageIds: incremental ? [...(affected ?? [])] : undefined,
				})) {
					const entry = {
						messageId: rawEntry.messageId,
						seq: rawEntry.seq,
						segments: rawEntry.segments
							.map((segment) => ({
								category: segment.category,
								chars: safeCharacters(segment.chars),
							}))
							.filter((segment) => segment.chars > 0),
					};
					metrics.rows++;
					adjustTotals(entry.segments, 1);
					state.maxSeq = Math.max(state.maxSeq, entry.seq);
					retainedBytes += 192 + entry.messageId.length * 2 + entry.segments.length * 96;
					if (retainedBytes > 8 * 1024 * 1024) {
						cacheable = false;
						if (!incremental) state.entries.clear();
					}
					if (entry.segments.length && (cacheable || incremental))
						state.entries.set(entry.messageId, entry);
					if (!incremental) await project(entry);
				}
				if (incremental)
					for (const entry of [...state.entries.values()].sort((a, b) => a.seq - b.seq))
						await project(entry);
				for (const item of state.totals) {
					const total = totals.find((total) => total.category === item.category);
					if (total) total.chars += item.chars;
					totalChars += item.chars;
				}
				flush();
				await yieldContextReader();
				check(true);
				// Publish the small summary only after all pages exist, using an atomic version CAS.
				const cache: ContextCharCache = {
					generation,
					revision,
					pageCount: page,
					totalChars,
					totals,
				};
				const published = database
					.query(
						`UPDATE narrators SET context_char_cache_json = ? WHERE id = ?
					 AND context_char_revision = ? AND message_version = ? AND context_system_chars = ?
					 AND context_summary_chars = ? AND context_tools_chars = ? AND type = ? AND variant = ?`,
					)
					.run(
						JSON.stringify(cache),
						id,
						meta.revision,
						meta.messageVersion,
						meta.systemChars,
						meta.summaryChars,
						meta.toolsChars,
						meta.type,
						meta.variant,
					);
				if (published.changes) {
					if (cacheable) numeric.set(id, state);
					else numeric.delete(id);
					await deleteOrphanPages(id, generation);
				} else {
					await deleteGeneration(id, generation);
					throw new ContextRevisionChanged();
				}
			} catch (error) {
				// Cleanup is intentionally independent of cancellation, in bounded async batches.
				await deleteGeneration(id, generation);
				if (error instanceof ContextActorRemoved) {
					numeric.delete(id);
					return;
				}
				throw error;
			}
			await yieldContextReader();
		}
	}
	function schedule() {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (disposed || jobs.size >= 2) return;
		if (!pending.size && overflowCursor !== undefined) {
			timer = setTimeout(pump, 0);
			return;
		}
		if (!pending.size) return;
		const available = [...pending.entries()].filter(([id]) => !jobs.has(id));
		if (!available.length) return;
		const next = Math.min(...available.map(([, item]) => item.due));
		timer = setTimeout(pump, Math.max(0, next - performance.now()));
	}
	function pump() {
		timer = undefined;
		if (overflowCursor !== undefined && pending.size < 960) {
			const rows = database
				.query<{ id: string }, [string]>(
					"SELECT id FROM narrators WHERE id > ? ORDER BY id LIMIT 64",
				)
				.all(overflowCursor);
			if (!rows.length) {
				overflowCursor = undefined;
				if (!activeSweep) cancelled.clear();
			} else {
				overflowCursor = rows[rows.length - 1].id;
				for (const row of rows) {
					if (cancelled.has(row.id) || pending.has(row.id) || jobs.has(row.id)) continue;
					const meta = metadata(row.id);
					if (meta && cacheOf(meta.cache)?.revision !== revisionOf(meta)) queue(row.id);
				}
			}
		}
		for (const [id, dirty] of pending) {
			if (jobs.size >= 2) break;
			if (jobs.has(id) || dirty.due > performance.now()) continue;
			pending.delete(id);
			const started = performance.now();
			const controller = new AbortController();
			const metrics: ContextRebuildMetrics = {
				narratorId: id,
				mode: "cold",
				rows: 0,
				queries: 0,
				retries: dirty.retries,
				activeJobs: jobs.size + 1,
				activeMs: 0,
				sqlMs: 0,
				maxSqlMs: 0,
				waitMs: started - dirty.first,
				elapsedMs: 0,
			};
			const job = rebuild(id, controller.signal, started + budgetMs, dirty, metrics)
				.catch((error) => {
					if (controller.signal.aborted || disposed) return;
					if (error instanceof ContextRevisionChanged && pending.has(id)) {
						// Carry this unpublished round's dirty set into the next explicit round.
						queue(id, dirty.ids ? [...dirty.ids] : undefined);
					} else if (error instanceof ContextRevisionChanged && dirty.retries < 3) {
						queue(id);
						const next = pending.get(id);
						if (next) next.retries = dirty.retries + 1;
					} else
						logger.warn("Context character cache rebuild failed", {
							narratorId: id,
							error: String(error),
						});
				})
				.finally(() => {
					jobs.delete(id);
					metrics.activeMs = performance.now() - started;
					metrics.elapsedMs = metrics.activeMs + metrics.waitMs;
					try {
						options.onMetrics?.(metrics);
					} catch (error) {
						logger.warn("Context character metrics observer failed", {
							narratorId: id,
							error: String(error),
						});
					}
					if (
						metrics.activeMs > 1000 &&
						performance.now() - (slowLogged.get(id) ?? -Infinity) > 60_000
					) {
						if (slowLogged.size >= 32 && !slowLogged.has(id)) {
							const oldest = slowLogged.keys().next().value;
							if (oldest !== undefined) slowLogged.delete(oldest);
						}
						slowLogged.set(id, performance.now());
						logger.warn("Slow context character cache rebuild", metrics);
					}
					schedule();
				});
			jobs.set(id, { promise: job, controller });
		}
		schedule();
	}
	function queue(id: string, messageIds?: readonly string[]) {
		if (disposed) return;
		cancelled.delete(id);
		const now = performance.now();
		const item = pending.get(id);
		if (!item && pending.size >= 1024) {
			overflowCursor = "";
			schedule();
			return;
		}
		if (item) {
			if (item.cleanup) {
				item.cleanup = false;
				item.ids = messageIds ? new Set(messageIds) : null;
			}
			if (!messageIds) item.ids = null;
			else if (item.ids) for (const messageId of messageIds) item.ids.add(messageId);
			if (item.ids && item.ids.size > 4096) item.ids = null;
			item.due = Math.min(item.first + 500, now + debounceMs);
		} else
			pending.set(id, {
				ids: messageIds && messageIds.length <= 4096 ? new Set(messageIds) : null,
				first: now,
				due: now + debounceMs,
				retries: 0,
			});
		let dirtyCount = 0;
		for (const queued of pending.values()) dirtyCount += queued.ids?.size ?? 0;
		if (dirtyCount > 8192) for (const queued of pending.values()) queued.ids = null;
		schedule();
	}
	function queueCleanup(id: string) {
		if (disposed || pending.has(id) || jobs.has(id)) return;
		if (pending.size >= 1024) return; // Optional cleanup can wait for the next GET/pin change.
		const now = performance.now();
		pending.set(id, { ids: null, first: now, due: now, retries: 0, cleanup: true });
		schedule();
	}
	function invalidateOverflow(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (activeSweep) return activeSweep;
		numeric.clear();
		const enqueueEpoch = ++sweepEnqueueEpoch;
		// Single-flight numeric mark sweep: every actor gets an epoch, including fork holders.
		// Cancellation backpressure can stop enqueueing this round, never its DB invalidation.
		activeSweep = yieldContextReader()
			.then(async () => {
				let cursor = "";
				while (!disposed) {
					const rows = database
						.query<{ id: string }, [string]>(
							"SELECT id FROM narrators WHERE id > ? ORDER BY id LIMIT 64",
						)
						.all(cursor);
					if (!rows.length) break;
					const ids = rows.map((row) => row.id);
					database
						.query(
							`UPDATE narrators SET context_char_revision = context_char_revision + 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
						)
						.run(...ids);
					let sliceStarted = performance.now();
					for (const id of ids) {
						if (disposed) break;
						if (enqueueEpoch === sweepEnqueueEpoch && !cancelled.has(id)) queue(id);
						if (performance.now() - sliceStarted >= 4) {
							await yieldContextReader();
							sliceStarted = performance.now();
						}
					}
					cursor = ids[ids.length - 1];
					// At most 64 indexed marks and bounded queues between cooperative timer yields.
					await yieldContextReader();
				}
			})
			.finally(() => {
				activeSweep = undefined;
				if (overflowCursor === undefined) cancelled.clear();
			});
		return activeSweep;
	}
	return {
		invalidateOverflow,
		freeze(
			id: string,
			counts: ContextInputCharacters | null,
			requestId: string,
			startedAt: string,
			runtimeSummaryChars = 0,
		): ContextCharCache | null {
			const meta = metadata(id);
			if (!meta) return null;
			let composition: ContextCharCache | null = null;
			if (
				counts &&
				validInputCharacters(counts) &&
				Number.isSafeInteger(runtimeSummaryChars) &&
				runtimeSummaryChars >= 0 &&
				runtimeSummaryChars <= counts.systemChars
			) {
				const prefix = (system: number, summary: number, tools: number): ContextSegment[] =>
					[
						{ category: "system" as const, chars: system },
						{ category: "summary" as const, chars: summary },
						{ category: "toolDefinition" as const, chars: tools },
					].filter((item) => item.chars > 0);
				const current = prefix(
					counts.systemChars - runtimeSummaryChars,
					runtimeSummaryChars,
					counts.toolsChars,
				);
				const previous = prefix(meta.systemChars, meta.summaryChars, meta.toolsChars);
				const candidate = cacheOf(meta.cache);
				if (
					candidate?.revision === revisionOf(meta) &&
					!candidate.fixedPrefix &&
					!hasPendingContextCharacterRefresh() &&
					!activeSweep &&
					invalidations === 0 &&
					!pending.has(id) &&
					!jobs.has(id)
				) {
					const first = database
						.query<{ json: string }, [string, string]>(
							"SELECT segments_json AS json FROM narrator_context_char_pages WHERE narrator_id = ? AND generation = ? AND page = 0",
						)
						.get(id, candidate.generation);
					const segments = readContextSegments(first?.json ?? null);
					const prefixMatches =
						(candidate.pageCount === 0 || !!first) &&
						previous.every(
							(item, index) =>
								segments[index]?.category === item.category &&
								segments[index]?.chars === item.chars,
						);
					if (prefixMatches) {
						const totals = candidate.totals.map((item) => ({ ...item }));
						for (const item of previous) {
							const total = totals.find((entry) => entry.category === item.category);
							if (total) total.chars -= item.chars;
						}
						for (const item of current) {
							const total = totals.find((entry) => entry.category === item.category);
							if (total) total.chars += item.chars;
						}
						const totalChars = totals.reduce((sum, item) => sum + item.chars, 0);
						if (totals.every((item) => item.chars >= 0) && totalChars <= counts.totalChars)
							composition = {
								...candidate,
								pageCount: candidate.pageCount + 1,
								totalChars,
								totals,
								fixedPrefix: { previous, current },
							};
					}
				}
				if (!composition) {
					// No matched variable cache: record only the final fixed input, never stale history.
					const generation = crypto.randomUUID();
					database
						.query(
							"INSERT INTO narrator_context_char_pages (id,narrator_id,generation,page,segments_json) VALUES (?,?,?,?,?)",
						)
						.run(crypto.randomUUID(), id, generation, 0, JSON.stringify(current));
					composition = {
						generation,
						revision: `request:${requestId}`,
						pageCount: 1,
						totalChars: counts.systemChars + counts.toolsChars,
						totals: groupContextSegments(current),
					};
				}
			}
			// Pin before yielding to any background rebuild. Starting another request releases the old pin.
			const snapshot = boundedContextSnapshot({
				requestId,
				startedAt,
				source: "estimate",
				percentage: null,
				contextWindow: null,
				occupiedTokens: null,
				inputCharacters: counts,
				composition,
			});
			database
				.query("UPDATE narrators SET context_usage_snapshot_json = ? WHERE id = ?")
				.run(snapshot ? JSON.stringify(snapshot) : null, id);
			if (parseContextSnapshot(meta.usage)?.composition?.generation !== composition?.generation)
				queueCleanup(id);
			return composition;
		},
		storeUsage(id: string, snapshot: ContextUsageSnapshot) {
			const value = boundedContextSnapshot(snapshot);
			if (!value) return;
			const before = metadata(id);
			database
				.query("UPDATE narrators SET context_usage_snapshot_json = ? WHERE id = ?")
				.run(JSON.stringify(value), id);
			const meta = metadata(id);
			if (
				meta &&
				cacheOf(meta.cache)?.revision !== revisionOf(meta) &&
				!pending.has(id) &&
				!jobs.has(id)
			)
				queue(id);
			else if (
				parseContextSnapshot(before?.usage ?? null)?.composition?.generation !==
				value.composition?.generation
			)
				queueCleanup(id);
		},
		async invalidate(id: string, messageId?: string) {
			return this.invalidateBatch(id, messageId ? [messageId] : undefined);
		},
		async invalidateBatch(
			id: string,
			messageIds?: readonly string[],
			batchOptions?: { full?: boolean },
		) {
			invalidations++;
			try {
				const invalidateOne = (narratorId: string, ids?: readonly string[]) => {
					database
						.query(
							"UPDATE narrators SET context_char_revision = context_char_revision + 1 WHERE id = ?",
						)
						.run(narratorId);
					queue(narratorId, ids);
				};
				invalidateOne(id, batchOptions?.full ? undefined : messageIds);
				if (!messageIds?.length || disposed) return;
				// Keyset union makes each holder's revision change once, across duplicate dirty IDs.
				const unique = [...new Set(messageIds)];
				let cursor = "";
				while (!disposed) {
					const holders = new Map<string, Set<string>>();
					for (let offset = 0; offset < unique.length; offset += 64) {
						const batch = unique.slice(offset, offset + 64);
						const rows = database
							.query<{ id: string }, (string | number)[]>(
								`SELECT DISTINCT narrator_id AS id FROM narrator_message_refs WHERE message_id IN (${batch.map(() => "?").join(",")}) AND narrator_id > ? ORDER BY narrator_id LIMIT 64`,
							)
							.all(...batch, cursor);
						for (const row of rows) holders.set(row.id, new Set());
						for (const excess of [...holders.keys()].sort().slice(64)) holders.delete(excess);
						await yieldContextReader();
					}
					const ids = [...holders.keys()].sort().slice(0, 64);
					if (!ids.length) break;
					for (const holder of ids) {
						const dirtyIds: string[] = [];
						let full = false;
						let sliceStarted = performance.now();
						for (let offset = 0; offset < unique.length; offset += 64) {
							const batch = unique.slice(offset, offset + 64);
							const rows = database
								.query<{ messageId: string }, string[]>(
									`SELECT message_id AS messageId FROM narrator_message_refs WHERE narrator_id = ? AND message_id IN (${batch.map(() => "?").join(",")}) LIMIT 64`,
								)
								.all(holder, ...batch);
							dirtyIds.push(...rows.map((row) => row.messageId));
							if (dirtyIds.length > 4096) {
								full = true;
								break;
							}
							if (performance.now() - sliceStarted >= 4) {
								await yieldContextReader();
								sliceStarted = performance.now();
							}
						}
						if (holder !== id) invalidateOne(holder, full ? undefined : dirtyIds);
					}
					cursor = ids[ids.length - 1];
					await yieldContextReader();
				}
			} finally {
				invalidations--;
			}
		},
		async storeRuntime(id: string, values: { systemChars?: number; toolsChars?: number }) {
			const systemChars =
				values.systemChars === undefined ? null : safeCharacters(values.systemChars);
			const toolsChars = values.toolsChars === undefined ? null : safeCharacters(values.toolsChars);
			const changed = database
				.query(`UPDATE narrators SET context_system_chars = coalesce(?, context_system_chars),
			 context_tools_chars = coalesce(?, context_tools_chars), context_char_revision = context_char_revision + 1
			 WHERE id = ? AND (context_system_chars != coalesce(?, context_system_chars)
			 OR context_tools_chars != coalesce(?, context_tools_chars))`)
				.run(systemChars, toolsChars, id, systemChars, toolsChars);
			if (changed.changes) queue(id);
		},
		async get(id: string, signal?: AbortSignal, cursor?: string): Promise<ContextComposition> {
			if (disposed) throw new DOMException("Context cache service disposed", "AbortError");
			signal?.throwIfAborted();
			const meta = metadata(id);
			if (!meta) throw new NotFoundError("Narrator", id);
			const usage = parseContextSnapshot(meta.usage);
			const cache = usage?.composition ?? cacheOf(meta.cache);
			if (!cache) {
				if (!pending.has(id) && !jobs.has(id)) queue(id);
				return { ...emptyContextComposition(true), usage };
			}
			const isPending =
				!usage?.composition &&
				(cache.revision !== revisionOf(meta) ||
					hasPendingContextCharacterRefresh() ||
					invalidations > 0 ||
					!!activeSweep);
			if (cacheOf(meta.cache)?.revision !== revisionOf(meta) && !pending.has(id) && !jobs.has(id))
				queue(id);
			else if (!cleaned.has(id)) queueCleanup(id);
			let page = 0;
			if (cursor) {
				const [generation, rawPage, extra] = cursor.split(":");
				if (
					cursor.length > 200 ||
					!generation ||
					extra !== undefined ||
					!/^\d+$/.test(rawPage ?? "") ||
					!Number.isSafeInteger(Number(rawPage))
				)
					throw new AppError("Invalid context cursor", 400, "INVALID_CONTEXT_CURSOR");
				// A stale generation intentionally restarts at the new first page.
				if (generation === cache.generation) page = Number(rawPage);
			}
			if (page >= Math.max(1, cache.pageCount))
				throw new AppError("Context cursor out of range", 400, "INVALID_CONTEXT_CURSOR");
			const projectedPrefix = cache.fixedPrefix;
			const prefixPage = !!projectedPrefix && page === 0;
			const hasBasePage = projectedPrefix ? cache.pageCount > 1 : cache.pageCount > 0;
			const row = hasBasePage
				? database
						.query<{ json: string }, [string, string, number]>(
							"SELECT segments_json AS json FROM narrator_context_char_pages WHERE narrator_id = ? AND generation = ? AND page = ?",
						)
						.get(id, cache.generation, projectedPrefix ? Math.max(0, page - 1) : page)
				: null;
			const baseSegments = readContextSegments(row?.json ?? null);
			const prefixMismatch =
				!!projectedPrefix &&
				page <= 1 &&
				!projectedPrefix.previous.every(
					(item, index) =>
						baseSegments[index]?.category === item.category &&
						baseSegments[index]?.chars === item.chars,
				);
			const segments = prefixPage
				? projectedPrefix.current
				: projectedPrefix && page === 1
					? baseSegments.slice(projectedPrefix.previous.length)
					: baseSegments;
			if ((hasBasePage && !row) || prefixMismatch) {
				// A lost historical pin cannot be rebuilt from today's transcript. Retain
				// its occupancy but make classification unknown, without destroying a newer cache.
				if (usage?.composition)
					database
						.query("UPDATE narrators SET context_usage_snapshot_json = ? WHERE id = ?")
						.run(JSON.stringify({ ...usage, composition: null }), id);
				if (!usage?.composition || cacheOf(meta.cache)?.generation === cache.generation)
					database
						.query(
							"UPDATE narrators SET context_char_cache_json = NULL, context_char_revision = context_char_revision + 1 WHERE id = ?",
						)
						.run(id);
				queue(id);
				return {
					...emptyContextComposition(true),
					usage: usage ? { ...usage, composition: null } : null,
				};
			}
			const response: ContextComposition = {
				usage,
				generation: cache.generation,
				totalChars: cache.totalChars,
				totals: cache.totals,
				segments: segments.slice(0, CONTEXT_COMPOSITION_LIMITS.pageSegments),
				nextCursor: page + 1 < cache.pageCount ? `${cache.generation}:${page + 1}` : null,
				pending: isPending,
			};
			signal?.throwIfAborted();
			return response;
		},
		async cancel(id: string) {
			if ((overflowCursor !== undefined || activeSweep) && !cancelled.has(id)) {
				if (cancelled.size >= 1024) {
					// Never discard cancellation tombstones while their sweep can resurrect old work.
					// Stop that recovery round first. Unqueued actors remain DB-stale and can be
					// scheduled by a later explicit GET/invalidation; uncancelled pending jobs continue.
					overflowCursor = undefined;
					sweepEnqueueEpoch++;
					cancelled.clear();
					if (performance.now() - cancellationBackpressureLoggedAt >= 60_000) {
						cancellationBackpressureLoggedAt = performance.now();
						logger.warn("Context overflow recovery deferred by cancellation backpressure", {
							pendingActors: pending.size,
						});
					}
				} else cancelled.add(id);
			} else if (overflowCursor === undefined && !activeSweep) cancelled.clear();
			pending.delete(id);
			numeric.delete(id);
			schedule();
			const job = jobs.get(id);
			job?.controller.abort(new DOMException("Context character rebuild cancelled", "AbortError"));
			await job?.promise;
		},
		async dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			pending.clear();
			overflowCursor = undefined;
			cancelled.clear();
			numeric.clear();
			for (const job of jobs.values())
				job.controller.abort(new DOMException("Context cache service disposed", "AbortError"));
			await Promise.all(
				[...jobs.values()].map((job) => job.promise).concat(activeSweep ? [activeSweep] : []),
			);
		},
		/** Wait for the local background queue in tests, not on the HTTP read path. */
		async settled() {
			while (
				jobs.size ||
				pending.size ||
				timer ||
				overflowCursor !== undefined ||
				invalidations > 0 ||
				activeSweep
			) {
				if (jobs.size) await Promise.all([...jobs.values()].map((job) => job.promise));
				else if (activeSweep) await activeSweep;
				else await new Promise((resolve) => setTimeout(resolve, Math.max(1, debounceMs)));
			}
		},
	};
}
let service: ReturnType<typeof createContextCharacterService> | undefined;
function currentService() {
	if (activeDatabaseBackend === "postgres")
		throw new AppError(
			"Context composition is not yet available on PostgreSQL",
			501,
			"CONTEXT_COMPOSITION_UNAVAILABLE",
		);
	service ??= createContextCharacterService(sqlite);
	return service;
}
export function freezeNarratorContextComposition(
	narratorId: string,
	counts: ContextInputCharacters | null,
	requestId: string,
	startedAt: string,
	runtimeSummaryChars = 0,
): ContextCharCache | null {
	if (activeDatabaseBackend === "postgres") return null;
	return currentService().freeze(narratorId, counts, requestId, startedAt, runtimeSummaryChars);
}
export async function storeNarratorContextUsage(
	narratorId: string,
	snapshot: ContextUsageSnapshot,
): Promise<void> {
	if (activeDatabaseBackend === "postgres") {
		const value = boundedContextSnapshot(snapshot);
		if (value)
			await db
				.update(narrators)
				.set({ contextUsageSnapshotJson: value })
				.where(eq(narrators.id, narratorId));
		return;
	}
	currentService().storeUsage(narratorId, snapshot);
}
export async function invalidateContextCharacterCache(
	narratorId: string,
	messageId?: string,
): Promise<void> {
	if (activeDatabaseBackend === "postgres") return;
	await currentService().invalidate(narratorId, messageId);
}
export async function invalidateContextCharacterBatch(
	narratorId: string,
	messageIds?: readonly string[],
	options?: { full?: boolean },
): Promise<void> {
	if (activeDatabaseBackend === "postgres") return;
	await currentService().invalidateBatch(narratorId, messageIds, options);
}
export async function invalidateContextCharacterOverflow(): Promise<void> {
	if (activeDatabaseBackend === "postgres") return;
	await currentService().invalidateOverflow();
}
export async function storeContextRuntimeCharacters(
	narratorId: string,
	values: { systemChars?: number; toolsChars?: number },
): Promise<void> {
	if (activeDatabaseBackend === "postgres") return;
	await currentService().storeRuntime(narratorId, values);
}
export async function getNarratorContextComposition(
	narratorId: string,
	signal?: AbortSignal,
	cursor?: string,
): Promise<ContextComposition> {
	return currentService().get(narratorId, signal, cursor);
}
