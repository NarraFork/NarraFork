import { type Profiler, Session } from "node:inspector";
import { AppError, ValidationError } from "../lib/errors";

export const DEFAULT_CPU_PROFILE_DURATION_MS = 15_000;
export const MAX_CPU_PROFILE_DURATION_MS = 2_147_483_647;

/** Owns only the inspector session and recording started by this service. */
export class CpuProfiler {
	private active?: { controller: AbortController; completion: Promise<Profiler.Profile> };
	private closing = false;
	private readonly startupCpuProfileConflict =
		Bun.version === "1.4.3" &&
		(process.execArgv.includes("--cpu-prof") ||
			((process.env.BUN_OPTIONS ?? "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).some(
				(option) =>
					option === "--cpu-prof" || option === '"--cpu-prof"' || option === "'--cpu-prof'",
			));

	constructor(private readonly createSession: () => Session = () => new Session()) {}

	async capture(
		durationMs = DEFAULT_CPU_PROFILE_DURATION_MS,
		signal?: AbortSignal,
	): Promise<Profiler.Profile> {
		if (
			!Number.isInteger(durationMs) ||
			durationMs <= 0 ||
			durationMs > MAX_CPU_PROFILE_DURATION_MS
		) {
			throw new ValidationError(
				`durationMs must be a positive integer no greater than ${MAX_CPU_PROFILE_DURATION_MS}`,
			);
		}
		if (this.closing) {
			throw new AppError("CPU profiler is shutting down", 503, "CPU_PROFILER_SHUTDOWN");
		}
		if (this.active) {
			throw new AppError("A CPU profile is already being recorded", 409, "CPU_PROFILER_BUSY");
		}
		// Bun 1.4.3 rejects this combination, and even disconnecting an unused inspector
		// session clears the CLI recording. Check startup options before creating a session.
		if (this.startupCpuProfileConflict) {
			throw new AppError(
				"Bun 1.4.3 cannot combine online CPU profiling with startup --cpu-prof. " +
					"To use this endpoint, set NARRAFORK_CPU_PROFILE=0 on the next startup.",
				503,
				"CPU_PROFILE_CONFLICT",
			);
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort(new DOMException("Request aborted", "AbortError"));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		const completion = this.record(durationMs, controller.signal);
		const active = { controller, completion };
		this.active = active;
		try {
			return await completion;
		} catch (error) {
			if (controller.signal.aborted) throw controller.signal.reason;
			throw new AppError(
				`CPU profiling unavailable: ${error instanceof Error ? error.message : String(error)}`,
				503,
				"CPU_PROFILER_UNAVAILABLE",
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.active === active) this.active = undefined;
		}
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const active = this.active;
		if (!active) return;
		active.controller.abort(
			new AppError("CPU profiler is shutting down", 503, "CPU_PROFILER_SHUTDOWN"),
		);
		await active.completion.catch(() => {});
	}

	private async record(durationMs: number, signal: AbortSignal): Promise<Profiler.Profile> {
		signal.throwIfAborted();
		const session = this.createSession();
		let started = false;
		let stopPosted = false;
		const post = <T>(method: string, params: object = {}, onSuccess?: () => void): Promise<T> =>
			new Promise((resolve, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					reject(signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					// Cleanup must still dispatch stop when cancellation has already happened.
					session.post(method, params, (error, result) => {
						signal.removeEventListener("abort", onAbort);
						if (error) reject(new Error(`${method}: ${error.message}`));
						else {
							onSuccess?.();
							resolve(result as T);
						}
					});
					if (signal.aborted) onAbort();
				} catch (error) {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				}
			});
		try {
			session.connect();
			await post("Profiler.enable");
			signal.throwIfAborted();
			// An existing CLI recording rejects this call; never stop a recording we did not start.
			await post("Profiler.setSamplingInterval", { interval: 10_000 });
			signal.throwIfAborted();
			await post("Profiler.start", {}, () => {
				started = true;
			});
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, durationMs);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			signal.throwIfAborted();
			stopPosted = true;
			const { profile } = await post<Profiler.StopReturnType>("Profiler.stop");
			return profile;
		} finally {
			try {
				if (started && !stopPosted) await post("Profiler.stop");
			} finally {
				// Also releases pending native commands if a client cancels before their callback.
				session.disconnect();
			}
		}
	}
}

export const cpuProfiler = new CpuProfiler();
