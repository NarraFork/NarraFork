import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import type { Protocol } from "devtools-protocol";
import { CDPSessionEvent, connect } from "puppeteer-core";
import { analyzeAllocations, failedAllocationSummary } from "./allocation-summary";
import { analyzeGcTrace, failedGcSummary } from "./gc-trace-summary";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";
import {
	checkProfileAbort,
	createProfileDirectory,
	downloadProfileTrace,
	profileDeadline,
	profileFileSize,
	removeProfileFiles,
	writeProfileJson,
} from "./memory-profile-io";
import { MemoryProfileTransport } from "./memory-profile-transport";
import {
	type HeapTrendPoint,
	MEMORY_PROFILE_TRACE_CATEGORIES,
	type MemoryProfileArtifact,
	type MemoryProfileFailureDiagnostic,
	type MemoryProfileRequest,
	type MemoryProfileSummary,
	type MemoryProfileWorkerCommand,
	type MemoryProfileWorkerReply,
	profileDiagnosticBrowserVersion,
} from "./memory-profile-types";
import { definiteTraceStartRejection } from "./tracing-lease";

// Puppeteer emits a symbol, not the string "disconnected", on actual CDP detach.
export const PROFILE_SESSION_DISCONNECTED = (CDPSessionEvent as unknown as { Disconnected: symbol })
	.Disconnected;

type Listener = (value: unknown) => void;
export interface ProfileSession {
	send(
		method: string,
		params?: Record<string, unknown>,
		options?: { timeout: number },
	): Promise<unknown>;
	on(event: string | symbol, listener: Listener): unknown;
	off(event: string | symbol, listener: Listener): unknown;
	detach(): Promise<void>;
}
export interface ProfileConnection {
	session: ProfileSession;
	disconnect(): Promise<void>;
	failureStage?: () => string | undefined;
}

/** A new, limited socket, attached by exact CDP identity; no page/URL heuristics. */
export async function connectProfileTarget(
	opts: MemoryProfileRequest,
	signal: AbortSignal,
	connector: typeof connect = connect,
): Promise<ProfileConnection> {
	const transport = await MemoryProfileTransport.create(opts.wsEndpoint);
	let browser: Awaited<ReturnType<typeof connect>> | undefined;
	const abortConnect = () => transport.close();
	signal.addEventListener("abort", abortConnect, { once: true });
	try {
		checkProfileAbort(signal);
		browser = await connector({
			transport,
			protocolTimeout: PROFILE_LIMITS.stopTimeoutMs,
			defaultViewport: null,
		});
		checkProfileAbort(signal);
		const root = await browser.target().createCDPSession();
		try {
			const connection = root.connection();
			if (!connection) throw new MemoryProfileError("target");
			const { sessionId } = await connection.send("Target.attachToTarget", {
				targetId: opts.targetId,
				flatten: true,
			});
			checkProfileAbort(signal);
			const session = connection.session(sessionId);
			if (!session) throw new MemoryProfileError("target");
			const { targetInfo } = await session.send("Target.getTargetInfo");
			if (targetInfo.targetId !== opts.targetId || targetInfo.type !== "page") {
				throw new MemoryProfileError("target");
			}
			checkProfileAbort(signal);
			const attachedBrowser = browser;
			return {
				session: session as unknown as ProfileSession,
				disconnect: () => attachedBrowser.disconnect(),
				failureStage: () => transport.failureStage,
			};
		} finally {
			await profileDeadline(() => root.detach(), PROFILE_LIMITS.cleanupTimeoutMs, "cleanup").catch(
				() => {},
			);
		}
	} catch (error) {
		transport.close();
		await profileDeadline(
			() => browser?.disconnect() ?? Promise.resolve(),
			PROFILE_LIMITS.cleanupTimeoutMs,
			"cleanup",
		).catch(() => {});
		throw new MemoryProfileError(
			transport.failureStage ?? (error instanceof MemoryProfileError ? error.stage : "connect"),
		);
	} finally {
		signal.removeEventListener("abort", abortConnect);
	}
}

