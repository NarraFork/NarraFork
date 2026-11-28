/**
 * Dependencies between the work items of one team (D): an item waits for other items of its
 * team to MERGE before it may start.
 *
 * - The coordinator sets an item's whole set at once (`Team` `dependsOn` on `work.create` and
 *   `work.update`), only while the item is queued: at most {@link TEAM_WORK_DEPENDENCIES_MAX},
 *   every target an item of the same team that is not cancelled, never the item itself, never a
 *   cycle. Recorded as `work.dependencies_changed`.
 * - Starting a queued item (`Agent({ workdir })` → `attachWorker`) is refused with 409
 *   `TEAM_WORK_ITEM_BLOCKED` while any dependency is not merged — `ready` is not enough (the
 *   branch would start from a base without it), and a cancelled one blocks until the coordinator
 *   removes or replaces it.
 * - Every target is made from the same base branch as the item (409
 *   `TEAM_WORK_DEPENDENCY_BASE_MISMATCH`): items pin the team's base when created and the team's
 *   base can change, while `work.sync` only brings the item's own base in. A dependency on another
 *   base (rows from before this check) never counts as merged, with its own blocker reason.
 * - Merged is necessary, not sufficient: a dependency counts only once its head is inside the ref
 *   the dependent's work starts from (`origin/<base>` or the local base, `unreachedDependencies`):
 *   the `Agent` tool refuses the start otherwise, naming where it merged.
 * - When an item merges (`markMerged`, the only writer of `merged`), each queued dependent whose
 *   dependencies are now all merged is a candidate (same transaction); after it, once git shows
 *   them inside its start ref, it gets one `work.unblocked` event and the coordinator is told 「「X」现在可以开始了」 (woken when idle, like
 *   `team_return`). Nothing starts automatically: nothing in a team does.
 *
 * Every statement is a primary-key or index range with a LIMIT: `(item_id, depends_on_item_id)`
 * and `(depends_on_item_id, item_id)`. Portable SQL only (no JSON functions). SQLite only, like
 * the rest of the team surface.
 */

import {
	dependencyResolved,
	TEAM_UNBLOCKED_NOTE_SOURCE,
	TEAM_WORK_DEPENDENCIES_MAX,
	TEAM_WORK_DEPENDENTS_LIMIT,
	type TeamWorkDependencyRef,
	type TeamWorkItemState,
} from "@shared/project-teams";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm/alias";
import { db } from "../../db";
import {
	projectTeams,
	teamWorkEvents,
	teamWorkItemDependencies,
	teamWorkItems,
} from "../../db/schema";
import { AppError, ValidationError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { teamRepoGit } from "./team-git-write";
import { projectStartFacts, startRefFor } from "./team-work-start";
import { recordWorkEvent, type WorkActor } from "./work-items";

type Executor = Pick<typeof db, "select" | "insert" | "delete">;

/** Most items the cycle check walks before it refuses the set as too large to check. */
export const DEPENDENCY_WALK_MAX = 500;
/** Most dependents of one merged item looked at for an unblock. */
const UNBLOCK_SCAN_MAX = 200;

// ── Reading ─────────────────────────────────────────────────────────────────

/** The base an item's branch was made from: its own `base_ref`, else the team's base. */
const effectiveBase = (baseRef: string | null, teamBase: string | null): string | null =>
	baseRef ?? teamBase;

const dependentItems = aliasedTable(teamWorkItems, "dependent_items");

/**
 * The dependencies of each listed item (one query, at most {@link TEAM_WORK_DEPENDENCIES_MAX}
 * per item), oldest dependency target first. Items without any are absent from the map. A target
 * made from another base than the item carries `baseMismatch`.
 */
export function readDependencies(
	itemIds: readonly string[],
	executor: Pick<typeof db, "select"> = db,
): Map<string, TeamWorkDependencyRef[]> {
	const byItem = new Map<string, TeamWorkDependencyRef[]>();
	const ids = [...new Set(itemIds)];
	if (ids.length === 0) return byItem;
	const rows = executor
		.select({
			itemId: teamWorkItemDependencies.itemId,
			id: teamWorkItems.id,
			title: teamWorkItems.title,
			state: teamWorkItems.state,
			dependencyBaseRef: teamWorkItems.baseRef,
			dependentBaseRef: dependentItems.baseRef,
			teamBase: projectTeams.baseBranch,
		})
		.from(teamWorkItemDependencies)
		.innerJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkItemDependencies.dependsOnItemId))
		.innerJoin(dependentItems, eq(dependentItems.id, teamWorkItemDependencies.itemId))
		.leftJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItemDependencies.teamId))
		.where(inArray(teamWorkItemDependencies.itemId, ids))
		.orderBy(
			asc(teamWorkItemDependencies.itemId),
			asc(teamWorkItems.createdAt),
			asc(teamWorkItems.id),
		)
		.limit(ids.length * TEAM_WORK_DEPENDENCIES_MAX)
		.all();
	for (const row of rows) {
		const list = byItem.get(row.itemId) ?? [];
		const dependencyBase = effectiveBase(row.dependencyBaseRef, row.teamBase);
		const dependentBase = effectiveBase(row.dependentBaseRef, row.teamBase);
		list.push({
			id: row.id,
			title: row.title,
			state: row.state,
			...(dependencyBase !== dependentBase
				? { baseMismatch: { dependencyBase, dependentBase } }
				: {}),
		});
		byItem.set(row.itemId, list);
	}
	return byItem;
}

