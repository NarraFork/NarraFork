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
export async function sweepOrphanCoordinatorOutputs(isStopped = () => false): Promise<number> {
	if (isStopped()) return 0;
	const owners = await listCoordinatorOutputOwners(SWEEP_MAX);
	let removed = 0;
	for (let start = 0; start < owners.length; start += SWEEP_BATCH) {
		if (isStopped()) break;
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
			if (isStopped()) return removed;
			if (alive.has(id)) continue;
			await removeCoordinatorOutputs(id);
			removed++;
		}
	}
	return removed;
}

/** Stop admission synchronously, then drain this owner's finite filesystem/database work. */
export function startCoordinatorMaintenance(): () => Promise<void> {
	let stopped = false;
	let failed = false;
	const pending = new Set<Promise<unknown>>();
	const track = <T>(work: Promise<T>): Promise<T> => {
		pending.add(work);
		void work.then(
			() => pending.delete(work),
			() => {
				failed = true;
				pending.delete(work);
			},
		);
		return work;
	};
	const onDeleted = (event: { narratorId: string }) => {
		if (stopped) return;
		forgetTeamStatus(event.narratorId);
		forgetCoordinatorRun(event.narratorId);
		void track(removeCoordinatorOutputs(event.narratorId)).catch((error) =>
			logger.warn("Removing saved coordinator outputs failed", { error: String(error) }),
		);
	};
	eventBus.on("narrator:deleted", onDeleted);
	void track(sweepOrphanCoordinatorOutputs(() => stopped))
		.then((removed) => {
			if (removed > 0)
				logger.info("Removed saved coordinator outputs of deleted sessions", { removed });
		})
		.catch((error) =>
			logger.warn("Sweeping saved coordinator outputs failed", { error: String(error) }),
		);
	return async () => {
		stopped = true;
		try {
			eventBus.off("narrator:deleted", onDeleted);
		} catch {
			failed = true;
		}
		while (pending.size) await Promise.allSettled([...pending]);
		if (failed) throw new Error("Coordinator maintenance did not drain successfully");
	};
}
