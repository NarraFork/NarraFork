/**
 * Project tabs in the sidebar's recent tabs (`type: "project"`, id = project id): the runtime
 * state their hover card shows, so the card says more than the name in the row.
 *
 * For each project tab whose project the user can still read (`resolveProjectGate`):
 * - `projectPath`: the project's repository directory;
 * - `activeSessionCount` / `waitingSessionCount`: primary sessions linked to the project
 *   (any link role, as on the project page) that are `working` or `waiting`, and that this user
 *   can read (`narratorReadableWhere`, so private sessions of others are not counted);
 * - `teamCount`: the project's active teams whose coordinator this user can read;
 * - `projectCountsCapped`: a read hit its row cap, so the counts are lower bounds.
 * A project the user can no longer read, or that is gone, gets no state.
 *
 * Bounded, and off the main thread for the joins: at most PROJECT_TAB_DETAIL_LIMIT project tabs
 * per runtime request, one gate check each, one primary-key `IN` for the paths, and two
 * indexed reads (`idx_narrators_status` / `idx_narrator_project_links_project`,
 * `idx_project_teams_project_status`) of at most PROJECT_TAB_ROW_CAP + 1 rows each, run through
 * the read worker (`readQuery`, `worker-required`). No `COUNT(*)` over a project's history:
 * only sessions running right now are read.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { narratorProjectLinks, narrators, projects, projectTeams } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { logger } from "../lib/logger";
import { narratorReadableWhere } from "./narrator-acl";
import { resolveProjectGate } from "./project-acl";
import { principalOf } from "./recent-tab-teams";

/** Project tabs of one runtime request that get details; the rest report none. */
export const PROJECT_TAB_DETAIL_LIMIT = 20;
/** Rows read per query (active sessions, teams) across all project tabs of one request. */
export const PROJECT_TAB_ROW_CAP = 200;
const READ_TIMEOUT_MS = 5_000;

const RUNTIME_FIELDS = [
	"projectPath",
	"activeSessionCount",
	"waitingSessionCount",
	"teamCount",
	"projectCountsCapped",
] as const;

/** Runtime state of project tabs, in place (see the module header). Never throws. */
export async function enrichProjectTabs(
	tabs: Record<string, unknown>[],
	userId: string,
): Promise<void> {
	const projectTabs = tabs.filter((tab) => tab.type === "project" && typeof tab.id === "string");
	if (projectTabs.length === 0) return;
	for (const tab of projectTabs) for (const field of RUNTIME_FIELDS) delete tab[field];
	try {
		const principal = await principalOf(userId);
		if (!principal) return;
		const candidates = [...new Set(projectTabs.map((tab) => tab.id as string))].slice(
			0,
			PROJECT_TAB_DETAIL_LIMIT,
		);
		const readable: string[] = [];
		for (const projectId of candidates)
			if ((await resolveProjectGate(projectId, principal)).read) readable.push(projectId);
		if (readable.length === 0) return;

		const paths = await db
			.select({ id: projects.id, gitPath: projects.gitPath })
			.from(projects)
			.where(inArray(projects.id, readable))
			.limit(readable.length);
		const pathOf = new Map(paths.map((row) => [row.id, row.gitPath]));

		const sessionRows = await readQuery(
			db
				.select({
					projectId: narratorProjectLinks.projectId,
					id: narrators.id,
					status: narrators.status,
				})
				.from(narratorProjectLinks)
				.innerJoin(narrators, eq(narrators.id, narratorProjectLinks.narratorId))
				.where(
					and(
						inArray(narratorProjectLinks.projectId, readable),
						inArray(narrators.status, ["working", "waiting"]),
						eq(narrators.type, "primary"),
						eq(narrators.hiddenFromLists, false),
						narratorReadableWhere(principal),
					),
				)
				.limit(PROJECT_TAB_ROW_CAP + 1),
			{
				executionPolicy: "worker-required",
				maxRows: PROJECT_TAB_ROW_CAP + 1,
				timeoutMs: READ_TIMEOUT_MS,
			},
		);
		const teamRows = await readQuery(
			db
				.select({ projectId: projectTeams.projectId, id: projectTeams.narratorId })
				.from(projectTeams)
				.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
				.where(
					and(
						inArray(projectTeams.projectId, readable),
						eq(projectTeams.status, "active"),
						ne(narrators.status, "archived"),
						narratorReadableWhere(principal),
					),
				)
				.limit(PROJECT_TAB_ROW_CAP + 1),
			{
				executionPolicy: "worker-required",
				maxRows: PROJECT_TAB_ROW_CAP + 1,
				timeoutMs: READ_TIMEOUT_MS,
			},
		);
		const capped =
			sessionRows.length > PROJECT_TAB_ROW_CAP || teamRows.length > PROJECT_TAB_ROW_CAP;

		const active = new Map<string, Set<string>>();
		const waiting = new Map<string, Set<string>>();
		for (const row of sessionRows.slice(0, PROJECT_TAB_ROW_CAP)) {
			add(active, row.projectId, row.id);
			if (row.status === "waiting") add(waiting, row.projectId, row.id);
		}
		const teams = new Map<string, Set<string>>();
		for (const row of teamRows.slice(0, PROJECT_TAB_ROW_CAP)) add(teams, row.projectId, row.id);

		const readableSet = new Set(readable);
		for (const tab of projectTabs) {
			const projectId = tab.id as string;
			if (!readableSet.has(projectId) || !pathOf.has(projectId)) continue;
			tab.projectPath = pathOf.get(projectId) ?? null;
			tab.activeSessionCount = active.get(projectId)?.size ?? 0;
			tab.waitingSessionCount = waiting.get(projectId)?.size ?? 0;
			tab.teamCount = teams.get(projectId)?.size ?? 0;
			if (capped) tab.projectCountsCapped = true;
		}
	} catch (err) {
		for (const tab of projectTabs) for (const field of RUNTIME_FIELDS) delete tab[field];
		logger.warn("Failed to enrich project tabs", { error: String(err) });
	}
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(value);
}