interface TraceComplete {
	stream?: string;
	dataLossOccurred?: boolean;
}
export interface ProfileDependencies {
	connect?: typeof connectProfileTarget;
	analyzeAllocations?: typeof analyzeAllocations;
	analyzeGcTrace?: typeof analyzeGcTrace;
}

/** One recorder per worker. Large CDP bodies and file content stay in this isolate. */
export class MemoryProfileRecorder {
	private request?: MemoryProfileRequest;
	private connection?: ProfileConnection;
	private readonly controller = new AbortController();
	private phase: "idle" | "starting" | "recording" | "finalizing" | "done" = "idle";
	private cancelStage = "cancelled";
	private stopReason: MemoryProfileSummary["stopReason"] = "manual";
	private stopRecording: () => void = () => {};
	private readonly stopped = new Promise<void>((resolve) => {
		this.stopRecording = resolve;
	});
	private samplingAttempted = false;
	private samplingStarted = false;
	private tracingStarted = false;
	private tracingEndSent = false;
	private traceStopped = true;
	private traceComplete?: TraceComplete;
	private completeTrace: (value: TraceComplete) => void = () => {};
	private readonly traceDone = new Promise<TraceComplete>((resolve) => {
		this.completeTrace = resolve;
	});
	private rootFrameId = "";
	private rootLoaderId = "";
	private bufferLimited = false;
	private traceUsage = 0;
	private startedAt = "";
	private startedClock = 0;
	private browserVersion = "unavailable";
	private failureDiagnostic?: MemoryProfileFailureDiagnostic;
	private readonly heapTrend: HeapTrendPoint[] = [];
	private readonly warnings: string[] = [];
	private readonly listeners: Array<[string | symbol, Listener]> = [];
	private heapTimer?: ReturnType<typeof setInterval>;
	private durationTimer?: ReturnType<typeof setTimeout>;
	private heapPending = false;
	private stopRequested = false;
	private lastProgress = -Infinity;
	private readonly marker = `nf-memory-${crypto.randomUUID()}`;

	constructor(
		private readonly emit: (reply: MemoryProfileWorkerReply) => void,
		private readonly dependencies: ProfileDependencies = {},
	) {}

	command(command: MemoryProfileWorkerCommand): Promise<void> | undefined {
		if (command.kind === "start") {
			if (this.phase !== "idle") return;
			this.request = command.request;
			this.phase = "starting";
			return this.run(command.request);
		}
		if (!this.request || command.profileId !== this.request.profileId || this.phase === "done") {
			return;
		}
		if (command.kind === "cancel") this.cancel("cancelled");
		else this.stop("manual");
	}

	cancel(stage = "cancelled"): void {
		if (this.phase === "done" || this.controller.signal.aborted) return;
		this.cancelStage = stage;
		this.controller.abort();
		this.stopRecording();
	}

	private stop(reason: MemoryProfileSummary["stopReason"]): void {
		if (this.phase === "done" || this.phase === "finalizing" || this.stopRequested) return;
		// First stopping cause wins, including requests received during startup.
		this.stopRequested = true;
		this.stopReason = reason;
		this.clearTimers();
		this.stopRecording();
	}

	private warn(warning: string): void {
		if (this.warnings.length >= PROFILE_LIMITS.warnings || this.warnings.includes(warning)) return;
		this.warnings.push(warning.slice(0, PROFILE_LIMITS.warningChars));
	}

