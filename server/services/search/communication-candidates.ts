import {
	COMMUNICATION_LIMITS,
	type CommunicationCandidate,
	type CommunicationCandidates,
} from "@shared/narrator-communication";
import { getDbPath } from "../../db/connection";
import type { PgExecutor } from "../../db/pg-fts";
import { AppError, ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { hotOnce, hotSafe } from "../../lib/hot-safe";
import { logger } from "../../lib/logger";
import {
	communicationReadableText,
	communicationReadPredicate,
} from "../narrator-communication/predicates";
import {
	createSqliteSearchQueryExecutor,
	SEARCH_MAX_OUTSTANDING,
	type SearchQueryExecutor,
} from "./sqlite-worker-runner";

const accessState = hotSafe("narrafork.communicationAccessEpoch", () => ({ generation: 0 }));
export const getCommunicationAccessEpoch = () => accessState.generation;
if (hotOnce("narrafork.communicationAccessEpoch.listener"))
	eventBus.onAny((event) => {
		if (
			event.type === "auth:changed" ||
			event.type === "narrator:execution_principal_changed" ||
			event.type.endsWith(":access_changed") ||
			event.type === "trait-layer:changed" ||
			event.type.startsWith("integration:")
		)
			accessState.generation++;
	});

export interface CommunicationCandidatePrincipal {
	userId: string;
	isAdmin: boolean;
}

export interface CommunicationCandidateSearchOptions {
	query?: string;
	limit?: number;
	signal?: AbortSignal;
}

/** Trusted SQL only: aliases n (candidate) and source, with bound ? parameters. */
export interface CommunicationCandidateSearchPredicate {
	sql: string;
	params: Array<string | number | null>;
	/** Resolved from the current users row, never the cached HTTP role. */
	viewerIsAdmin?: boolean;
	authorizationKey?: string;
	backend?: "sqlite" | "postgres";
}

export type CommunicationCandidateSearchGuard = (
	sourceNarratorId: string,
	principal: CommunicationCandidatePrincipal,
	options: { signal?: AbortSignal; deadlineAt: number; backend: "sqlite" | "postgres" },
) => Promise<CommunicationCandidateSearchPredicate>;

const MAX_ID_CHARS = 128;
const ACTIVITY = "COALESCE(n.last_message_at, n.updated_at, n.created_at, '')";

function invalidInput(): never {
	throw new ValidationError(
		"Invalid communication candidate search",
		"COMMUNICATION_SEARCH_INVALID",
	);
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ID_CHARS &&
		/^[A-Za-z0-9_-]+$/.test(value)
	);
}

