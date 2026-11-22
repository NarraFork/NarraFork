import { type Profiler, Session, url } from "node:inspector";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";

export const DEFAULT_CPU_PROFILE_DURATION_MS = 15_000;
export const MAX_CPU_PROFILE_DURATION_MS = 30_000;

function startupInspectorInUse(): boolean {
	if (process.env.BUN_INSPECT_CONNECT_TO) return true;
	const envOptions = (process.env.BUN_OPTIONS ?? "").split(/\s+/);
	// Bun's inspector.url() does not report listeners started by its CLI.
	return [...process.execArgv, ...envOptions].some((arg) =>
		/^--(?:cpu-prof(?:-md)?$|inspect(?:-brk|-wait)?(?:=|$))/.test(arg.replace(/['"]/g, "")),
	);
}

function unavailable() {
	return new AppError("CPU profiling is unavailable", 503, "CPU_PROFILER_UNAVAILABLE");
}

function busy() {
	return new AppError("A CPU profile is already being recorded", 409, "CPU_PROFILER_BUSY");
}

function shuttingDown() {
	return new AppError("CPU profiling is shutting down", 503, "CPU_PROFILER_SHUTDOWN");
}

function post<T>(session: Session, method: string, params: object = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(unavailable()), 2_000);
		try {
			session.post(method, params, (error, result) => {
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(result as T);
			});
		} catch (error) {
			clearTimeout(timer);
			reject(error);
		}
	});
}

export class CpuProfiler {
	private active?: { controller: AbortController; completion: Promise<Profiler.Profile> };
	private probe?: Session;
	private closing = false;
	private readonly startupInspectorInUse = startupInspectorInUse();

	async capture(
		durationMs = DEFAULT_CPU_PROFILE_DURATION_MS,
		signal?: AbortSignal,
	): Promise<Profiler.Profile> {
		if (
			!Number.isInteger(durationMs) ||
			durationMs < 1 ||
			durationMs > MAX_CPU_PROFILE_DURATION_MS
		) {
			throw new ValidationError("Invalid CPU profile duration");
		}
		if (this.closing) throw shuttingDown();
		if (this.active) throw busy();
		// Never connect to the inspector when CLI sampling or a debugger may own it.
		if (this.startupInspectorInUse || url()) throw unavailable();
		const controller = new AbortController();
		const captureSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		const completion = this.record(durationMs, captureSignal);
		this.active = { controller, completion };
		try {
			return await completion;
		} finally {
			this.active = undefined;
		}
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const active = this.active;
		if (!active) return;
		active.controller.abort(shuttingDown());
		await active.completion.catch(() => {});
	}

	private async record(durationMs: number, signal: AbortSignal): Promise<Profiler.Profile> {
		signal.throwIfAborted();
		try {
			if (!this.probe) {
				const session = new Session();
				session.connect();
				this.probe = session;
			}
			const session = this.probe;
			await post(session, "Profiler.enable");
			try {
				await post(session, "Profiler.setSamplingInterval", { interval: 10_000 });
			} catch (error) {
				// Bun 1.4.3 shares the sampler between sessions. Even disconnecting
				// a probe would stop foreign sampling, so reuse this one probe on retries.
				if (error instanceof Error && error.message.includes("while profiler is running")) {
					throw busy();
				}
				throw unavailable();
			}
			signal.throwIfAborted();
			try {
				await post(session, "Profiler.start");
				this.probe = undefined;
				let result: Profiler.StopReturnType;
				try {
					await delay(durationMs, undefined, { signal });
				} finally {
					result = await post<Profiler.StopReturnType>(session, "Profiler.stop");
				}
				signal.throwIfAborted();
				if (!result.profile?.nodes?.length) throw unavailable();
				return result.profile;
			} finally {
				if (!this.probe) session.disconnect();
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof AppError) throw error;
			throw unavailable();
		}
	}
}

export const cpuProfiler = hotSafe("narrafork.cpu-profiler", () => new CpuProfiler());
