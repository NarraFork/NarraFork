import { DbReadError } from "./errors";
import type { DbReadTaskParams } from "./protocol";

export const DB_READ_DEFAULT_MAX_QUEUED = 64;
export const DB_READ_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export const DB_READ_NORMAL_MAX_QUEUED_BYTES = 6 * 1024 * 1024;
export interface DbReadSchedulingConfig {
	readonly concurrency: number;
	readonly reservedCapacity: number;
	readonly normalCapacity: number;
	readonly maxQueued: number;
	readonly reservedQueued: number;
	readonly normalMaxQueued: number;
	readonly maxQueuedBytes: number;
	readonly normalMaxQueuedBytes: number;
}
export function readSchedulingConfig(
	concurrency: number,
	raw = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED,
): DbReadSchedulingConfig {
	if (concurrency < 2) throw new Error("concurrency_requires_at_least_2");
	const value = raw?.trim();
	if (value && (!/^\d+$/.test(value) || Number(value) > 1024))
		throw new Error("invalid_max_queued_expected_decimal_0_to_1024");
	const maxQueued = value ? Number(value) : DB_READ_DEFAULT_MAX_QUEUED;
	const reservedCapacity = Math.max(1, Math.ceil(concurrency / 4));
	const reservedQueued = maxQueued ? Math.max(1, Math.ceil(maxQueued / 4)) : 0;
	return Object.freeze({
		concurrency,
		reservedCapacity,
		normalCapacity: concurrency - reservedCapacity,
		maxQueued,
		reservedQueued,
		normalMaxQueued: maxQueued - reservedQueued,
		maxQueuedBytes: DB_READ_MAX_QUEUED_BYTES,
		normalMaxQueuedBytes: DB_READ_NORMAL_MAX_QUEUED_BYTES,
	});
}
export function classifyReadTask(
	params: DbReadTaskParams,
	hint?: "auth-session",
): {
	taskClass: "normal" | "short";
	shortSource?: "auth-session" | "readerProbe";
} {
	if (hint !== undefined && (hint !== "auth-session" || params.kind !== "selectRows"))
		throw new DbReadError("DB_READ_INVALID", "Invalid database read scheduling hint");
	if (hint === "auth-session") return { taskClass: "short", shortSource: "auth-session" };
	if (params.kind === "domainRead" && params.task === "readerProbe")
		return { taskClass: "short", shortSource: "readerProbe" };
	return { taskClass: "normal" };
}
