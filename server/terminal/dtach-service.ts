/**
 * dtach service — manages detached terminal sessions that survive server restarts.
 * Falls back gracefully when dtach is not installed.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "../lib/logger";

const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash";

// === Process tree utilities ===

function findProcessesByArg(searchArg: string): number[] {
	const pids: number[] = [];
	try {
		const procDirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
		for (const pid of procDirs) {
			try {
				const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
				if (cmdline.includes(searchArg)) {
					pids.push(Number.parseInt(pid, 10));
				}
			} catch {
				// Process may have exited
			}
		}
	} catch {
		try {
			const result = execSync(`pgrep -f "${searchArg}"`, { encoding: "utf-8" });
			for (const line of result.trim().split("\n")) {
				const pid = Number.parseInt(line, 10);
				if (!Number.isNaN(pid)) pids.push(pid);
			}
		} catch {
			// No matches
		}
	}
	return pids;
}

function getDescendantPids(pid: number): number[] {
	const descendants: number[] = [];
	try {
		const result = execSync(`ps --ppid ${pid} -o pid= 2>/dev/null || true`, {
			encoding: "utf-8",
		});
		for (const line of result.trim().split("\n")) {
			const childPid = Number.parseInt(line.trim(), 10);
			if (!Number.isNaN(childPid)) {
				descendants.push(childPid);
				descendants.push(...getDescendantPids(childPid));
			}
		}
	} catch {
		// ignore
	}
	return descendants;
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
			try {
				execSync("which dtach", { encoding: "utf-8", stdio: "pipe" });
				_available = true;
			} catch {
				_available = false;
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
		const shell = DEFAULT_SHELL;

		// dtach -n: create new session without attaching
		// -z: disable suspend (Ctrl+Z doesn't detach)
		const proc = Bun.spawn(["dtach", "-n", socketPath, "-z", shell, "-li"], {
			cwd: opts.cwd,
			env: {
				...process.env,
				...opts.env,
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
	}): { pty: InstanceType<typeof Bun.Terminal>; proc: import("bun").Subprocess } {
		const socketPath = this.getSocketPath(opts.terminalId);

		const pty = new Bun.Terminal({
			cols: opts.cols,
			rows: opts.rows,
			data(_term, data) {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				if (text) opts.onData(text);
			},
		});

		// Attach to dtach session through PTY
		const proc = Bun.spawn(["bash", "-c", 'stty -echoctl && exec dtach -a "$1" -z', "_", socketPath], {
			env: { ...process.env, TERM: "xterm-256color" },
			terminal: pty,
		});

		return { pty, proc };
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
