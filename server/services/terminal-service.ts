import { readdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, terminals } from "../db/schema";
import { detectShell } from "../lib/agent/shell";
import { resetCursorForTerminal } from "../lib/agent/tools/terminal";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { DEV_NULL, getHome, IS_WINDOWS } from "../lib/platform";
import { BufferManager } from "../terminal/buffer-manager";
import {
	dtachService,
	findProcessesByArg,
	getDescendantPids,
	ProcessSnapshot,
} from "../terminal/dtach-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "../terminal/runtime";
import { spawnBunTerminal } from "../terminal/runtime-bun";
import { spawnPortablePty } from "../terminal/runtime-pty";
import { sendToTerminal } from "../websocket/terminal-ws";

const DEFAULT_SHELL = detectShell().path;

export interface TerminalProcessInfo {
	pid: number;
	ppid: number;
	command: string;
	state: string;
	rss: number;
	cpu: number;
	elapsed: string;
}

/** Batch-fetch process info for multiple PIDs in a single ps call. */
async function getProcessInfoBatch(pids: number[]): Promise<Map<number, TerminalProcessInfo>> {
	const result = new Map<number, TerminalProcessInfo>();
	if (pids.length === 0) return result;
	try {
		if (IS_WINDOWS) {
			const pwsh = Bun.which("pwsh") ?? Bun.which("powershell.exe");
			if (!pwsh) return result;
			const pidList = pids.join(",");
			const proc = Bun.spawn(
				[
					pwsh,
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Parent.Id)|$($_.ProcessName)|$($_.WorkingSet64)|$($_.CPU)" }`,
				],
				{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
			);
			const output = await Promise.race([
				proc.exited.then(async (code) => {
					if (code !== 0) return null;
					return new Response(proc.stdout).text();
				}),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
			]);
			try {
				proc.kill();
			} catch {
				// already exited
			}
			if (!output) return result;
			for (const line of output.trim().split(/\r?\n/)) {
				const parts = line.split("|");
				if (parts.length < 5) continue;
				const pid = Number.parseInt(parts[0], 10);
				if (Number.isNaN(pid)) continue;
				const ppid = Number.parseInt(parts[1], 10);
				result.set(pid, {
					pid,
					ppid: Number.isNaN(ppid) ? 0 : ppid,
					command: parts[2] || "",
					state: "running",
					rss: Math.round((Number.parseInt(parts[3], 10) || 0) / 1024),
					cpu: Number.parseFloat(parts[4]) || 0,
					elapsed: "",
				});
			}
			return result;
		}
		const proc = Bun.spawn(
			["ps", "-o", "pid=,ppid=,comm=,stat=,rss=,%cpu=,etime=", "-p", pids.join(",")],
			{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
		);
		const output = await Promise.race([
			proc.exited.then(async (code) => {
				if (code !== 0) return null;
				return new Response(proc.stdout).text();
			}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
		]);
		try {
			proc.kill();
		} catch {
			// already exited
		}
		if (!output) return result;
		for (const line of output.trim().split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 7) continue;
			const pid = Number.parseInt(parts[0], 10);
			if (Number.isNaN(pid)) continue;
			result.set(pid, {
				pid,
				ppid: Number.parseInt(parts[1], 10),
				command: parts[2],
				state: parts[3],
				rss: Number.parseInt(parts[4], 10),
				cpu: Number.parseFloat(parts[5]),
				elapsed: parts[6],
			});
		}
	} catch {
		// fallback: empty
	}
	return result;
}

interface ActiveTerminal {
	runtime: TerminalRuntime;
	terminalId: string;
	buffer: BufferManager;
	useDtach: boolean;
}

const activeTerminals = new Map<string, ActiveTerminal>();

/**
 * Mark a terminal as exited in DB and emit the lifecycle event.
 *
 * @param narratorId - Pass `null` if the terminal has no narrator.
 *   Pass `undefined` (or omit) to have the function look up the value from DB.
 * @param chapterId  - Same convention as narratorId.
 */
async function markTerminalExited(
	terminalId: string,
	exitCode: number | null,
	narratorId?: string | null,
	chapterId?: string | null,
) {
	await db
		.update(terminals)
		.set({ status: "exited", exitCode: exitCode ?? 0 })
		.where(eq(terminals.id, terminalId));
	// Resolve narrator/chapter IDs if not provided
	let nId = narratorId;
	let cId = chapterId;
	if (nId === undefined || cId === undefined) {
		const row = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
			columns: { narratorId: true, chapterId: true },
		});
		if (row) {
			if (nId === undefined) nId = row.narratorId;
			if (cId === undefined) cId = row.chapterId;
		}
	}
	eventBus.emit({
		type: "terminal:exited",
		terminalId,
		narratorId: nId ?? null,
		chapterId: cId ?? null,
	});
}

