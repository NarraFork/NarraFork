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
 *
 * On Windows the priority is:
 *   1. Git Bash (from Git for Windows / MSYS2) — NOT WSL bash
 *   2. PowerShell (pwsh or powershell.exe)
 *   3. cmd.exe (last resort)
 */
let _cachedShellInfo: ShellInfo | undefined;
export function detectShell(): ShellInfo {
	if (_cachedShellInfo) return _cachedShellInfo;

	let shellPath: string | undefined;
	const extraEnv: Record<string, string> = {};
	let loginWrap = false;

	if (process.platform === "win32") {
		shellPath = findGitBash() ?? Bun.which("pwsh") ?? "powershell.exe";
		if (isGitBash(shellPath)) {
			loginWrap = true;
			extraEnv.MSYS2_PATH_TYPE = "inherit";
		}
	} else {
		const env = process.env.SHELL;
		if (env) {
			const name = path.basename(env);
			if (!SHELL_BLACKLIST.has(name)) {
				shellPath = env;
			}
		}
		if (!shellPath) {
			if (process.platform === "darwin") {
				shellPath = "/bin/zsh";
			} else {
				shellPath = Bun.which("bash") ?? "/bin/sh";
			}
		}
	}

	_cachedShellInfo = { path: shellPath, extraEnv, loginWrap };
	return _cachedShellInfo;
}

// ── Windows Git Bash detection ───────────────────────────────────────────────

/**
 * Locate Git Bash's bash.exe on Windows, carefully avoiding WSL's bash.exe.
 *
 * WSL's bash lives at `C:\Windows\System32\bash.exe` (or SysWOW64).
 * Git Bash lives under the Git for Windows install dir, e.g.
 *   `C:\Program Files\Git\bin\bash.exe`
 *   `C:\Program Files\Git\usr\bin\bash.exe`
 *
 * We check well-known install locations first, then fall back to
 * `Bun.which("bash")` but reject anything under System32/SysWOW64.
 */
function findGitBash(): string | undefined {
	const { existsSync } = require("node:fs") as typeof import("node:fs");

	// Well-known Git for Windows install paths
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA ?? "";

	const candidates = [
		path.join(programFiles, "Git", "bin", "bash.exe"),
		path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
		path.join(programFilesX86, "Git", "bin", "bash.exe"),
		path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
		...(localAppData
			? [
					path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
					path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
				]
			: []),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	// Fallback: Bun.which("bash") but reject WSL bash
	const found = Bun.which("bash");
	if (found && !isWslBash(found)) return found;

	return undefined;
}

/** Check whether a bash path is WSL's bash (System32/SysWOW64). */
function isWslBash(bashPath: string): boolean {
	const lower = bashPath.toLowerCase().replace(/\\/g, "/");
	return lower.includes("/system32/") || lower.includes("/syswow64/");
}

/** Check whether a shell path points to Git Bash / MSYS2 bash. */
function isGitBash(shellPath: string): boolean {
	const lower = shellPath.toLowerCase().replace(/\\/g, "/");
	return (
		(lower.endsWith("/bash.exe") || lower.endsWith("/bash")) &&
		(lower.includes("/git/") || lower.includes("/msys")) &&
		!isWslBash(shellPath)
	);
}

/**
 * @deprecated Use `detectShell().path` instead. Kept for backward compat.
 */
export function detectShellPath(): string {
	return detectShell().path;
}
