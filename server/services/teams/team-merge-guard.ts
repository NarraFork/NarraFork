/**
 * The in-memory "merging" guard of team work items (M). While a merge or fast-forward job holds
 * an item, every change that would move it — a person's 退回, and the coordinator's review,
 * ready, sync and cancel — is refused with 409 `TEAM_WORK_ITEM_MERGING`, and the background
 * ancestry pass leaves it alone. No state column: a server restart drops the guard together with
 * the job, and the job's git steps heal by ancestry (`team-merge.ts`).
 *
 * A leaf module (no imports beyond errors) so `work-items.ts` and `team-overlap.ts` can consult it
 * without importing the merge job itself.
 */
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";

const merging = hotSafe("narrafork.teams.merging", () => new Set<string>());

/** Whether a merge or fast-forward job holds this item now. */
export function isMerging(itemId: string): boolean {
	return merging.has(itemId);
}

/** Take the guard for one item; false when a job already holds it. */
export function claimMerging(itemId: string): boolean {
	if (merging.has(itemId)) return false;
	merging.add(itemId);
	return true;
}

/** Give the guard back (idempotent). */
export function releaseMerging(itemId: string): void {
	merging.delete(itemId);
}

/** Refuse a change to an item a merge job holds. */
export function assertNotMerging(itemId: string): void {
	if (merging.has(itemId))
		throw new AppError(
			`Work item ${itemId} is being merged into its base right now; try again once the merge is done`,
			409,
			"TEAM_WORK_ITEM_MERGING",
		);
}

/** Drop every guard (tests). */
export function resetMergingForTests(): void {
	merging.clear();
}