/**
 * The items of a team that depend on `itemId`, oldest first, at most `limit` (+ `more`); only
 * those in `state` when it is given.
 */
export function readDependents(
	teamId: string,
	itemId: string,
	limit = TEAM_WORK_DEPENDENTS_LIMIT,
	state?: TeamWorkItemState,
): { items: TeamWorkDependencyRef[]; more: boolean } {
	const rows = db
		.select({ id: teamWorkItems.id, title: teamWorkItems.title, state: teamWorkItems.state })
		.from(teamWorkItemDependencies)
		.innerJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkItemDependencies.itemId))
		.where(
			and(
				eq(teamWorkItemDependencies.dependsOnItemId, itemId),
				eq(teamWorkItemDependencies.teamId, teamId),
				state === undefined ? undefined : eq(teamWorkItems.state, state),
			),
		)
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(limit + 1)
		.all();
	return { items: rows.slice(0, limit), more: rows.length > limit };
}

/**
 * The dependencies of one item that are not merged into its base yet (its blockers), in order:
 * one made from another base never is.
 */
export function blockersOf(
	itemId: string,
	executor: Pick<typeof db, "select"> = db,
): TeamWorkDependencyRef[] {
	return (readDependencies([itemId], executor).get(itemId) ?? []).filter(
		(dependency) => !dependencyResolved(dependency),
	);
}

const quoted = (refs: readonly TeamWorkDependencyRef[]) =>
	refs.map((ref) => `"${ref.title}" (${ref.id}, ${ref.state})`).join(", ");

const baseName = (base: string | null) => base ?? "(unknown)";

/**
 * Refuse to start an item whose dependencies have not all merged: 409 `TEAM_WORK_ITEM_BLOCKED`,
 * naming each blocker (`details.blockers`). A cancelled blocker is called out: it never merges,
 * so the coordinator must remove or replace it.
 */
export function assertWorkItemStartable(
	itemId: string,
	executor: Pick<typeof db, "select"> = db,
): void {
	const blockers = blockersOf(itemId, executor);
	if (blockers.length === 0) return;
	const otherBase = blockers.filter((blocker) => blocker.baseMismatch);
	const cancelled = blockers.filter(
		(blocker) => !blocker.baseMismatch && blocker.state === "cancelled",
	);
	const waiting = blockers.filter(
		(blocker) => !blocker.baseMismatch && blocker.state !== "cancelled",
	);
	const parts: string[] = [];
	if (waiting.length > 0)
		parts.push(`it waits for ${quoted(waiting)} to be merged into the base first`);
	if (cancelled.length > 0)
		parts.push(
			`its dependency ${quoted(cancelled)} was cancelled and will never merge: remove or replace it with Team work.update (dependsOn)`,
		);
	for (const blocker of otherBase)
		parts.push(
			`its dependency ${quoted([blocker])} was made from base ${baseName(blocker.baseMismatch?.dependencyBase ?? null)}, not this item's base ${baseName(blocker.baseMismatch?.dependentBase ?? null)}, so its merge never reaches this item: remove or replace it with Team work.update (dependsOn)`,
		);
	throw new AppError(
		`Work item ${itemId} cannot start yet: ${parts.join("; ")}. Nothing was started.`,
		409,
		"TEAM_WORK_ITEM_BLOCKED",
		undefined,
		{ blockers },
	);
}

