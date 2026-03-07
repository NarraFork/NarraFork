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

export interface ShellInfo {
	/** Path to the shell executable. */
	path: string;
	/**
	 * Extra environment variables to inject when spawning commands with this shell.
	 * For Git Bash on Windows this includes MSYS2_PATH_TYPE=inherit so that
	 * /etc/profile converts and inherits the Windows PATH.
	 */
	extraEnv: Record<string, string>;
	/**
	 * Whether to wrap the command as `bash --login -c '<command>'` instead of
	 * using Node's `shell` option.  Required for Git Bash on Windows so that
	 * /etc/profile is sourced and PATH is properly set up.
	 */
	loginWrap: boolean;
}

/**
 * Pick a shell suitable for non-interactive command execution.
 *
 * Reads $SHELL but filters out shells with incompatible syntax (fish, nu).
 * Falls back to platform-appropriate defaults. Result is cached.
 */
let _cachedShellInfo: ShellInfo | undefined;
export function detectShell(): ShellInfo {
	if (_cachedShellInfo) return _cachedShellInfo;

	let shellPath: string | undefined;
	const extraEnv: Record<string, string> = {};
	let loginWrap = false;

	const env = process.env.SHELL;
	if (env) {
		const name = path.basename(env);
		if (!SHELL_BLACKLIST.has(name)) {
			shellPath = env;
		}
	}

	if (!shellPath) {
		if (process.platform === "win32") {
			shellPath = Bun.which("bash") ?? Bun.which("sh") ?? "cmd.exe";
		} else if (process.platform === "darwin") {
			shellPath = "/bin/zsh";
		} else {
			shellPath = Bun.which("bash") ?? "/bin/sh";
		}
	}

	// Git Bash on Windows: enable login-shell wrapping so /etc/profile is
	// sourced and PATH is converted from Windows to POSIX format.
	if (process.platform === "win32" && isGitBash(shellPath)) {
		loginWrap = true;
		// Tell MSYS2/Git Bash to inherit the Windows PATH entries
		extraEnv.MSYS2_PATH_TYPE = "inherit";
	}

	_cachedShellInfo = { path: shellPath, extraEnv, loginWrap };
	return _cachedShellInfo;
}

/** Check whether a shell path points to Git Bash / MSYS2 bash. */
function isGitBash(shellPath: string): boolean {
	const lower = shellPath.toLowerCase().replace(/\\/g, "/");
	return (
		lower.endsWith("/bash.exe") ||
		lower.endsWith("/bash") ||
		lower.includes("/git/") ||
		lower.includes("/msys")
	);
}

/**
 * @deprecated Use `detectShell().path` instead. Kept for backward compat.
 */
export function detectShellPath(): string {
	return detectShell().path;
}
