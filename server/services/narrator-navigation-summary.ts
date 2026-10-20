import type { NarratorNavigationSummary } from "@shared/narrator-panel-state";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { isSubagentVariant } from "../lib/narrator-utils";
import { canReadNarrator, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";
import { projectReadableWhere, projectReadableWhereForColumn } from "./project-acl";

/** Navigation is a separate read surface, never a title-based authorization guess. */
export async function getNarratorNavigationSummary(
	row: Pick<
		typeof narrators.$inferSelect,
		"parentNarratorId" | "variant" | "chapterId" | "contextProjectId"
	>,
	principal: NarratorPrincipal,
): Promise<NarratorNavigationSummary> {
	const result: NarratorNavigationSummary = {
		parentNarratorId: null,
		parentNarratorTitle: null,
		chapterId: null,
		chapterTitle: null,
		projectId: null,
	};
	let context = row;
	if (isSubagentVariant(row.variant)) {
		if (!row.parentNarratorId) return result;
		const parent = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, row.parentNarratorId),
				columns: { ...NARRATOR_ACL_COLUMNS, title: true, variant: true, parentNarratorId: true },
			}),
			{ site: "narrator-navigation-summary.getNarratorNavigationSummary" },
		);
		if (!parent || !(await canReadNarrator(parent, principal))) return result;
		result.parentNarratorId = parent.id;
		result.parentNarratorTitle = parent.title;
		context = parent;
	}
	if (context.chapterId) {
		const chapter = await readQueryFirst(
			db
				.select({ id: chapters.id, title: chapters.title, projectId: projects.id })
				.from(chapters)
				.innerJoin(projects, eq(projects.id, chapters.projectId))
				.where(and(eq(chapters.id, context.chapterId), projectReadableWhere(principal))),
			{ site: "narrator-navigation-summary.getNarratorNavigationSummary" },
		);
		if (chapter) {
			result.chapterId = chapter.id;
			result.chapterTitle = chapter.title;
			result.projectId = chapter.projectId;
		}
	} else if (context.contextProjectId) {
		const project = await readQueryFirst(
			db
				.select({ id: projects.id })
				.from(projects)
				.where(
					and(
						eq(projects.id, context.contextProjectId),
						projectReadableWhereForColumn(principal, sql`projects.id`),
					),
				),
			{ site: "narrator-navigation-summary.getNarratorNavigationSummary" },
		);
		result.projectId = project?.id ?? null;
	}
	if (result.parentNarratorId) {
		const current = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, result.parentNarratorId),
				columns: NARRATOR_ACL_COLUMNS,
			}),
			{ site: "narrator-navigation-summary.getNarratorNavigationSummary" },
		);
		if (!current || !(await canReadNarrator(current, principal)))
			return {
				parentNarratorId: null,
				parentNarratorTitle: null,
				chapterId: null,
				chapterTitle: null,
				projectId: null,
			};
	}
	return result;
}