// ── Merged where this item's work starts ────────────────────────────────────

/** Merged dependencies whose head the dependent's start ref does not hold yet. */
export interface UnreachedDependencies {
	/** What the dependent's work starts from (`origin/main`, `main`). */
	label: string;
	missing: TeamWorkDependencyRef[];
}

type ReachCheck = (dependentId: string) => Promise<UnreachedDependencies>;
let reachOverride: ReachCheck | null = null;

/** Replace the git check of {@link unreachedDependencies} (tests); null restores git. */
export function setDependencyReachForTests(next: ReachCheck | null): void {
	reachOverride = next;
}

/**
 * The merged dependencies of an item that are NOT inside the ref its work starts from: merged is
 * not enough when the dependency landed in the local base but the dependent starts from
 * `origin/<base>` (or the other way round) — its sync would never bring the dependency in. Git
 * runs here (a resolve and one `merge-base --is-ancestor` per dependency, at most
 * {@link TEAM_WORK_DEPENDENCIES_MAX}, each with `team-git-write.ts`'s timeout), never inside a
 * transaction. A dependency without a recorded head, or a start ref that does not resolve,
 * counts as not inside.
 */
export async function unreachedDependencies(itemId: string): Promise<UnreachedDependencies> {
	const merged = (readDependencies([itemId]).get(itemId) ?? []).filter((dependency) =>
		dependencyResolved(dependency),
	);
	if (merged.length === 0) return { label: "", missing: [] };
	if (reachOverride) return reachOverride(itemId);
	const item = db
		.select({
			projectId: teamWorkItems.projectId,
			baseRef: teamWorkItems.baseRef,
			teamBase: projectTeams.baseBranch,
			settings: projectTeams.settingsJson,
		})
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.where(eq(teamWorkItems.id, itemId))
		.limit(1)
		.get();
	if (!item) return { label: "", missing: [] };
	const start = await startRefFor({
		projectId: item.projectId,
		baseBranch: item.baseRef ?? item.teamBase,
		settings: item.settings,
	});
	const heads = new Map(
		db
			.select({ id: teamWorkItems.id, head: teamWorkItems.headSha })
			.from(teamWorkItems)
			.where(
				inArray(
					teamWorkItems.id,
					merged.map((dependency) => dependency.id),
				),
			)
			.limit(TEAM_WORK_DEPENDENCIES_MAX)
			.all()
			.map((row) => [row.id, row.head]),
	);
	const { repo } = projectStartFacts(item.projectId);
	const git = repo ? teamRepoGit(repo) : null;
	const target = git ? await git.resolve(start.ref).catch(() => null) : null;
	const missing: TeamWorkDependencyRef[] = [];
	for (const dependency of merged) {
		const head = heads.get(dependency.id);
		let inside =
			git && target && head ? await git.isAncestor(head, target).catch(() => false) : false;
		// G: a squash or rebase merge of its pull request never puts the head itself there; the
		// commit GitHub merged it as does.
		const landedAs = inside ? null : mergeCommitOf(dependency.id);
		if (!inside && git && target && landedAs)
			inside = await git.isAncestor(landedAs, target).catch(() => false);
		if (!inside) missing.push(dependency);
	}
	return { label: start.label, missing };
}

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The commit a pull request merged an item as (`work.merged` by `pull_request`), or null. */
function mergeCommitOf(itemId: string): string | null {
	const detail = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.merged")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get()?.detail;
	const commit = detail?.detectedBy === "pull_request" ? detail.mergeCommit : null;
	return typeof commit === "string" && FULL_SHA.test(commit) ? commit : null;
}

/**
 * Refuse to start an item while a merged dependency is not inside the ref its work starts from
 * (409 `TEAM_WORK_ITEM_BLOCKED`, `details.blockers` with `notInStart`). Async (git); the `Agent`
 * tool checks it before creating the worker, next to {@link assertWorkItemStartable}.
 */