function buildQuery(
	source: string,
	principal: CommunicationCandidatePrincipal,
	query: string,
	limit: number,
	guard: CommunicationCandidateSearchPredicate,
	backend: "sqlite" | "postgres",
): { sql: string; params: Array<string | number | null> } {
	const parentReadable = communicationReadPredicate("parent", principal);
	const params: Array<string | number | null> = [
		source,
		principal.userId,
		...parentReadable.params,
		source,
	];
	const clauses = [
		"n.id <> source.id",
		"NOT n.hidden_from_lists",
		`COALESCE(n.traits, '[]') NOT LIKE '%"modeltrace"%'`,
		"n.status <> 'archived'",
		"NOT source.hidden_from_lists",
		"source.status <> 'archived'",
		"EXISTS (SELECT 1 FROM narrator_communication_nodes cn WHERE cn.narrator_id = n.id)",
		"EXISTS (SELECT 1 FROM narrator_communication_nodes cs WHERE cs.narrator_id = source.id)",
	];
	if (!principal.isAdmin) {
		for (const alias of ["source", "n"]) {
			const acl = communicationReadableText(alias);
			clauses.push(acl);
			params.push(...Array<string>(acl.split("?").length - 1).fill(principal.userId));
		}
	}
	clauses.push(`(${guard.sql})`);
	params.push(...guard.params);
	if (query) {
		// Search the entire authorized scope, including one- and two-character CJK.
		// There is deliberately no recent-N preselection or FTS minimum-length gate.
		const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
		if (backend === "sqlite" && [...query].length >= 3) {
			clauses.push(
				"(n.rowid IN (SELECT rowid FROM narrators_fts WHERE narrators_fts MATCH ?) OR lower(COALESCE(n.handle_fold, n.handle, '')) LIKE ? ESCAPE '\\' OR n.id = ?)",
			);
			params.push(`"${query.replace(/"/g, '""')}"`, pattern, query);
		} else {
			clauses.push(
				"(lower(COALESCE(n.title, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(n.handle_fold, n.handle, '')) LIKE ? ESCAPE '\\' OR n.id = ?)",
			);
			params.push(pattern, pattern, query);
		}
	}
	params.push(limit + 1);
	return {
		sql: `WITH RECURSIVE source_ancestors(id,parent,depth) AS (
 SELECT narrator_id,parent_narrator_id,1 FROM narrator_communication_nodes WHERE narrator_id=?
 UNION ALL SELECT c.narrator_id,c.parent_narrator_id,a.depth+1 FROM narrator_communication_nodes c JOIN source_ancestors a ON c.narrator_id=a.parent WHERE a.depth<16
 ), source_members(id,depth) AS (
 SELECT id,1 FROM source_ancestors WHERE parent IS NULL UNION ALL SELECT c.narrator_id,m.depth+1 FROM narrator_communication_nodes c JOIN source_members m ON c.parent_narrator_id=m.id WHERE m.depth<16
 ), eligible AS (
			SELECT n.id, substr(n.title, 1, 512) AS title,
				substr(n.handle, 1, 128) AS handle, n.status,
				substr(${ACTIVITY}, 1, 64) AS last_activity_at,
				CASE WHEN EXISTS (
					SELECT 1 FROM user_recent_tabs recent
					WHERE recent.user_id = ? AND (
						recent.represented_narrator_id = n.id
						OR (recent.type = 'team' AND recent.entity_id = n.id)
					)
				) THEN 1 ELSE 0 END AS is_recent,
 (SELECT substr(parent.title,1,512) FROM narrators parent WHERE parent.id=n.parent_narrator_id AND NOT parent.hidden_from_lists AND ${parentReadable.sql} LIMIT 1) AS parent_title,
 CASE WHEN EXISTS(SELECT 1 FROM source_members m WHERE m.id=n.id) THEN 1 ELSE 0 END AS same_group,
 CASE WHEN EXISTS(SELECT 1 FROM narrator_communication_peers peer WHERE (peer.endpoint_lo=source.id AND peer.endpoint_hi=n.id) OR (peer.endpoint_hi=source.id AND peer.endpoint_lo=n.id)) THEN 1 ELSE 0 END AS connected
			FROM narrators n JOIN narrators source ON source.id = ?
			WHERE ${clauses.join(" AND ")}
		)
		SELECT id, title, handle, status, last_activity_at, is_recent, parent_title, same_group, connected FROM eligible
		ORDER BY is_recent DESC, last_activity_at DESC, id DESC LIMIT ?`,
		params,
	};
}

function unavailable(): AppError {
	return new AppError(
		"Communication search is temporarily unavailable",
		503,
		"SEARCH_QUERY_UNAVAILABLE",
	);
}

