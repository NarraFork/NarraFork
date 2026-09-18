import { and, asc, eq, getTableColumns, gt, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { chapterEdges, chapters, containerInstances, narrators, projects } from "../../db/schema";
import { narratorReadableWhere } from "../narrator-acl";
import {
	type ProjectPrincipal,
	projectReadableWhere,
	projectReadableWhereForColumn,
} from "../project-acl";
import {
	chunkIds,
	type GraphNarratorRow,
	isReadablePrincipal,
	type ProjectReadAdapter,
	READ_LIMITS,
	type ReadPage,
} from "./project-read-adapter";
import { decodeSortCursor, encodeSortCursor } from "./read-cursor";

/** Ids per `in (...)` batch. Well under SQLite's default 999-variable ceiling. */
const ID_BATCH_SIZE = 400;

/**
 * Chapter columns for the LIST, derived from the table so it cannot drift as columns are
 * added: everything except the two per-chapter blobs.
 *
 * `dockLayoutJson` and `detachedPanelsJson` are read by their own `/chapters/:id/...`
 * endpoints. A listing returns every chapter of a project, so carrying one blob per row is
 * how a bounded query becomes a multi-megabyte response.
 */
const {
	dockLayoutJson: _dockLayoutJson,
	detachedPanelsJson: _detachedPanelsJson,
	...CHAPTER_LIST_COLUMNS
} = getTableColumns(chapters);

function clampLimit(limit: number | undefined, max: number): number {
	return Math.min(Math.max(limit ?? max, 1), max);
}

export class SqliteProjectReadAdapter implements ProjectReadAdapter {
	async listProjects(principal: ProjectPrincipal, page: ReadPage = {}, status?: string) {
		const limit = clampLimit(page.limit, READ_LIMITS.projectPage);
		const cursor = decodeSortCursor("updatedAt", page.cursor);
		const rows = await db.query.projects.findMany({
			where: and(
				isReadablePrincipal(principal) ? undefined : sql`0`,
				status ? eq(projects.status, status as "active" | "archived") : undefined,
				projectReadableWhere(principal),
				cursor
					? or(
							// Descending order, so a continuation walks towards OLDER rows.
							sql`${projects.updatedAt} < ${cursor.sort}`,
							and(eq(projects.updatedAt, cursor.sort), gt(projects.id, cursor.id)),
						)
					: undefined,
			),
			// Most-recently-updated first — the order this endpoint has always had and what
			// the dashboard's "recent projects" reading depends on. The id tiebreak is what
			// makes the cursor safe when many rows share `updatedAt`.
			orderBy: (p, { desc }) => [desc(p.updatedAt), asc(p.id)],
			limit: limit + 1,
		});
		const pageRows = rows.slice(0, limit);
		const last = pageRows.at(-1);
		return {
			rows: pageRows,
			nextCursor:
				rows.length > limit && last ? encodeSortCursor("updatedAt", last.updatedAt, last.id) : null,
		};
	}

	async getProject(id: string, principal: ProjectPrincipal) {
		return (
			(await db.query.projects.findFirst({
				where: and(
					isReadablePrincipal(principal) ? undefined : sql`0`,
					eq(projects.id, id),
					projectReadableWhere(principal),
				),
			})) ?? null
		);
	}

	async anyProjectExists(): Promise<boolean> {
		const row = await db.query.projects.findFirst({ columns: { id: true } });
		return !!row;
	}

	async getChapter(id: string, principal: ProjectPrincipal) {
		const rows = await db
			.select({ chapter: chapters })
			.from(chapters)
			.where(
				and(
					isReadablePrincipal(principal) ? undefined : sql`0`,
					eq(chapters.id, id),
					projectReadableWhereForColumn(principal, chapters.projectId),
				),
			)
			.limit(1);
		return rows[0]?.chapter ?? null;
	}

	/**
	 * One page of chapters, oldest first.
	 *
	 * `createdAt` ascending is the graph's reading order (a chapter's parents come before
	 * it), and the id tiebreak decides among chapters created in the same millisecond —
	 * which a fork burst genuinely produces.
	 */
	private chapterPageQuery(
		projectId: string,
		principal: ProjectPrincipal,
		limit: number,
		cursor: { sort: string; id: string } | null,
		status?: string,
	) {
		return (
			db
				// Every chapter column EXCEPT the two per-chapter blobs: `dock_layout_json` and
				// `detached_panels_json` are read by their own `/chapters/:id/...` endpoints, and a
				// listing that returns every chapter of a project must not carry one blob per row.
				.select(CHAPTER_LIST_COLUMNS)
				.from(chapters)
				.where(
					and(
						isReadablePrincipal(principal) ? undefined : sql`0`,
						eq(chapters.projectId, projectId),
						status
							? eq(chapters.status, status as "active" | "dormant" | "merged" | "abandoned")
							: undefined,
						projectReadableWhereForColumn(principal, chapters.projectId),
						cursor
							? or(
									gt(chapters.createdAt, cursor.sort),
									and(eq(chapters.createdAt, cursor.sort), gt(chapters.id, cursor.id)),
								)
							: undefined,
					),
				)
				.orderBy(asc(chapters.createdAt), asc(chapters.id))
				.limit(limit)
		);
	}

	async listChaptersPage(
		projectId: string,
		principal: ProjectPrincipal,
		page: ReadPage = {},
		status?: string,
	) {
		const limit = clampLimit(page.limit, READ_LIMITS.chapterPage);
		const cursor = decodeSortCursor("createdAt", page.cursor);
		const rows = await this.chapterPageQuery(projectId, principal, limit + 1, cursor, status);
		const pageRows = rows.slice(0, limit);
		const last = pageRows.at(-1);
		return {
			rows: pageRows,
			nextCursor:
				rows.length > limit && last ? encodeSortCursor("createdAt", last.createdAt, last.id) : null,
		};
	}

	async listChapters(projectId: string, principal: ProjectPrincipal, status?: string) {
		// `chapterPage + 1` rows, returned as-is: the legacy array shape has nowhere to put a
		// cursor, so the extra row IS the truncation signal for callers that count.
		return this.chapterPageQuery(projectId, principal, READ_LIMITS.chapterPage + 1, null, status);
	}

	async getGraphAuxiliaryData(
		projectId: string,
		chapterIds: string[],
		principal: ProjectPrincipal,
	) {
		if (chapterIds.length === 0 || !(await this.getProject(projectId, principal))) {
			return { narrators: [], containers: [], detachedPanels: [] };
		}
		const limit = READ_LIMITS.auxiliaryRows;
		const narratorRows: GraphNarratorRow[] = [];
		const containers: Array<{ chapterId: string }> = [];
		const detachedPanels: Array<{ id: string; detachedPanelsJson: string }> = [];
		let truncated = false;

		/** Take rows up to the shared cap, recording whether anything was left behind. */
		const collect = <T>(target: T[], rows: T[], headroom: number): void => {
			if (rows.length > headroom) truncated = true;
			target.push(...rows.slice(0, headroom));
		};

		for (const batch of chunkIds(chapterIds, ID_BATCH_SIZE)) {
			const narratorHeadroom = limit - narratorRows.length;
			if (narratorHeadroom <= 0) truncated = true;
			else {
				collect(
					narratorRows,
					await this.narratorBatch(batch, projectId, principal, narratorHeadroom + 1),
					narratorHeadroom,
				);
			}

			const containerHeadroom = limit - containers.length;
			if (containerHeadroom <= 0) truncated = true;
			else {
				const rows = await db
					.select({ chapterId: containerInstances.chapterId })
					.from(containerInstances)
					// The project is reached THROUGH the chapter. This predicate used to be
					// `projectReadableWhereForColumn(principal, containerInstances.chapterId)`, which
					// compiles to `p.id = container_instances.chapter_id` — a project id compared
					// against a chapter id, so the EXISTS never matched and every non-admin lost the
					// container badge on every node. Admins were unaffected only because the helper
					// returns `undefined` for them, which `and(...)` drops, which is why this never
					// showed up in admin-run checks.
					.innerJoin(chapters, eq(chapters.id, containerInstances.chapterId))
					.where(
						and(
							inArray(containerInstances.chapterId, batch),
							ne(containerInstances.status, "removed"),
							// Chapters of another project reach nothing, even when named explicitly.
							eq(chapters.projectId, projectId),
							projectReadableWhereForColumn(principal, chapters.projectId),
						),
					)
					.groupBy(containerInstances.chapterId)
					.orderBy(asc(containerInstances.chapterId))
					.limit(containerHeadroom + 1)
					.all();
				collect(containers, rows, containerHeadroom);
			}

			const panelHeadroom = limit - detachedPanels.length;
			if (panelHeadroom <= 0) truncated = true;
			else {
				const rows = await db
					.select({ id: chapters.id, detachedPanelsJson: chapters.detachedPanelsJson })
					.from(chapters)
					.where(
						and(
							inArray(chapters.id, batch),
							eq(chapters.projectId, projectId),
							sql`${chapters.detachedPanelsJson} is not null`,
						),
					)
					.orderBy(asc(chapters.id))
					.limit(panelHeadroom + 1)
					.all();
				collect(
					detachedPanels,
					rows.flatMap((row) =>
						row.detachedPanelsJson === null
							? []
							: [{ id: row.id, detachedPanelsJson: row.detachedPanelsJson }],
					),
					panelHeadroom,
				);
			}
		}

		return {
			narrators: narratorRows,
			containers,
			detachedPanels,
			// Absent unless something was actually dropped, so a complete answer keeps the exact
			// shape this call has always returned.
			...(truncated ? { truncated: true as const } : {}),
		};
	}

	/**
	 * The readable narrators of one batch of chapters.
	 *
	 * `narratorReadableWhere` is the same predicate the narrator surface lists with, so a
	 * badge on the canvas cannot open into a 404 and a teammate's private session cannot
	 * appear because the project happens to be readable. The join to `chapters` scopes the
	 * result to the requested project, so a foreign chapter id passed by a caller reaches
	 * nothing.
	 */
	private narratorBatch(
		batch: string[],
		projectId: string,
		principal: ProjectPrincipal,
		limit: number,
	) {
		return (
			db
				.select({
					id: narrators.id,
					chapterId: narrators.chapterId,
					status: narrators.status,
					substatus: narrators.substatus,
					ownerUserId: narrators.ownerUserId,
					visibility: narrators.visibility,
				})
				.from(narrators)
				.innerJoin(chapters, eq(chapters.id, narrators.chapterId))
				.where(
					and(
						inArray(narrators.chapterId, batch),
						eq(chapters.projectId, projectId),
						narratorReadableWhere(principal),
					),
				)
				// Oldest first, which is the insertion order this list used to come back in and
				// therefore keeps the "first narrator of a chapter" the graph badges on. Explicit
				// rather than incidental so both backends agree, including about WHICH rows a
				// truncated batch keeps.
				.orderBy(asc(narrators.createdAt), asc(narrators.id))
				.limit(limit)
				.all()
		);
	}

	async getGraph(projectId: string, principal: ProjectPrincipal) {
		const visible = await this.getProject(projectId, principal);
		// An unreadable project yields the same empty graph an empty project does, with no
		// truncation fields — nothing was cut, and the two must be indistinguishable so a
		// denial does not confirm the project has content.
		if (!visible) return { chapters: [], edges: [] };
		const chapterLimit = READ_LIMITS.graphChapters;
		const edgeLimit = READ_LIMITS.graphEdges;
		const projectChapters = await db.query.chapters.findMany({
			where: eq(chapters.projectId, projectId),
			orderBy: (ch) => [asc(ch.createdAt), asc(ch.id)],
			columns: {
				id: true,
				title: true,
				status: true,
				branch: true,
				role: true,
				color: true,
				groupLabel: true,
				explorationGroupId: true,
				isRoot: true,
				graphX: true,
				graphY: true,
				commitCount: true,
				headCommitSha: true,
				worktreePath: true,
				panelExpanded: true,
				panelWidth: true,
				panelHeight: true,
				reviewSourceChapterId: true,
				reviewStatus: true,
			},
			// One row over the cap, so truncation is detected rather than inferred from
			// `length === limit` (which is wrong for a project holding exactly `limit` rows).
			limit: chapterLimit + 1,
		});
		const truncatedChapters = projectChapters.length > chapterLimit;
		const pageChapters = projectChapters.slice(0, chapterLimit);
		const keptIds = new Set(pageChapters.map((ch) => ch.id));
		const edgeRows = await db.query.chapterEdges.findMany({
			where: eq(chapterEdges.projectId, projectId),
			columns: { id: true, sourceId: true, targetId: true, type: true, metadata: true },
			// Ordered so that WHICH edges a truncated graph keeps is the same on both backends.
			orderBy: (edge) => [asc(edge.createdAt), asc(edge.id)],
			limit: edgeLimit + 1,
		});
		const truncatedEdges = edgeRows.length > edgeLimit;
		// Edges whose endpoints were dropped are removed too: an edge pointing at a chapter
		// that is not in the payload renders as a dangling connection on the canvas.
		const keptEdges = edgeRows.slice(0, edgeLimit);
		// Edges whose endpoints were dropped are removed too, and that ALSO counts as
		// truncation: an edge pointing at a chapter missing from the payload renders as a
		// dangling connection, and silently dropping it renders as a deleted relationship.
		const edges = keptEdges.filter(
			(edge) => keptIds.has(edge.sourceId) && keptIds.has(edge.targetId),
		);
		const droppedDanglingEdges = edges.length < keptEdges.length;
		return {
			chapters: pageChapters,
			edges,
			...(truncatedChapters || truncatedEdges || droppedDanglingEdges
				? { truncated: true as const }
				: {}),
			...(truncatedChapters ? { truncatedChapters: true as const } : {}),
			...(truncatedEdges || droppedDanglingEdges ? { truncatedEdges: true as const } : {}),
		};
	}
}