export async function assertDependenciesReachStart(itemId: string): Promise<void> {
	const { label, missing } = await unreachedDependencies(itemId);
	if (missing.length === 0) return;
	throw new AppError(
		`Work item ${itemId} cannot start yet: ${quoted(missing)} merged, but not into ${label}, where this item's work starts, so work.sync would not bring it in. Get it into ${label} first (push or fetch the base), or change where the team's work starts. Nothing was started.`,
		409,
		"TEAM_WORK_ITEM_BLOCKED",
		undefined,
		{ blockers: missing.map((dependency) => ({ ...dependency, notInStart: label })) },
	);
}

// ── Setting ─────────────────────────────────────────────────────────────────

/** Trimmed, de-duplicated ids in the order given; refuses more than the cap. */
export function normalizeDependencyIds(ids: readonly string[]): string[] {
	const out = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
	if (out.length > TEAM_WORK_DEPENDENCIES_MAX)
		throw new ValidationError(
			`A work item depends on at most ${TEAM_WORK_DEPENDENCIES_MAX} items (${out.length} were given)`,
		);
	return out;
}

/**
 * Check a new set of dependencies for `itemId` (null: an item about to be created, which nothing
 * can depend on yet): every target an item of `teamId`, not cancelled, made from the same base as
 * the item (`baseRef`: the item's pinned base; null, the team's), not the item itself, and no
 * cycle through the existing edges. Synchronous, so it can run inside the write transaction as
 * well as before any side effect.
 */
export function checkDependencies(
	executor: Pick<typeof db, "select">,
	teamId: string,
	itemId: string | null,
	baseRef: string | null,
	ids: readonly string[],
): TeamWorkDependencyRef[] {
	if (ids.length === 0) return [];
	if (itemId !== null && ids.includes(itemId))
		throw new AppError(
			`Work item ${itemId} cannot depend on itself`,
			409,
			"TEAM_WORK_ITEM_DEPENDENCY_CYCLE",
			undefined,
			{ cycle: [itemId, itemId] },
		);
	const rows = executor
		.select({
			id: teamWorkItems.id,
			title: teamWorkItems.title,
			state: teamWorkItems.state,
			baseRef: teamWorkItems.baseRef,
			teamBase: projectTeams.baseBranch,
		})
		.from(teamWorkItems)
		.leftJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.where(and(eq(teamWorkItems.teamId, teamId), inArray(teamWorkItems.id, [...ids])))
		.limit(ids.length)
		.all();
	const byId = new Map(rows.map((row) => [row.id, row]));
	const missing = ids.filter((id) => !byId.has(id));
	// Another team's item is not found either: its existence is not this coordinator's to learn.
	if (missing.length > 0)
		throw new AppError(
			`Not work items of this team: ${missing.join(", ")}. Dependencies are item ids from work.list, of this team only.`,
			404,
			"TEAM_WORK_ITEM_DEPENDENCY_NOT_FOUND",
			undefined,
			{ missing },
		);
	const refs: TeamWorkDependencyRef[] = ids.map((id) => {
		const row = byId.get(id) as (typeof rows)[number];
		return { id: row.id, title: row.title, state: row.state };
	});
	const cancelled = refs.filter((ref) => ref.state === "cancelled");
	if (cancelled.length > 0)
		throw new AppError(
			`A cancelled item never merges, so nothing can wait for it: ${quoted(cancelled)}`,
			409,
			"TEAM_WORK_ITEM_DEPENDENCY_CANCELLED",
			undefined,
			{ cancelled: cancelled.map((ref) => ref.id) },
		);
	// Same team, so one team base for every row.
	const teamBase = rows[0]?.teamBase ?? null;
	const base = effectiveBase(baseRef, teamBase);
	const otherBase = ids
		.map((id) => byId.get(id) as (typeof rows)[number])
		.filter((row) => effectiveBase(row.baseRef, teamBase) !== base);
	if (otherBase.length > 0)
		throw new AppError(
			`This item starts from base ${baseName(base)}, but ${otherBase
				.map(
					(row) =>
						`"${row.title}" (${row.id}) was made from base ${baseName(effectiveBase(row.baseRef, teamBase))}`,
				)
				.join(
					", ",
				)}: its merge never reaches this item's base (work.sync brings in this item's base only), so it cannot be a dependency. Depend only on items made from the same base.`,
			409,
			"TEAM_WORK_DEPENDENCY_BASE_MISMATCH",
			undefined,
			{
				base,
				mismatched: otherBase.map((row) => ({
					id: row.id,
					base: effectiveBase(row.baseRef, teamBase),
				})),
			},
		);
	if (itemId !== null) assertNoCycle(executor, itemId, ids);
	return refs;
}

