import { type ChildProcess, execSync } from "node:child_process";
import path from "node:path";

const SIGKILL_DELAY_MS = 200;

/**
 * Kill a process and all its children.
 *
 * On Linux/macOS the process must have been spawned with `detached: true` so it
 * leads its own process group.  We send SIGTERM to the whole group first, wait
 * briefly, then escalate to SIGKILL if the process hasn't exited yet.
 */
export async function killTree(
	proc: ChildProcess,
	opts?: { exited?: () => boolean },
): Promise<void> {
	const pid = proc.pid;
	if (!pid || opts?.exited?.()) return;

	if (process.platform === "win32") {
		// Windows: no process-group signals; kill directly then try taskkill /T
		try {
			proc.kill();
			await Bun.sleep(SIGKILL_DELAY_MS);
			if (!opts?.exited?.()) {
				try {
					execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore", timeout: 5000 });
				} catch {
					/* best effort */
				}
			}
		} catch {
			// Process already gone
		}
		return;
	}

	try {
		// Kill the entire process group (negative pid)
		process.kill(-pid, "SIGTERM");
		await Bun.sleep(SIGKILL_DELAY_MS);
		if (!opts?.exited?.()) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	} catch {
		// Fallback: group kill failed (e.g. not a group leader), kill the process directly
		try {
			proc.kill("SIGTERM");
			await Bun.sleep(SIGKILL_DELAY_MS);
			if (!opts?.exited?.()) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		} catch {
			// Process already gone — nothing to do
		}
	}
}

const SHELL_BLACKLIST = new Set(["fish", "nu"]);

/**
 * Pick a shell suitable for non-interactive command execution.
 *
 * Reads $SHELL but filters out shells with incompatible syntax (fish, nu).
 * Falls back to platform-appropriate defaults. Result is cached.
 */
let _cachedShell: string | undefined;
export function detectShell(): string {
	if (_cachedShell) return _cachedShell;
	const env = process.env.SHELL;
	if (env) {
		const name = path.basename(env);
		if (!SHELL_BLACKLIST.has(name)) {
			_cachedShell = env;
			return env;
		}
	}
	// Platform fallbacks
	if (process.platform === "win32") {
		_cachedShell = Bun.which("bash") ?? Bun.which("sh") ?? "cmd.exe";
	} else if (process.platform === "darwin") {
		_cachedShell = "/bin/zsh";
	} else {
		_cachedShell = Bun.which("bash") ?? "/bin/sh";
	}
	return _cachedShell;
}
