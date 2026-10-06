import { basename, isAbsolute, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";

export const FILE_CHANGE_PHYSICAL_AUDIT_LIMITS = Object.freeze({
	blobBytes: FILE_CHANGE_LIMITS.blobBytes,
	chunkBytes: FILE_CHANGE_LIMITS.streamChunkBytes,
	readBytes: FILE_CHANGE_LIMITS.captureCandidateBytes,
	items: FILE_CHANGE_LIMITS.capturePaths,
	pageItems: FILE_CHANGE_LIMITS.historyPageItems,
	summaryBytes: FILE_CHANGE_LIMITS.summaryBytes,
	concurrency: FILE_CHANGE_LIMITS.captureConcurrency,
	queueItems: FILE_CHANGE_LIMITS.captureQueueItems,
	requestBytes: 2 * FILE_CHANGE_LIMITS.metadataBytes,
	progressBytes: 1024,
	progressIntervalMs: 250,
	defaultDurationMs: 30_000,
	maximumDurationMs: 120_000,
	directoryDepth: 32,
	directoryItems: FILE_CHANGE_LIMITS.capturePaths,
	samples: FILE_CHANGE_LIMITS.historyPageItems,
});
const LIMITS = FILE_CHANGE_PHYSICAL_AUDIT_LIMITS;

/** Captured by a trusted maintenance caller, not by a request-thread scan here.
 * Numeric filesystem identities are decimal strings to avoid precision loss. */
export interface FileChangeAuditIdentity {
	dev: string;
	ino: string;
	birthtimeNs: string;
	ctimeNs: string;
	mtimeNs: string;
	sizeBytes: string;
	nlink: string;
	mode: number;
	uid: number;
}
export interface FileChangePhysicalAuditDescription {
	/** A responsibility label, NOT an ACL. Never expose this entry point over HTTP,
	 * to untrusted tools, or as a hash-addressed content API. Authorize outside it. */
	maintenanceCaller: { kind: "maintenance"; subjectKey: string };
	/** Existing canonical local paths. No HOME, application connection or default root. */
	databasePath: string;
	blobRoot: string;
	namespaceKey: string;
	expectedGeneration: number;
	expectedNamespaceStatus: "ready" | "unverified" | "reconciling";
	sourceIdentity: FileChangeAuditIdentity;
	rootIdentity: FileChangeAuditIdentity;
}
export interface FileChangePhysicalAuditBudget {
	blobBytes: number;
	chunkBytes: number;
	readBytes: number;
	items: number;
	pageItems: number;
	summaryBytes: number;
	directoryDepth: number;
	directoryItems: number;
	samples: number;
	durationMs: number;
}
export interface FileChangePhysicalAuditMetrics {
	catalogRows: number;
	catalogPages: number;
	maxCatalogPage: number;
	pendingReservations: number;
	pendingReservationBytes: number;
	physicalObjects: number;
	physicalBytes: number;
	stagingBytes: number;
	temporaryObjects: number;
	temporaryBytes: number;
	physicalOnly: number;
	catalogOnly: number;
	verifiedObjects: number;
	verifiedBytes: number;
	readBytes: number;
	visitedItems: number;
	queries: number;
	mismatches: number;
	durationMs: number;
	responseBytes: number;
}
export interface FileChangePhysicalAuditSnapshot {
	schemaVersion: number;
	dataVersion: number;
	generation: number;
	namespaceStatus: FileChangePhysicalAuditDescription["expectedNamespaceStatus"];
	usedBytes: number;
	reservedBytes: number;
	quotaBytes: number;
	pendingReservations: "present" | "none_observed";
	source: FileChangeAuditIdentity;
	root: FileChangeAuditIdentity;
}
export interface FileChangePhysicalAuditSummary {
	version: 1;
	readOnly: true;
	noDeletionAuthority: true;
	referenceCompleteness: "not_checked";
	observation: "concurrent_or_unknown";
	writersQuiescent: false;
	retention: "unknown";
	candidate: false;
	/** Full means both bounded enumerations and comparisons ended, NOT a consistent
	 * snapshot, reference proof, reconciliation attestation or capacity total. */
	full: boolean;
	status: "observed" | "partial" | "unknown";
	catalogComplete: boolean;
	physicalComplete: boolean;
	reservationsComplete: boolean;
	/** Counts are lower bounds of observations, never a point-in-time store total. */
	countsLowerBound: true;
	start: FileChangePhysicalAuditSnapshot | null;
	end: FileChangePhysicalAuditSnapshot | null;
	issues: string[];
	samples: { code: string; key?: string; expectedBytes?: number; observedBytes?: number }[];
	samplesTruncated: boolean;
	metrics: FileChangePhysicalAuditMetrics;
}
export interface FileChangePhysicalAuditProgress {
	phase: "catalog" | "physical" | "reservations";
	catalogRows: number;
	physicalObjects: number;
	readBytes: number;
	visitedItems: number;
	durationMs: number;
}
export interface FileChangePhysicalAuditOptions extends FileChangePhysicalAuditDescription {
	/** All overrides can only lower the hard limits (duration defaults to 30s, max 2m). */
	budget?: Partial<FileChangePhysicalAuditBudget>;
	signal?: AbortSignal;
	onProgress?: (progress: FileChangePhysicalAuditProgress) => void;
}
/** Private wire protocol: no user messages, body data, arbitrary SQL or executable callbacks. */
export interface FileChangePhysicalAuditRequest {
	description: FileChangePhysicalAuditDescription;
	budget: FileChangePhysicalAuditBudget;
}

export class FileChangePhysicalAuditError extends Error {
	constructor(readonly code: "invalid_input") {
		super(`File-change physical audit: ${code}`);
		this.name = "FileChangePhysicalAuditError";
	}
}

interface Job {
	request: FileChangePhysicalAuditRequest;
	signal?: AbortSignal;
	onProgress?: FileChangePhysicalAuditOptions["onProgress"];
	scope: string;
	resolve: (summary: FileChangePhysicalAuditSummary) => void;
	timer?: ReturnType<typeof setTimeout>;
	abort?: () => void;
}
const activeScopes = new Set<string>();
const queue: Job[] = [];
let active = 0;

/** Explicit, internal, finite read-only maintenance work. Never automatically called
 * by startup, retention, a scheduler or HTTP. The private root is an OS trust boundary,
 * not a sandbox against a hostile owner. Linux descriptor-rooted traversal is currently
 * required; unsupported platforms fail closed. This report NEVER settles reservations,
 * calls completeReconciliation, restores ready, expires evidence, or grants GC authority.
 * Even unchanged data_version/generation and successful hashes cannot prove quiescence.
 * The concurrency slot stays occupied until the owned worker has actually exited. */
export function auditFileChangePhysical(
	options: FileChangePhysicalAuditOptions,
): Promise<FileChangePhysicalAuditSummary> {
	const request = validateRequest(options);
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid();
	if (options.onProgress !== undefined && typeof options.onProgress !== "function") invalid();
	if (options.signal?.aborted) return Promise.resolve(stopped("cancelled"));
	if (queue.length >= LIMITS.queueItems) return Promise.resolve(stopped("queue_limit"));
	return new Promise((resolve) => {
		const job: Job = {
			request,
			signal: options.signal,
			onProgress: options.onProgress,
			scope: JSON.stringify([request.description.databasePath, request.description.namespaceKey]),
			resolve,
		};
		const remove = (code: string) => {
			const index = queue.indexOf(job);
			if (index < 0) return;
			queue.splice(index, 1);
			clearWaiting(job);
			resolve(stopped(code));
		};
		job.abort = () => remove("cancelled");
		job.signal?.addEventListener("abort", job.abort, { once: true });
		job.timer = setTimeout(() => remove("queue_deadline"), request.budget.durationMs);
		queue.push(job);
		drain();
	});
}

function drain(): void {
	while (active < LIMITS.concurrency) {
		const index = queue.findIndex((job) => !activeScopes.has(job.scope));
		if (index < 0) return;
		const job = queue.splice(index, 1)[0];
		clearWaiting(job);
		active++;
		activeScopes.add(job.scope);
		void runWorker(job).then((summary) => {
			active--;
			activeScopes.delete(job.scope);
			job.resolve(summary);
			drain();
		});
	}
}
function clearWaiting(job: Job): void {
	clearTimeout(job.timer);
	if (job.abort) job.signal?.removeEventListener("abort", job.abort);
}
async function runWorker(job: Job): Promise<FileChangePhysicalAuditSummary> {
	// Source-only internal maintenance step. Never accidentally launch a compiled
	// NarraFork application binary as a child server. Bundled worker packaging is not wired.
	if (
		!/^bun(?:-debug)?(?:\.exe)?$/.test(basename(process.execPath)) ||
		import.meta.url.includes("$bunfs")
	)
		return stopped("unsupported_runtime");
	return new Promise((resolve) => {
		let result: FileChangePhysicalAuditSummary | undefined;
		let reason: string | undefined;
		let lastProgress = -Infinity;
		let progress: FileChangePhysicalAuditProgress | undefined;
		let termination: ReturnType<typeof setTimeout> | undefined;
		let worker: Bun.Subprocess<"ignore", "ignore", "ignore">;
		const stop = (code: string) => {
			if (reason) return;
			reason = code;
			try {
				worker.send(JSON.stringify({ type: "cancel", code }));
			} catch {
				/* exit settles below */
			}
			// Cooperative cleanup first, then kill ONLY this owned read-only worker process.
			// A separate PID also keeps DB source-FD close from releasing application fcntl locks.
			termination = setTimeout(() => {
				try {
					worker.kill("SIGKILL");
				} catch {
					/* exited still owns settlement */
				}
			}, 50);
		};
		try {
			worker = Bun.spawn(
				[
					process.execPath,
					fileURLToPath(new URL("./file-change-physical-audit-worker.ts", import.meta.url)),
				],
				{
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					ipc(message: unknown) {
						// Private IPC carries bounded JSON, never stdout, raw bodies or dumped arguments.
						if (
							typeof message !== "string" ||
							Buffer.byteLength(message) > job.request.budget.summaryBytes
						) {
							stop("worker_protocol");
							return;
						}
						try {
							const data = JSON.parse(message);
							if (data.type === "summary") result = data.value;
							else if (
								data.type === "progress" &&
								Buffer.byteLength(message) <= LIMITS.progressBytes
							) {
								progress = data.value;
								if (performance.now() - lastProgress >= LIMITS.progressIntervalMs) {
									lastProgress = performance.now();
									try {
										job.onProgress?.({ ...data.value });
									} catch {
										/* advisory only */
									}
								}
							} else stop("worker_protocol");
						} catch {
							stop("worker_protocol");
						}
					},
				},
			);
		} catch {
			resolve(stopped("worker_start_failed"));
			return;
		}
		const abort = () => stop("cancelled");
		job.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("deadline"), job.request.budget.durationMs);
		void worker.exited.then((code) => {
			clearTimeout(timer);
			clearTimeout(termination);
			job.signal?.removeEventListener("abort", abort);
			// OS exit, not an early summary/abort notification, releases the global slot.
			if (!reason && code === 0 && result) resolve(result);
			else {
				const summary = result ?? emptyPhysicalAuditSummary();
				summary.full = false;
				summary.status = "partial";
				summary.issues.push(reason ?? "worker_exited");
				if (!result && progress) {
					const { phase: _phase, ...counts } = progress;
					Object.assign(summary.metrics, counts);
				}
				resolve(finishPhysicalAuditSummary(summary, job.request.budget.summaryBytes));
			}
		});
		try {
			worker.send(JSON.stringify({ type: "start", request: job.request }));
		} catch {
			stop("worker_protocol");
		}
		if (job.signal?.aborted) abort();
	});
}

