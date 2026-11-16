import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { CDPSessionEvent } from "puppeteer-core";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { generateId } from "../id";
import { getNarraforkPath } from "../narrafork-home";
import { isCompiledRuntime } from "../runtime-target";
import { createShare, getMaxShareSizeBytes, getSharesDir, revokeShareRegistry } from "../shares";
import { WorkerCleanupError, type WorkerHandle } from "../worker-runtime/lifecycle";
import type { TaskQueuePermit } from "../worker-runtime/queue";
import { reserveDiagnostic } from "./diagnostic-admission";
import {
	type BrowserMemoryJob,
	memoryDiagnosticQueue,
	trackMemoryDiagnostic,
	waitForMemory,
} from "./memory-job";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";
import {
	MEMORY_PROFILE_TRACE_CATEGORIES,
	type MemoryProfileArtifact,
	type MemoryProfileConfig,
	type MemoryProfileFailureDiagnostic,
	type MemoryProfileMode,
	type MemoryProfileRequest,
	type MemoryProfileView,
	type MemoryProfileWorkerReply,
	profileDiagnosticBrowserVersion,
} from "./memory-profile-types";
import type { BrowserSession } from "./session";
import { acquireTraceLease, type TraceLease } from "./tracing-lease";

export interface MemoryProfileHandle {
	view: MemoryProfileView;
	done: Promise<void>;
	/** A bounded response failure does not settle done or relinquish any resource. */
	responseFailure?: Promise<never>;
	stop(): void;
	cancel(): void;
}
export interface MemoryProfileOptions {
	mode?: MemoryProfileMode;
	durationMs?: number;
	samplingIntervalBytes?: number;
	signal?: AbortSignal;
}
interface TargetSetup {
	targetId: string;
	detach(): Promise<void>;
}
interface ProfilerDependencies {
	specifiers?: () => string[];
	setup?: (session: BrowserSession, signal: AbortSignal, lost: () => void) => Promise<TargetSetup>;
	reserve?: typeof reserveDiagnostic;
	lease?: typeof acquireTraceLease;
	root?: string;
	sharesRoot?: string;
	registerShare?: typeof createShare;
	revokeShare?: typeof revokeShareRegistry;
	shareMaxBytes?: typeof getMaxShareSizeBytes;
	moveArtifact?: typeof rename;
	limits?: {
		startTimeoutMs?: number;
		stopTimeoutMs?: number;
		cleanupTimeoutMs?: number;
		workerCleanupTimeoutMs?: number;
		replyGraceMs?: number;
	};
}
/** Worker work remains 15s. Its terminal reply is emitted only after a separate 5s cleanup. */
export const PROFILE_SUPERVISOR_PHASE_BUDGETS = {
	workerFinalizeMs: PROFILE_LIMITS.stopTimeoutMs,
	workerCleanupMs: PROFILE_LIMITS.cleanupTimeoutMs,
	replyGraceMs: 1_000,
	mainCleanupMs: PROFILE_LIMITS.cleanupTimeoutMs,
} as const;
interface ProfilePhaseBudgets {
	workerFinalizeMs: number;
	workerCleanupMs: number;
	replyGraceMs: number;
	mainCleanupMs: number;
}
const profilePhaseBudgets = new WeakMap<MemoryProfileHandle, ProfilePhaseBudgets>();
function terminalReplyBudget(budgets: ProfilePhaseBudgets): number {
	return budgets.workerFinalizeMs + budgets.workerCleanupMs + budgets.replyGraceMs;
}
function completionBudget(budgets: ProfilePhaseBudgets): number {
	// Reserve own cleanup too, then allow one reply grace for done's settling microtask/timer order.
	return terminalReplyBudget(budgets) + budgets.mainCleanupMs + budgets.replyGraceMs;
}
const STAGES = new Set([
	"input",
	"busy",
	"closing",
	"startup",
	"setup",
	"connect",
	"target",
	"allocation",
	"trace",
	"trace_capability",
	"recording",
	"navigation",
	"bytes",
	"buffer",
	"queue",
	"write",
	"analysis",
	"finalize",
	"share",
	"worker",
	"timeout",
	"cancelled",
]);
const safeStage = (stage: string) => (STAGES.has(stage) ? stage : "worker");
function safeFailureDiagnostic(
	stage: string,
	value: unknown,
): MemoryProfileFailureDiagnostic | undefined {
	if (stage !== "trace_capability" || !value || typeof value !== "object") return;
	const diagnostic = value as Record<string, unknown>;
	if (
		diagnostic.diagnosticStage !== "trace_capability" ||
		!Array.isArray(diagnostic.missingCategories) ||
		diagnostic.missingCategories.length > MEMORY_PROFILE_TRACE_CATEGORIES.length
	)
		return;
	const missingCategories = MEMORY_PROFILE_TRACE_CATEGORIES.filter((category) =>
		(diagnostic.missingCategories as unknown[]).includes(category),
	);
	// A real startup rejection can occur even when no categories were missing.
	// Only an explicitly empty list is trusted; unknown-only lists still drop.
	if (missingCategories.length === 0 && diagnostic.missingCategories.length !== 0) return;
	return {
		diagnosticStage: "trace_capability",
		browserVersion: profileDiagnosticBrowserVersion(diagnostic.browserVersion),
		missingCategories,
	};
}
const CDP_DISCONNECTED = (CDPSessionEvent as typeof CDPSessionEvent & { Disconnected: symbol })
	.Disconnected;