function onData(id: string, buffer: BufferManager, data: string | Uint8Array) {
	const text = typeof data === "string" ? data : new TextDecoder().decode(data);
	if (text) {
		buffer.append(text);
		sendToTerminal(id, { type: "output", terminalId: id, data: text });
	}
}

/**
 * Monitor a dtach attach process. When it exits:
 * - If the dtach socket is still alive, save buffer and remove from activeTerminals
 *   (lazy re-attach will happen when a client subscribes via ensureAttached).
 * - If the socket is dead, the shell truly exited — mark terminal as exited.
 */
function monitorAttachProcess(
	terminalId: string,
	runtime: TerminalRuntime,
	narratorId?: string | null,
	chapterId?: string | null,
) {
	runtime.exited.then(async (code) => {
		const active = activeTerminals.get(terminalId);
		if (!active) return;

		if (await dtachService.isSocketAlive(terminalId)) {
			// Detached — save buffer, remove from active. Will re-attach on demand.
			active.buffer.saveToDisk();
			active.runtime.close();
			activeTerminals.delete(terminalId);
			logger.info("dtach attach process exited, session still alive", { terminalId });
			return;
		}

		// Shell actually exited
		await active.buffer.dispose();
		activeTerminals.delete(terminalId);
		runtime.close();
		await markTerminalExited(terminalId, code ?? 0, narratorId, chapterId);
		sendToTerminal(terminalId, { type: "exit", terminalId, code: code ?? 0 });
		logger.info("Terminal exited", { terminalId, code });
	});
}