/**
 * A cycle appears when `itemId` is reachable from one of the new targets along existing edges
 * (target depends on … depends on `itemId`). Breadth first, one indexed `IN` read per level, at
 * most {@link DEPENDENCY_WALK_MAX} items visited.
 */
function assertNoCycle(
	executor: Pick<typeof db, "select">,
	itemId: string,
	ids: readonly string[],
): void {
	const parent = new Map<string, string | null>(ids.map((id) => [id, null]));
	let frontier = [...ids];
	while (frontier.length > 0) {
		const edges = executor
			.select({
				from: teamWorkItemDependencies.itemId,
				to: teamWorkItemDependencies.dependsOnItemId,
			})
			.from(teamWorkItemDependencies)
			.where(inArray(teamWorkItemDependencies.itemId, frontier))
			.orderBy(asc(teamWorkItemDependencies.itemId), asc(teamWorkItemDependencies.dependsOnItemId))
			.limit(frontier.length * TEAM_WORK_DEPENDENCIES_MAX)
			.all();
		const next: string[] = [];
		for (const edge of edges) {
			if (edge.to === itemId) {
				// itemId → … → edge.from → itemId, read back along the parents.
				const path = [edge.from];
				for (let at = parent.get(edge.from); at; at = parent.get(at)) path.push(at);
				const cycle = [itemId, ...path.reverse(), itemId];
				throw new AppError(
					`These dependencies would make a cycle: ${cycle.join(" → ")}`,
					409,
					"TEAM_WORK_ITEM_DEPENDENCY_CYCLE",
					undefined,
					{ cycle },
				);
			}
			if (parent.has(edge.to)) continue;
			parent.set(edge.to, edge.from);
			next.push(edge.to);
		}
		if (parent.size > DEPENDENCY_WALK_MAX)
			throw new AppError(
				`The items these dependencies lead to are more than ${DEPENDENCY_WALK_MAX}; the set cannot be checked for cycles. Depend on fewer, closer items.`,
				409,
				"TEAM_WORK_ITEM_DEPENDENCY_GRAPH_TOO_LARGE",
			);
		frontier = next;
	}
}

/**
 * Replace the dependencies of `itemId` with `refs` (already checked, in the transaction), and
 * record `work.dependencies_changed` when the set changed. Returns whether it changed.
 */
export function writeDependencies(
	tx: Executor,
	input: {
		teamId: string;
		itemId: string;
		refs: readonly TeamWorkDependencyRef[];
		actor: WorkActor;
		at: string;
	},
): boolean {
	const before = tx
		.select({ id: teamWorkItemDependencies.dependsOnItemId })
		.from(teamWorkItemDependencies)
		.where(eq(teamWorkItemDependencies.itemId, input.itemId))
		.limit(TEAM_WORK_DEPENDENCIES_MAX + 1)
		.all()
		.map((row) => row.id);
	const next = input.refs.map((ref) => ref.id);
	const added = next.filter((id) => !before.includes(id));
	const removed = before.filter((id) => !next.includes(id));
	if (added.length === 0 && removed.length === 0) return false;
	if (removed.length > 0)
		tx.delete(teamWorkItemDependencies)
			.where(
				and(
					eq(teamWorkItemDependencies.itemId, input.itemId),
					inArray(teamWorkItemDependencies.dependsOnItemId, removed),
				),
			)
			.run();
	if (added.length > 0)
		tx.insert(teamWorkItemDependencies)
			.values(
				added.map((id) => ({
					itemId: input.itemId,
					dependsOnItemId: id,
					teamId: input.teamId,
					createdAt: input.at,
				})),
			)
			.run();
	recordWorkEvent(tx, {
		teamId: input.teamId,
		workItemId: input.itemId,
		kind: "work.dependencies_changed",
		actor: input.actor,
		detail: { dependsOn: next, added, removed },
		at: input.at,
	});
	return true;
}

// ── Unblocking ──────────────────────────────────────────────────────────────

/** A queued item whose last dependency just merged. */
export interface UnblockedItem {
	id: string;
	teamId: string;
	title: string;
	createdBy: string | null;
	dependsOn: string[];
}

