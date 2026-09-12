import { createHash } from "node:crypto";
import { createSandboxBootstrap } from "./bootstrap";
import { createGateway, type GatewayOptions } from "./gateway";
import {
	errorShape,
	PROGRAMMATIC_LIMITS,
	ProgrammaticError,
	parseChildFrame,
	type RunBudgets,
	type SandboxResult,
	type StartFrame,
} from "./protocol";
import type { CleanupReport, IsolationDriver, SandboxSession } from "./sandbox";

export interface ExecutionOptions
	extends Pick<GatewayOptions, "identity" | "receivers" | "authorize" | "audit"> {
	source: string;
	signal: AbortSignal;
	wallMs?: number;
}
export interface ExecutionResult {
	runId: string;
	ok: boolean;
	result?: SandboxResult;
	error?: ReturnType<typeof errorShape>;
	cleanup: CleanupReport;
	resourcesReleased: boolean;
	stats: {
		calls: number;
		requestBytes: number;
		responseBytes: number;
		durationMs: number;
		sourceHash: string;
	};
}
export interface ServiceOptions {
	driver: IsolationDriver;
	maxConcurrent?: number;
	maxPerUser?: number;
	maxPerTeam?: number;
	/** Metadata only; never receives source, tool arguments, or result bodies. */
	onSlowOperation?: (event: { runId: string; phase: string; elapsedMs: number }) => void;
}

