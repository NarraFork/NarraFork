import { type SafeSpawnResult, safeSpawn } from "../lib/spawn";

export interface PluginProcessRunnerOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
	killProcessTree?: boolean;
}

export interface PluginProcessResult extends SafeSpawnResult {
	command: string[];
	durationMs: number;
	cancelled: boolean;
	timedOut: boolean;
}

/** Runs a fixed argv array with bounded output and a hard cancellation deadline. */
export class PluginProcessRunner {
	async run(
		command: readonly string[],
		options: PluginProcessRunnerOptions = {},
	): Promise<PluginProcessResult> {
		if (
			command.length === 0 ||
			command.some((part) => typeof part !== "string" || part.length === 0)
		) {
			throw new Error("Plugin process command must be a non-empty argument array");
		}
		const startedAt = Date.now();
		let cancelled = Boolean(options.signal?.aborted);
		let timedOut = false;
		const signal = options.signal;
		const abortListener = () => {
			cancelled = true;
		};
		if (signal) signal.addEventListener("abort", abortListener, { once: true });
		try {
			const result = await safeSpawn({
				cmd: [...command],
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeoutMs,
				signal,
				maxOutputBytes: options.maxOutputBytes,
				killProcessTree: options.killProcessTree ?? true,
			});
			timedOut = options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs;
			return {
				...result,
				command: [...command],
				durationMs: Date.now() - startedAt,
				cancelled,
				timedOut,
			};
		} finally {
			signal?.removeEventListener("abort", abortListener);
		}
	}
}

export const pluginProcessRunner = new PluginProcessRunner();
