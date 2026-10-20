import type { Database } from "bun:sqlite";
import {
	collectSessionAggregateStats,
	type SessionOwnedTableRelation,
	summarizeToolCallPayloads,
} from "./storage-scan-queries";

export type DatabaseCleanupReadTask =
	| {
			kind: "databaseCleanupReadV1";
			action: "sessions";
			narratorIds: string[];
			relations: SessionOwnedTableRelation[];
	  }
	| { kind: "databaseCleanupReadV1"; action: "payloads"; cutoffIso: string };

/** Reuse the cleanup query implementations on the injected read-only connection. */
export function executeDatabaseCleanupReadTask(
	connection: Database,
	task: DatabaseCleanupReadTask,
) {
	return task.action === "sessions"
		? collectSessionAggregateStats(connection, task.narratorIds, task.relations)
		: summarizeToolCallPayloads(connection, task.cutoffIso);
}
