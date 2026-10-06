import { and, asc, eq, getTableColumns, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
	chapterEdges,
	chapters,
	containerInstances,
	narrators,
	projects,
} from "../../db/postgres-schema";
import type { ProjectPrincipal } from "../project-acl";
import { bindPlaceholders, narratorReadableText, projectReadableText } from "./acl-sql";
import {
	chunkIds,
	type GraphNarratorRow,
	isReadablePrincipal,
	type ProjectReadAdapter,
	READ_LIMITS,
	type ReadPage,
} from "./project-read-adapter";
import { decodeSortCursor, encodeSortCursor } from "./read-cursor";

/**
 * Ids per `in (...)` batch.
 *
 * PostgreSQL's parameter ceiling is 65535, far above SQLite's, but the batch size is kept
 * the same as the SQLite adapter's so both backends truncate a very large id list at the
 * same place. Parity is worth more here than the extra round trips it costs.
 */
const ID_BATCH_SIZE = 400;

/** The same column set the SQLite listing uses: everything except the two per-chapter blobs. */
const {
	dockLayoutJson: _dockLayoutJson,
	detachedPanelsJson: _detachedPanelsJson,
	...CHAPTER_LIST_COLUMNS
} = getTableColumns(chapters);

/**
 * A text sort/keyset expression pinned to `COLLATE "C"`, i.e. byte order.
 *
 * WHY, and why it is not cosmetic: every sort key and tiebreak in this adapter is a `text`
 * column, and the two backends order text by different rules unless told otherwise.
 * SQLite compares `text` with its BINARY collation (byte order) and has no locale support
 * to change it. PostgreSQL uses the database's collation, which for the official
 * `postgres:17` image is glibc `en_US.utf8` — a locale that ignores case at the primary
 * level and interleaves it. Measured on the two images this suite runs, over ids of the
 * shape nanoid actually produces:
 *
 *   glibc en_US.utf8: bR7Kq2…, Br7Kq2…, p_alpha, p_beta, p_Beta, …, V1stGXR8…, V1StGXR8…
 *   byte order (C)  : Br7Kq2…, V1StGXR8…, V1stGXR8…, bR7Kq2…, p_Beta, …, p_alpha, p_beta
 *
 * `'Zed' < 'abc'` is FALSE under glibc en_US.utf8 and TRUE in byte order. Ids come from
 * `nanoid`, whose alphabet mixes upper and lower case, so real data always lands in that
 * divergence — which means without this the two backends disagree about page boundaries,
 * about WHICH rows a truncated read keeps, and about what a cursor means.
 *
 * The musl-based `postgres:17-alpine` hides all of this: musl's `en_US.utf8` collation
 * degenerates to byte order, so the default test image agrees with SQLite by accident. That
 * is exactly why the parity matrix also runs the glibc image.
 *
 * `COLLATE "C"` is chosen over the alternative — declaring the cursor non-portable — because
 * these keys are opaque machine identifiers and ISO-8601 timestamps, never anything a person
 * reads in sorted order, so no locale-aware ordering is wanted for them. A user-facing
 * ordering (project name, say) would be the opposite case and must NOT be forced to C; see
 * `read-cursor.ts` for the boundary this contract draws.
 *
 * Applied to the ORDER BY and to the keyset comparison TOGETHER, always. Collating only one
 * of them is worse than collating neither: the WHERE clause would then exclude rows the
 * ORDER BY had not yet reached, and those rows are dropped from the walk entirely rather
 * than merely reordered.
 */
function byteOrder(column: PgColumn): SQL {
	return sql`${column} collate "C"`;
}

/**
 * `column COLLATE "C" <op> value`, the keyset half of the pair above.
 *
 * The bound value carries no collation of its own, so the explicit one on the column decides
 * the comparison. Equality is collated too: under a deterministic collation it means the same
 * thing either way, but leaving one comparison uncollated is precisely how the pair drifts
 * apart during a later edit.
 */
function byteOrderCompare(column: PgColumn, op: "<" | ">" | "=", value: string): SQL {
	return sql`${column} collate "C" ${sql.raw(op)} ${value}`;
}

function clampLimit(limit: number | undefined, max: number): number {
	return Math.min(Math.max(limit ?? max, 1), max);
}

/**
 * Read-only PostgreSQL projection. ACL predicates are part of every query, and every one of
 * them is generated from `acl-sql.ts` — the same text the SQLite fragments produce — so a
 * rule cannot hold on one backend and not the other.
 *
 * Nothing in here may fall back to the SQLite handle. When PostgreSQL serves reads, a
 * SQLite second read would answer from a different (and on a real deployment, empty)
 * dataset while looking like a successful check.
 */
export class PostgresProjectReadAdapter implements ProjectReadAdapter {
	constructor(private readonly db: BunSQLDatabase) {}

