import type { NarratorNavigationSummary } from "@shared/narrator-panel-state";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects } from "../db/schema";
import { isSubagentVariant, parseTraits } from "../lib/narrator-utils";
import { canReadNarrator, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";
import { resolveNarratorProjectId } from "./narrator-project";
import { projectReadableWhereForColumn } from "./project-acl";

/** Navigation is a separate read surface, never a title-based authorization guess. */
export async function getNarratorNavigationSummary(
	row: Pick<
		typeof narrators.$inferSelect,
		"id" | "parentNarratorId" | "variant" | "contextProjectId"
	> &
		Partial<Pick<typeof narrators.$inferSelect, "traits">>,
	principal: NarratorPrincipal,
): Promise<NarratorNavigationSummary> {
	const result: NarratorNavigationSummary = {
		parentNarratorId: null,
		parentNarratorTitle: null,
		projectId: null,
	};
	let context = row;
	if (isSubagentVariant(row.variant) || parseTraits(row.traits).includes("modeltrace")) {
		if (!row.parentNarratorId) return result;
		const parent = await db.query.narrators.findFirst({
			where: eq(narrators.id, row.parentNarratorId),
			columns: { ...NARRATOR_ACL_COLUMNS, title: true, variant: true, parentNarratorId: true },
		});
		if (!parent || !(await canReadNarrator(parent, principal))) return result;
		result.parentNarratorId = parent.id;
		result.parentNarratorTitle = parent.title;
		context = parent;
	}
	const contextProjectId = await resolveNarratorProjectId(context);
	if (contextProjectId) {
		const project = await db
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.id, contextProjectId),
					projectReadableWhereForColumn(principal, sql`projects.id`),
				),
			)
			.get();
		result.projectId = project?.id ?? null;
	}
	if (result.parentNarratorId) {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, result.parentNarratorId),
			columns: NARRATOR_ACL_COLUMNS,
		});
		if (!current || !(await canReadNarrator(current, principal)))
			return {
				parentNarratorId: null,
				parentNarratorTitle: null,
				projectId: null,
			};
	}
	return result;
}