	private async send<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		timeout?: number,
	): Promise<T> {
		if (!this.connection) throw new MemoryProfileError("connect");
		return (await this.connection.session.send(
			method,
			params,
			timeout ? { timeout } : undefined,
		)) as T;
	}

	private listen(event: string | symbol, listener: Listener): void {
		this.connection?.session.on(event, listener);
		this.listeners.push([event, listener]);
	}

	private installListeners(): void {
		this.listen(PROFILE_SESSION_DISCONNECTED, () =>
			this.cancel(this.connection?.failureStage?.() ?? "disconnected"),
		);
		this.listen("Page.frameNavigated", (value) => {
			const { frame } = value as { frame: { id: string; loaderId: string; parentId?: string } };
			if (this.rootFrameId && !frame.parentId && frame.loaderId !== this.rootLoaderId) {
				this.cancel("navigation");
			}
		});
		this.listen("Page.navigatedWithinDocument", (value) => {
			if ((value as { frameId: string }).frameId === this.rootFrameId) {
				this.warn("Same-document navigation occurred; the original target remained attached.");
			}
		});
		this.listen("Tracing.bufferUsage", (value) => {
			const { percentFull, value: usage } = value as { percentFull?: number; value?: number };
			const ratio = percentFull ?? usage ?? 0;
			if (!Number.isFinite(ratio)) return;
			this.traceUsage = Math.max(this.traceUsage, Math.min(1, Math.max(0, ratio)));
			if (this.traceUsage >= PROFILE_LIMITS.traceBufferStopRatio) {
				this.bufferLimited = true;
				this.stop("buffer_limit");
			}
		});
		this.listen("Tracing.tracingComplete", (value) => {
			// No confirmation from another trace, or before we requested our own end.
			if (!this.tracingStarted || !this.tracingEndSent) return;
			this.traceComplete = value as TraceComplete;
			this.traceStopped = true;
			this.completeTrace(this.traceComplete);
		});
	}

	private async start(opts: MemoryProfileRequest): Promise<void> {
		const signal = this.controller.signal;
		await createProfileDirectory(opts.dir);
		checkProfileAbort(signal);
		const connection = await (this.dependencies.connect ?? connectProfileTarget)(opts, signal);
		this.connection = connection;
		if (signal.aborted || this.phase === "done") {
			await profileDeadline(
				() => connection.disconnect(),
				PROFILE_LIMITS.cleanupTimeoutMs,
				"cleanup",
			);
			checkProfileAbort(signal);
		}
		this.installListeners();
		const frameTree = await this.send<{ frameTree: { frame: { id: string; loaderId: string } } }>(
			"Page.getFrameTree",
		);
		this.rootFrameId = frameTree.frameTree.frame.id;
		this.rootLoaderId = frameTree.frameTree.frame.loaderId;
		await this.send("Page.enable");
		const version = await this.send<{ product: string }>("Browser.getVersion");
		this.browserVersion = version.product.slice(0, PROFILE_LIMITS.functionChars);
		this.warn("Allocation sampling and renderer GC event semantics vary by browser version.");
		if (opts.config.mode !== "allocation") {
			const { categories } = await this.send<{ categories: string[] }>("Tracing.getCategories");
			const required = [...MEMORY_PROFILE_TRACE_CATEGORIES];
			const missingCategories = required.filter((category) => !categories.includes(category));
			if (missingCategories.length > 0) {
				this.failureDiagnostic = {
					diagnosticStage: "trace_capability",
					browserVersion: profileDiagnosticBrowserVersion(this.browserVersion),
					missingCategories,
				};
				throw new MemoryProfileError("trace_capability");
			}
			checkProfileAbort(signal);
			// Unknown outcome must not be mistaken for a safely stopped browser trace.
			this.traceStopped = false;
			try {
				await this.send("Tracing.start", {
					transferMode: "ReturnAsStream",
					streamFormat: "json",
					streamCompression: "none",
					bufferUsageReportingInterval: PROFILE_LIMITS.traceBufferUsageIntervalMs,
					traceConfig: {
						recordMode: "recordUntilFull",
						traceBufferSizeInKb: PROFILE_LIMITS.traceBufferKb,
						includedCategories: required,
					},
				});
			} catch (error) {
				// A definite protocol rejection means OUR trace never started. Do not end
				// a foreign/DevTools trace, and do not strand our lease as uncertain.
				if (definiteTraceStartRejection(error)) this.traceStopped = true;
				throw error;
			}
			this.tracingStarted = true;
			checkProfileAbort(signal);
		}
		if (opts.config.mode !== "gc") {
			await this.send("HeapProfiler.enable");
			checkProfileAbort(signal);
			this.samplingAttempted = true;
			await this.send("HeapProfiler.startSampling", {
				samplingInterval: opts.config.samplingIntervalBytes,
				stackDepth: PROFILE_LIMITS.stackDepth,
				includeObjectsCollectedByMinorGC: true,
				includeObjectsCollectedByMajorGC: true,
			});
			this.samplingStarted = true;
			checkProfileAbort(signal);
		}
		if (this.tracingStarted) await this.mark("start");
		checkProfileAbort(signal);
		this.startedAt = new Date().toISOString();
		this.startedClock = performance.now();
		this.phase = "recording";
		this.durationTimer = setTimeout(() => this.stop("duration_limit"), opts.config.durationMs);
		this.heapTimer = setInterval(() => void this.sampleHeap(), PROFILE_LIMITS.heapIntervalMs);
		this.emit({
			kind: "recording",
			profileId: opts.profileId,
			startedAt: this.startedAt,
			browserVersion: this.browserVersion,
			warnings: [...this.warnings],
		});
	}

	private async mark(edge: "start" | "end"): Promise<void> {
		const name = JSON.stringify(`${this.marker}-${edge}`);
		const result = await this.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
			expression: `performance.mark(${name});performance.clearMarks(${name});void 0`,
			returnByValue: true,
		});
		if (result.exceptionDetails) throw new MemoryProfileError("marker");
	}

	private async sampleHeap(): Promise<void> {
		if (
			this.phase !== "recording" ||
			this.heapPending ||
			this.heapTrend.length >= PROFILE_LIMITS.heapPoints
		) {
			return;
		}
		this.heapPending = true;
		const elapsedMs = Math.round(performance.now() - this.startedClock);
		try {
			const heap = await this.send<{ usedSize: number; totalSize: number }>(
				"Runtime.getHeapUsage",
				undefined,
				PROFILE_LIMITS.heapIntervalMs,
			);
			if (this.phase !== "recording") return;
			if (
				!Number.isFinite(heap.usedSize) ||
				!Number.isFinite(heap.totalSize) ||
				heap.usedSize < 0 ||
				heap.totalSize < 0
			) {
				throw new MemoryProfileError("heap_unavailable");
			}
			this.heapTrend.push({ elapsedMs, usedBytes: heap.usedSize, totalBytes: heap.totalSize });
		} catch {
			if (this.phase !== "recording") return;
			this.heapTrend.push({ elapsedMs, usedBytes: null, totalBytes: null });
			this.warn("Some heap trend samples were unavailable.");
		} finally {
			this.heapPending = false;
		}
		if (performance.now() - this.lastProgress >= PROFILE_LIMITS.heapIntervalMs) {
			this.lastProgress = performance.now();
			this.emit({
				kind: "progress",
				profileId: this.request?.profileId ?? "",
				elapsedMs,
				heapPoints: this.heapTrend.length,
				traceUsage: this.traceUsage,
			});
		}
	}

	private clearTimers(): void {
		clearInterval(this.heapTimer);
		clearTimeout(this.durationTimer);
		this.heapTimer = undefined;
		this.durationTimer = undefined;
	}

	private async endTracing(): Promise<TraceComplete> {
		if (!this.tracingStarted) throw new MemoryProfileError("trace_start");
		if (!this.tracingEndSent) {
			this.tracingEndSent = true;
			await this.send("Tracing.end");
		}
		return this.traceDone;
	}

	private async finalize(opts: MemoryProfileRequest): Promise<{
		summary: MemoryProfileSummary;
		artifacts: MemoryProfileArtifact[];
	}> {
		const signal = this.controller.signal;
		const endedAt = new Date().toISOString();
		const durationMs = Math.max(0, Math.round(performance.now() - this.startedClock));
		const artifacts: MemoryProfileArtifact[] = [];
		const budget = Math.min(opts.maxArtifactsBytes, PROFILE_LIMITS.artifactBytes);
		let used = 0;
		const summary: MemoryProfileSummary = {
			status: "complete",
			browserVersion: this.browserVersion,
			mode: opts.config.mode,
			requestedConfig: {
				...opts.config,
				stackDepth: PROFILE_LIMITS.stackDepth,
				includeObjectsCollectedByMinorGC: opts.config.mode !== "gc",
				includeObjectsCollectedByMajorGC: opts.config.mode !== "gc",
			},
			startedAt: this.startedAt,
			endedAt,
			durationMs,
			stopReason: this.stopReason,
			heapTrend: this.heapTrend,
			warnings: this.warnings,
		};
		if (this.tracingStarted) {
			try {
				await this.mark("end");
			} catch {
				checkProfileAbort(signal);
				this.warn("End marker unavailable; GC scope/window may be unavailable.");
			}
		}
		// Issue both stopping commands before expensive analysis or disk IO.
		const tracing = this.tracingStarted ? this.endTracing() : undefined;
		// Attach a rejection handler immediately while allocation collection is in flight.
		const traceOutcome = tracing?.then(
			(value) => ({ value }),
			() => ({ value: undefined }),
		);
		if (this.samplingStarted) {
			try {
				const { profile } = await this.send<{ profile: Protocol.HeapProfiler.SamplingHeapProfile }>(
					"HeapProfiler.stopSampling",
				);
				this.samplingStarted = false;
				this.samplingAttempted = false;
				checkProfileAbort(signal);
				summary.allocation = (this.dependencies.analyzeAllocations ?? analyzeAllocations)(profile);
				if (summary.allocation.status === "ok" || summary.allocation.status === "incomplete") {
					const size = await writeProfileJson(
						join(opts.dir, "allocation.heapprofile"),
						profile,
						Math.min(PROFILE_LIMITS.allocationBytes, budget - used - PROFILE_LIMITS.summaryBytes),
						signal,
					);
					artifacts.push({ kind: "allocation", filename: "allocation.heapprofile", size });
					used += size;
				}
			} catch {
				checkProfileAbort(signal);
				summary.allocation = failedAllocationSummary();
				this.warn("Allocation component failed or exceeded its resource budget.");
				await rm(join(opts.dir, "allocation.heapprofile"), { force: true });
			}
		}
		if (this.tracingStarted) {
			const rawPath = join(opts.dir, "raw.trace.json");
			try {
				const complete = (await traceOutcome)?.value;
				checkProfileAbort(signal);
				if (!complete?.stream) throw new MemoryProfileError("trace_stop");
				await downloadProfileTrace(
					{
						read: (handle, size) => this.send("IO.read", { handle, size }),
						close: (handle) => this.send("IO.close", { handle }),
					},
					complete.stream,
					rawPath,
					Math.min(
						PROFILE_LIMITS.traceBytes,
						opts.maxArtifactsBytes,
						PROFILE_LIMITS.tempBytes - used,
					),
					signal,
				);
				checkProfileAbort(signal);
				summary.gc = await (this.dependencies.analyzeGcTrace ?? analyzeGcTrace)({
					inputPath: rawPath,
					outputPath: join(opts.dir, "gc.trace.json"),
					startMarker: `${this.marker}-start`,
					endMarker: `${this.marker}-end`,
					dataLossOccurred: complete.dataLossOccurred === true,
					bufferLimited: this.bufferLimited,
					maxOutputBytes: Math.min(
						PROFILE_LIMITS.traceBytes,
						budget - used - PROFILE_LIMITS.summaryBytes,
					),
					signal,
				});
				checkProfileAbort(signal);
				if (summary.gc.status === "ok" || summary.gc.status === "incomplete") {
					const size = await profileFileSize(join(opts.dir, "gc.trace.json"));
					if (
						size > Math.min(PROFILE_LIMITS.traceBytes, budget - used - PROFILE_LIMITS.summaryBytes)
					) {
						throw new MemoryProfileError("artifact_limit");
					}
					artifacts.push({ kind: "gc", filename: "gc.trace.json", size });
					used += size;
				}
			} catch {
				checkProfileAbort(signal);
				summary.gc = failedGcSummary();
				this.warn("GC component failed or exceeded its resource budget.");
				await rm(join(opts.dir, "gc.trace.json"), { force: true });
			} finally {
				await rm(rawPath, { force: true });
			}
		}
		if (summary.allocation?.status !== undefined && summary.allocation.status !== "ok") {
			summary.status = "partial";
		}
		if (summary.gc?.status !== undefined && summary.gc.status !== "ok") summary.status = "partial";
		if (!this.traceStopped) {
			summary.status = "partial";
			this.warn(
				"Browser trace stop was not confirmed during finalization; GC output may be unavailable.",
			);
		}
		const resultEnvelopeBytes = Buffer.byteLength(
			JSON.stringify({
				kind: "result",
				profileId: opts.profileId,
				traceStopped: false,
				summary: null,
				artifacts: [
					...artifacts,
					{ kind: "summary", filename: "summary.json", size: PROFILE_LIMITS.summaryBytes },
				],
			}),
		);
		const bounded = boundProfileSummary(summary, PROFILE_LIMITS.summaryBytes - resultEnvelopeBytes);
		const summarySize = await writeProfileJson(
			join(opts.dir, "summary.json"),
			bounded,
			Math.min(PROFILE_LIMITS.summaryBytes, budget - used),
			signal,
		);
		artifacts.push({ kind: "summary", filename: "summary.json", size: summarySize });
		return { summary: bounded, artifacts };
	}

	private async cleanup(discard: boolean): Promise<void> {
		this.clearTimers();
		// One total cleanup budget, not a fresh 5 seconds for each subsystem.
		await profileDeadline(
			async () => {
				await profileDeadline(
					() =>
						Promise.allSettled([
							this.tracingStarted && !this.traceStopped ? this.endTracing() : Promise.resolve(),
							this.samplingAttempted
								? this.send(
										"HeapProfiler.stopSampling",
										undefined,
										PROFILE_LIMITS.cleanupTimeoutMs / 2,
									)
								: Promise.resolve(),
						]),
					PROFILE_LIMITS.cleanupTimeoutMs / 2,
					"cleanup",
				).catch(() => {});
				if (this.traceComplete?.stream) {
					void this.send(
						"IO.close",
						{ handle: this.traceComplete.stream },
						PROFILE_LIMITS.cleanupTimeoutMs / 2,
					).catch(() => {});
				}
				for (const [event, listener] of this.listeners)
					this.connection?.session.off(event, listener);
				// Disconnect must not be queued behind a hanging detach.
				await Promise.allSettled([
					this.connection?.session.detach() ?? Promise.resolve(),
					this.connection?.disconnect() ?? Promise.resolve(),
					discard && this.request ? removeProfileFiles(this.request.dir) : Promise.resolve(),
				]);
			},
			PROFILE_LIMITS.cleanupTimeoutMs,
			"cleanup",
		).catch(() => {});
	}

	private async run(opts: MemoryProfileRequest): Promise<void> {
		let result: Awaited<ReturnType<MemoryProfileRecorder["finalize"]>> | undefined;
		let failedStage = "start";
		try {
			if (
				!opts.profileId ||
				!Number.isFinite(opts.maxArtifactsBytes) ||
				opts.maxArtifactsBytes < PROFILE_LIMITS.summaryBytes ||
				!["allocation", "gc", "both"].includes(opts.config.mode) ||
				opts.config.durationMs < PROFILE_LIMITS.minDurationMs ||
				opts.config.durationMs > PROFILE_LIMITS.maxDurationMs ||
				!Number.isFinite(opts.config.durationMs) ||
				opts.config.samplingIntervalBytes < PROFILE_LIMITS.minSamplingIntervalBytes ||
				opts.config.samplingIntervalBytes > PROFILE_LIMITS.maxSamplingIntervalBytes ||
				!Number.isFinite(opts.config.samplingIntervalBytes)
			)
				throw new MemoryProfileError("config");
			await profileDeadline(
				() => this.start(opts),
				PROFILE_LIMITS.startTimeoutMs,
				"start_timeout",
				this.controller.signal,
			);
			await this.stopped;
			checkProfileAbort(this.controller.signal);
			this.clearTimers();
			this.phase = "finalizing";
			this.emit({ kind: "finalizing", profileId: opts.profileId, stopReason: this.stopReason });
			failedStage = "finalize";
			result = await profileDeadline(
				() => this.finalize(opts),
				PROFILE_LIMITS.stopTimeoutMs,
				"finalize_timeout",
				this.controller.signal,
			);
		} catch (error) {
			failedStage =
				this.connection?.failureStage?.() ??
				(this.controller.signal.aborted
					? this.cancelStage
					: error instanceof MemoryProfileError
						? error.stage
						: failedStage);
		} finally {
			const cancelled = this.controller.signal.aborted;
			this.phase = "done";
			// Prevent late CDP/file completions from producing recording/results after a timeout.
			this.controller.abort();
			await this.cleanup(!result || cancelled);
			if (result && !cancelled) {
				this.emit({
					kind: "result",
					profileId: opts.profileId,
					...result,
					traceStopped: this.traceStopped,
				});
			} else {
				this.emit({
					kind: cancelled ? "cancelled" : "failed",
					profileId: opts.profileId,
					stage: failedStage,
					traceStopped: this.traceStopped,
					...(!cancelled && failedStage === "trace_capability" && this.failureDiagnostic
						? { diagnostic: this.failureDiagnostic }
						: {}),
				});
			}
		}
	}
}

