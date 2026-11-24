/**
 * Which project a narrator belongs to — the single answer to that question.
 *
 * Project membership gates access, layers traits and selects skills, routines and
 * devices. Every divergent copy of this question is a place where a check can be
 * bypassed, so callers go through here rather than reading `contextProjectId` or the
 * link table themselves.
 *
 * The answer is the narrator's PRIMARY project: `contextProjectId` when it has one,
 * otherwise the project its working directory was indexed into (see
 * `project-index.ts`). Additional links never take part.
 */

import { and, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { narratorProjectLinks, narrators } from "../db/schema";
import { type ReadQueryOptions, readQueryFirst } from "../db/worker-read";

/** The narrator columns this resolution needs — nothing else is read. */
export interface NarratorProjectRef {
	id: string;
	contextProjectId?: string | null;
}

/**
 * Resolve the project from an already-loaded narrator row.
 *
 * Returns null when the narrator belongs to no project. Callers gating on membership
 * must treat null as "no project gate applies", NOT as "no restrictions" — the
 * resource's own ACL still decides.
 */
export async function resolveNarratorProjectId(
	narrator: NarratorProjectRef,
	readOptions?: ReadQueryOptions,
): Promise<string | null> {
	readOptions?.signal?.throwIfAborted();
	if (narrator.contextProjectId) return narrator.contextProjectId;
	// The link table lives in the SQLite main database; on PostgreSQL only the explicit
	// project is known until the index is ported there.
	if (activeDatabaseBackend !== "sqlite") return null;
	const link = await readQueryFirst(
		db
			.select({ projectId: narratorProjectLinks.projectId })
			.from(narratorProjectLinks)
			.where(
				and(
					eq(narratorProjectLinks.narratorId, narrator.id),
					eq(narratorProjectLinks.role, "primary"),
				),
			),
		{ timeoutMs: 30_000, ...readOptions, executionPolicy: "worker-required", maxRows: 1 },
	);
	return link?.projectId ?? null;
}

/**
 * Same resolution, starting from a narrator id.
 *
 * Returns null when the narrator does not exist, matching the row-based variant's
 * "unknown project" contract instead of throwing: callers are gating or layering,
 * not asserting existence.
 */
export async function resolveProjectIdForNarratorId(
	narratorId: string,
	readOptions?: ReadQueryOptions,
): Promise<string | null> {
	readOptions?.signal?.throwIfAborted();
	const narrator = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, narratorId),
			columns: { id: true, contextProjectId: true },
		}),
		{ timeoutMs: 30_000, ...readOptions, executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!narrator) return null;
	return await resolveNarratorProjectId(narrator, readOptions);
}

/**
 * The same rule as a Drizzle expression over the (unaliased) `narrators` table, for
 * queries that select, join or filter on a narrator's project. The raw-SQL mirror used
 * by list predicates is `narratorProjectIdText` in `read/acl-sql.ts`.
 */
export const narratorProjectIdColumn = sql<
	string | null
>`coalesce(${narrators.contextProjectId}, (select npl.project_id from narrator_project_links npl where npl.narrator_id = ${narrators.id} and npl.role = 'primary'))`;