export function profileWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/browser/memory-profile-worker.ts",
		"./memory-profile-worker.ts",
		moduleUrl,
		compiled,
	);
}
function configFor(opts: MemoryProfileOptions): MemoryProfileConfig {
	const mode = opts.mode ?? "both";
	if (!["allocation", "gc", "both"].includes(mode)) throw new MemoryProfileError("input");
	const integer = (value: number | undefined, fallback: number, min: number, max: number) => {
		if (value === undefined) return fallback;
		if (!Number.isSafeInteger(value) || value < min || value > max)
			throw new MemoryProfileError("input");
		return value;
	};
	return {
		mode,
		durationMs: integer(
			opts.durationMs,
			PROFILE_LIMITS.defaultDurationMs,
			PROFILE_LIMITS.minDurationMs,
			PROFILE_LIMITS.maxDurationMs,
		),
		samplingIntervalBytes: integer(
			opts.samplingIntervalBytes,
			PROFILE_LIMITS.defaultSamplingIntervalBytes,
			PROFILE_LIMITS.minSamplingIntervalBytes,
			PROFILE_LIMITS.maxSamplingIntervalBytes,
		),
	};
}

/** Bound traversal before serialization, so an invalid worker reply cannot allocate an enormous JSON string. */
function smallReply(value: unknown): boolean {
	let budget = PROFILE_LIMITS.summaryBytes;
	const walk = (item: unknown, depth: number): boolean => {
		if (--budget < 0 || depth > 32) return false;
		if (typeof item === "string") {
			budget -= item.length;
			return budget >= 0;
		}
		if (item === null || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item !== "object") return false;
		if (Array.isArray(item) && item.length > PROFILE_LIMITS.summaryBytes) return false;
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			budget -= key.length;
			if (budget < 0 || !walk((item as Record<string, unknown>)[key], depth + 1)) return false;
		}
		return true;
	};
	try {
		return (
			walk(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= PROFILE_LIMITS.summaryBytes
		);
	} catch {
		return false;
	}
}
async function setupTarget(
	session: BrowserSession,
	signal: AbortSignal,
	lost: () => void,
): Promise<TargetSetup> {
	// Keep the startup owner until a late CDP attachment has really been detached.
	const client = await session.page.createCDPSession();
	if (signal.aborted) {
		await client.detach().catch(() => {});
		signal.throwIfAborted();
	}
	client.on(CDP_DISCONNECTED, lost);
	try {
		const info = await waitForMemory(client.send("Target.getTargetInfo"), signal);
		return {
			targetId: info.targetInfo.targetId,
			async detach() {
				client.off(CDP_DISCONNECTED, lost);
				await client.detach().catch(() => {});
			},
		};
	} catch {
		client.off(CDP_DISCONNECTED, lost);
		await client.detach().catch(() => {});
		throw new MemoryProfileError("setup");
	}
}

