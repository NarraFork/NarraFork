/**
 * dtach service — manages detached terminal sessions that survive server restarts.
 * Falls back gracefully when dtach is not installed.
 *
 * All process queries use async Bun.spawn() to avoid blocking the main thread.
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectShell } from "../lib/agent/shell";
import { logger } from "../lib/logger";
import { DEV_NULL, IS_WINDOWS } from "../lib/platform";
import type { TerminalRuntime } from "./runtime";
import { spawnBunTerminal } from "./runtime-bun";

// === Async command runner ===

/**
 * Run a command asynchronously via Bun.spawn and return stdout as string.
 * Returns null on failure or timeout.
 */
async function runCommand(
	cmd: string[],
	opts?: { timeout?: number; env?: Record<string, string> },
): Promise<string | null> {
	try {
		const proc = Bun.spawn(cmd, {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: opts?.env,
		});
		const timeoutMs = opts?.timeout ?? 5000;
		const result = await Promise.race([
			proc.exited.then(async (code) => {
				if (code !== 0) return null;
				return new Response(proc.stdout).text();
			}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
		]);
		// Kill if still running after timeout
		try {
			proc.kill();
		} catch {
			// already exited
		}
		return result;
	} catch {
		return null;
	}
}

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

type WinRunner = { type: "gitbash"; bash: string } | { type: "powershell"; pwsh: string } | null;
let _cachedWinRunner: WinRunner | undefined;
function getWinRunner(): WinRunner {
	if (_cachedWinRunner !== undefined) return _cachedWinRunner;
	const shell = detectShell();
	if (shell.loginWrap) {
		_cachedWinRunner = { type: "gitbash", bash: shell.path };
	} else {
		const pwsh = Bun.which("pwsh") ?? Bun.which("powershell.exe") ?? null;
		_cachedWinRunner = pwsh ? { type: "powershell", pwsh } : null;
	}
	return _cachedWinRunner;
}

async function runGitBash(
	bash: string,
	command: string,
	timeoutMs = 10000,
): Promise<string | null> {
	return runCommand([bash, "--login", "-c", command], {
		timeout: timeoutMs,
		env: { ...process.env, MSYS2_PATH_TYPE: "inherit" },
	});
}

async function runPowerShell(
	pwsh: string,
	command: string,
	timeoutMs = 10000,
): Promise<string | null> {
	return runCommand([pwsh, "-NoProfile", "-NonInteractive", "-Command", command], {
		timeout: timeoutMs,
	});
}

/**
 * Snapshot of all system processes (async construction).
 * Use the static `create()` factory method.
 */
export class ProcessSnapshot {
	private infoByPid = new Map<number, ProcessInfo>();
	private childrenByPid = new Map<number, number[]>();
	private argsByPid = new Map<number, string>();

	private constructor() {}

	static async create(): Promise<ProcessSnapshot> {
		const snap = new ProcessSnapshot();
		try {
			if (IS_WINDOWS) {
				await snap._buildFromWindows();
			} else {
				await snap._buildFromUnix();
			}
		} catch {
			// ignore — snapshot will be empty
		}
		return snap;
	}

	private async _buildFromUnix(): Promise<void> {
		const result = await runCommand(
			["ps", "-ax", "-o", "pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=,args="],
			{ timeout: 5000 },
		);
		if (result) this._parseUnixPs(result);
	}

	private async _buildFromWindows(): Promise<void> {
		const runner = getWinRunner();
		if (!runner) return;

		if (runner.type === "gitbash") {
			const result = await runGitBash(
				runner.bash,
				"ps -ax -o pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=,args=",
			);
			if (result) {
				this._parseUnixPs(result);
			}
			return;
		}

		const result = await runPowerShell(
			runner.pwsh,
			'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.WorkingSetSize)|$($_.CommandLine)" }',
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
				cpu: 0,
				elapsed: "",
			});
			if (parts[4]) this.argsByPid.set(pid, parts[4]);
			if (!Number.isNaN(ppid)) this._addChild(ppid, pid);
		}
	}

	private _parseUnixPs(output: string): void {
		for (const line of output.trim().split(/\r?\n/)) {
			const trimmed = line.trim();
			const parts = trimmed.split(/\s+/);
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
			// Extract the full args preserving original whitespace by locating
			// the 8th token's position in the raw line.
			if (parts.length > 7) {
				const argsStart = trimmed.indexOf(parts[7], trimmed.indexOf(parts[6]) + parts[6].length);
				if (argsStart !== -1) {
					this.argsByPid.set(pid, trimmed.substring(argsStart));
				}
			}
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

	/** Find PIDs whose command line contains `searchArg` (in-memory, no subprocess). */
	findByArg(searchArg: string): number[] {
		const pids: number[] = [];
		for (const [pid, args] of this.argsByPid) {
			if (args.includes(searchArg)) pids.push(pid);
		}
		return pids;
	}
}

/**
 * Find PIDs whose command line contains `searchArg`.
 */
export async function findProcessesByArg(searchArg: string): Promise<number[]> {
	const pids: number[] = [];
	try {
		if (IS_WINDOWS) {
			const runner = getWinRunner();
			if (!runner) return pids;

			if (runner.type === "gitbash") {
				const result = await runGitBash(runner.bash, `pgrep -f "${searchArg}"`);
				if (result) {
					for (const line of result.trim().split(/\r?\n/)) {
						const pid = Number.parseInt(line, 10);
						if (!Number.isNaN(pid)) pids.push(pid);
					}
				}
				return pids;
			}

			const escaped = searchArg.replace(/'/g, "''").replace(/"/g, '\\"');
			const result = await runPowerShell(
				runner.pwsh,
				`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { $_.ProcessId }`,
			);
			if (!result) return pids;
			for (const line of result.trim().split(/\r?\n/)) {
				const pid = Number.parseInt(line.trim(), 10);
				if (!Number.isNaN(pid)) pids.push(pid);
			}
		} else {
			const result = await runCommand(["pgrep", "-f", searchArg], { timeout: 5000 });
			if (result) {
				for (const line of result.trim().split("\n")) {
					const pid = Number.parseInt(line, 10);
					if (!Number.isNaN(pid)) pids.push(pid);
				}
			}
		}
	} catch {
		// No matches or command not available
	}
	return pids;
}

/**
 * Get child PIDs recursively.
 */
export async function getDescendantPids(pid: number): Promise<number[]> {
	const descendants: number[] = [];
	try {
		const children = new Map<number, number[]>();

		if (IS_WINDOWS) {
			const runner = getWinRunner();
			if (!runner) return descendants;

			if (runner.type === "gitbash") {
				const result = await runGitBash(runner.bash, "ps -ax -o pid=,ppid=");
				if (result) {
					parseUnixPidPpid(result, children);
				}
				if (children.size === 0) return descendants;
			} else {
				const result = await runPowerShell(
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
			const result = await runCommand(["ps", "-ax", "-o", "pid=,ppid="], { timeout: 5000 });
			if (result) {
				parseUnixPidPpid(result, children);
			}
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

async function killProcessTree(pid: number): Promise<void> {
	const descendants = await getDescendantPids(pid);
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

	async isAvailable(): Promise<boolean> {
		if (_available === null) {
			if (IS_WINDOWS) {
				_available = false;
			} else {
				const result = await runCommand(["which", "dtach"], { timeout: 3000 });
				_available = result !== null;
			}
			logger.info("dtach availability", { available: _available });
		}
		return _available;
	},

	getSocketPath(terminalId: string): string {
		return join(this.socketsDir, `terminal-${terminalId}.sock`);
	},

	async createSession(opts: {
		terminalId: string;
		cwd: string;
		env?: Record<string, string>;
	}): Promise<{ proc: import("bun").Subprocess }> {
		this.init();
		const socketPath = this.getSocketPath(opts.terminalId);
		const shell = detectShell().path;

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

		await this.waitForSocket(socketPath, 3000);

		logger.info("dtach session created", { terminalId: opts.terminalId, socketPath });
		return { proc };
	},

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

	async isSocketAlive(terminalId: string): Promise<boolean> {
		const socketPath = this.getSocketPath(terminalId);
		if (!existsSync(socketPath)) return false;
		try {
			const stats = statSync(socketPath);
			if (!stats.isSocket()) return false;
		} catch {
			return false;
		}
		const pids = await findProcessesByArg(socketPath);
		return pids.length > 0;
	},

	async killSession(terminalId: string): Promise<void> {
		const socketPath = this.getSocketPath(terminalId);
		const dtachPids = await findProcessesByArg(socketPath);
		for (const pid of dtachPids) {
			await killProcessTree(pid);
		}
		try {
			if (existsSync(socketPath)) unlinkSync(socketPath);
		} catch {
			// ignore
		}
	},

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
