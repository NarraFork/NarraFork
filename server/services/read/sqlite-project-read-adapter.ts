import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import { readQuery } from "../../db/worker-read";
import { type ProjectPrincipal, projectReadableWhere } from "../project-acl";
import {
	isReadablePrincipal,
	type ProjectReadAdapter,
	READ_LIMITS,
	type ReadPage,
} from "./project-read-adapter";
import { decodeSortCursor, encodeSortCursor } from "./read-cursor";

function clampLimit(limit: number | undefined, max: number): number {
	return Math.min(Math.max(limit ?? max, 1), max);
}

export class SqliteProjectReadAdapter implements ProjectReadAdapter {
	async listProjects(principal: ProjectPrincipal, page: ReadPage = {}, status?: string) {
		const limit = clampLimit(page.limit, READ_LIMITS.projectPage);
		const cursor = decodeSortCursor("updatedAt", page.cursor);
		const rows = await readQuery(
			db.query.projects.findMany({
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
			}),
			{ executionPolicy: "worker-required" },
		);
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
			(await readQuery(
				db.query.projects.findFirst({
					where: and(
						isReadablePrincipal(principal) ? undefined : sql`0`,
						eq(projects.id, id),
						projectReadableWhere(principal),
					),
				}),
				{ executionPolicy: "worker-required" },
			)) ?? null
		);
	}

	async anyProjectExists(): Promise<boolean> {
		const row = await readQuery(db.query.projects.findFirst({ columns: { id: true } }), {
			executionPolicy: "worker-required",
		});
		return !!row;
	}
}
