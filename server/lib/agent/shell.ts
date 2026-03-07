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

export type ShellType = "bash" | "powershell" | "cmd";

export interface ShellInfo {
	/** Path to the shell executable. */
	path: string;
	/** Which kind of shell this is. */
	type: ShellType;
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
	let type: ShellType = "bash";

	if (process.platform === "win32") {
		shellPath = findGitBash();
		if (shellPath) {
			loginWrap = true;
			extraEnv.MSYS2_PATH_TYPE = "inherit";
			type = "bash";
		} else {
			shellPath = Bun.which("pwsh") ?? "powershell.exe";
			type = "powershell";
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
		type = "bash";
	}

	_cachedShellInfo = { path: shellPath, type, extraEnv, loginWrap };
	return _cachedShellInfo;
}

/** Reset the cached shell info (for testing). */
export function _resetShellCache(): void {
	_cachedShellInfo = undefined;
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
 * Detection strategy (in order):
 *   1. Well-known install paths (Program Files, LocalAppData)
 *   2. GIT_INSTALL_ROOT environment variable (set by Scoop and some installers)
 *   3. Scan all environment variables for paths containing a Git installation
 *   4. `git --exec-path` to reverse-locate the Git install directory
 *   5. `Bun.which("bash")` but reject anything under System32/SysWOW64
 */
function findGitBash(): string | undefined {
	const { existsSync } = require("node:fs") as typeof import("node:fs");

	// 1. Well-known Git for Windows install paths
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

	// 2. GIT_INSTALL_ROOT (set by Scoop, Chocolatey, and some custom installers)
	const gitInstallRoot = process.env.GIT_INSTALL_ROOT;
	if (gitInstallRoot) {
		for (const sub of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
			const p = path.join(gitInstallRoot, sub);
			if (existsSync(p)) return p;
		}
	}

	// 3. Scan all environment variables for Git installation paths.
	//    Many tools (Scoop, Chocolatey, portable Git) add Git paths to PATH or
	//    custom env vars. We look for any value containing a directory with
	//    `\Git\` and check for bash.exe inside it.
	const found = findGitBashFromEnvVars(existsSync);
	if (found) return found;

	// 4. Ask git itself where it's installed
	const fromGit = findGitBashViaGitExecPath(existsSync);
	if (fromGit) return fromGit;

	// 5. Fallback: Bun.which("bash") but reject WSL bash
	const whichBash = Bun.which("bash");
	if (whichBash && !isWslBash(whichBash)) return whichBash;

	return undefined;
}

/**
 * Scan all environment variables for paths that contain a Git installation.
 * Looks for `\Git\` in PATH-like variables and individual path values.
 */
function findGitBashFromEnvVars(existsSync: (p: string) => boolean): string | undefined {
	const checked = new Set<string>();

	for (const [, value] of Object.entries(process.env)) {
		if (!value) continue;

		// Split on ; (Windows PATH separator) to handle PATH-like variables
		const segments = value.includes(";") ? value.split(";") : [value];

		for (const segment of segments) {
			const trimmed = segment.trim();
			if (!trimmed) continue;

			// Look for segments containing \Git\ or ending with \Git
			const lower = trimmed.toLowerCase().replace(/\//g, "\\");
			const gitIdx = lower.indexOf("\\git\\");
			const endsWithGit = lower.endsWith("\\git");
			if (gitIdx < 0 && !endsWithGit) continue;

			// Extract the Git root directory
			let gitRoot: string;
			if (gitIdx >= 0) {
				gitRoot = trimmed.slice(0, gitIdx + 4); // include \Git
			} else {
				gitRoot = trimmed;
			}

			if (checked.has(gitRoot.toLowerCase())) continue;
			checked.add(gitRoot.toLowerCase());

			// Skip WSL paths
			if (isWslBash(gitRoot)) continue;

			for (const sub of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
				const p = path.join(gitRoot, sub);
				if (existsSync(p)) return p;
			}
		}
	}

	return undefined;
}

/**
 * Use `git --exec-path` to find the Git installation directory,
 * then look for bash.exe relative to it.
 */
function findGitBashViaGitExecPath(existsSync: (p: string) => boolean): string | undefined {
	try {
		const execPath = execSync("git --exec-path", {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
		if (!execPath) return undefined;

		// git --exec-path returns something like:
		//   C:\Program Files\Git\mingw64\libexec\git-core
		// We need to go up to the Git root
		let dir = execPath;
		for (let i = 0; i < 5; i++) {
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
			for (const sub of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
				const p = path.join(dir, sub);
				if (existsSync(p)) return p;
			}
		}
	} catch {
		// git not found or timed out
	}
	return undefined;
}

/** Check whether a bash path is WSL's bash (System32/SysWOW64). */
function isWslBash(bashPath: string): boolean {
	const lower = bashPath.toLowerCase().replace(/\\/g, "/");
	return lower.includes("/system32/") || lower.includes("/syswow64/");
}

/** Check whether a shell path points to PowerShell (pwsh or powershell.exe). */
export function isPowerShell(shellPath: string): boolean {
	const lower = path.basename(shellPath).toLowerCase();
	return lower === "pwsh" || lower === "pwsh.exe" || lower === "powershell.exe";
}

/**
 * @deprecated Use `detectShell().path` instead. Kept for backward compat.
 */
export function detectShellPath(): string {
	return detectShell().path;
}
