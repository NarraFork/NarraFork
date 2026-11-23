import type { NarratorNavigationSummary } from "@shared/narrator-panel-state";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects } from "../db/schema";
import { type ReadQueryOptions, readQueryFirst } from "../db/worker-read";
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
	options: Pick<ReadQueryOptions, "deadlineAt" | "signal"> = {},
): Promise<NarratorNavigationSummary> {
	const readOptions: ReadQueryOptions = {
		deadlineAt: options.deadlineAt ?? Date.now() + 30_000,
		signal: options.signal,
		executionPolicy: "worker-required",
		diagnosticSource: "narrators.navigation-summary",
		maxRows: 1,
	};
	readOptions.signal?.throwIfAborted();
	const result: NarratorNavigationSummary = {
		parentNarratorId: null,
		parentNarratorTitle: null,
		projectId: null,
	};
	let context = row;
	if (isSubagentVariant(row.variant) || parseTraits(row.traits).includes("modeltrace")) {
		if (!row.parentNarratorId) return result;
		const parent = await readQueryFirst(
			db.query.narrators.findMany({
				limit: 1,
				where: eq(narrators.id, row.parentNarratorId),
				columns: { ...NARRATOR_ACL_COLUMNS, title: true, variant: true, parentNarratorId: true },
			}),
			readOptions,
		);
		if (!parent || !(await canReadNarrator(parent, principal, readOptions))) return result;
		result.parentNarratorId = parent.id;
		result.parentNarratorTitle = parent.title;
		context = parent;
	}
	const contextProjectId = await resolveNarratorProjectId(context, readOptions);
	if (contextProjectId) {
		const project = await readQueryFirst(
			db
				.select({ id: projects.id })
				.from(projects)
				.where(
					and(
						eq(projects.id, contextProjectId),
						projectReadableWhereForColumn(principal, sql`projects.id`),
					),
				)
				.limit(1),
			readOptions,
		);
		result.projectId = project?.id ?? null;
	}
	if (result.parentNarratorId) {
		const current = await readQueryFirst(
			db.query.narrators.findMany({
				limit: 1,
				where: eq(narrators.id, result.parentNarratorId),
				columns: NARRATOR_ACL_COLUMNS,
			}),
			readOptions,
		);
		if (!current || !(await canReadNarrator(current, principal, readOptions)))
			return {
				parentNarratorId: null,
				parentNarratorTitle: null,
				projectId: null,
			};
	}
	return result;
}
