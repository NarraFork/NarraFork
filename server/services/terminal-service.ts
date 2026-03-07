import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, terminals } from "../db/schema";
import { detectShell } from "../lib/agent/shell";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { DEV_NULL, getHome, IS_WINDOWS } from "../lib/platform";
import { BufferManager } from "../terminal/buffer-manager";
import { dtachService, findProcessesByArg, getDescendantPids } from "../terminal/dtach-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "../terminal/runtime";
import { spawnBunTerminal } from "../terminal/runtime-bun";
import { spawnPortablePty } from "../terminal/runtime-pty";
import { sendToTerminal } from "../websocket/terminal-ws";

const DEFAULT_SHELL = detectShell();

export interface TerminalProcessInfo {
	pid: number;
	ppid: number;
	command: string;
	state: string;
	rss: number;
	cpu: number;
	elapsed: string;
}

function getProcessInfoByPid(pid: number): TerminalProcessInfo | null {
	try {
		const result = execSync(`ps -o pid=,ppid=,comm=,stat=,rss=,%cpu=,etime= -p ${pid}`, {
			encoding: "utf-8",
			stdio: "pipe",
		});
		const line = result.trim();
		if (!line) return null;
		const parts = line.split(/\s+/);
		if (parts.length < 7) return null;
		return {
			pid: Number.parseInt(parts[0], 10),
			ppid: Number.parseInt(parts[1], 10),
			command: parts[2],
			state: parts[3],
			rss: Number.parseInt(parts[4], 10),
			cpu: Number.parseFloat(parts[5]),
			elapsed: parts[6],
		};
	} catch {
		return null;
	}
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

		if (chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (!chapter.worktreePath) {
				throw new Error("Chapter has no worktree (dormant?)");
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
			throw new Error("Either chapterId or narratorId is required");
		}

		const id = generateId();
		const now = new Date().toISOString();
		const buffer = new BufferManager(id);
		buffer.startPeriodicFlush();
		const useDtach = dtachService.isAvailable();

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

		// Monitor process exit
		runtime.exited.then(async (code) => {
			const active = activeTerminals.get(id);
			if (!active) return;

			if (useDtach) {
				// In dtach mode, the attach process exiting doesn't mean the shell died.
				// Check if the dtach socket is still alive.
				if (dtachService.isSocketAlive(id)) {
					// Detached — save buffer but keep terminal "running"
					active.buffer.saveToDisk();
					active.runtime.close();
					activeTerminals.delete(id);
					logger.info("dtach attach process exited, session still alive", { terminalId: id });
					return;
				}
			}

			// Shell actually exited
			active.buffer.dispose();
			activeTerminals.delete(id);
			runtime.close();
			await markTerminalExited(id, code ?? 0, narratorId ?? null, chapterId ?? null);
			sendToTerminal(id, { type: "exit", terminalId: id, code: code ?? 0 });
			logger.info("Terminal exited", { terminalId: id, code });
		});

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
			active.buffer.dispose(true);
			if (active.useDtach) {
				dtachService.killSession(terminalId);
			}
			active.runtime.kill();
			active.runtime.close();
			activeTerminals.delete(terminalId);
		} else if (dtachService.isAvailable()) {
			// Terminal might be detached (no active entry) but dtach session alive
			if (dtachService.isSocketAlive(terminalId)) {
				dtachService.killSession(terminalId);
			}
			// Clean up buffer file
			const buf = new BufferManager(terminalId);
			buf.deleteFromDisk();
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
	listOrphanSockets(): { socketPath: string; terminalId: string }[] {
		if (!dtachService.isAvailable()) return [];
		const orphans: { socketPath: string; terminalId: string }[] = [];
		try {
			const { readdirSync } = require("node:fs");
			const files: string[] = readdirSync(dtachService.socketsDir);
			for (const file of files) {
				const match = file.match(/^terminal-(.+)\.sock$/);
				if (!match) continue;
				const terminalId = match[1];
				const socketPath = dtachService.getSocketPath(terminalId);
				// Check if the socket is alive but terminal is not in activeTerminals
				if (dtachService.isSocketAlive(terminalId) && !activeTerminals.has(terminalId)) {
					orphans.push({ socketPath, terminalId });
				}
			}
		} catch {
			// sockets dir may not exist
		}
		return orphans;
	},

	/** Kill an orphan dtach socket that has no DB record */
	killOrphanSocket(terminalId: string) {
		dtachService.killSession(terminalId);
		// Clean up buffer file if any
		const buf = new BufferManager(terminalId);
		buf.deleteFromDisk();
	},

	/** Check if a terminal is currently attached (has an active PTY connection) */
	isAttached(terminalId: string): boolean {
		return activeTerminals.has(terminalId);
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
		if (!dtachService.isAvailable()) return false;
		if (!dtachService.isSocketAlive(terminalId)) return false;

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) return false;

		const buffer = new BufferManager(terminalId);
		buffer.loadFromDisk();
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

		// Monitor attach process
		runtime.exited.then(async (code) => {
			const active = activeTerminals.get(terminalId);
			if (!active) return;
			if (dtachService.isSocketAlive(terminalId)) {
				active.buffer.saveToDisk();
				active.runtime.close();
				activeTerminals.delete(terminalId);
				return;
			}
			active.buffer.dispose();
			activeTerminals.delete(terminalId);
			runtime.close();
			await markTerminalExited(terminalId, code ?? 0);
			sendToTerminal(terminalId, {
				type: "exit",
				terminalId,
				code: code ?? 0,
			});
		});

		logger.info("Terminal re-attached", { terminalId });
		return true;
	},

	/**
	 * Re-attach to an orphan dtach socket (no DB record).
	 * Creates a DB record and attaches. Returns the new terminal record.
	 */
	async reattachOrphan(terminalId: string): Promise<unknown> {
		if (!dtachService.isAvailable() || !dtachService.isSocketAlive(terminalId)) {
			throw new Error("dtach socket not alive");
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
		if (!success) throw new Error("Failed to reattach");

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
		if (buf.loadFromDisk()) {
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
		const running = await db.query.terminals.findMany({
			where: eq(terminals.status, "running"),
		});
		if (running.length === 0) return;

		let recovered = 0;
		let marked = 0;

		for (const terminal of running) {
			if (dtachService.isAvailable() && terminal.dtachSocket) {
				// Check if dtach session is still alive
				if (dtachService.isSocketAlive(terminal.id)) {
					// Re-attach to the dtach session
					const buffer = new BufferManager(terminal.id);
					buffer.loadFromDisk();
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

					// Monitor attach process
					runtime.exited.then(async (code) => {
						const active = activeTerminals.get(terminal.id);
						if (!active) return;
						if (dtachService.isSocketAlive(terminal.id)) {
							active.buffer.saveToDisk();
							active.runtime.close();
							activeTerminals.delete(terminal.id);
							return;
						}
						active.buffer.dispose();
						activeTerminals.delete(terminal.id);
						runtime.close();
						await markTerminalExited(
							terminal.id,
							code ?? 0,
							terminal.narratorId,
							terminal.chapterId,
						);
						sendToTerminal(terminal.id, {
							type: "exit",
							terminalId: terminal.id,
							code: code ?? 0,
						});
					});

					recovered++;
					continue;
				}
			}

			// No dtach or socket dead — mark as exited
			await markTerminalExited(terminal.id, null, terminal.narratorId, terminal.chapterId);
			marked++;
		}

		if (recovered > 0) logger.info("Recovered dtach terminals", { count: recovered });
		if (marked > 0) logger.info("Marked stale terminals as exited", { count: marked });
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
	getShellPid(terminalId: string): number | null {
		const active = activeTerminals.get(terminalId);
		if (active) {
			if (active.useDtach) {
				// In dtach mode, active.process is the "dtach -a" attach process, not the shell.
				// The actual shell is a child of the "dtach -n" server process.
				const socketPath = dtachService.getSocketPath(terminalId);
				const dtachPids = findProcessesByArg(socketPath);
				for (const pid of dtachPids) {
					const children = getDescendantPids(pid);
					if (children.length > 0) return children[0];
				}
				return null;
			}
			return active.runtime.pid ?? null;
		}
		// Detached dtach terminal (not in activeTerminals)
		if (dtachService.isAvailable() && dtachService.isSocketAlive(terminalId)) {
			const socketPath = dtachService.getSocketPath(terminalId);
			const dtachPids = findProcessesByArg(socketPath);
			for (const pid of dtachPids) {
				const children = getDescendantPids(pid);
				if (children.length > 0) return children[0];
			}
		}
		return null;
	},

	/**
	 * Get process info for a terminal: the shell and all its descendants.
	 */
	getProcesses(terminalId: string): TerminalProcessInfo[] {
		const shellPid = this.getShellPid(terminalId);
		if (!shellPid) return [];

		const allPids = [shellPid, ...getDescendantPids(shellPid)];
		return allPids
			.map((pid) => getProcessInfoByPid(pid))
			.filter((info): info is TerminalProcessInfo => info !== null);
	},
};
