import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { hotSafe } from "../lib/hot-safe";
import {
	emptyLegacyRetainedManifest,
	LEGACY_RETAINED_HISTORY_LIMITS,
	type LegacyRetainedHistoryInput,
	type LegacyRetainedHistoryResult,
} from "./legacy-retained-history-contract";

export type {
	LegacyRetainedAsset,
	LegacyRetainedHistoryInput,
	LegacyRetainedHistoryManifest,
	LegacyRetainedHistoryOrigin,
	LegacyRetainedHistoryResult,
	LegacyRetainedNarratorOrigin,
	LegacyRetainedWorkspace,
	LegacyRetainedWorkspaceBinding,
} from "./legacy-retained-history-contract";

export interface LegacyRetainedHistoryOptions {
	/** Trusted in-process holdAdmission/consumer guard, never a client DTO flag. */
	assertLinkedAdmissionReady?: () => void;
}

// Share the existing readonly history-reader pool: strict + retained together cap at
// two workers. Timed-out workers occupy capacity until exit is confirmed across reloads.
const readers = hotSafe<Set<Worker>>("narrafork.legacyRootHistoryReaders", () => new Set());
function unknown(input: LegacyRetainedHistoryInput, reason: string): LegacyRetainedHistoryResult {
	return {
		status: "unknown",
		digest: createHash("sha256").update(JSON.stringify({ input, reason })).digest("hex"),
		guards: [],
		complete: false,
		reason,
		manifest: emptyLegacyRetainedManifest(input),
	};
}
function validResult(value: unknown): value is LegacyRetainedHistoryResult {
	try {
		if (!value || typeof value !== "object") return false;
		const result = value as LegacyRetainedHistoryResult;
		return (
			["unknown", "retained"].includes(result.status) &&
			typeof result.digest === "string" &&
			/^[a-f0-9]{64}$/.test(result.digest) &&
			result.complete === (result.status === "retained") &&
			(result.reason === undefined ||
				(typeof result.reason === "string" && result.reason.length <= 160)) &&
			Array.isArray(result.guards) &&
			result.guards.length <= LEGACY_RETAINED_HISTORY_LIMITS.inputs &&
			result.guards.every(
				(guard) =>
					guard &&
					typeof guard.id === "string" &&
					guard.id.length <= 1024 &&
					[guard.messageVersion, guard.messageStructureVersion, guard.nextSeq].every(
						(v) => Number.isSafeInteger(v) && v >= 0,
					),
			) &&
			!!result.manifest &&
			result.manifest.version === 1 &&
			Array.isArray(result.manifest.chapters) &&
			Array.isArray(result.manifest.rawLayouts) &&
			Array.isArray(result.manifest.assets) &&
			Array.isArray(result.manifest.narratorOrigins) &&
			Array.isArray(result.manifest.workspaces) &&
			Array.isArray(result.manifest.historyOrigins) &&
			Array.isArray(result.manifest.externalNarratorIds) &&
			Array.isArray(result.manifest.legacyUnknownEvidence) &&
			!!result.manifest.references &&
			(result.status !== "retained" ||
				(result.guards.length > 0 &&
					result.manifest.chapters.length > 0 &&
					typeof result.manifest.ownerUserId === "string" &&
					!!result.manifest.gitIdentity)) &&
			Buffer.byteLength(JSON.stringify(result)) <= LEGACY_RETAINED_HISTORY_LIMITS.bytes + 64 * 1024
		);
	} catch {
		return false;
	}
}

/** Exported lifecycle seam; never returns usable evidence until worker exit is confirmed. */
export async function collectLegacyRetainedHistoryWorker(
	worker: Pick<Worker, "once" | "terminate">,
	input: LegacyRetainedHistoryInput,
	timeoutMs = 4_000,
	exitTimeoutMs = 1_000,
): Promise<LegacyRetainedHistoryResult> {
	let evidence: LegacyRetainedHistoryResult | undefined;
	let failed = false;
	let exited = false;
	const result = await new Promise<LegacyRetainedHistoryResult>((resolve) => {
		let settled = false;
		const finish = (value: LegacyRetainedHistoryResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(
			() => finish(unknown(input, "retained history reader timeout")),
			timeoutMs,
		);
		worker.once("message", (message: unknown) => {
			if (validResult(message)) evidence = message;
			else {
				failed = true;
				finish(unknown(input, "invalid retained history response"));
			}
		});
		worker.once("error", () => {
			failed = true;
			finish(unknown(input, "retained history reader error"));
		});
		worker.once("exit", (code) => {
			exited = true;
			finish(
				code === 0 && evidence && !failed
					? evidence
					: unknown(input, "retained reader exited without valid evidence"),
			);
		});
	});
	if (exited) return result;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const confirmed = await Promise.race([
			worker.terminate().then(
				() => exited,
				() => false,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), exitTimeoutMs);
			}),
		]);
		return confirmed ? result : unknown(input, "retained reader exit unconfirmed");
	} catch {
		return unknown(input, "retained reader termination failed");
	} finally {
		clearTimeout(timer);
	}
}

/** Preparation only. Core must recheck the digest/guards, owned indexes and private ACL,
 * persist the complete manifest and per-member claims atomically before deleting chapters.
 * This API does not authorize release, restore, writes, or history namespace changes. */
export async function prepareLegacyRetainedHistory(
	input: LegacyRetainedHistoryInput,
	options: LegacyRetainedHistoryOptions = {},
): Promise<LegacyRetainedHistoryResult> {
	const linked = input.workspaceBindings?.some((binding) => binding.kind === "linked");
	const assertLinkedAdmissionReady = options.assertLinkedAdmissionReady;
	if (linked) {
		try {
			if (typeof assertLinkedAdmissionReady !== "function")
				throw new Error("missing admission guard");
			assertLinkedAdmissionReady();
		} catch {
			return unknown(
				input,
				"linked retained history requires trusted admission/consumer readiness",
			);
		}
	}
	if (readers.size >= 2) return unknown(input, "retained reader capacity exceeded");
	let worker: Worker;
	try {
		worker = new Worker(new URL("./legacy-retained-history-worker.ts", import.meta.url), {
			workerData: input,
		});
	} catch {
		return unknown(input, "retained history worker could not start");
	}
	readers.add(worker);
	worker.once("exit", () => readers.delete(worker));
	const result = await collectLegacyRetainedHistoryWorker(worker, input);
	if (linked) {
		try {
			if (
				typeof assertLinkedAdmissionReady !== "function" ||
				options.assertLinkedAdmissionReady !== assertLinkedAdmissionReady
			)
				throw new Error("admission guard changed");
			assertLinkedAdmissionReady();
		} catch {
			return unknown(input, "linked retained admission/consumer guard changed during prepare");
		}
	}
	return result;
}