/** A queued dependent whose dependencies all merged, to be confirmed after the transaction. */
export interface UnblockCandidate extends UnblockedItem {
	mergedItem: string;
}

/**
 * Inside the transaction that marked `mergedItemId` merged: the queued dependents whose
 * dependencies are now all merged (no git here). {@link confirmUnblocks} records them after the
 * transaction, once their dependencies are inside the ref their work starts from.
 */
export function unblockCandidates(tx: Executor, mergedItemId: string): UnblockCandidate[] {
	const dependents = tx
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			title: teamWorkItems.title,
			createdBy: teamWorkItems.createdBy,
		})
		.from(teamWorkItemDependencies)
		.innerJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkItemDependencies.itemId))
		// Filtered before the LIMIT: started dependents never crowd out a queued one.
		.where(
			and(
				eq(teamWorkItemDependencies.dependsOnItemId, mergedItemId),
				eq(teamWorkItems.state, "queued"),
				isNull(teamWorkItems.workerNarratorId),
			),
		)
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(UNBLOCK_SCAN_MAX)
		.all();
	if (dependents.length === 0) return [];
	const all = readDependencies(
		dependents.map((row) => row.id),
		tx,
	);
	const candidates: UnblockCandidate[] = [];
	for (const row of dependents) {
		const dependsOn = all.get(row.id) ?? [];
		// A dependency on another base never resolves: its dependent is not unblocked by it.
		if (!dependsOn.every((dependency) => dependencyResolved(dependency))) continue;
		candidates.push({
			...row,
			dependsOn: dependsOn.map((dependency) => dependency.id),
			mergedItem: mergedItemId,
		});
	}
	return candidates;
}

/**
 * After the merge transaction: each candidate whose merged dependencies are all inside the ref
 * its work starts from (git, outside any transaction) gets one `work.unblocked` event — recorded
 * in a short transaction that re-reads it (still queued, no worker, no `work.unblocked` since its
 * dependencies last changed), so two merges at once record it once. A candidate whose dependency
 * merged elsewhere (the local base for an origin start, or origin only for a local start) is not
 * unblocked; starting it names why.
 */