export function emptyPhysicalAuditSummary(): FileChangePhysicalAuditSummary {
	return {
		version: 1,
		readOnly: true,
		noDeletionAuthority: true,
		referenceCompleteness: "not_checked",
		observation: "concurrent_or_unknown",
		writersQuiescent: false,
		retention: "unknown",
		candidate: false,
		full: false,
		status: "unknown",
		catalogComplete: false,
		physicalComplete: false,
		reservationsComplete: false,
		countsLowerBound: true,
		start: null,
		end: null,
		issues: [],
		samples: [],
		samplesTruncated: false,
		metrics: {
			catalogRows: 0,
			catalogPages: 0,
			maxCatalogPage: 0,
			pendingReservations: 0,
			pendingReservationBytes: 0,
			physicalObjects: 0,
			physicalBytes: 0,
			stagingBytes: 0,
			temporaryObjects: 0,
			temporaryBytes: 0,
			physicalOnly: 0,
			catalogOnly: 0,
			verifiedObjects: 0,
			verifiedBytes: 0,
			readBytes: 0,
			visitedItems: 0,
			queries: 0,
			mismatches: 0,
			durationMs: 0,
			responseBytes: 0,
		},
	};
}
export function finishPhysicalAuditSummary(
	summary: FileChangePhysicalAuditSummary,
	maxBytes = LIMITS.summaryBytes,
): FileChangePhysicalAuditSummary {
	// Reserve the envelope and enough fixed metadata; samples were bounded before insertion.
	while (Buffer.byteLength(JSON.stringify(summary)) > maxBytes - 64 && summary.samples.length) {
		summary.samples.pop();
		summary.samplesTruncated = true;
		summary.full = false;
		summary.status = "partial";
	}
	for (let i = 0; i < 4; i++)
		summary.metrics.responseBytes = Buffer.byteLength(JSON.stringify(summary));
	return summary;
}
function stopped(code: string): FileChangePhysicalAuditSummary {
	const summary = emptyPhysicalAuditSummary();
	summary.issues.push(code);
	return finishPhysicalAuditSummary(summary);
}

