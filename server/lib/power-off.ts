/**
 * OS-level power-off for unattended mode.
 *
 * Deliberately tiny and injectable: this module never decides WHEN the machine should go
 * down — it only answers "what command would do it here" and "did issuing it work". The
 * unattended watcher owns the policy (see `services/unattended-mode.ts`), and the shutdown
 * hook owns the moment (after `performGracefulShutdown` has finished, see `main.ts`).
 *
 * Command resolution uses an ABSOLUTE interpreter path on Windows. The server may inherit a
 * PATH that contains a Git-Bash/MSYS `shutdown` shim, and a shim that silently swallows the
 * request would look exactly like a power-off that never happened.
 */

import { logger } from "./logger";

/** What this platform can run, in the order it should be tried. */
export interface PowerOffPlan {
	supported: boolean;
	candidates: string[][];
	/** Machine-readable reason when nothing can be run (e.g. "unsupported-platform"). */
	note?: string;
}

/** A spawned process: only the two things the caller needs. */
export type PowerOffSpawn = (command: string[]) => {
	exited: Promise<number>;
	kill: () => void;
	unref?: () => void;
};

export interface RunPowerOffDeps {
	platform?: NodeJS.Platform;
	spawn?: PowerOffSpawn;
	/** Overall budget, including unsuccessful candidates and reaping. */
	timeoutMs?: number;
}

export interface PowerOffAttempt {
	command: string[];
	code?: number;
	error?: string;
}

export interface RunPowerOffResult {
	ok: boolean;
	command?: string[];
	attempts: PowerOffAttempt[];
	error?: string;
	/** True when this platform (or the configured custom command) has no runnable command. */
	unsupported?: boolean;
	note?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * A custom command is executed through the platform shell, so it is the one place where a
 * raw string reaches a process. Newlines and NUL are refused: the schema already rejects a
 * multi-line value, and this is the second gate in case a future caller bypasses it.
 */
function customCommandIsUsable(custom: string): boolean {
	const trimmed = custom.trim();
	if (trimmed.length === 0 || trimmed.length > 500) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them IS the check
	return !/[\u0000-\u001f\u007f]/.test(trimmed);
}

function windowsShutdownPath(): string {
	const root = process.env.SystemRoot?.trim() || "C:\\Windows";
	return `${root.replace(/[\\/]+$/, "")}\\System32\\shutdown.exe`;
}

/**
 * Resolve the command list for a platform. Pure apart from reading `SystemRoot` on Windows,
 * so tests pin the three platforms without touching a real host.
 */
export function resolvePowerOffPlan(
	platform: NodeJS.Platform = process.platform,
	custom: string | null = null,
): PowerOffPlan {
	const trimmedCustom = custom?.trim();
	if (trimmedCustom) {
		if (!customCommandIsUsable(trimmedCustom)) {
			return { supported: false, candidates: [], note: "invalid-custom-command" };
		}
		return {
			supported: true,
			candidates: [
				platform === "win32" ? ["cmd.exe", "/c", trimmedCustom] : ["/bin/sh", "-c", trimmedCustom],
			],
		};
	}
	if (platform === "win32") {
		return {
			supported: true,
			candidates: [[windowsShutdownPath(), "/s", "/t", "0"]],
		};
	}
	if (platform === "darwin") {
		return {
			supported: true,
			candidates: [["osascript", "-e", 'tell application "System Events" to shut down']],
		};
	}
	if (platform === "linux") {
		return {
			supported: true,
			candidates: [
				["systemctl", "poweroff"],
				["shutdown", "-h", "now"],
			],
		};
	}
	return { supported: false, candidates: [], note: "unsupported-platform" };
}

const defaultSpawn: PowerOffSpawn = (command) => {
	const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
	return {
		exited: child.exited,
		kill: () => child.kill("SIGKILL"),
		unref: () => {
			try {
				child.unref();
			} catch {
				// An already-reaped child cannot be unrereferenced, and that is not a failure.
			}
		},
	};
};

async function exitWithin(exited: Promise<number>, timeoutMs: number): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			exited,
			new Promise<number>((resolve) => {
				timer = setTimeout(() => resolve(-1), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Issue the power-off command, trying the platform's candidates in order.
 *
 * Never throws: the caller is inside a shutdown hook whose only job is to leave a diagnostic
 * before the process exits.
 */
export async function runPowerOff(
	options: { custom?: string | null } = {},
	deps: RunPowerOffDeps = {},
): Promise<RunPowerOffResult> {
	const platform = deps.platform ?? process.platform;
	const spawn = deps.spawn ?? defaultSpawn;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const plan = resolvePowerOffPlan(platform, options.custom ?? null);
	if (!plan.supported) {
		return { ok: false, attempts: [], unsupported: true, note: plan.note };
	}
	const attempts: PowerOffAttempt[] = [];
	const deadline = performance.now() + timeoutMs;
	for (const [index, command] of plan.candidates.entries()) {
		const startedAt = performance.now();
		const remaining = deadline - startedAt;
		if (remaining <= 0) break;
		const budget = remaining / (plan.candidates.length - index);
		const attemptDeadline = startedAt + budget;
		try {
			const child = spawn(command);
			const code = await exitWithin(
				child.exited,
				Math.max(0, attemptDeadline - budget * 0.2 - performance.now()),
			);
			attempts.push({ command, code });
			if (code === -1) {
				try {
					child.kill();
					const reaped = await exitWithin(
						child.exited,
						Math.max(0, attemptDeadline - performance.now()),
					);
					if (reaped === -1) break;
				} catch {
					break;
				} finally {
					child.unref?.();
				}
			}
			if (code === 0) {
				child.unref?.();
				return { ok: true, command, attempts };
			}
		} catch (error) {
			attempts.push({ command, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const last = attempts[attempts.length - 1];
	const result: RunPowerOffResult = {
		ok: false,
		attempts,
		error:
			last?.error ?? (last?.code === -1 ? "timed out" : `exit code ${last?.code ?? "unknown"}`),
	};
	try {
		logger.warn("Power-off command failed", {
			platform,
			attempts: attempts.length,
			error: result.error,
		});
	} catch {
		// Diagnostics must not turn a failed power-off into a throw.
	}
	return result;
}