export async function confirmUnblocks(
	candidates: readonly UnblockCandidate[],
): Promise<UnblockedItem[]> {
	const confirmed: UnblockedItem[] = [];
	for (const candidate of candidates) {
		const reach = await unreachedDependencies(candidate.id).catch((error) => {
			logger.warn("Team unblock could not be checked", {
				workItemId: candidate.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
		if (!reach || reach.missing.length > 0) continue;
		const at = new Date().toISOString();
		const recorded = db.transaction((tx) => {
			const row = tx
				.select({ state: teamWorkItems.state, worker: teamWorkItems.workerNarratorId })
				.from(teamWorkItems)
				.where(eq(teamWorkItems.id, candidate.id))
				.limit(1)
				.get();
			if (!row || row.state !== "queued" || row.worker) return false;
			const latest = tx
				.select({ kind: teamWorkEvents.kind })
				.from(teamWorkEvents)
				.where(
					and(
						eq(teamWorkEvents.workItemId, candidate.id),
						inArray(teamWorkEvents.kind, ["work.unblocked", "work.dependencies_changed"]),
					),
				)
				.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
				.limit(1)
				.get();
			if (latest?.kind === "work.unblocked") return false;
			recordWorkEvent(tx, {
				teamId: candidate.teamId,
				workItemId: candidate.id,
				kind: "work.unblocked",
				actor: { kind: "system", id: null },
				detail: { mergedItem: candidate.mergedItem, dependsOn: candidate.dependsOn },
				at,
			});
			return true;
		});
		if (recorded) {
			const { mergedItem: _merged, ...item } = candidate;
			confirmed.push(item);
		}
	}
	return confirmed;
}

/** Queued items one reconcile looks at. */
const RECONCILE_SCAN_MAX = 200;

/**
 * Unblocks that a merge could not confirm then: a dependency merged into the local base while its
 * dependent starts from `origin/<base>` (or the other way round) reaches the dependent's start ref
 * only later, through a fetch. Called after a work-start fetch and by the periodic refresh: the
 * queued, workerless items of a project (or of all projects) that have dependencies — an indexed
 * read, at most {@link RECONCILE_SCAN_MAX} — whose dependencies are all merged go through
 * {@link confirmUnblocks} (the same git check and the same once-only recording), and the
 * coordinators of the newly unblocked ones are told. Returns how many were unblocked.
 */
export async function reconcileUnblocks(options: { projectId?: string } = {}): Promise<number> {
	const rows = db
		.selectDistinct({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			title: teamWorkItems.title,
			createdBy: teamWorkItems.createdBy,
		})
		.from(teamWorkItems)
		.innerJoin(teamWorkItemDependencies, eq(teamWorkItemDependencies.itemId, teamWorkItems.id))
		.where(
			and(
				eq(teamWorkItems.state, "queued"),
				isNull(teamWorkItems.workerNarratorId),
				...(options.projectId ? [eq(teamWorkItems.projectId, options.projectId)] : []),
			),
		)
		.orderBy(asc(teamWorkItems.id))
		.limit(RECONCILE_SCAN_MAX)
		.all();
	if (rows.length === 0) return 0;
	const all = readDependencies(rows.map((row) => row.id));
	const candidates: UnblockCandidate[] = [];
	for (const row of rows) {
		const dependsOn = all.get(row.id) ?? [];
		if (dependsOn.length === 0 || !dependsOn.every((dependency) => dependencyResolved(dependency)))
			continue;
		candidates.push({
			...row,
			dependsOn: dependsOn.map((dependency) => dependency.id),
			mergedItem: dependsOn.at(-1)?.id ?? "",
		});
	}
	if (candidates.length === 0) return 0;
	const unblocked = await confirmUnblocks(candidates);
	await deliverUnblockedNotes(unblocked);
	return unblocked.length;
}

/** How a coordinator hears that an item can start (one `sys` row, woken when idle). */
export type UnblockDelivery = (input: {
	teamId: string;
	itemId: string;
	text: string;
	userId: string | null;
}) => Promise<boolean>;

let unblockDeliveryOverride: UnblockDelivery | null = null;

/** Replace the note's delivery (tests). Null restores production. */
export function setUnblockDeliveryForTests(next: UnblockDelivery | null): void {
	unblockDeliveryOverride = next;
}

async function coordinatorLocale(teamId: string): Promise<"en" | "zh-CN"> {
	try {
		const { activeNarrators } = await import("../narrator-session-state");
		return activeNarrators.get(teamId)?.locale === "zh-CN" ? "zh-CN" : "en";
	} catch {
		return "en";
	}
}

const defaultUnblockDelivery: UnblockDelivery = async ({ teamId, text, userId }) => {
	const { deliverInjection } = await import("../narrator-injection");
	const written = await deliverInjection(teamId, {
		content: text,
		source: TEAM_UNBLOCKED_NOTE_SOURCE,
		body: { kind: "prose", text },
		schedule: "wakeIfIdle",
		createdBy: userId,
		executionPrincipal: { version: 1, userId },
	});
	return written.messageId !== null;
};

/**
 * Tell each coordinator, once per unblocked item, that it can start now. Delivered after the
 * merge transaction; a failed delivery is logged (the `work.unblocked` event stands).
 */
export async function deliverUnblockedNotes(items: readonly UnblockedItem[]): Promise<number> {
	if (items.length === 0) return 0;
	const { unblockedNote } = await import("../../lib/prompts/team-lead");
	const deliver = unblockDeliveryOverride ?? defaultUnblockDelivery;
	let delivered = 0;
	for (const item of items) {
		try {
			const locale = await coordinatorLocale(item.teamId);
			const ok = await deliver({
				teamId: item.teamId,
				itemId: item.id,
				text: unblockedNote(locale, { itemId: item.id, title: item.title }),
				userId: item.createdBy,
			});
			if (ok) delivered++;
		} catch (error) {
			logger.warn("Team unblock note was not delivered", {
				workItemId: item.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return delivered;
}

/**
 * The queued items that depend on `itemId` (for `work.cancel`'s next action), at most 20. The
 * state is filtered in the query, so started or finished dependents never crowd them out.
 */
export function queuedDependentsOf(teamId: string, itemId: string): TeamWorkDependencyRef[] {
	return readDependents(teamId, itemId, TEAM_WORK_DEPENDENCIES_MAX, "queued").items;
}