/** Preserve every summary field, bounding strings rather than silently dropping evidence. */
export function boundProfileSummary(
	summary: MemoryProfileSummary,
	maxBytes: number = PROFILE_LIMITS.summaryBytes,
): MemoryProfileSummary {
	const shorten = (value: unknown, maxChars: number): unknown => {
		if (typeof value === "string")
			return value.length > maxChars ? `${value.slice(0, maxChars - 12)}…[truncated]` : value;
		if (Array.isArray(value)) return value.map((item) => shorten(item, maxChars));
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, shorten(item, maxChars)]),
			);
		}
		return value;
	};
	for (const maxChars of [
		PROFILE_LIMITS.functionChars,
		PROFILE_LIMITS.functionChars / 2,
		PROFILE_LIMITS.functionChars / 4,
	]) {
		const bounded = shorten(summary, maxChars) as MemoryProfileSummary;
		if (Buffer.byteLength(JSON.stringify(bounded)) < maxBytes) return bounded;
	}
	throw new MemoryProfileError("summary_limit");
}

if (parentPort) {
	const port = parentPort;
	const recorder = new MemoryProfileRecorder((reply) => port.postMessage(reply));
	port.on("message", (command: MemoryProfileWorkerCommand) => {
		const task = recorder.command(command);
		if (task) void task.finally(() => port.close());
	});
	port.on("close", () => recorder.cancel("parent_disconnected"));
	port.postMessage({ kind: "ready" } satisfies MemoryProfileWorkerReply);
}
