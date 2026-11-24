import type { ReadQueryOptions } from "../db/worker-read";
import { DbReadError } from "../lib/db-worker/errors";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";

export type NarratorSurfaceReadBudget = Pick<
	ReadQueryOptions,
	"signal" | "deadlineAt" | "timeoutMs"
>;

export function assertNarratorSurfaceObservation<T extends object>(
	expected: T,
	current: T | undefined,
	fields: readonly (keyof T)[],
): void {
	if (
		!current ||
		fields.some((key) => JSON.stringify(expected[key]) !== JSON.stringify(current[key]))
	)
		throw new RuntimeReadConflictError();
}

export function narratorSurfaceReadOptions(options: NarratorSurfaceReadBudget = {}) {
	options.signal?.throwIfAborted();
	const deadlineAt =
		options.deadlineAt ?? Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000);
	const timeoutMs = Math.min(30_000, options.timeoutMs ?? 30_000, deadlineAt - Date.now());
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Narrator surface read deadline expired");
	return {
		executionPolicy: "worker-required" as const,
		signal: options.signal,
		deadlineAt,
		timeoutMs,
	};
}