/** Not registered as an agent tool: callers must provide real authorization and audit sinks. */
export function createProgrammaticService(options: ServiceOptions) {
	const driver = options.driver;
	if (!driver || driver.policy.kind !== "podman")
		throw new ProgrammaticError("ISOLATION_REQUIRED", "A qualified isolation driver is required");
	const capacities = {
		total: options.maxConcurrent ?? 2,
		user: options.maxPerUser ?? 1,
		team: options.maxPerTeam ?? 1,
	};
	for (const value of Object.values(capacities))
		if (!Number.isInteger(value) || value < 1 || value > 16)
			throw new ProgrammaticError("CONFIG", "Concurrency capacities must be in 1..16");
	const active = new Map<string, { user: string; team?: string }>();
	const bootstrap = createSandboxBootstrap();
	function checkAbort(signal: AbortSignal) {
		if (signal.aborted) throw new ProgrammaticError("CANCELLED", "Execution was cancelled");
	}
	async function execute(input: ExecutionOptions): Promise<ExecutionResult> {
		checkAbort(input.signal);
		if (
			typeof input.source !== "string" ||
			Buffer.byteLength(input.source) > PROGRAMMATIC_LIMITS.sourceBytes
		)
			throw new ProgrammaticError("SOURCE_LIMIT", "Source exceeds 64 KiB");
		const wallMs = input.wallMs ?? PROGRAMMATIC_LIMITS.wallMs;
		if (!Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > PROGRAMMATIC_LIMITS.maxWallMs)
			throw new ProgrammaticError("CONFIG", "Invalid wall deadline");
		const budgets: RunBudgets = {
			requestBytes: PROGRAMMATIC_LIMITS.requestBytes,
			responseBytes: PROGRAMMATIC_LIMITS.responseBytes,
			transferBytes: PROGRAMMATIC_LIMITS.transferBytes,
			maxCalls: PROGRAMMATIC_LIMITS.maxCalls,
			wallMs,
			resultBytes: PROGRAMMATIC_LIMITS.resultBytes,
			maxLogs: PROGRAMMATIC_LIMITS.maxLogs,
			logBytes: PROGRAMMATIC_LIMITS.logBytes,
			summaryChars: PROGRAMMATIC_LIMITS.summaryChars,
		};
		const controller = new AbortController();
		const started = Date.now();
		const deadlineAt = started + wallMs;
		const gateway = createGateway({ ...input, budgets, signal: controller.signal, deadlineAt });
		const identity = Object.freeze({ ...input.identity });
		const existing = [...active.values()];
		if (
			active.has(identity.runId) ||
			active.size >= capacities.total ||
			existing.filter((r) => r.user === identity.actorUserId).length >= capacities.user ||
			(identity.teamId &&
				existing.filter((r) => r.team === identity.teamId).length >= capacities.team)
		) {
			gateway.close();
			throw new ProgrammaticError(
				"CAPACITY",
				"Execution capacity is occupied; no unbounded queue is created",
			);
		}
		active.set(identity.runId, { user: identity.actorUserId, team: identity.teamId });
		let stopReason: ProgrammaticError | undefined;
		let rejectStop: (error: ProgrammaticError) => void = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			rejectStop = reject;
		});
		void stopped.catch(() => {});
		const stop = (reason: ProgrammaticError) => {
			if (stopReason) return;
			stopReason = reason;
			controller.abort();
			gateway.close();
			rejectStop(reason);
		};
		const onAbort = () => stop(new ProgrammaticError("CANCELLED", "Execution cancelled by caller"));
		input.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() => stop(new ProgrammaticError("DEADLINE", "Execution exceeded its wall deadline")),
			wallMs,
		);
		if (input.signal.aborted) onAbort();
		const guarded = <T>(promise: Promise<T>) => Promise.race([promise, stopped]);
		let session: SandboxSession | undefined;
		let launch: Promise<SandboxSession> | undefined;
		let readiness: Promise<void> | undefined;
		let pump: Promise<void> | undefined;
		let inFlight: Promise<void> | undefined;
		let result: SandboxResult | undefined;
		let error: ReturnType<typeof errorShape> | undefined;
		let cleanup: CleanupReport = { confirmed: true, exitCode: null };
		let cleanupPromise: Promise<CleanupReport> | undefined;
		let ready = false;
		let sourceSent = false;
		let resultSeen = false;
		let incomingBytes = 0;
		let resolveReady: () => void = () => {};
		const readyPromise = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		let resolveResult: (result: SandboxResult) => void = () => {};
		const resultPromise = new Promise<SandboxResult>((resolve) => {
			resolveResult = resolve;
		});
		function terminate(): Promise<CleanupReport> {
			cleanupPromise ??= (async () => {
				try {
					const target = session ?? (launch ? await launch.catch(() => undefined) : undefined);
					return target ? await target.terminate() : { confirmed: true, exitCode: null };
				} catch {
					return {
						confirmed: false,
						exitCode: null,
						message: "Isolated resource cleanup could not be confirmed",
					};
				}
			})();
			return cleanupPromise;
		}
		try {
			readiness = driver.checkAvailable(controller.signal);
			await guarded(readiness);
			launch = driver.launch({
				runId: identity.runId,
				bootstrap,
				wallMs: Math.max(1, deadlineAt - Date.now()),
				signal: controller.signal,
			});
			session = await guarded(launch);
			pump = (async () => {
				try {
					if (!session) throw new ProgrammaticError("PROTOCOL", "Missing isolated session");
					for await (const text of session.frames) {
						if (controller.signal.aborted) break;
						incomingBytes += Buffer.byteLength(text);
						if (incomingBytes > budgets.transferBytes)
							throw new ProgrammaticError("TRANSFER_LIMIT", "Wire transfer budget exceeded");
						const frame = parseChildFrame(text);
						if (resultSeen) throw new ProgrammaticError("PROTOCOL", "Frame after terminal result");
						if (frame.type === "ready") {
							if (ready || sourceSent)
								throw new ProgrammaticError("PROTOCOL", "Duplicate isolation handshake");
							const { probe } = frame,
								policy = session.policy;
							if (
								probe.uid !== policy.uid ||
								probe.uid === 0 ||
								probe.memoryBytes > policy.memoryBytes ||
								probe.pids > policy.maxPids ||
								probe.cpuQuota / probe.cpuPeriod > policy.cpuCores
							)
								throw new ProgrammaticError(
									"ISOLATION_REQUIRED",
									"Runtime resource limits do not match required isolation",
								);
							ready = true;
							resolveReady();
							continue;
						}
						if (!ready || !sourceSent)
							throw new ProgrammaticError("PROTOCOL", "Unsolicited frame before source admission");
						if (inFlight)
							throw new ProgrammaticError("PROTOCOL", "Concurrent request or premature result");
						if (frame.type === "result") {
							resultSeen = true;
							resolveResult(frame);
							continue;
						}
						const callStarted = Date.now();
						inFlight = (async () => {
							try {
								const response = await gateway.dispatch(frame);
								if (controller.signal.aborted) return;
								await session.send(JSON.stringify(response));
								if (!response.ok && response.error.fatal)
									stop(new ProgrammaticError(response.error.code, response.error.message));
							} catch (caught) {
								stop(
									caught instanceof ProgrammaticError
										? caught
										: new ProgrammaticError("HOST_ERROR", "Host dispatch failed"),
								);
							} finally {
								inFlight = undefined;
								const elapsedMs = Date.now() - callStarted;
								if (elapsedMs > 1000)
									try {
										options.onSlowOperation?.({
											runId: identity.runId,
											phase: "host-call",
											elapsedMs,
										});
									} catch {
										/* Observability cannot alter execution. */
									}
							}
						})();
					}
					if (!resultSeen && !controller.signal.aborted)
						throw new ProgrammaticError(
							"TRANSPORT_CLOSED",
							"Sandbox ended without a terminal result",
						);
				} catch (caught) {
					stop(
						caught instanceof ProgrammaticError
							? caught
							: new ProgrammaticError("TRANSPORT", "Sandbox transport failed"),
					);
				}
			})();
			let readyTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await guarded(
					Promise.race([
						readyPromise,
						new Promise<never>((_resolve, reject) => {
							readyTimer = setTimeout(
								() =>
									reject(new ProgrammaticError("STARTUP_TIMEOUT", "Isolation handshake timed out")),
								Math.min(PROGRAMMATIC_LIMITS.startupMs, wallMs),
							);
						}),
					]),
				);
			} finally {
				if (readyTimer) clearTimeout(readyTimer);
			}
			await guarded(session.verifyIsolation());
			if (controller.signal.aborted) throw stopReason;
			const start: StartFrame = {
				type: "start",
				version: 1,
				source: input.source,
				receivers: gateway.manifest,
				budgets,
			};
			const serialized = JSON.stringify(start);
			if (Buffer.byteLength(serialized) > PROGRAMMATIC_LIMITS.wireFrameBytes)
				throw new ProgrammaticError(
					"FRAME_LIMIT",
					"Source and capability manifest exceed start frame budget",
				);
			sourceSent = true;
			await guarded(session.send(serialized));
			result = await guarded(resultPromise);
			// EOF is part of the protocol: do not return success while additional frames
			// could still be delivered after the terminal frame.
			await guarded(pump);
			if (controller.signal.aborted) throw stopReason;
			const exitCode = await guarded(session.exited);
			if (exitCode !== 0)
				throw new ProgrammaticError("SANDBOX_EXIT", "Isolated runtime exited abnormally");
			if (!result.ok) error = result.error;
		} catch (caught) {
			error = errorShape(stopReason ?? caught);
			stop(
				caught instanceof ProgrammaticError
					? caught
					: new ProgrammaticError("EXECUTION_FAILED", "Execution failed"),
			);
		} finally {
			gateway.close();
			clearTimeout(timeout);
			input.signal.removeEventListener("abort", onAbort);
			// Cleanup remains bounded independently of the already-expired execution clock.
			let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				cleanup = await Promise.race([
					terminate(),
					new Promise<CleanupReport>((resolve) => {
						cleanupTimer = setTimeout(
							() =>
								resolve({
									confirmed: false,
									exitCode: null,
									message: "Cleanup still pending; capacity remains reserved",
								}),
							12000,
						);
					}),
				]);
			} finally {
				if (cleanupTimer) clearTimeout(cleanupTimer);
			}
		}
		let drained = false;
		const pendingDrain = Promise.allSettled([gateway.drained(), readiness, pump, inFlight]).then(
			() => {
				drained = true;
				if (cleanup.confirmed) active.delete(identity.runId);
			},
		);
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pendingDrain,
				new Promise<void>((resolve) => {
					drainTimer = setTimeout(resolve, 100);
				}),
			]);
		} finally {
			if (drainTimer) clearTimeout(drainTimer);
		}
		if (!drained || !cleanup.confirmed) {
			void Promise.all([pendingDrain, terminate()]).then(([, confirmed]) => {
				if (confirmed.confirmed) active.delete(identity.runId);
			});
			error ??= {
				code: "RECLAIM_PENDING",
				message: "Cleanup or host callback completion is pending; capacity remains reserved",
				fatal: true,
			};
		} else active.delete(identity.runId);
		const resourcesReleased = !active.has(identity.runId);
		return {
			runId: identity.runId,
			ok: !!result?.ok && !error && resourcesReleased,
			...(result ? { result } : {}),
			...(error ? { error } : {}),
			cleanup,
			resourcesReleased,
			stats: {
				...gateway.stats(),
				durationMs: Date.now() - started,
				sourceHash: createHash("sha256").update(input.source).digest("hex"),
			},
		};
	}
	return { execute, activeRuns: () => active.size };
}
