/**
 * Which team a session belongs to, and the team's recorded worktrees (P3).
 *
 * Database-only on purpose: the permission engine and the runtime prompt builder call these on
 * every tool decision and every request, so they must not import the team or narrator services
 * (which import them back). Every query is a primary-key probe or a `(team_id, state)` index
 * range bounded by a LIMIT; teams live on SQLite only, so another backend answers "no team".
 *
 * A session belongs to a team when it IS the coordinator (its narrator id is a `project_teams`
 * key) or when it is a subagent whose ACL root is one — the root is the single authority for a
 * subagent's access decisions, and both subagent levels carry the coordinator there.
 */
import { TEAM_WORK_ITEM_FINISHED_STATES } from "@shared/project-teams";
import { and, asc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../../db";
import { narrators, narratorWorktreeResources, projectTeams, teamWorkItems } from "../../db/schema";

/** Most worktrees of one team a permission decision looks at. */
export const TEAM_WORKTREE_LOOKUP_LIMIT = 64;

export interface TeamWorktree {
	workItemId: string;
	path: string;
}

function teamExists(teamId: string): boolean {
	return Boolean(
		db
			.select({ id: projectTeams.narratorId })
			.from(projectTeams)
			.where(eq(projectTeams.narratorId, teamId))
			.limit(1)
			.get(),
	);
}

/** The team whose coordinator this narrator is, or null. */
export function coordinatedTeamId(narratorId: string): string | null {
	if (activeDatabaseBackend !== "sqlite") return null;
	return teamExists(narratorId) ? narratorId : null;
}

/**
 * The team a narrator works for: its own (a coordinator) or its ACL root's (a team subagent of
 * either level). Null for every other session.
 */
export function teamIdOfNarrator(narratorId: string): string | null {
	if (activeDatabaseBackend !== "sqlite") return null;
	if (teamExists(narratorId)) return narratorId;
	const row = db
		.select({ type: narrators.type, root: narrators.aclRootNarratorId })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.limit(1)
		.get();
	if (!row || row.type !== "subagent" || !row.root) return null;
	return teamExists(row.root) ? row.root : null;
}

/**
 * The recorded worktrees of a team's live work items (not merged or cancelled, worktree still
 * recorded), oldest first. These are the team's own resources: delegating into one and file
 * writes inside one need no person's approval.
 */
export function teamWorktrees(teamId: string): TeamWorktree[] {
	if (activeDatabaseBackend !== "sqlite") return [];
	return db
		.select({ workItemId: teamWorkItems.id, path: narratorWorktreeResources.worktreePath })
		.from(teamWorkItems)
		.innerJoin(
			narratorWorktreeResources,
			eq(narratorWorktreeResources.id, teamWorkItems.worktreeResourceId),
		)
		.where(
			and(
				eq(teamWorkItems.teamId, teamId),
				notInArray(teamWorkItems.state, [...TEAM_WORK_ITEM_FINISHED_STATES]),
				isNotNull(teamWorkItems.worktreeResourceId),
				eq(narratorWorktreeResources.deviceId, "local"),
			),
		)
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(TEAM_WORKTREE_LOOKUP_LIMIT)
		.all();
}

/**
 * The worktree paths a narrator may treat as its team's own (empty outside a team):
 * - the coordinator: every live work item worktree of its team;
 * - a first-level worker: only the item(s) it is the recorded worker of;
 * - a second-level helper: only its parent worker's item(s).
 * Another member's worktree is not this session's resource and still needs a person.
 *
 * Bounded by {@link TEAM_WORKTREE_LOOKUP_LIMIT}: past that many live items the oldest are
 * listed and the rest fall back to asking a person (fails safe, never wider).
 */
export function teamWorktreePathsForNarrator(narratorId: string): string[] {
	const teamId = teamIdOfNarrator(narratorId);
	if (!teamId) return [];
	const all = teamWorktrees(teamId);
	if (teamId === narratorId) return all.map((row) => row.path);
	const row = db
		.select({ parent: narrators.parentNarratorId })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.limit(1)
		.get();
	const workers = new Set([
		narratorId,
		...(row?.parent && row.parent !== teamId ? [row.parent] : []),
	]);
	if (all.length === 0) return [];
	const owned = new Set(
		db
			.select({ id: teamWorkItems.id })
			.from(teamWorkItems)
			.where(
				and(
					eq(teamWorkItems.teamId, teamId),
					inArray(teamWorkItems.workerNarratorId, [...workers]),
				),
			)
			.limit(TEAM_WORKTREE_LOOKUP_LIMIT)
			.all()
			.map((item) => item.id),
	);
	return all.filter((item) => owned.has(item.workItemId)).map((item) => item.path);
}

/**
 * A path segment as the file system may resolve it: lower case (case-insensitive file systems)
 * and without trailing dots and spaces (Windows drops them: `.husky.` is `.husky`).
 */
export function controlSegment(segment: string): string {
	return segment.replace(/[. ]+$/, "").toLowerCase() || segment;
}

/**
 * Whether a path inside a worktree is git control data: a segment named `.git…` (`.git`,
 * `.gitattributes`, `.gitmodules`, `.gitignore`, `.gitconfig`, `.github`, …), `.husky`,
 * `.githooks` or `.lfsconfig`, compared case-insensitively and without trailing dots and spaces.
 * Writing one changes what git runs or how it reads the tree, so it is never auto-allowed as an
 * ordinary file write of the team.
 */
export function isGitControlRelativePath(relative: string): boolean {
	return relative.split(/[\\/]+/).some((segment) => {
		const name = controlSegment(segment);
		return (
			name.startsWith(".git") || name === ".husky" || name === ".githooks" || name === ".lfsconfig"
		);
	});
}

/** Whether `path` is `dir` or inside it, comparing segments as {@link controlSegment} does. */
export function isInsideControlDir(dir: string, path: string): boolean {
	const split = (value: string) =>
		value
			.split(/[\\/]+/)
			.filter(Boolean)
			.map(controlSegment);
	const parent = split(dir);
	const child = split(path);
	return (
		parent.length <= child.length && parent.every((segment, index) => segment === child[index])
	);
}

/**
 * The team brief a team subagent works under, or null (not a team subagent, or no brief).
 * Read on every request of the subagent, so a brief edited mid-run reaches it on its next one.
 */
export function teamBriefForSubagent(row: {
	type: string;
	aclRootNarratorId?: string | null;
}): string | null {
	if (activeDatabaseBackend !== "sqlite") return null;
	if (row.type !== "subagent" || !row.aclRootNarratorId) return null;
	const team = db
		.select({ brief: projectTeams.brief })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, row.aclRootNarratorId))
		.limit(1)
		.get();
	const brief = team?.brief.trim();
	return brief ? brief : null;
}