/** Session admission is synchronous; resource ownership lasts until actual cleanup, not a response race. */
export function createMemoryProfiler(deps: ProfilerDependencies = {}) {
	const startTimeout = deps.limits?.startTimeoutMs ?? PROFILE_LIMITS.startTimeoutMs;
	const phaseBudgets: ProfilePhaseBudgets = {
		workerFinalizeMs:
			deps.limits?.stopTimeoutMs ?? PROFILE_SUPERVISOR_PHASE_BUDGETS.workerFinalizeMs,
		workerCleanupMs:
			deps.limits?.workerCleanupTimeoutMs ?? PROFILE_SUPERVISOR_PHASE_BUDGETS.workerCleanupMs,
		replyGraceMs: deps.limits?.replyGraceMs ?? PROFILE_SUPERVISOR_PHASE_BUDGETS.replyGraceMs,
		mainCleanupMs: deps.limits?.cleanupTimeoutMs ?? PROFILE_SUPERVISOR_PHASE_BUDGETS.mainCleanupMs,
	};
	const stopTimeout = terminalReplyBudget(phaseBudgets);
	const cleanupTimeout = phaseBudgets.mainCleanupMs;
	const shareBudget = () => {
		const configured = (deps.shareMaxBytes ?? getMaxShareSizeBytes)();
		if (!Number.isFinite(configured) || configured <= 0) throw new MemoryProfileError("bytes");
		return Math.min(PROFILE_LIMITS.artifactBytes, Math.floor(configured));
	};
	async function start(
		session: BrowserSession,
		opts: MemoryProfileOptions = {},
	): Promise<MemoryProfileView> {
		const config = configFor(opts);
		if (session.memoryDiagnosticsClosed || session.page.isClosed())
			throw new MemoryProfileError("closing");
		if (session.memoryJob) throw new MemoryProfileError("busy");
		if (opts.signal?.aborted) throw new MemoryProfileError("cancelled");
		let release: () => void;
		let lease: TraceLease | undefined;
		const browser = session.page.browser();
		try {
			release = (deps.reserve ?? reserveDiagnostic)("profile");
		} catch {
			throw new MemoryProfileError("busy");
		}
		const profileId = generateId();
		try {
			if (config.mode !== "allocation")
				lease = (deps.lease ?? acquireTraceLease)(browser, profileId);
		} catch {
			release();
			throw new MemoryProfileError("busy");
		}
		const controller = new AbortController();
		let done!: () => void;
		const job: BrowserMemoryJob = {
			controller,
			done: new Promise<void>((resolve) => {
				done = resolve;
			}),
		};
		let started!: (view: MemoryProfileView) => void;
		let startFailed!: (error: MemoryProfileError) => void;
		const startResult = new Promise<MemoryProfileView>((resolve, reject) => {
			started = resolve;
			startFailed = reject;
		});
		try {
			trackMemoryDiagnostic(job);
		} catch {
			lease?.confirmStopped();
			release();
			done();
			throw new MemoryProfileError("closing");
		}
		let permit: TaskQueuePermit | undefined;
		let workerHandle: WorkerHandle<Worker> | undefined;
		let startupDone!: () => void;
		const pendingStartup = new Promise<void>((resolve) => {
			startupDone = resolve;
		});
		let publication: Promise<MemoryProfileView["artifacts"]> | undefined;
		let worker: Worker | undefined;
		let target: TargetSetup | undefined;
		let dir: string | undefined;
		let dispatched = false;
		let recordingBudget: number = PROFILE_LIMITS.artifactBytes;
		let finishing = false;
		let traceStopped = false;
		let terminalReplySeen = false;
		let startSettled = false;
		let stopping = false;
		let startedMs = 0;
		let abortStage = "cancelled";
		let autoTimer: ReturnType<typeof setTimeout> | undefined;
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		let cleanupAck: (() => void) | undefined;
		let cleanupDeadline = Number.POSITIVE_INFINITY;
		const published: Array<{ id: string; dir: string; revoked?: boolean }> = [];
		let failResponse!: (error: MemoryProfileError) => void;
		const responseFailure = new Promise<never>((_, reject) => {
			failResponse = reject;
		});
		void responseFailure.catch(() => {});
		const handle: MemoryProfileHandle = {
			view: { profileId, state: "starting", config },
			done: job.done,
			responseFailure,
			stop: () => {
				if (finishing || stopping) return;
				if (handle.view.state === "starting") {
					abortStage = "cancelled";
					controller.abort();
					return;
				}
				stopping = true;
				finalizing();
				try {
					worker?.postMessage({ kind: "stop", profileId });
				} catch {
					void finish("failed", "worker");
				}
			},
			cancel: () => controller.abort(),
		};
		profilePhaseBudgets.set(handle, phaseBudgets);
		session.memoryJob = job;
		session.memoryProfile = handle;
		const externalAbort = () => controller.abort();
		const lost = () => controller.abort();
		const startupDeadline = Date.now() + startTimeout;
		const startTimer = setTimeout(() => {
			abortStage = "timeout";
			controller.abort();
		}, startTimeout);
		opts.signal?.addEventListener("abort", externalAbort, { once: true });
		session.page.on("close", lost);
		session.page.on("error", lost);
		browser.on("disconnected", lost);
		const jobAbort = () => {
			void finish(abortStage === "timeout" ? "failed" : "cancelled", abortStage);
		};
		controller.signal.addEventListener("abort", jobAbort, { once: true });
		if (opts.signal?.aborted) controller.abort();
		function finalizing() {
			if (finishing || stopTimer) return;
			clearTimeout(autoTimer);
			handle.view.state = "finalizing";
			stopTimer = setTimeout(() => {
				abortStage = "timeout";
				controller.abort();
			}, stopTimeout);
		}
		async function bounded(action: () => Promise<unknown>) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.resolve()
						.then(action)
						.catch(() => {}),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, Math.max(1, cleanupDeadline - Date.now() - 10));
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		async function rollback() {
			for (const share of published) {
				if (!share.revoked) {
					(deps.revokeShare ?? revokeShareRegistry)(share.id);
					share.revoked = true;
				}
			}
			await Promise.all(
				published.map((share) => rm(share.dir, { recursive: true, force: true }).catch(() => {})),
			);
		}
		async function publish(message: Extract<MemoryProfileWorkerReply, { kind: "result" }>) {
			const names: Record<MemoryProfileArtifact["kind"], string> = {
				allocation: "allocation.heapprofile",
				gc: "gc.trace.json",
				summary: "summary.json",
			};
			if (
				!smallReply(message) ||
				!dir ||
				!Array.isArray(message.artifacts) ||
				message.artifacts.length > 3 ||
				message.artifacts.length < 1
			)
				throw new MemoryProfileError("bytes");
			if (
				!message.summary ||
				!["complete", "partial"].includes(message.summary.status) ||
				message.summary.mode !== config.mode
			)
				throw new MemoryProfileError("worker");
			let total = 0;
			const checkShareBudget = (fileSize = 0) => {
				const currentBudget = Math.min(recordingBudget, shareBudget());
				if (fileSize > currentBudget || total > currentBudget)
					throw new MemoryProfileError("bytes");
			};
			const seen = new Set<string>();
			for (const artifact of message.artifacts) {
				if (
					artifact.filename !== names[artifact.kind] ||
					seen.has(artifact.kind) ||
					!Number.isSafeInteger(artifact.size) ||
					artifact.size <= 0
				)
					throw new MemoryProfileError("bytes");
				seen.add(artifact.kind);
				const max =
					artifact.kind === "allocation"
						? PROFILE_LIMITS.allocationBytes
						: artifact.kind === "gc"
							? PROFILE_LIMITS.traceBytes
							: PROFILE_LIMITS.summaryBytes;
				total += artifact.size;
				if (artifact.size > max) throw new MemoryProfileError("bytes");
				checkShareBudget(artifact.size);
				const stat = await lstat(join(dir, artifact.filename));
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size)
					throw new MemoryProfileError("bytes");
			}
			const artifacts: NonNullable<MemoryProfileView["artifacts"]> = [];
			for (const artifact of message.artifacts) {
				controller.signal.throwIfAborted();
				checkShareBudget();
				const id = generateId();
				const shareDir = join(deps.sharesRoot ?? getSharesDir(), id);
				published.push({ id, dir: shareDir });
				await mkdir(shareDir, { recursive: true });
				controller.signal.throwIfAborted();
				const path = join(shareDir, artifact.filename);
				await (deps.moveArtifact ?? rename)(join(dir, artifact.filename), path);
				controller.signal.throwIfAborted();
				checkShareBudget();
				(deps.registerShare ?? createShare)({
					id,
					originalName: artifact.filename,
					storagePath: path,
					size: artifact.size,
					createdBy: session.narratorId,
					expiryHours: 24,
				});
				artifacts.push({
					...artifact,
					shareId: id,
					shareUrl: `/api/shares/${id}`,
					path,
				});
			}
			controller.signal.throwIfAborted();
			checkShareBudget();
			return artifacts;
		}
		async function finish(
			state: "completed" | "failed" | "cancelled",
			stage?: string,
			result?: Extract<MemoryProfileWorkerReply, { kind: "result" }>,
		) {
			if (finishing) return;
			if (result && state === "completed") finalizing();
			finishing = true;
			clearTimeout(startTimer);
			clearTimeout(autoTimer);
			clearTimeout(stopTimer);
			opts.signal?.removeEventListener("abort", externalAbort);
			// A terminal reply ends the worker phase. Publishing and disposal share our own 5s budget,
			// rather than competing with the last milliseconds of the worker reply allowance.
			cleanupDeadline = Date.now() + cleanupTimeout;
			// This bounds responses, not physical cleanup. Native slots/session leases remain owned.
			const responseTimer = setTimeout(() => {
				failResponse(new MemoryProfileError("timeout"));
				if (!controller.signal.aborted) {
					abortStage = "timeout";
					controller.abort();
				}
				if (!startSettled) {
					startSettled = true;
					startFailed(
						new MemoryProfileError(
							safeStage(controller.signal.aborted ? abortStage : (stage ?? "timeout")),
						),
					);
				}
			}, cleanupTimeout);
			let artifacts: MemoryProfileView["artifacts"];
			try {
				if (result && state === "completed") {
					publication = publish(result);
					artifacts = await waitForMemory(publication, controller.signal);
				}
			} catch (error) {
				state = controller.signal.aborted ? "cancelled" : "failed";
				stage = error instanceof MemoryProfileError ? error.stage : "share";
			}
			// Close can race asynchronous artifact movement, including after the last createShare.
			if (controller.signal.aborted) {
				state = abortStage === "timeout" ? "failed" : "cancelled";
				stage = abortStage;
			}
			// Startup can finish after cancellation, and publication can complete a late FS operation.
			// Neither a response timeout nor detach proves the worker has stopped writing.
			await pendingStartup;
			await publication?.catch(() => {});
			await Promise.all([
				(async () => {
					if (!workerHandle) return;
					const ack = new Promise<void>((resolve) => {
						cleanupAck = resolve;
						if (terminalReplySeen || workerHandle?.closed) resolve();
					});
					try {
						worker?.postMessage({ kind: "cancel", profileId });
					} catch {}
					await bounded(() => ack);
					await workerHandle.close().catch(() => {});
					await workerHandle.exited;
					worker?.off("message", message);
				})(),
				target?.detach().catch(() => {}),
			]);
			if (controller.signal.aborted) {
				state = abortStage === "timeout" ? "failed" : "cancelled";
				stage = abortStage;
			}
			if (state !== "completed") await rollback();
			if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
			session.page.off("close", lost);
			session.page.off("error", lost);
			browser.off("disconnected", lost);
			controller.signal.removeEventListener("abort", jobAbort);
			if (lease?.isCurrent()) {
				if (traceStopped || !dispatched) lease.confirmStopped();
				else lease.markUncertain();
			}
			permit?.release();
			release();
			clearTimeout(responseTimer);
			handle.view = {
				...handle.view,
				state,
				...(state === "completed" && result
					? { summary: result.summary, artifacts }
					: { stage: safeStage(stage ?? "worker") }),
			};
			if (session.memoryJob === job) session.memoryJob = undefined;
			done();
			if (!startSettled) {
				startSettled = true;
				const error = new MemoryProfileError(safeStage(stage ?? "worker"));
				if (handle.view.diagnostic) error.cause = handle.view.diagnostic;
				startFailed(error);
			}
		}
		function message(message: MemoryProfileWorkerReply) {
			if (!message || typeof message !== "object") return;
			if (message.kind === "ready") {
				if (dispatched || finishing || !dir || !target || controller.signal.aborted) return;
				try {
					recordingBudget = shareBudget();
					const request: MemoryProfileRequest = {
						profileId,
						wsEndpoint: browser.wsEndpoint(),
						targetId: target.targetId,
						dir,
						maxArtifactsBytes: recordingBudget,
						config,
					};
					dispatched = true;
					worker?.postMessage({ kind: "start", request });
				} catch (error) {
					void finish(
						"failed",
						error instanceof MemoryProfileError ? safeStage(error.stage) : "worker",
					);
				}
				return;
			}
			if (message.profileId !== profileId || session.memoryProfile !== handle) return;
			if (message.kind === "result" || message.kind === "failed" || message.kind === "cancelled") {
				terminalReplySeen = true;
				if (message.traceStopped === true) traceStopped = true;
				cleanupAck?.();
			}
			if (finishing) return;
			if (!dispatched) return;
			if (!smallReply(message)) {
				void finish("failed", "bytes");
				return;
			}
			switch (message.kind) {
				case "recording": {
					if (handle.view.state !== "starting") return;
					if (
						!Number.isFinite(Date.parse(message.startedAt)) ||
						typeof message.browserVersion !== "string" ||
						!Array.isArray(message.warnings)
					) {
						void finish("failed", "worker");
						return;
					}
					clearTimeout(startTimer);
					opts.signal?.removeEventListener("abort", externalAbort);
					startedMs = Date.now();
					handle.view = {
						...handle.view,
						state: "recording",
						startedAt: message.startedAt,
						browserVersion: message.browserVersion,
						warnings: message.warnings,
						deadline: new Date(startedMs + config.durationMs).toISOString(),
						elapsedMs: 0,
					};
					// Worker owns stopReason=duration_limit. This timer bounds a missing finalizing event only.
					autoTimer = setTimeout(() => finalizing(), config.durationMs);
					startSettled = true;
					started(memoryProfileView(session));
					break;
				}
				case "progress":
					if (Number.isFinite(message.elapsedMs) && message.elapsedMs >= 0)
						handle.view.elapsedMs = Math.min(config.durationMs, message.elapsedMs);
					break;
				case "finalizing":
					finalizing();
					break;
				case "result":
					void finish("completed", undefined, message);
					break;
				case "failed": {
					const stage = safeStage(message.stage);
					const diagnostic = safeFailureDiagnostic(stage, message.diagnostic);
					if (diagnostic) handle.view.diagnostic = diagnostic;
					void finish("failed", stage);
					break;
				}
				case "cancelled":
					void finish("cancelled", "cancelled");
					break;
			}
		}
		void (async () => {
			let stage = "setup";
			try {
				const signal = controller.signal;
				// Queue has no total deadline: recording/finalize/cleanup retain their domain budgets.
				permit = await memoryDiagnosticQueue.acquire({
					signal,
					deadlineAt: Infinity,
					key: session.id,
				});
				signal.throwIfAborted();
				target = await (deps.setup ?? setupTarget)(session, signal, lost);
				signal.throwIfAborted();
				const root = deps.root ?? getNarraforkPath("memory-profiles");
				await mkdir(root, { recursive: true });
				signal.throwIfAborted();
				dir = await mkdtemp(join(root, "profile-"));
				signal.throwIfAborted();
				stage = "startup";
				const connected = await connectCompiledWorker(
					(deps.specifiers ?? profileWorkerSpecifiers)(),
					{
						signal,
						deadlineAt: startupDeadline,
						timeoutMs: startTimeout,
						sendPing: false,
						isReady: (reply) => (reply as MemoryProfileWorkerReply)?.kind === "ready",
					},
				);
				workerHandle = connected.handle;
				worker = connected.worker;
				const failure = () => {
					cleanupAck?.();
					if (!finishing) void finish("failed", "worker");
				};
				worker.on("message", message);
				worker.on("error", failure);
				worker.once("exit", () => {
					worker?.off("error", failure);
					failure();
				});
				message({ kind: "ready" });
			} catch (error) {
				if (error instanceof WorkerCleanupError)
					workerHandle = error.handle as WorkerHandle<Worker>;
				if (!finishing)
					void finish(
						controller.signal.aborted
							? abortStage === "timeout"
								? "failed"
								: "cancelled"
							: "failed",
						controller.signal.aborted ? abortStage : stage,
					);
			} finally {
				startupDone();
			}
		})();
		return startResult;
	}
	return {
		startMemoryProfile: start,
		stopMemoryProfile,
		statusMemoryProfile,
		cancelMemoryProfile,
		memoryProfileView,
	};
}