	/** The project-readability predicate for the `projects` table itself. */
	private projectReadable(principal: ProjectPrincipal) {
		if (!isReadablePrincipal(principal)) return sql`false`;
		if (principal.isAdmin) return undefined;
		return bindPlaceholders(projectReadableText("projects"), principal.userId);
	}

	/**
	 * The same predicate against a column holding a project id.
	 *
	 * Takes the Drizzle column rather than SQL text so the reference is rendered with the
	 * alias of whatever query it lands in.
	 */
	private projectReadableForColumn(projectIdColumn: unknown, principal: ProjectPrincipal) {
		if (!isReadablePrincipal(principal)) return sql`false`;
		if (principal.isAdmin) return undefined;
		return sql`exists (select 1 from ${projects} p where p.id = ${projectIdColumn} and ${bindPlaceholders(
			projectReadableText("p"),
			principal.userId,
		)})`;
	}

	/**
	 * Whether the principal may read the narrator row — inheritance for subagents, project
	 * gate, private/project/public visibility and explicit grants included.
	 *
	 * This was previously ABSENT: the auxiliary narrator query filtered on chapter ids and
	 * the project only, so anyone who could open a project received every session inside it,
	 * including a teammate's private one and every subagent. Passing the project gate is
	 * necessary for a narrator, never sufficient.
	 */
	private narratorReadable(principal: ProjectPrincipal) {
		if (!isReadablePrincipal(principal)) return sql`false`;
		if (principal.isAdmin) return undefined;
		return bindPlaceholders(narratorReadableText("narrators"), principal.userId);
	}

	async listProjects(principal: ProjectPrincipal, page: ReadPage = {}, status?: string) {
		const limit = clampLimit(page.limit, READ_LIMITS.projectPage);
		const cursor = decodeSortCursor("updatedAt", page.cursor);
		const rows = await this.db
			.select({ project: projects })
			.from(projects)
			.where(
				and(
					status ? eq(projects.status, status) : undefined,
					this.projectReadable(principal),
					cursor
						? or(
								byteOrderCompare(projects.updatedAt, "<", cursor.sort),
								and(
									byteOrderCompare(projects.updatedAt, "=", cursor.sort),
									byteOrderCompare(projects.id, ">", cursor.id),
								),
							)
						: undefined,
				),
			)
			// Same order as SQLite: newest first, id as the tiebreak that makes the cursor safe.
			// Both keys are byte-ordered, matching the keyset comparison above exactly — see
			// `byteOrder` for why the pair must move together.
			.orderBy(sql`${byteOrder(projects.updatedAt)} desc`, asc(byteOrder(projects.id)))
			.limit(limit + 1);
		const pageRows = rows.slice(0, limit).map((row) => row.project);
		const last = pageRows.at(-1);
		return {
			rows: pageRows,
			nextCursor:
				rows.length > limit && last ? encodeSortCursor("updatedAt", last.updatedAt, last.id) : null,
		};
	}

	async getProject(id: string, principal: ProjectPrincipal) {
		const rows = await this.db
			.select({ project: projects })
			.from(projects)
			.where(and(eq(projects.id, id), this.projectReadable(principal)))
			.limit(1);
		return rows[0]?.project ?? null;
	}

	async anyProjectExists(): Promise<boolean> {
		const rows = await this.db.select({ id: projects.id }).from(projects).limit(1);
		return rows.length > 0;
	}

	async getChapter(id: string, principal: ProjectPrincipal) {
		const rows = await this.db
			.select({ chapter: chapters })
			.from(chapters)
			.where(and(eq(chapters.id, id), this.projectReadableForColumn(chapters.projectId, principal)))
			.limit(1);
		return rows[0]?.chapter ?? null;
	}

