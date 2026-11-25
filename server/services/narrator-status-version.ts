import { narrators } from "../db/schema";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { readNarratorMessageRefCountSnapshot } from "./narrator-message-count";

export interface NarratorStatusVersion {
	statusEpoch: string;
	statusRevision: number;
}

// One process-wide clock, retained across hot reloads. No narrator/history-sized cache.
const clock = hotSafe("narrafork.narratorStatusVersion", () => ({
	statusEpoch: generateId(),
	statusRevision: 0,
}));

/** Allocate at the synchronous write point, or before a synchronous snapshot read. */
export function nextNarratorStatusVersion(): NarratorStatusVersion {
	return { statusEpoch: clock.statusEpoch, statusRevision: ++clock.statusRevision };
}

// This is deliberately not a full narrator row: no model, paths, runtime or message payloads.
export const narratorStatusPatchColumns = {
	status: narrators.status,
	substatus: narrators.substatus,
	turnStartedAt: narrators.turnStartedAt,
	updatedAt: narrators.updatedAt,
	// Internal count-cache key only. The stored messageCount is not an exact UI count.
	messageVersion: narrators.messageVersion,
	errorMessage: narrators.errorMessage,
	errorRetryable: narrators.errorRetryable,
	archivedWithNarratorId: narrators.archivedWithNarratorId,
};
export type CommittedNarratorStatus = Pick<
	typeof narrators.$inferSelect,
	keyof typeof narratorStatusPatchColumns
> &
	NarratorStatusVersion;

/** Call inside the synchronous transaction immediately after UPDATE RETURNING. Rollback gaps are safe. */
export function versionNarratorStatusCommit<T extends object>(
	committed: T | undefined,
): (T & NarratorStatusVersion) | undefined {
	return committed ? { ...committed, ...nextNarratorStatusVersion() } : undefined;
}

// Only in-flight work is retained here. Settled exact counts use the existing bounded cache.
const pendingCounts = new Map<string, Promise<number | undefined>>();

export async function committedNarratorStatusPatch(
	narratorId: string,
	row: CommittedNarratorStatus,
) {
	const key = JSON.stringify([narratorId, row.messageVersion]);
	let pending = pendingCounts.get(key);
	if (!pending) {
		pending = readNarratorMessageRefCountSnapshot(narratorId, row.messageVersion)
			.then((snapshot) => (snapshot?.version === row.messageVersion ? snapshot.count : undefined))
			.catch((error) => {
				// Preserve the client's count on reader failure, never fall back to the upper bound.
				logger.warn("Status message count unavailable", { narratorId, error: String(error) });
				return undefined;
			})
			.finally(() => {
				if (pendingCounts.get(key) === pending) pendingCounts.delete(key);
			});
		pendingCounts.set(key, pending);
	}
	const messageCount = await pending;
	return {
		status: row.status,
		substatus: parseSubstatus(row.substatus),
		turnStartedAt: row.turnStartedAt,
		updatedAt: row.updatedAt,
		...(messageCount !== undefined ? { messageCount } : {}),
		errorMessage: row.errorMessage,
		errorRetryable: row.errorRetryable,
		archivedWithNarratorId: row.archivedWithNarratorId,
		statusEpoch: row.statusEpoch,
		statusRevision: row.statusRevision,
	};
}