/** Test fixtures may inject a reader; production always uses Worker or async PostgreSQL. */
export function createCommunicationCandidateSearcher(dependencies: {
	execute: SearchQueryExecutor;
	authorize: CommunicationCandidateSearchGuard;
	backend?: "sqlite" | "postgres";
	timeoutMs?: number;
	getAccessEpoch?: () => number;
}) {
	let outstanding = 0;
	return async (
		sourceNarratorId: string,
		principal: CommunicationCandidatePrincipal,
		options: CommunicationCandidateSearchOptions = {},
	): Promise<CommunicationCandidates> => {
		if (
			!validId(sourceNarratorId) ||
			!validId(principal?.userId) ||
			typeof principal.isAdmin !== "boolean" ||
			(options.query !== undefined &&
				(typeof options.query !== "string" ||
					options.query.length > COMMUNICATION_LIMITS.searchQueryChars)) ||
			(options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
		)
			invalidInput();
		const query = (options.query ?? "").normalize("NFC").trim();
		const limit = Math.min(
			options.limit ?? COMMUNICATION_LIMITS.searchDefaultLimit,
			COMMUNICATION_LIMITS.searchMaxLimit,
		);
		if (options.signal?.aborted)
			throw new AppError("Search was cancelled", 499, "SEARCH_QUERY_CANCELLED");
		if (outstanding >= SEARCH_MAX_OUTSTANDING)
			throw new AppError("Search is busy; please retry", 503, "SEARCH_QUERY_BUSY");
		outstanding++;
		const startedAt = Date.now();
		const timeoutMs = dependencies.timeoutMs ?? COMMUNICATION_LIMITS.searchTimeoutMs;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		let rejectCancelled: (() => void) | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			rejectCancelled = () => reject(new Error("Communication search cancelled"));
			controller.signal.addEventListener("abort", rejectCancelled, { once: true });
		});
		try {
			return await Promise.race([
				(async () => {
					// This guard resolves persistent source authority and runtime ceiling BEFORE
					// selection. Its candidate predicate is part of SQL, never a post-limit filter.
					const accessEpoch = (dependencies.getAccessEpoch ?? getCommunicationAccessEpoch)();
					const guard = await dependencies.authorize(sourceNarratorId, principal, {
						signal: controller.signal,
						deadlineAt: startedAt + timeoutMs,
						backend: dependencies.backend ?? "sqlite",
					});
					controller.signal.throwIfAborted();
					if (!guard?.sql || !Array.isArray(guard.params)) throw unavailable();
					const statement = buildQuery(
						sourceNarratorId,
						{ ...principal, isAdmin: guard.viewerIsAdmin ?? principal.isAdmin },
						query,
						limit,
						guard,
						guard.backend ?? dependencies.backend ?? "sqlite",
					);
					const rows = await dependencies.execute(statement.sql, statement.params, {
						signal: controller.signal,
						operation: "communication-candidates",
					});
					controller.signal.throwIfAborted();
					const currentGuard = await dependencies.authorize(sourceNarratorId, principal, {
						signal: controller.signal,
						deadlineAt: startedAt + timeoutMs,
						backend: dependencies.backend ?? "sqlite",
					});
					controller.signal.throwIfAborted();
					if (
						accessEpoch !== (dependencies.getAccessEpoch ?? getCommunicationAccessEpoch)() ||
						JSON.stringify(currentGuard) !== JSON.stringify(guard)
					)
						throw new AppError(
							"Communication access changed; retry search",
							403,
							"COMMUNICATION_ACCESS_CHANGED",
						);
					const hasMore = rows.length > limit;
					const items: CommunicationCandidate[] = rows.slice(0, limit).map((row) => ({
						id: String(row.id),
						title: row.title == null ? null : String(row.title),
						handle: row.handle == null ? null : String(row.handle),
						status: String(row.status),
						lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
						isRecent: Number(row.is_recent) === 1,
						canConnect: true,
						connected: Number(row.connected) === 1,
						sameGroup: Number(row.same_group) === 1,
						parentTitle: row.parent_title == null ? null : String(row.parent_title),
					}));
					return { items, hasMore };
				})(),
				cancelled,
			]);
		} catch (error) {
			if (timedOut) throw new AppError("Search timed out", 504, "SEARCH_QUERY_TIMEOUT");
			if (options.signal?.aborted)
				throw new AppError("Search was cancelled", 499, "SEARCH_QUERY_CANCELLED");
			if (error instanceof AppError) throw error;
			throw unavailable();
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (rejectCancelled) controller.signal.removeEventListener("abort", rejectCancelled);
			outstanding--;
			const durationMs = Date.now() - startedAt;
			if (durationMs > 1000) logger.warn("Slow communication candidate search", { durationMs });
		}
	};
}

/** Bun's asynchronous SQL query is cancellable; a failure never falls back to SQLite. */
export function createPostgresCommunicationCandidateExecutor(
	client: PgExecutor,
): SearchQueryExecutor {
	return async (sql, params, options = {}) => {
		options.signal?.throwIfAborted();
		let position = 0;
		const pending = client.unsafe(
			sql.replace(/\?/g, () => `$${++position}`),
			params,
		) as Promise<Record<string, unknown>[]> & { cancel?: () => void };
		const onAbort = () => pending.cancel?.();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await pending;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	};
}

const sqliteExecute = createSqliteSearchQueryExecutor(getDbPath, {
	timeoutMs: COMMUNICATION_LIMITS.searchTimeoutMs,
});

export const searchCommunicationCandidates = createCommunicationCandidateSearcher({
	authorize: async (sourceNarratorId, principal, options) => {
		const [{ activeDatabaseBackend }, { communicationCandidateSearchGuard }] = await Promise.all([
			import("../../db"),
			import("../narrator-communication/access"),
		]);
		options.signal?.throwIfAborted();
		return communicationCandidateSearchGuard(sourceNarratorId, principal, {
			...options,
			backend: activeDatabaseBackend,
		});
	},
	execute: async (sql, params, options) => {
		const { activeDatabaseBackend, postgresRuntime } = await import("../../db");
		options?.signal?.throwIfAborted();
		if (activeDatabaseBackend !== "postgres") return sqliteExecute(sql, params, options);
		if (!postgresRuntime || postgresRuntime.closed) throw unavailable();
		return createPostgresCommunicationCandidateExecutor(postgresRuntime.executor)(
			sql,
			params,
			options,
		);
	},
});
