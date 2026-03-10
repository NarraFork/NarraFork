/**
 * dtach service — manages detached terminal sessions that survive server restarts.
 * Falls back gracefully when dtach is not installed.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectShell } from "../lib/agent/shell";
import { logger } from "../lib/logger";
import { DEV_NULL, IS_WINDOWS } from "../lib/platform";
import type { TerminalRuntime } from "./runtime";
import { spawnBunTerminal } from "./runtime-bun";

// === Process tree utilities ===

export interface ProcessInfo {
	pid: number;
	ppid: number;
	command: string;
	state: string;
	rss: number;
	cpu: number;
	elapsed: string;
}

/**
 * Resolve the best command runner for process queries on Windows.
 *
 * Priority:
 *   1. Git Bash — has MSYS2 `ps` that understands Unix-style flags
 *   2. PowerShell (pwsh / powershell.exe)
 *   3. null — nothing available, process queries will return empty
 */
type WinRunner = { type: "gitbash"; bash: string } | { type: "powershell"; pwsh: string } | null;
let _cachedWinRunner: WinRunner | undefined;
function getWinRunner(): WinRunner {
	if (_cachedWinRunner !== undefined) return _cachedWinRunner;
	const shell = detectShell();
	if (shell.loginWrap) {
		// loginWrap === true means Git Bash was detected
		_cachedWinRunner = { type: "gitbash", bash: shell.path };
	} else {
		const pwsh = Bun.which("pwsh") ?? Bun.which("powershell.exe") ?? null;
		_cachedWinRunner = pwsh ? { type: "powershell", pwsh } : null;
	}
	return _cachedWinRunner;
}

/** Run a command via Git Bash and return stdout, or null on failure. */
function runGitBash(bash: string, command: string, timeoutMs = 10000): string | null {
	try {
		return execSync(`"${bash}" --login -c '${command.replace(/'/g, "'\\''")}'`, {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: timeoutMs,
			env: { ...process.env, MSYS2_PATH_TYPE: "inherit" },
		});
	} catch {
		return null;
	}
}

/** Run a PowerShell command and return stdout, or null on failure. */
function runPowerShell(pwsh: string, command: string, timeoutMs = 10000): string | null {
	try {
		return execSync(`"${pwsh}" -NoProfile -NonInteractive -Command "${command}"`, {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: timeoutMs,
		});
	} catch {
		return null;
	}
}

/**
 * Snapshot of all system processes.
 * Unix: single `ps` call. Windows: Git Bash `ps` → PowerShell fallback.
 * Provides efficient tree traversal and info lookup without repeated execSync.
 */
export class ProcessSnapshot {
	private infoByPid = new Map<number, ProcessInfo>();
	private childrenByPid = new Map<number, number[]>();

	constructor() {
		try {
			if (IS_WINDOWS) {
				this._buildFromWindows();
			} else {
				this._buildFromUnix();
			}
		} catch {
			// ignore — snapshot will be empty
		}
	}

	private _buildFromUnix(): void {
		const result = execSync("ps -ax -o pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=", {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 5000,
		});
		this._parseUnixPs(result);
	}

	private _buildFromWindows(): void {
		const runner = getWinRunner();
		if (!runner) return;

		if (runner.type === "gitbash") {
			// MSYS2 ps supports -ax -o flags just like Unix
			const result = runGitBash(runner.bash, "ps -ax -o pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=");
			if (result) {
				this._parseUnixPs(result);
				return;
			}
			// Git Bash ps failed — don't fallback, just return empty
			return;
		}

		// PowerShell fallback
		const result = runPowerShell(
			runner.pwsh,
			'Get-Process | ForEach-Object { "$($_.Id)|$($_.Parent.Id)|$($_.ProcessName)|$($_.WorkingSet64)|$($_.CPU)" }',
		);
		if (!result) return;
		for (const line of result.trim().split(/\r?\n/)) {
			const parts = line.split("|");
			if (parts.length < 5) continue;
			const pid = Number.parseInt(parts[0], 10);
			const ppid = Number.parseInt(parts[1], 10);
			if (Number.isNaN(pid)) continue;
			this.infoByPid.set(pid, {
				pid,
				ppid: Number.isNaN(ppid) ? 0 : ppid,
				command: parts[2] || "",
				state: "running",
				rss: Math.round((Number.parseInt(parts[3], 10) || 0) / 1024),
				cpu: Number.parseFloat(parts[4]) || 0,
				elapsed: "",
			});
			if (!Number.isNaN(ppid)) this._addChild(ppid, pid);
		}
	}