	private chapterPageQuery(
		projectId: string,
		principal: ProjectPrincipal,
		limit: number,
		cursor: { sort: string; id: string } | null,
		status?: string,
	) {
		return this.db
			.select(CHAPTER_LIST_COLUMNS)
			.from(chapters)
			.where(
				and(
					eq(chapters.projectId, projectId),
					status ? eq(chapters.status, status) : undefined,
					this.projectReadableForColumn(chapters.projectId, principal),
					cursor
						? or(
								byteOrderCompare(chapters.createdAt, ">", cursor.sort),
								and(
									byteOrderCompare(chapters.createdAt, "=", cursor.sort),
									byteOrderCompare(chapters.id, ">", cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(byteOrder(chapters.createdAt)), asc(byteOrder(chapters.id)))
			.limit(limit);
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
		return await this.chapterPageQuery(
			projectId,
			principal,
			READ_LIMITS.chapterPage + 1,
			null,
			status,
		);
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

		const collect = <T>(target: T[], rows: T[], headroom: number): void => {
			if (rows.length > headroom) truncated = true;
			target.push(...rows.slice(0, headroom));
		};

		for (const batch of chunkIds(chapterIds, ID_BATCH_SIZE)) {
			const narratorHeadroom = limit - narratorRows.length;
			if (narratorHeadroom <= 0) truncated = true;
			else {
				const rows = await this.db
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
							// `inArray`, not `= any(...)`. `sql\`${col} = any(${ids})\`` renders the array
							// as a parenthesised parameter LIST — `any(($1, $2, $3))` — which PostgreSQL
							// rejects outright with "op ANY/ALL (array) requires array on right side".
							// It never reached a real server before, so the shape looked fine.
							inArray(narrators.chapterId, batch),
							eq(chapters.projectId, projectId),
							this.narratorReadable(principal),
						),
					)
					// Byte-ordered, like every other ordering here: this one decides WHICH
					// narrators survive `auxiliaryRows`, so a locale-dependent order would make
					// the two backends drop different sessions from the same canvas.
					.orderBy(asc(byteOrder(narrators.createdAt)), asc(byteOrder(narrators.id)))
					.limit(narratorHeadroom + 1);
				collect(narratorRows, rows, narratorHeadroom);
			}

			const containerHeadroom = limit - containers.length;
			if (containerHeadroom <= 0) truncated = true;
			else {
				const rows = await this.db
					.select({ chapterId: containerInstances.chapterId })
					.from(containerInstances)
					.innerJoin(chapters, eq(chapters.id, containerInstances.chapterId))
					.where(
						and(
							inArray(containerInstances.chapterId, batch),
							ne(containerInstances.status, "removed"),
							eq(chapters.projectId, projectId),
							this.projectReadableForColumn(chapters.projectId, principal),
						),
					)
					.groupBy(containerInstances.chapterId)
					.orderBy(asc(byteOrder(containerInstances.chapterId)))
					.limit(containerHeadroom + 1);
				collect(containers, rows, containerHeadroom);
			}

			const panelHeadroom = limit - detachedPanels.length;
			if (panelHeadroom <= 0) truncated = true;
			else {
				const rows = await this.db
					.select({ id: chapters.id, detachedPanelsJson: chapters.detachedPanelsJson })
					.from(chapters)
					.where(
						and(
							eq(chapters.projectId, projectId),
							inArray(chapters.id, batch),
							sql`${chapters.detachedPanelsJson} is not null`,
						),
					)
					.orderBy(asc(byteOrder(chapters.id)))
					.limit(panelHeadroom + 1);
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
			...(truncated ? { truncated: true as const } : {}),
		};
	}

	async getGraph(projectId: string, principal: ProjectPrincipal) {
		const visible = await this.getProject(projectId, principal);
		if (!visible) return { chapters: [], edges: [] };
		const chapterLimit = READ_LIMITS.graphChapters;
		const edgeLimit = READ_LIMITS.graphEdges;
		const chapterRows = await this.db
			.select({
				id: chapters.id,
				title: chapters.title,
				status: chapters.status,
				branch: chapters.branch,
				role: chapters.role,
				color: chapters.color,
				groupLabel: chapters.groupLabel,
				explorationGroupId: chapters.explorationGroupId,
				isRoot: chapters.isRoot,
				graphX: chapters.graphX,
				graphY: chapters.graphY,
				commitCount: chapters.commitCount,
				headCommitSha: chapters.headCommitSha,
				worktreePath: chapters.worktreePath,
				panelExpanded: chapters.panelExpanded,
				panelWidth: chapters.panelWidth,
				panelHeight: chapters.panelHeight,
				reviewSourceChapterId: chapters.reviewSourceChapterId,
				reviewStatus: chapters.reviewStatus,
			})
			.from(chapters)
			.where(eq(chapters.projectId, projectId))
			.orderBy(asc(byteOrder(chapters.createdAt)), asc(byteOrder(chapters.id)))
			.limit(chapterLimit + 1);
		const truncatedChapters = chapterRows.length > chapterLimit;
		const pageChapters = chapterRows.slice(0, chapterLimit);
		const keptIds = new Set(pageChapters.map((ch) => ch.id));
		const edgeRows = await this.db
			.select({
				id: chapterEdges.id,
				sourceId: chapterEdges.sourceId,
				targetId: chapterEdges.targetId,
				type: chapterEdges.type,
				metadata: chapterEdges.metadata,
			})
			.from(chapterEdges)
			.where(eq(chapterEdges.projectId, projectId))
			.orderBy(asc(byteOrder(chapterEdges.createdAt)), asc(byteOrder(chapterEdges.id)))
			.limit(edgeLimit + 1);
		const truncatedEdges = edgeRows.length > edgeLimit;
		const keptEdges = edgeRows.slice(0, edgeLimit);
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