export const terminalService = {
	async create(opts: {
		chapterId?: string;
		narratorId?: string;
		name?: string;
		cols?: number;
		rows?: number;
	}) {
		const cols = opts.cols ?? 80;
		const rows = opts.rows ?? 24;
		let cwd: string;
		const chapterId: string | undefined = opts.chapterId;
		const narratorId: string | undefined = opts.narratorId;

		if (chapterId && narratorId) {
			throw new ValidationError("Only one of chapterId or narratorId may be provided");
		}

		if (chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (!chapter.worktreePath) {
				throw new ValidationError("Chapter has no worktree (dormant?)");
			}
			cwd = chapter.worktreePath;
		} else if (narratorId) {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
			});
			if (!narrator) throw new NotFoundError("Narrator", narratorId);
			if (narrator.chapterId) {
				const chapter = await db.query.chapters.findFirst({
					where: eq(chapters.id, narrator.chapterId),
				});
				logger.info("Terminal CWD resolution (chapter-bound narrator)", {
					narratorId,
					chapterId: narrator.chapterId,
					chapterFound: !!chapter,
					worktreePath: chapter?.worktreePath,
					narratorCwd: narrator.cwd,
				});
				if (chapter?.worktreePath) {
					cwd = chapter.worktreePath;
				} else {
					cwd = narrator.cwd ?? getHome();
				}
			} else {
				cwd = narrator.cwd ?? getHome();
			}
			if (!cwd || cwd === getHome()) {
				logger.warn("Narrator has no cwd, falling back", { narratorId, cwd });
			}
		} else {
			// Standalone terminals are used by global flows such as setup wizard dependency installs.
			cwd = getHome();
		}

		const id = generateId();
		const now = new Date().toISOString();
		const buffer = new BufferManager(id);
		buffer.startPeriodicFlush();
		const useDtach = await dtachService.isAvailable();

		let runtime: TerminalRuntime;
		let dtachSocket: string | null = null;

		if (useDtach) {
			// dtach mode: create detached session, then attach via PTY
			await dtachService.createSession({ terminalId: id, cwd });
			dtachSocket = dtachService.getSocketPath(id);
			runtime = dtachService.attachSession({
				terminalId: id,
				cols,
				rows,
				onData: (text) => onData(id, buffer, text),
			});
		} else {
			// Direct mode: platform-appropriate PTY
			const spawnOpts: TerminalSpawnOptions = {
				cmd: [DEFAULT_SHELL, "-l"],
				cwd,
				env: {
					...process.env,
					HISTFILE: DEV_NULL,
					TERM: "xterm-256color",
				},
				cols,
				rows,
				onData: (data) => onData(id, buffer, data),
			};
			runtime = IS_WINDOWS ? spawnPortablePty(spawnOpts) : spawnBunTerminal(spawnOpts);
		}

		activeTerminals.set(id, { runtime, terminalId: id, buffer, useDtach });

		if (useDtach) {
			monitorAttachProcess(id, runtime, narratorId ?? null, chapterId ?? null);
		} else {
			// Direct mode: process exit means the shell exited
			runtime.exited.then(async (code) => {
				const active = activeTerminals.get(id);
				if (!active) return;
				await active.buffer.dispose();
				activeTerminals.delete(id);
				runtime.close();
				await markTerminalExited(id, code ?? 0, narratorId ?? null, chapterId ?? null);
				sendToTerminal(id, { type: "exit", terminalId: id, code: code ?? 0 });
				logger.info("Terminal exited", { terminalId: id, code });
			});
		}

		const [terminal] = await db
			.insert(terminals)
			.values({
				id,
				chapterId: chapterId ?? null,
				narratorId: narratorId ?? null,
				name: opts.name ?? "Terminal",
				cwd,
				dtachSocket,
				status: "running",
				createdAt: now,
			})
			.returning();

		logger.info("Terminal created", { id, chapterId, narratorId, useDtach });
		eventBus.emit({
			type: "terminal:created",
			terminalId: id,
			narratorId: narratorId ?? null,
			chapterId: chapterId ?? null,
		});
		return terminal;
	},

	write(terminalId: string, data: string) {
		const active = activeTerminals.get(terminalId);
		if (!active) {
			logger.warn("Terminal write: no active terminal", { terminalId });
			return;
		}
		active.runtime.write(data);
	},

	resize(terminalId: string, cols: number, rows: number) {
		const active = activeTerminals.get(terminalId);
		if (!active) return;
		active.runtime.resize(cols, rows);
		// Bun.Terminal.resize() does not send SIGWINCH to the child.
		// dtach relies on SIGWINCH to forward the new size. Only on Unix.
		if (active.useDtach && !IS_WINDOWS && active.runtime.pid) {
			try {
				process.kill(active.runtime.pid, "SIGWINCH");
			} catch {
				// process may have exited
			}
		}
		// Buffer resize is async (waits for pending writes) — fire and forget
		active.buffer.resize(cols, rows);
	},

	async kill(terminalId: string) {
		const active = activeTerminals.get(terminalId);
		if (active) {
			await active.buffer.dispose(true);
			if (active.useDtach) {
				await dtachService.killSession(terminalId);
			}
			active.runtime.kill();
			active.runtime.close();
			activeTerminals.delete(terminalId);
		} else if (await dtachService.isAvailable()) {
			// Terminal might be detached (no active entry) but dtach session alive
			if (await dtachService.isSocketAlive(terminalId)) {
				await dtachService.killSession(terminalId);
			}
			// Clean up buffer file
			const buf = new BufferManager(terminalId);
			await buf.deleteFromDisk();
		}

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) throw new NotFoundError("Terminal", terminalId);

		await markTerminalExited(terminalId, -1, terminal.narratorId, terminal.chapterId);

		sendToTerminal(terminalId, { type: "exit", terminalId, code: -1 });
		logger.info("Terminal killed", { terminalId });
	},

	async rename(terminalId: string, name: string) {
		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) throw new NotFoundError("Terminal", terminalId);
		await db.update(terminals).set({ name }).where(eq(terminals.id, terminalId));
	},

	async updateGraphState(
		terminalId: string,
		state: {
			graphOpened?: boolean;
			graphX?: number;
			graphY?: number;
			graphWidth?: number;
			graphHeight?: number;
		},
	) {
		const updates: Record<string, unknown> = {};
		if (state.graphOpened !== undefined) updates.graphOpened = state.graphOpened ? 1 : 0;
		if (state.graphX !== undefined) updates.graphX = state.graphX;
		if (state.graphY !== undefined) updates.graphY = state.graphY;
		if (state.graphWidth !== undefined) updates.graphWidth = state.graphWidth;
		if (state.graphHeight !== undefined) updates.graphHeight = state.graphHeight;
		if (Object.keys(updates).length === 0) return;
		await db.update(terminals).set(updates).where(eq(terminals.id, terminalId));
	},

	async getById(id: string) {
		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, id),
		});
		if (!terminal) throw new NotFoundError("Terminal", id);
		return terminal;
	},

	async listByChapter(chapterId: string) {
		return db.query.terminals.findMany({
			where: eq(terminals.chapterId, chapterId),
		});
	},

	async listByNarrator(narratorId: string) {
		return db.query.terminals.findMany({
			where: eq(terminals.narratorId, narratorId),
		});
	},

	/** List all terminals (admin use) */
	async listAll() {
		return db.query.terminals.findMany({
			orderBy: (t, { desc }) => [desc(t.createdAt)],
		});
	},

	/** Find orphan dtach sockets — sockets on disk with no matching running terminal in DB */
	async listOrphanSockets(
		snapshot?: ProcessSnapshot,
	): Promise<{ socketPath: string; terminalId: string }[]> {
		if (!(await dtachService.isAvailable())) return [];
		const orphans: { socketPath: string; terminalId: string }[] = [];
		try {
			const files = await readdir(dtachService.socketsDir);
			for (const file of files) {
				const match = file.match(/^terminal-(.+)\.sock$/);
				if (!match) continue;
				const terminalId = match[1];
				const socketPath = dtachService.getSocketPath(terminalId);
				// Check if the socket is alive but terminal is not in activeTerminals
				const alive = snapshot
					? snapshot.findByArg(socketPath).length > 0
					: await dtachService.isSocketAlive(terminalId);
				if (alive && !activeTerminals.has(terminalId)) {
					orphans.push({ socketPath, terminalId });
				}
			}
		} catch {
			// sockets dir may not exist
		}
		return orphans;
	},

	/** Kill an orphan dtach socket that has no DB record */
	async killOrphanSocket(terminalId: string) {
		await dtachService.killSession(terminalId);
		// Clean up buffer file if any
		const buf = new BufferManager(terminalId);
		await buf.deleteFromDisk();
	},

	/** Check if a terminal is currently attached (has an active PTY connection) */
	isAttached(terminalId: string): boolean {
		return activeTerminals.has(terminalId);
	},

	/**
	 * Ensure a dtach terminal is attached. If it's a running dtach terminal
	 * that's not in activeTerminals (e.g. after server restart or detach),
	 * automatically re-attach so new output flows through WebSocket.
	 * No-op for non-dtach terminals or already-attached terminals.
	 */
	async ensureAttached(terminalId: string): Promise<void> {
		if (activeTerminals.has(terminalId)) return;
		if (!(await dtachService.isAvailable())) return;

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
			columns: { id: true, status: true, dtachSocket: true },
		});
		if (!terminal || terminal.status !== "running" || !terminal.dtachSocket) return;

		await this.reattach(terminalId);
	},

	/** Get attached status for multiple terminals at once */
	getAttachedSet(): Set<string> {
		return new Set(activeTerminals.keys());
	},

	/**
	 * Re-attach to a dtach terminal that exists in DB but is not in activeTerminals.
	 * Returns true if successfully re-attached.
	 */
	async reattach(terminalId: string): Promise<boolean> {
		if (activeTerminals.has(terminalId)) return true; // already attached
		if (!(await dtachService.isAvailable())) return false;
		if (!(await dtachService.isSocketAlive(terminalId))) return false;

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) return false;

		const buffer = new BufferManager(terminalId);
		await buffer.loadFromDisk();
		buffer.startPeriodicFlush();

		const runtime = dtachService.attachSession({
			terminalId,
			cols: 80,
			rows: 24,
			onData: (text) => onData(terminalId, buffer, text),
		});

		activeTerminals.set(terminalId, {
			runtime,
			terminalId,
			buffer,
			useDtach: true,
		});

		// Ensure DB status is running
		await db.update(terminals).set({ status: "running" }).where(eq(terminals.id, terminalId));

		// Clear stale read cursors so next read returns full buffer
		resetCursorForTerminal(terminalId);

		monitorAttachProcess(terminalId, runtime);

		logger.info("Terminal re-attached", { terminalId });
		return true;
	},

	/**
	 * Re-attach to an orphan dtach socket (no DB record).
	 * Creates a DB record and attaches. Returns the new terminal record.
	 */
	async reattachOrphan(terminalId: string): Promise<unknown> {
		if (!(await dtachService.isAvailable()) || !(await dtachService.isSocketAlive(terminalId))) {
			throw new AppError("dtach socket not alive", 500);
		}

		const id = terminalId;
		const now = new Date().toISOString();
		const dtachSocket = dtachService.getSocketPath(terminalId);

		// Check if DB record already exists
		const existing = await db.query.terminals.findFirst({
			where: eq(terminals.id, id),
		});

		if (!existing) {
			// Create DB record for the orphan
			await db.insert(terminals).values({
				id,
				chapterId: null,
				narratorId: null,
				name: `Recovered ${id.slice(0, 8)}`,
				cwd: getHome(),
				dtachSocket,
				status: "running",
				createdAt: now,
			});
		} else {
			await db
				.update(terminals)
				.set({ status: "running", dtachSocket })
				.where(eq(terminals.id, id));
		}

		// Now reattach
		const success = await this.reattach(id);
		if (!success) throw new AppError("Failed to reattach", 500);

		return db.query.terminals.findFirst({ where: eq(terminals.id, id) });
	},

	async getScrollback(
		terminalId: string,
	): Promise<{ data: string; cols: number; rows: number } | null> {
		const active = activeTerminals.get(terminalId);
		if (active) {
			const contents = await active.buffer.getContents();
			if (!contents) return null;
			return { data: contents, cols: active.buffer.cols, rows: active.buffer.rows };
		}
		// Try loading from disk (detached terminal)
		const buf = new BufferManager(terminalId);
		if (await buf.loadFromDisk()) {
			const contents = await buf.getContents();
			if (!contents) return null;
			return { data: contents, cols: buf.cols, rows: buf.rows };
		}
		return null;
	},

	getBufferState(terminalId: string): { mouseTracking: boolean; cursorVisible: boolean } | null {
		const active = activeTerminals.get(terminalId);
		if (!active) return null;
		return active.buffer.getState();
	},

	/** On startup, recover dtach sessions or mark stale terminals as exited. */
	async recoverOnStartup() {
		if (!(await dtachService.isAvailable())) {
			// No dtach — just mark all running terminals as exited
			const running = await db.query.terminals.findMany({
				where: eq(terminals.status, "running"),
			});
			for (const terminal of running) {
				await markTerminalExited(terminal.id, null, terminal.narratorId, terminal.chapterId);
			}
			if (running.length > 0) {
				logger.info("Marked stale terminals as exited (no dtach)", { count: running.length });
			}
			return;
		}

		// Phase 1: recover DB-tracked running terminals
		const running = await db.query.terminals.findMany({
			where: eq(terminals.status, "running"),
		});

		let recovered = 0;
		let marked = 0;

		for (const terminal of running) {
			if (terminal.dtachSocket && (await dtachService.isSocketAlive(terminal.id))) {
				// Re-attach to the dtach session
				const buffer = new BufferManager(terminal.id);
				await buffer.loadFromDisk();
				buffer.startPeriodicFlush();

				const runtime = dtachService.attachSession({
					terminalId: terminal.id,
					cols: 80,
					rows: 24,
					onData: (text) => onData(terminal.id, buffer, text),
				});

				activeTerminals.set(terminal.id, {
					runtime,
					terminalId: terminal.id,
					buffer,
					useDtach: true,
				});

				// Clear stale read cursors so next read returns full buffer
				resetCursorForTerminal(terminal.id);

				monitorAttachProcess(terminal.id, runtime, terminal.narratorId, terminal.chapterId);

				recovered++;
				continue;
			}

			// Socket dead — mark as exited
			await markTerminalExited(terminal.id, null, terminal.narratorId, terminal.chapterId);
			marked++;
		}

		// Phase 2: recover orphan sockets that have a matching exited DB record.
		// This handles the case where a previous server run incorrectly marked a
		// still-alive dtach terminal as exited (e.g. due to a detection failure).
		// We restore the DB record to running and re-attach.
		let revivedFromExited = 0;
		try {
			const files = await readdir(dtachService.socketsDir);
			for (const file of files) {
				const match = file.match(/^terminal-(.+)\.sock$/);
				if (!match) continue;
				const terminalId = match[1];

				// Skip if already recovered in phase 1
				if (activeTerminals.has(terminalId)) continue;

				if (!(await dtachService.isSocketAlive(terminalId))) continue;

				// Check if there's an exited DB record we can revive
				const existing = await db.query.terminals.findFirst({
					where: eq(terminals.id, terminalId),
				});
				if (existing && existing.status === "exited") {
					// Revive: update status back to running and re-attach
					await db
						.update(terminals)
						.set({
							status: "running",
							dtachSocket: dtachService.getSocketPath(terminalId),
						})
						.where(eq(terminals.id, terminalId));

					const buffer = new BufferManager(terminalId);
					await buffer.loadFromDisk();
					buffer.startPeriodicFlush();

					const runtime = dtachService.attachSession({
						terminalId,
						cols: 80,
						rows: 24,
						onData: (text) => onData(terminalId, buffer, text),
					});

					activeTerminals.set(terminalId, {
						runtime,
						terminalId,
						buffer,
						useDtach: true,
					});

					// Clear stale read cursors so next read returns full buffer
					resetCursorForTerminal(terminalId);

					monitorAttachProcess(terminalId, runtime, existing.narratorId, existing.chapterId);

					revivedFromExited++;
				}
			}
		} catch {
			// sockets dir may not exist
		}

		if (recovered > 0) logger.info("Recovered dtach terminals", { count: recovered });
		if (marked > 0) logger.info("Marked stale terminals as exited", { count: marked });
		if (revivedFromExited > 0) {
			logger.info("Revived exited terminals with live dtach sockets", {
				count: revivedFromExited,
			});
		}
	},

	async cleanupForChapter(chapterId: string) {
		await this._cleanupByField("chapterId", chapterId);
	},

	async cleanupForNarrator(narratorId: string) {
		await this._cleanupByField("narratorId", narratorId);
	},

	async _cleanupByField(field: "chapterId" | "narratorId", value: string) {
		const col = field === "chapterId" ? terminals.chapterId : terminals.narratorId;
		const matched = await db.query.terminals.findMany({
			where: eq(col, value),
		});
		for (const terminal of matched) {
			if (terminal.status === "running") {
				try {
					await this.kill(terminal.id);
				} catch {
					// best effort
				}
			}
		}
		await db.delete(terminals).where(eq(col, value));
	},

	/**
	 * Get the root shell PID for a terminal.
	 * dtach mode: find the dtach process via socket path, its child is the shell.
	 * direct mode: the subprocess PID is the shell.
	 */
	async getShellPid(terminalId: string): Promise<number | null> {
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.useDtach) {
				// In dtach mode, active.process is the "dtach -a" attach process, not the shell.
				// The actual shell is a child of the "dtach -n" server process.
				const socketPath = dtachService.getSocketPath(terminalId);
				const dtachPids = await findProcessesByArg(socketPath);
				for (const pid of dtachPids) {
					const children = await getDescendantPids(pid);
					if (children.length > 0) return children[0];
				}
				return null;
			}
			return active.runtime.pid ?? null;
		}
		// Detached dtach terminal (not in activeTerminals)
		if ((await dtachService.isAvailable()) && (await dtachService.isSocketAlive(terminalId))) {
			const socketPath = dtachService.getSocketPath(terminalId);
			const dtachPids = await findProcessesByArg(socketPath);
			for (const pid of dtachPids) {
				const children = await getDescendantPids(pid);
				if (children.length > 0) return children[0];
			}
		}
		return null;
	},

	/**
	 * Get process info for a terminal: the shell and all its descendants.
	 */
	async getProcesses(terminalId: string): Promise<TerminalProcessInfo[]> {
		const shellPid = await this.getShellPid(terminalId);
		if (!shellPid) return [];

		const allPids = [shellPid, ...(await getDescendantPids(shellPid))];
		const infoMap = await getProcessInfoBatch(allPids);
		return allPids
			.map((pid) => infoMap.get(pid))
			.filter((info): info is TerminalProcessInfo => info !== undefined);
	},

	/**
	 * Batch-get process info for multiple terminals using a single ps snapshot.
	 * Returns a Map from terminalId to its process list.
	 */
	async getProcessesBatch(
		terminalIds: string[],
		snapshot?: ProcessSnapshot,
	): Promise<Map<string, TerminalProcessInfo[]>> {
		const result = new Map<string, TerminalProcessInfo[]>();
		if (terminalIds.length === 0) return result;

		const snap = snapshot ?? (await ProcessSnapshot.create());

		for (const terminalId of terminalIds) {
			const shellPid = await this._getShellPidWithSnapshot(terminalId, snap);
			if (!shellPid) {
				result.set(terminalId, []);
				continue;
			}
			const allPids = [shellPid, ...snap.getDescendants(shellPid)];
			const processes = allPids
				.map((pid) => snap.getInfo(pid))
				.filter((info): info is TerminalProcessInfo => info !== null);
			result.set(terminalId, processes);
		}
		return result;
	},

	/**
	 * getShellPid variant that uses a pre-built ProcessSnapshot instead of spawning processes.
	 */
	async _getShellPidWithSnapshot(
		terminalId: string,
		snapshot: ProcessSnapshot,
	): Promise<number | null> {
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.useDtach) {
				const socketPath = dtachService.getSocketPath(terminalId);
				const dtachPids = snapshot.findByArg(socketPath);
				for (const pid of dtachPids) {
					const children = snapshot.getChildren(pid);
					if (children.length > 0) return children[0];
				}
				return null;
			}
			return active.runtime.pid ?? null;
		}
		if (await dtachService.isAvailable()) {
			const socketPath = dtachService.getSocketPath(terminalId);
			const dtachPids = snapshot.findByArg(socketPath);
			for (const pid of dtachPids) {
				const children = snapshot.getChildren(pid);
				if (children.length > 0) return children[0];
			}
		}
		return null;
	},

	/**
	 * Graceful shutdown: detach from dtach sessions (keeping them alive)
	 * and kill direct-mode terminals.
	 */
	async shutdownAll() {
		const promises: Promise<void>[] = [];
		for (const [id, active] of activeTerminals) {
			promises.push(
				(async () => {
					try {
						if (active.useDtach) {
							// dtach mode: save buffer and close the attach process,
							// but do NOT kill the dtach session — it should survive restart.
							// DB status stays "running" so recoverOnStartup can find it.
							await active.buffer.saveToDisk();
							active.buffer.stopPeriodicFlush();
							active.runtime.close();
						} else {
							// Direct mode: kill the process and mark as exited
							await active.buffer.dispose(true);
							active.runtime.kill();
							active.runtime.close();
							await markTerminalExited(id, -1);
						}
					} catch {
						// best effort — we're shutting down
					}
				})(),
			);
		}
		await Promise.allSettled(promises);
		const count = activeTerminals.size;
		activeTerminals.clear();
		if (count > 0) {
			logger.info("Shutdown: detached/killed active terminals", { count });
		}
	},
};