	private _parseUnixPs(output: string): void {
		for (const line of output.trim().split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 7) continue;
			const pid = Number.parseInt(parts[0], 10);
			const ppid = Number.parseInt(parts[1], 10);
			if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
			this.infoByPid.set(pid, {
				pid,
				ppid,
				command: parts[2],
				state: parts[3],
				rss: Number.parseInt(parts[4], 10),
				cpu: Number.parseFloat(parts[5]),
				elapsed: parts[6],
			});
			this._addChild(ppid, pid);
		}
	}

	private _addChild(ppid: number, pid: number): void {
		let list = this.childrenByPid.get(ppid);
		if (!list) {
			list = [];
			this.childrenByPid.set(ppid, list);
		}
		list.push(pid);
	}

	getInfo(pid: number): ProcessInfo | null {
		return this.infoByPid.get(pid) ?? null;
	}

	getDescendants(pid: number): number[] {
		const descendants: number[] = [];
		const queue = [...(this.childrenByPid.get(pid) ?? [])];
		while (queue.length > 0) {
			const child = queue.shift();
			if (child === undefined) break;
			descendants.push(child);
			const grandchildren = this.childrenByPid.get(child);
			if (grandchildren) queue.push(...grandchildren);
		}
		return descendants;
	}

	getChildren(pid: number): number[] {
		return this.childrenByPid.get(pid) ?? [];
	}
}

/**
 * Find PIDs whose command line contains `searchArg`.
 * Unix: `pgrep -f`. Windows: Git Bash `pgrep` → PowerShell fallback.
 */
export function findProcessesByArg(searchArg: string): number[] {
	const pids: number[] = [];
	try {
		if (IS_WINDOWS) {
			const runner = getWinRunner();
			if (!runner) return pids;

			if (runner.type === "gitbash") {
				const result = runGitBash(runner.bash, `pgrep -f "${searchArg}"`);
				if (result) {
					for (const line of result.trim().split(/\r?\n/)) {
						const pid = Number.parseInt(line, 10);
						if (!Number.isNaN(pid)) pids.push(pid);
					}
					return pids;
				}
				return pids;
			}

			// PowerShell fallback
			const escaped = searchArg.replace(/'/g, "''").replace(/"/g, '\\"');
			const result = runPowerShell(
				runner.pwsh,
				`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { $_.ProcessId }`,
			);
			if (!result) return pids;
			for (const line of result.trim().split(/\r?\n/)) {
				const pid = Number.parseInt(line.trim(), 10);
				if (!Number.isNaN(pid)) pids.push(pid);
			}
		} else {
			const result = execSync(`pgrep -f "${searchArg}"`, {
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5000,
			});
			for (const line of result.trim().split("\n")) {
				const pid = Number.parseInt(line, 10);
				if (!Number.isNaN(pid)) pids.push(pid);
			}
		}
	} catch {
		// No matches or command not available
	}
	return pids;
}

/**
 * Get child PIDs recursively.
 * Unix: `ps`. Windows: Git Bash `ps` → PowerShell fallback.
 */
export function getDescendantPids(pid: number): number[] {
	const descendants: number[] = [];
	try {
		const children = new Map<number, number[]>();

		if (IS_WINDOWS) {
			const runner = getWinRunner();
			if (!runner) return descendants;

			if (runner.type === "gitbash") {
				const result = runGitBash(runner.bash, "ps -ax -o pid=,ppid=");
				if (result) {
					parseUnixPidPpid(result, children);
				}
				// If Git Bash ps failed, return empty
				if (children.size === 0) return descendants;
			} else {
				const result = runPowerShell(
					runner.pwsh,
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }',
				);
				if (!result) return descendants;
				for (const line of result.trim().split(/\r?\n/)) {
					const parts = line.split("|");
					if (parts.length < 2) continue;
					const childPid = Number.parseInt(parts[0], 10);
					const parentPid = Number.parseInt(parts[1], 10);
					if (Number.isNaN(childPid) || Number.isNaN(parentPid)) continue;
					let list = children.get(parentPid);
					if (!list) {
						list = [];
						children.set(parentPid, list);
					}
					list.push(childPid);
				}
			}
		} else {
			const result = execSync("ps -ax -o pid=,ppid=", {
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5000,
			});
			parseUnixPidPpid(result, children);
		}

		// BFS to collect all descendants
		const queue = children.get(pid) ?? [];
		while (queue.length > 0) {
			const child = queue.shift();
			if (child === undefined) break;
			descendants.push(child);
			const grandchildren = children.get(child);
			if (grandchildren) queue.push(...grandchildren);
		}
	} catch {
		// ignore
	}
	return descendants;
}

