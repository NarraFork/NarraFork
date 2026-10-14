import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { hotSafe } from "../lib/hot-safe";
import {
	LEGACY_ROOT_HISTORY_LIMITS,
	type LegacyRootHistoryInput,
	type LegacyRootHistoryResult,
} from "./legacy-root-history-contract";

export type {
	LegacyRootHistoryGuard,
	LegacyRootHistoryInput,
	LegacyRootHistoryResult,
} from "./legacy-root-history-contract";

// Includes unconfirmed-to-exit workers across reloads; no waiting queue is created.
const readers = hotSafe<Set<Worker>>("narrafork.legacyRootHistoryReaders", () => new Set());

function unknown(input: LegacyRootHistoryInput, reason: string): LegacyRootHistoryResult {
	return {
		status: "unknown",
		digest: createHash("sha256").update(JSON.stringify({ input, reason })).digest("hex"),
		reason,
	};
}

function validResult(message: unknown): message is LegacyRootHistoryResult {
	if (!message || typeof message !== "object") return false;
	const value = message as Partial<LegacyRootHistoryResult>;
	return (
		["empty", "history", "unknown"].includes(value.status ?? "") &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest) &&
		(value.reason === undefined ||
			(typeof value.reason === "string" && value.reason.length <= 160)) &&
		Array.isArray(value.guards) &&
		value.guards.length <= LEGACY_ROOT_HISTORY_LIMITS.inputs &&
		value.guards.every(
			(guard) =>
				guard &&
				typeof guard.id === "string" &&
				guard.id.length <= 1024 &&
				[guard.messageVersion, guard.messageStructureVersion, guard.nextSeq].every(
					(n) => Number.isSafeInteger(n) && n >= 0,
				),
		) &&
		Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024
	);
}

/** Exported for lifecycle tests; production always supplies a real readonly worker. */
export async function collectLegacyRootHistoryWorker(
	worker: Pick<Worker, "once" | "terminate">,
	input: LegacyRootHistoryInput,
	timeoutMs = 4_000,
	exitTimeoutMs = 1_000,
): Promise<LegacyRootHistoryResult> {
	let exited = false;
	let failed = false;
	worker.once("exit", () => {
		exited = true;
	});
	const result = await new Promise<LegacyRootHistoryResult>((resolve) => {
		let settled = false;
		const finish = (value: LegacyRootHistoryResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(unknown(input, "history reader timeout")), timeoutMs);
		worker.once("message", (message: unknown) =>
			finish(validResult(message) ? message : unknown(input, "invalid history reader response")),
		);
		worker.once("error", () => {
			failed = true;
			finish(unknown(input, "history reader error"));
		});
		worker.once("exit", (code) => {
			if (!settled || code !== 0) finish(unknown(input, "history reader exited before evidence"));
		});
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let terminated = false;
	try {
		terminated = await Promise.race([
			worker.terminate().then(
				() => exited,
				() => false,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), exitTimeoutMs);
			}),
		]);
	} catch {
		terminated = false;
	} finally {
		clearTimeout(timer);
	}
	return terminated && !failed
		? result
		: unknown(input, "history reader exit unconfirmed or errored");
}

/** Empty is only snapshot evidence. Caller must revalidate fingerprints and guards
 * inside its adoption protocol; this result alone never authorizes deletion. */
export async function inspectLegacyRootHistory(
	input: LegacyRootHistoryInput,
): Promise<LegacyRootHistoryResult> {
	if (readers.size >= 2) return unknown(input, "history reader capacity exceeded");
	let worker: Worker;
	try {
		worker = new Worker(new URL("./legacy-root-history-worker.ts", import.meta.url), {
			workerData: input,
		});
	} catch {
		return unknown(input, "history reader could not start");
	}
	readers.add(worker);
	worker.once("exit", () => readers.delete(worker));
	return collectLegacyRootHistoryWorker(worker, input);
}
