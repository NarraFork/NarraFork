/**
 * Lifetime of a coordinator's P2 state (Project Teams P2): when a narrator is deleted, its saved
 * tool outputs (`coordinator-outputs.ts`) and its in-memory status / run bookkeeping go with it.
 * At startup, saved-output directories whose narrator no longer exists (deleted by a path that
 * emits no event: data import's clear, a crash between the delete and the removal) are swept in
 * the background, in batches of primary-key lookups.
 */
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";
import { forgetCoordinatorRun } from "./coordinator-limits";
import { listCoordinatorOutputOwners, removeCoordinatorOutputs } from "./coordinator-outputs";
import { forgetTeamStatus } from "./team-status";

const SWEEP_BATCH = 500;
/** Directories looked at by one startup sweep. */
const SWEEP_MAX = 20_000;

/** Remove saved-output directories of narrators that no longer exist. Returns how many. */
export async function sweepOrphanCoordinatorOutputs(): Promise<number> {
	const owners = await listCoordinatorOutputOwners(SWEEP_MAX);
	let removed = 0;
	for (let start = 0; start < owners.length; start += SWEEP_BATCH) {
		const batch = owners.slice(start, start + SWEEP_BATCH);
		const alive = new Set(
			db
				.select({ id: narrators.id })
				.from(narrators)
				.where(inArray(narrators.id, batch))
				.all()
				.map((row) => row.id),
		);
		for (const id of batch) {
			if (alive.has(id)) continue;
			await removeCoordinatorOutputs(id);
			removed++;
		}
	}
	return removed;
}

/** Follow narrator deletions and sweep orphans once. Returns the stop function. */
export function startCoordinatorMaintenance(): () => void {
	const onDeleted = (event: { narratorId: string }) => {
		forgetTeamStatus(event.narratorId);
		forgetCoordinatorRun(event.narratorId);
		void removeCoordinatorOutputs(event.narratorId);
	};
	eventBus.on("narrator:deleted", onDeleted);
	sweepOrphanCoordinatorOutputs()
		.then((removed) => {
			if (removed > 0)
				logger.info("Removed saved coordinator outputs of deleted sessions", { removed });
		})
		.catch((error) =>
			logger.warn("Sweeping saved coordinator outputs failed", { error: String(error) }),
		);
	return () => eventBus.off("narrator:deleted", onDeleted);
}
