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
 * - When an item merges (`markMergedByAncestry`, the only writer of `merged`), each queued
 *   dependent whose dependencies are now all merged gets one `work.unblocked` event in the same
 *   transaction; the coordinator is then told 「「X」现在可以开始了」 (woken when idle, like
 *   `team_return`). Nothing starts automatically: nothing in a team does.
 *
 * Every statement is a primary-key or index range with a LIMIT: `(item_id, depends_on_item_id)`
 * and `(depends_on_item_id, item_id)`. Portable SQL only (no JSON functions). SQLite only, like
 * the rest of the team surface.
 */

import {
	dependencySatisfied,
	TEAM_UNBLOCKED_NOTE_SOURCE,
	TEAM_WORK_DEPENDENCIES_MAX,
	TEAM_WORK_DEPENDENTS_LIMIT,
	type TeamWorkDependencyRef,
	type TeamWorkItemState,
} from "@shared/project-teams";
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../../db";
import { teamWorkItemDependencies, teamWorkItems } from "../../db/schema";
import { AppError, ValidationError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { recordWorkEvent, type WorkActor } from "./work-items";

type Executor = Pick<typeof db, "select" | "insert" | "delete">;

/** Most items the cycle check walks before it refuses the set as too large to check. */
export const DEPENDENCY_WALK_MAX = 500;
/** Most dependents of one merged item looked at for an unblock. */
const UNBLOCK_SCAN_MAX = 200;

const targets = alias(teamWorkItems, "dependency_target");

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The dependencies of each listed item (one query, at most {@link TEAM_WORK_DEPENDENCIES_MAX}
 * per item), oldest dependency target first. Items without any are absent from the map.
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
			id: targets.id,
			title: targets.title,
			state: targets.state,
		})
		.from(teamWorkItemDependencies)
		.innerJoin(targets, eq(targets.id, teamWorkItemDependencies.dependsOnItemId))
		.where(inArray(teamWorkItemDependencies.itemId, ids))
		.orderBy(asc(teamWorkItemDependencies.itemId), asc(targets.createdAt), asc(targets.id))
		.limit(ids.length * TEAM_WORK_DEPENDENCIES_MAX)
		.all();
	for (const row of rows) {
		const list = byItem.get(row.itemId) ?? [];
		list.push({ id: row.id, title: row.title, state: row.state });
		byItem.set(row.itemId, list);
	}
	return byItem;
}

/** The items of a team that depend on `itemId`, oldest first, at most `limit` (+ `more`). */
export function readDependents(
	teamId: string,
	itemId: string,
	limit = TEAM_WORK_DEPENDENTS_LIMIT,
): { items: TeamWorkDependencyRef[]; more: boolean } {
	const rows = db
		.select({ id: teamWorkItems.id, title: teamWorkItems.title, state: teamWorkItems.state })
		.from(teamWorkItemDependencies)
		.innerJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkItemDependencies.itemId))
		.where(
			and(
				eq(teamWorkItemDependencies.dependsOnItemId, itemId),
				eq(teamWorkItemDependencies.teamId, teamId),
			),
		)
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(limit + 1)
		.all();
	return { items: rows.slice(0, limit), more: rows.length > limit };
}

/** The dependencies of one item that are not merged yet (its blockers), in order. */
export function blockersOf(
	itemId: string,
	executor: Pick<typeof db, "select"> = db,
): TeamWorkDependencyRef[] {
	return (readDependencies([itemId], executor).get(itemId) ?? []).filter(
		(dependency) => !dependencySatisfied(dependency.state),
	);
}

const quoted = (refs: readonly TeamWorkDependencyRef[]) =>
	refs.map((ref) => `"${ref.title}" (${ref.id}, ${ref.state})`).join(", ");

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
	const cancelled = blockers.filter((blocker) => blocker.state === "cancelled");
	const waiting = blockers.filter((blocker) => blocker.state !== "cancelled");
	const parts: string[] = [];
	if (waiting.length > 0)
		parts.push(`it waits for ${quoted(waiting)} to be merged into the base first`);
	if (cancelled.length > 0)
		parts.push(
			`its dependency ${quoted(cancelled)} was cancelled and will never merge: remove or replace it with Team work.update (dependsOn)`,
		);
	throw new AppError(
		`Work item ${itemId} cannot start yet: ${parts.join("; ")}. Nothing was started.`,
		409,
		"TEAM_WORK_ITEM_BLOCKED",
		undefined,
		{ blockers },
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
 * can depend on yet): every target an item of `teamId` and not cancelled, not the item itself,
 * and no cycle through the existing edges. Synchronous, so it can run inside the write
 * transaction as well as before any side effect.
 */
export function checkDependencies(
	executor: Pick<typeof db, "select">,
	teamId: string,
	itemId: string | null,
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
		.select({ id: teamWorkItems.id, title: teamWorkItems.title, state: teamWorkItems.state })
		.from(teamWorkItems)
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
	const refs = ids.map((id) => byId.get(id) as TeamWorkDependencyRef);
	const cancelled = refs.filter((ref) => ref.state === "cancelled");
	if (cancelled.length > 0)
		throw new AppError(
			`A cancelled item never merges, so nothing can wait for it: ${quoted(cancelled)}`,
			409,
			"TEAM_WORK_ITEM_DEPENDENCY_CANCELLED",
			undefined,
			{ cancelled: cancelled.map((ref) => ref.id) },
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

/**
 * Inside the transaction that marked `mergedItemId` merged: every queued dependent whose
 * dependencies are now all merged gets one `work.unblocked` event. `merged` is written once and
 * never undone, so each unblock is recorded exactly once.
 */
export function recordUnblocked(tx: Executor, mergedItemId: string, at: string): UnblockedItem[] {
	const dependents = tx
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			title: teamWorkItems.title,
			state: teamWorkItems.state,
			worker: teamWorkItems.workerNarratorId,
			createdBy: teamWorkItems.createdBy,
		})
		.from(teamWorkItemDependencies)
		.innerJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkItemDependencies.itemId))
		.where(eq(teamWorkItemDependencies.dependsOnItemId, mergedItemId))
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(UNBLOCK_SCAN_MAX)
		.all()
		.filter((row) => row.state === "queued" && row.worker === null);
	if (dependents.length === 0) return [];
	const all = readDependencies(
		dependents.map((row) => row.id),
		tx,
	);
	const unblocked: UnblockedItem[] = [];
	for (const row of dependents) {
		const dependsOn = all.get(row.id) ?? [];
		if (!dependsOn.every((dependency) => dependencySatisfied(dependency.state))) continue;
		const ids = dependsOn.map((dependency) => dependency.id);
		recordWorkEvent(tx, {
			teamId: row.teamId,
			workItemId: row.id,
			kind: "work.unblocked",
			actor: { kind: "system", id: null },
			detail: { mergedItem: mergedItemId, dependsOn: ids },
			at,
		});
		unblocked.push({
			id: row.id,
			teamId: row.teamId,
			title: row.title,
			createdBy: row.createdBy,
			dependsOn: ids,
		});
	}
	return unblocked;
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

/** The queued items that depend on `itemId` (for `work.cancel`'s next action), at most 20. */
export function queuedDependentsOf(teamId: string, itemId: string): TeamWorkDependencyRef[] {
	return readDependents(teamId, itemId, TEAM_WORK_DEPENDENCIES_MAX).items.filter(
		(item) => (item.state as TeamWorkItemState) === "queued",
	);
}