/** Small serializable view for snapshot/list displays; no worker, controller or endpoint escapes. */
export function memoryProfileView(session: BrowserSession): MemoryProfileView {
	return structuredClone(session.memoryProfile?.view ?? { state: "idle" });
}
export function statusMemoryProfile(
	session: BrowserSession,
	profileId?: string,
): MemoryProfileView {
	if (profileId !== undefined && session.memoryProfile?.view.profileId !== profileId)
		throw new MemoryProfileError("input");
	return memoryProfileView(session);
}
async function waitForProfile(
	handle: MemoryProfileHandle,
	signal?: AbortSignal,
): Promise<MemoryProfileView> {
	const budgets = profilePhaseBudgets.get(handle) ?? PROFILE_SUPERVISOR_PHASE_BUDGETS;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), completionBudget(budgets));
	const abort = () => handle.cancel();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		// External abort requests cancellation but still waits for bounded cleanup, not just the reply.
		await waitForMemory(
			handle.responseFailure ? Promise.race([handle.done, handle.responseFailure]) : handle.done,
			deadline.signal,
		);
	} catch (error) {
		handle.cancel();
		throw new MemoryProfileError(
			deadline.signal.aborted || (error instanceof MemoryProfileError && error.stage === "timeout")
				? "timeout"
				: "worker",
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
	return structuredClone(handle.view);
}
export async function stopMemoryProfile(
	session: BrowserSession,
	profileId: string,
	signal?: AbortSignal,
): Promise<MemoryProfileView> {
	statusMemoryProfile(session, profileId);
	const handle = session.memoryProfile as MemoryProfileHandle;
	handle.stop();
	return waitForProfile(handle, signal);
}
export async function cancelMemoryProfile(
	session: BrowserSession,
	profileId: string,
): Promise<MemoryProfileView> {
	statusMemoryProfile(session, profileId);
	const handle = session.memoryProfile as MemoryProfileHandle;
	if (["completed", "failed", "cancelled"].includes(handle.view.state))
		return memoryProfileView(session);
	handle.cancel();
	return waitForProfile(handle);
}
export const startMemoryProfile = createMemoryProfiler().startMemoryProfile;