/**
 * What a `Team({ action: "cleanup" })` call would remove, for the person approving it: the item,
 * its recorded worktree, the kept branch, and the loss a forced call confirms.
 */
export function describeTeamCleanup(narratorId: string, input: Record<string, unknown>): string {
	const itemId = typeof input.item === "string" ? input.item : "";
	const teamId = activeDatabaseBackend === "sqlite" ? coordinatedTeamId(narratorId) : null;
	const item =
		teamId && itemId
			? db
					.select({
						title: teamWorkItems.title,
						state: teamWorkItems.state,
						branch: teamWorkItems.branchName,
						path: narratorWorktreeResources.worktreePath,
					})
					.from(teamWorkItems)
					.leftJoin(
						narratorWorktreeResources,
						eq(narratorWorktreeResources.id, teamWorkItems.worktreeResourceId),
					)
					.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
					.limit(1)
					.get()
			: undefined;
	const parts = [
		item
			? `Team cleanup removes the worktree ${item.path ?? "(none recorded)"} of work item "${item.title}" (${itemId}, ${item.state}); its branch ${item.branch ?? "(none)"} is kept`
			: `Team cleanup of work item ${itemId || "(missing)"}`,
	];
	const loss = input.confirmedLoss as
		| { head?: unknown; dirtyFileCount?: unknown; unreachableCommits?: unknown }
		| undefined;
	if (input.force === true && loss)
		parts.push(
			`FORCED: discards ${String(loss.dirtyFileCount)} uncommitted file(s) and ${String(loss.unreachableCommits)} commit(s) the main branch and upstream lack (head ${String(loss.head)})`,
		);
	return parts.join("; ");
}