/** Parse Unix `ps -o pid=,ppid=` output into a parent→children map. */
function parseUnixPidPpid(output: string, children: Map<number, number[]>): void {
	for (const line of output.trim().split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const childPid = Number.parseInt(parts[0], 10);
		const parentPid = Number.parseInt(parts[1], 10);
		if (Number.isNaN(childPid) || Number.isNaN(parentPid)) continue;
		let list = children.get(parentPid);
		if (!list) {
			list = [];
			children.set(parentPid, list);
		}
		list.push(childPid);
	}
}

function killProcessTree(pid: number): void {
	const descendants = getDescendantPids(pid);
	for (const childPid of descendants.reverse()) {
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// already exited
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already exited
	}
}

// === DtachService ===

let _available: boolean | null = null;

export const dtachService = {
	socketsDir: resolve(homedir(), ".narrafork", "sockets"),

	init() {
		if (!existsSync(this.socketsDir)) {
			mkdirSync(this.socketsDir, { recursive: true });
		}
	},

	isAvailable(): boolean {
		if (_available === null) {
			if (IS_WINDOWS) {
				_available = false;
			} else {
				try {
					execSync("which dtach", { encoding: "utf-8", stdio: "pipe", timeout: 3000 });
					_available = true;
				} catch {
					_available = false;
				}
			}
			logger.info("dtach availability", { available: _available });
		}
		return _available;
	},

	getSocketPath(terminalId: string): string {
		return join(this.socketsDir, `terminal-${terminalId}.sock`);
	},

	/** Create a new detached session. Returns the dtach subprocess. */
	async createSession(opts: {
		terminalId: string;
		cwd: string;
		env?: Record<string, string>;
	}): Promise<{ proc: import("bun").Subprocess }> {
		this.init();
		const socketPath = this.getSocketPath(opts.terminalId);
		const shell = detectShell().path;

		// dtach -n: create new session without attaching
		// -z: disable suspend (Ctrl+Z doesn't detach)
		const proc = Bun.spawn(["dtach", "-n", socketPath, "-z", shell, "-li"], {
			cwd: opts.cwd,
			env: {
				...process.env,
				...opts.env,
				HISTFILE: DEV_NULL,
				TERM: "xterm-256color",
			},
			stdio: ["ignore", "ignore", "ignore"],
		});

		// Wait for socket to appear (dtach creates it asynchronously)
		await this.waitForSocket(socketPath, 3000);

		logger.info("dtach session created", { terminalId: opts.terminalId, socketPath });
		return { proc };
	},

	/** Attach to an existing dtach session via Bun.Terminal PTY */
	attachSession(opts: {
		terminalId: string;
		cols: number;
		rows: number;
		onData: (data: string) => void;
	}): TerminalRuntime {
		const socketPath = this.getSocketPath(opts.terminalId);

		return spawnBunTerminal({
			cmd: ["sh", "-c", 'stty -echoctl && exec dtach -a "$1" -z', "_", socketPath],
			cwd: process.cwd(),
			env: { ...process.env, TERM: "xterm-256color" },
			cols: opts.cols,
			rows: opts.rows,
			onData: opts.onData,
		});
	},

	/** Check if a dtach socket is still alive */
	isSocketAlive(terminalId: string): boolean {
		const socketPath = this.getSocketPath(terminalId);
		if (!existsSync(socketPath)) return false;
		try {
			const stats = statSync(socketPath);
			if (!stats.isSocket()) return false;
		} catch {
			return false;
		}
		// Verify dtach process is running
		const pids = findProcessesByArg(socketPath);
		return pids.length > 0;
	},

	/** Kill the dtach session and all child processes */
	killSession(terminalId: string): void {
		const socketPath = this.getSocketPath(terminalId);
		const dtachPids = findProcessesByArg(socketPath);
		for (const pid of dtachPids) {
			killProcessTree(pid);
		}
		// Clean up socket file
		try {
			if (existsSync(socketPath)) unlinkSync(socketPath);
		} catch {
			// ignore
		}
	},

	/** Wait for a socket file to appear */
	async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
		const start = Date.now();
		const interval = 50;
		while (Date.now() - start < timeoutMs) {
			if (existsSync(socketPath)) return;
			await new Promise((r) => setTimeout(r, interval));
		}
		logger.warn("dtach socket did not appear in time", { socketPath, timeoutMs });
	},
};
