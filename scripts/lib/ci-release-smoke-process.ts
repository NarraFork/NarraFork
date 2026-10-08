import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const SMOKE_TIMEOUT_MS = 8 * 60_000;
export const SMOKE_LOG_LIMIT = 64 * 1024 * 1024;
const TAIL_LIMIT = 32 * 1024;

/** Every child is spawned here, in its own POSIX process group; never adopt existing servers. */
export class SmokeProcessScope {
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	private readonly children: SmokeChild[] = [];
	private readonly timer: ReturnType<typeof setTimeout>;
	private outputBytes = 0;
	private closing = false;
	private readonly externalAbort: () => void;

	constructor(
		readonly cwd: string,
		readonly env: NodeJS.ProcessEnv,
		private readonly options: {
			timeoutMs?: number;
			maxOutputBytes?: number;
			signal?: AbortSignal;
		} = {},
	) {
		const timeout = options.timeoutMs ?? SMOKE_TIMEOUT_MS;
		const maximum = options.maxOutputBytes ?? SMOKE_LOG_LIMIT;
		if (
			!Number.isSafeInteger(timeout) ||
			timeout <= 0 ||
			timeout > SMOKE_TIMEOUT_MS ||
			!Number.isSafeInteger(maximum) ||
			maximum <= 0 ||
			maximum > SMOKE_LOG_LIMIT
		) {
			throw new Error("Invalid smoke resource budget");
		}
		this.timer = setTimeout(() => this.fail(new Error("Smoke hard timeout")), timeout);
		this.externalAbort = () => this.fail(options.signal?.reason ?? new Error("Smoke cancelled"));
		options.signal?.addEventListener("abort", this.externalAbort, { once: true });
		if (options.signal?.aborted) this.externalAbort();
	}

	fail(reason: unknown): void {
		if (!this.signal.aborted) this.controller.abort(reason);
	}

	spawn(command: readonly string[], onStdout?: (chunk: Buffer) => void): SmokeChild {
		this.signal.throwIfAborted();
		if (this.closing || !command[0]) throw new Error("Smoke scope is closed or command is empty");
		const child = spawn(command[0], command.slice(1), {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const managed = new SmokeChild(child);
		this.children.push(managed);
		const consume = (chunk: Buffer, stdout: boolean) => {
			this.outputBytes += chunk.length;
			if (this.outputBytes > (this.options.maxOutputBytes ?? SMOKE_LOG_LIMIT)) {
				this.fail(new Error("Smoke process output budget exceeded"));
				return;
			}
			managed.append(chunk);
			if (stdout && !this.signal.aborted) {
				try {
					onStdout?.(chunk);
				} catch (error) {
					this.fail(error);
				}
			}
		};
		child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
		child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
		child.stdin.on("error", (error) => {
			if (!this.closing) this.fail(error);
		});
		child.stdout.on("error", (error) => this.fail(error));
		child.stderr.on("error", (error) => this.fail(error));
		return managed;
	}

	async until<T>(label: string, probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
		const deadline = performance.now() + timeoutMs;
		while (true) {
			this.signal.throwIfAborted();
			const value = probe();
			if (value !== undefined) return value;
			if (performance.now() >= deadline) throw new Error(`${label} timed out`);
			await delay(25, undefined, { signal: this.signal });
		}
	}

	async command(command: readonly string[], timeoutMs = 15_000): Promise<void> {
		const child = this.spawn(command);
		const status = await this.until(command[0] ?? "command", () => child.status, timeoutMs);
		if (status !== 0) throw new Error(`Smoke command failed (${status}): ${child.diagnostic}`);
	}

	get diagnostic(): string {
		return this.children
			.map((child) => `[pid ${child.process.pid}] ${child.diagnostic}`)
			.join("\n")
			.slice(-TAIL_LIMIT);
	}

	/** Cleanup ignores the aborted test signal, but has its own finite subprocess budgets. */
	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		clearTimeout(this.timer);
		this.options.signal?.removeEventListener("abort", this.externalAbort);
		const failures: unknown[] = [];
		for (const child of this.children.toReversed()) {
			try {
				await terminateOwnedTree(child);
			} catch (error) {
				failures.push(error);
			}
			child.process.stdin.destroy();
			child.process.stdout.destroy();
			child.process.stderr.destroy();
		}
		if (failures.length) throw new AggregateError(failures, "Smoke child cleanup failed");
	}
}

export class SmokeChild {
	status: number | undefined;
	private tail = Buffer.alloc(0);
	constructor(readonly process: ChildProcessWithoutNullStreams) {
		process.once("exit", (code) => {
			this.status = code ?? 1;
		});
		process.once("error", (error) => {
			this.append(Buffer.from(String(error)));
			this.status = 1;
		});
	}
	append(chunk: Buffer): void {
		this.tail = Buffer.concat([this.tail, chunk.subarray(-TAIL_LIMIT)]).subarray(-TAIL_LIMIT);
	}
	get diagnostic(): string {
		return this.tail.toString("utf8");
	}
	assertRunning(): void {
		if (this.status !== undefined)
			throw new Error(`Smoke process exited (${this.status}): ${this.diagnostic}`);
	}
	send(message: unknown): void {
		this.assertRunning();
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** This helper only executes system ps/taskkill, never interpolates a shell command. */
async function cleanupCommand(
	command: [string, ...string[]],
): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let bytes = 0;
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Process cleanup timed out"));
		}, 5_000);
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 1024 * 1024) {
					child.kill("SIGKILL");
					reject(new Error("Process table exceeds budget"));
				} else chunks.push(chunk);
			});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
		});
	});
}

export function descendantPids(table: string, root: number): number[] {
	const rows = table
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(
			(row): row is [number, number] =>
				row.length === 2 && row.every((n) => Number.isSafeInteger(n) && n > 0),
		);
	const owned = new Set([root]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [pid, ppid] of rows)
			if (owned.has(ppid) && !owned.has(pid)) {
				owned.add(pid);
				changed = true;
			}
	}
	owned.delete(root);
	return [...owned].reverse();
}

async function terminateOwnedTree(child: SmokeChild): Promise<void> {
	const pid = child.process.pid;
	if (!pid) return;
	let failure: unknown;
	if (process.platform === "win32") {
		// No /IM, wildcards or blanket kills: this exact still-owned PID and its children only.
		if (child.status === undefined) {
			try {
				const result = await cleanupCommand(["taskkill.exe", "/PID", String(pid), "/T", "/F"]);
				if (result.code !== 0 && child.status === undefined)
					throw new Error(`taskkill failed: ${result.output}`);
			} catch (error) {
				failure = error;
				child.process.kill("SIGKILL");
			}
		}
	} else {
		// PTY shells can create a separate session, so the root's process group alone is insufficient.
		try {
			if (child.status === undefined) {
				const table = await cleanupCommand(["ps", "-ax", "-o", "pid=,ppid="]);
				if (table.code !== 0) throw new Error(`Cannot enumerate own descendants: ${table.output}`);
				for (const descendant of descendantPids(table.output, pid))
					signalPid(descendant, "SIGKILL");
			}
		} catch (error) {
			failure = error;
		}
		// Still terminate the owned root/group when process-table inspection failed.
		signalPid(-pid, "SIGKILL");
	}
	const deadline = performance.now() + 5_000;
	while (child.status === undefined && performance.now() < deadline) await delay(25);
	if (child.status === undefined)
		throw new Error(`Owned process ${pid} did not exit after cleanup`);
	if (failure) throw failure;
}
