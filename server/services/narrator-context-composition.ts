import type { Database } from "bun:sqlite";
import {
	type ContextCharCache,
	type ContextComposition,
	type ContextSegment,
	emptyContextComposition,
	groupContextSegments,
	safeCharacters,
} from "@shared/context-composition";
import { activeDatabaseBackend, sqlite } from "../db";
import { AppError, NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	CONTEXT_COMPOSITION_LIMITS,
	readContextHistory,
	yieldContextReader,
} from "./context-composition-history";
import { readContextSegments } from "./context-composition-projection";

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
		return cache &&
			typeof cache.generation === "string" &&
			cache.generation.length > 0 &&
			cache.generation.length < 128 &&
			typeof cache.revision === "string" &&
			cache.revision.length < 256 &&
			Number.isFinite(cache.totalChars) &&
			cache.totalChars >= 0 &&
			Number.isSafeInteger(cache.pageCount) &&
			cache.pageCount >= 0 &&
			Array.isArray(cache.totals)
			? cache
			: null;
	} catch {
		return null;
	}
}

/** Dependency injection keeps tests on disposable SQLite schemas and avoids runtime reconstruction. */
export function createContextCharacterService(
	database: Database,
	options: { budgetMs?: number } = {},
) {
	const budgetMs = options.budgetMs ?? CONTEXT_REBUILD_BUDGET_MS;
	const jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
	let disposed = false;
	const metadata = (id: string) =>
		database
			.query<Metadata, [string]>(
				`SELECT type, variant, context_char_revision AS revision, message_version AS messageVersion,
		 context_system_chars AS systemChars, context_summary_chars AS summaryChars,
		 context_tools_chars AS toolsChars, context_char_cache_json AS cache FROM narrators WHERE id = ?`,
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
				 END FROM narrators WHERE id = ?), '') LIMIT 64
				)`,
				)
				.run(id, buildingGeneration ?? null, buildingGeneration ?? null, id);
			if (!result.changes) break;
			await yieldContextReader();
		}
	}
	async function rebuild(id: string, signal: AbortSignal, deadline: number) {
		const checkBudget = () => {
			signal.throwIfAborted();
			if (disposed) throw new DOMException("Context cache service disposed", "AbortError");
			if (performance.now() >= deadline)
				throw new Error("Context character rebuild budget exceeded");
		};
		checkBudget();
		await deleteOrphanPages(id);
		while (true) {
			checkBudget();
			const meta = metadata(id);
			if (!meta) return;
			const revision = revisionOf(meta);
			const previous = cacheOf(meta.cache);
			if (previous?.revision === revision) return;
			const check = () => {
				checkBudget();
				const current = metadata(id);
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
			const append = (segment: ContextSegment) => {
				const chars = safeCharacters(segment.chars);
				if (!chars) return;
				totalChars += chars;
				const total = totals.find((item) => item.category === segment.category);
				if (total) total.chars += chars;
				segments.push({ category: segment.category, chars });
				if (segments.length === CONTEXT_COMPOSITION_LIMITS.pageSegments) flush();
			};
			try {
				append({ category: "system", chars: meta.systemChars });
				append({ category: "summary", chars: meta.summaryChars });
				append({ category: "toolDefinition", chars: meta.toolsChars });
				for await (const segment of readContextHistory(database, id, {
					profile: profileOf(meta),
					check,
				}))
					append(segment);
				check();
				flush();
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
					await deleteOrphanPages(id, generation);
					// An invalidation can land during cleanup; loop and publish its fresh revision too.
				} else await deleteGeneration(id, generation);
			} catch (error) {
				// Cleanup is intentionally independent of cancellation, in bounded async batches.
				await deleteGeneration(id, generation);
				if (error instanceof ContextActorRemoved) return;
				if (!(error instanceof ContextRevisionChanged)) throw error;
			}
			await yieldContextReader();
		}
	}
	function queue(id: string) {
		if (disposed || jobs.has(id)) return;
		// Start outside the request stack: GET never walks refs or message metadata.
		const started = performance.now();
		const controller = new AbortController();
		const job = yieldContextReader()
			.then(() => rebuild(id, controller.signal, started + budgetMs))
			.catch((error) => {
				if (controller.signal.aborted || disposed) return;
				logger.warn("Context character cache rebuild failed", {
					narratorId: id,
					error: String(error),
				});
			})
			.finally(() => {
				jobs.delete(id);
				const elapsedMs = performance.now() - started;
				if (elapsedMs > 1_000)
					logger.warn("Slow context character cache rebuild", { narratorId: id, elapsedMs });
			});
		jobs.set(id, { promise: job, controller });
	}
	return {
		async invalidate(id: string, messageId?: string) {
			const invalidateOne = (narratorId: string) => {
				database
					.query(
						"UPDATE narrators SET context_char_revision = context_char_revision + 1 WHERE id = ?",
					)
					.run(narratorId);
				queue(narratorId);
			};
			invalidateOne(id);
			if (!messageId || disposed) return;
			// Shared fork refs may keep the same messageVersion when its canonical numeric row changes.
			// Fan out through a limited keyset reader, never loading all holders or any message body.
			let cursor = "";
			while (!disposed) {
				const holders = database
					.query<{ id: string }, [string, string, number]>(
						`SELECT narrator_id AS id FROM narrator_message_refs WHERE message_id = ?
					 AND narrator_id > ? ORDER BY narrator_id LIMIT ?`,
					)
					.all(messageId, cursor, CONTEXT_COMPOSITION_LIMITS.batch);
				if (!holders.length) break;
				for (const holder of holders) if (holder.id !== id) invalidateOne(holder.id);
				cursor = holders[holders.length - 1].id;
				await yieldContextReader();
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
			const cache = cacheOf(meta.cache);
			if (!cache) {
				queue(id);
				return emptyContextComposition(true);
			}
			const pending = cache.revision !== revisionOf(meta);
			// Also reclaim restart debris when the published cache needs no rebuild.
			queue(id);
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
			const row = database
				.query<{ json: string }, [string, string, number]>(
					"SELECT segments_json AS json FROM narrator_context_char_pages WHERE narrator_id = ? AND generation = ? AND page = ?",
				)
				.get(id, cache.generation, page);
			if (cache.pageCount > 0 && !row) {
				// Repair an interrupted/externally removed page set rather than polling forever.
				database
					.query(
						"UPDATE narrators SET context_char_cache_json = NULL, context_char_revision = context_char_revision + 1 WHERE id = ?",
					)
					.run(id);
				queue(id);
				return emptyContextComposition(true);
			}
			const response: ContextComposition = {
				generation: cache.generation,
				totalChars: cache.totalChars,
				totals: cache.totals,
				segments: readContextSegments(row?.json ?? null).slice(
					0,
					CONTEXT_COMPOSITION_LIMITS.pageSegments,
				),
				nextCursor: page + 1 < cache.pageCount ? `${cache.generation}:${page + 1}` : null,
				pending,
			};
			signal?.throwIfAborted();
			return response;
		},
		async cancel(id: string) {
			const job = jobs.get(id);
			job?.controller.abort(new DOMException("Context character rebuild cancelled", "AbortError"));
			await job?.promise;
		},
		async dispose() {
			disposed = true;
			for (const job of jobs.values())
				job.controller.abort(new DOMException("Context cache service disposed", "AbortError"));
			await Promise.all([...jobs.values()].map((job) => job.promise));
		},
		/** Wait for the local background queue in tests, not on the HTTP read path. */
		async settled() {
			while (jobs.size) await Promise.all([...jobs.values()].map((job) => job.promise));
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
export async function invalidateContextCharacterCache(
	narratorId: string,
	messageId?: string,
): Promise<void> {
	if (activeDatabaseBackend === "postgres") return;
	await currentService().invalidate(narratorId, messageId);
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