function validateRequest(options: FileChangePhysicalAuditOptions): FileChangePhysicalAuditRequest {
	plain(options, [
		"maintenanceCaller",
		"databasePath",
		"blobRoot",
		"namespaceKey",
		"expectedGeneration",
		"expectedNamespaceStatus",
		"sourceIdentity",
		"rootIdentity",
		"budget",
		"signal",
		"onProgress",
	]);
	plain(options.maintenanceCaller, ["kind", "subjectKey"]);
	if (options.maintenanceCaller.kind !== "maintenance") invalid();
	key(options.maintenanceCaller.subjectKey);
	key(options.namespaceKey);
	for (const path of [options.databasePath, options.blobRoot]) {
		if (
			typeof path !== "string" ||
			path.length > 4096 ||
			path.includes("\0") ||
			!isAbsolute(path) ||
			normalize(path) !== path ||
			path === parse(path).root ||
			path.split(/[\\/]/).some((part) => part === "." || part === "..")
		)
			invalid();
	}
	integer(options.expectedGeneration, Number.MAX_SAFE_INTEGER);
	if (!["ready", "unverified", "reconciling"].includes(options.expectedNamespaceStatus)) invalid();
	const description: FileChangePhysicalAuditDescription = {
		maintenanceCaller: { kind: "maintenance", subjectKey: options.maintenanceCaller.subjectKey },
		databasePath: options.databasePath,
		blobRoot: options.blobRoot,
		namespaceKey: options.namespaceKey,
		expectedGeneration: options.expectedGeneration,
		expectedNamespaceStatus: options.expectedNamespaceStatus,
		sourceIdentity: identity(options.sourceIdentity),
		rootIdentity: identity(options.rootIdentity),
	};
	const budget: FileChangePhysicalAuditBudget = {
		blobBytes: LIMITS.blobBytes,
		chunkBytes: LIMITS.chunkBytes,
		readBytes: LIMITS.readBytes,
		items: LIMITS.items,
		pageItems: LIMITS.pageItems,
		summaryBytes: LIMITS.summaryBytes,
		directoryDepth: LIMITS.directoryDepth,
		directoryItems: LIMITS.directoryItems,
		samples: LIMITS.samples,
		durationMs: LIMITS.defaultDurationMs,
	};
	if (options.budget !== undefined) {
		plain(options.budget, Object.keys(budget));
		for (const field of Object.keys(options.budget) as (keyof FileChangePhysicalAuditBudget)[]) {
			const value = options.budget[field] as number;
			integer(
				value,
				field === "durationMs" ? LIMITS.maximumDurationMs : budget[field],
				field === "summaryBytes"
					? FILE_CHANGE_LIMITS.metadataBytes
					: ["samples", "readBytes", "items", "blobBytes"].includes(field)
						? 0
						: 1,
			);
			budget[field] = value;
		}
	}
	if (Buffer.byteLength(JSON.stringify({ description, budget })) > LIMITS.requestBytes) invalid();
	return { description, budget };
}
function identity(input: FileChangeAuditIdentity): FileChangeAuditIdentity {
	const fields = [
		"dev",
		"ino",
		"birthtimeNs",
		"ctimeNs",
		"mtimeNs",
		"sizeBytes",
		"nlink",
		"mode",
		"uid",
	];
	plain(input, fields);
	if (Object.keys(input).length !== fields.length) invalid();
	for (const field of fields.slice(0, 7) as (keyof FileChangeAuditIdentity)[]) {
		const value = input[field];
		if (typeof value !== "string" || value.length > 32 || !/^(0|[1-9][0-9]*)$/.test(value))
			invalid();
	}
	integer(input.mode, 0xffffffff);
	integer(input.uid, 0xffffffff);
	return { ...input };
}
function plain(input: unknown, fields: string[]): asserts input is object {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		invalid();
	const keys = Reflect.ownKeys(input);
	if (
		keys.length > fields.length ||
		keys.some(
			(field) =>
				typeof field !== "string" ||
				!fields.includes(field) ||
				!Object.hasOwn(Object.getOwnPropertyDescriptor(input, field) ?? {}, "value"),
		)
	)
		invalid();
}
function key(value: string): void {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > 256 ||
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		invalid();
}
function integer(value: number, maximum: number, minimum = 0): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
}
function invalid(): never {
	throw new FileChangePhysicalAuditError("invalid_input");
}
