import type { Subprocess } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, terminals } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { BufferManager } from "../terminal/buffer-manager";
import { dtachService } from "../terminal/dtach-service";
import { sendToTerminal } from "../websocket/terminal-ws";

const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash";

interface ActiveTerminal {
	process: Subprocess;
	pty: InstanceType<typeof Bun.Terminal>;
	terminalId: string;
	buffer: BufferManager;
	useDtach: boolean;
}

const activeTerminals = new Map<string, ActiveTerminal>();

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
			cwd = narrator.cwd ?? process.env.HOME ?? "/tmp";
			if (!narrator.cwd) {
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

		let pty: InstanceType<typeof Bun.Terminal>;
		let proc: Subprocess;
		let dtachSocket: string | null = null;

		if (useDtach) {
			// dtach mode: create detached session, then attach via PTY
			await dtachService.createSession({ terminalId: id, cwd });
			dtachSocket = dtachService.getSocketPath(id);
			const attached = dtachService.attachSession({
				terminalId: id,
				cols,
				rows,
				onData: (text) => onData(id, buffer, text),
			});
			pty = attached.pty;
			proc = attached.proc;
		} else {
			// Direct mode: Bun.Terminal + Bun.spawn
			pty = new Bun.Terminal({
				cols,
				rows,
				data(_term, data) {
					onData(id, buffer, data);
				},
			});
			proc = Bun.spawn([DEFAULT_SHELL, "-l"], {
				cwd,
				env: { ...process.env, TERM: "xterm-256color" },
				terminal: pty,
			});
		}

		activeTerminals.set(id, { process: proc, pty, terminalId: id, buffer, useDtach });

		// Monitor attach process exit
		proc.exited.then(async (code) => {
			const active = activeTerminals.get(id);
			if (!active) return;

			if (useDtach) {
				// In dtach mode, the attach process exiting doesn't mean the shell died.
				// Check if the dtach socket is still alive.
				if (dtachService.isSocketAlive(id)) {
					// Detached — save buffer but keep terminal "running"
					active.buffer.saveToDisk();
					active.pty.close();
					activeTerminals.delete(id);
					logger.info("dtach attach process exited, session still alive", { terminalId: id });
					return;
				}
			}

			// Shell actually exited
			active.buffer.dispose();
			activeTerminals.delete(id);
			pty.close();
			await db
				.update(terminals)
				.set({ status: "exited", exitCode: code ?? 0 })
				.where(eq(terminals.id, id));
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
		return terminal;
	},

	write(terminalId: string, data: string) {
		const active = activeTerminals.get(terminalId);
		if (!active) {
			logger.warn("Terminal write: no active terminal", { terminalId });
			return;
		}
		active.pty.write(new TextEncoder().encode(data));
	},

	resize(terminalId: string, cols: number, rows: number) {
		const active = activeTerminals.get(terminalId);
		if (!active) return;
		active.pty.resize(cols, rows);
	},

	async kill(terminalId: string) {
		const active = activeTerminals.get(terminalId);
		if (active) {
			active.buffer.dispose(true);
			if (active.useDtach) {
				dtachService.killSession(terminalId);
			}
			active.process.kill();
			active.pty.close();
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

		await db
			.update(terminals)
			.set({ status: "exited", exitCode: -1 })
			.where(eq(terminals.id, terminalId));

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

	getScrollback(terminalId: string): string | null {
		const active = activeTerminals.get(terminalId);
		if (active) {
			const contents = active.buffer.getContents();
			return contents || null;
		}
		// Try loading from disk (detached terminal)
		const buf = new BufferManager(terminalId);
		if (buf.loadFromDisk()) {
			return buf.getContents() || null;
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

					const attached = dtachService.attachSession({
						terminalId: terminal.id,
						cols: 80,
						rows: 24,
						onData: (text) => onData(terminal.id, buffer, text),
					});

					activeTerminals.set(terminal.id, {
						process: attached.proc,
						pty: attached.pty,
						terminalId: terminal.id,
						buffer,
						useDtach: true,
					});

					// Monitor attach process
					attached.proc.exited.then(async (code) => {
						const active = activeTerminals.get(terminal.id);
						if (!active) return;
						if (dtachService.isSocketAlive(terminal.id)) {
							active.buffer.saveToDisk();
							active.pty.close();
							activeTerminals.delete(terminal.id);
							return;
						}
						active.buffer.dispose();
						activeTerminals.delete(terminal.id);
						attached.pty.close();
						await db
							.update(terminals)
							.set({ status: "exited", exitCode: code ?? 0 })
							.where(eq(terminals.id, terminal.id));
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
			await db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, terminal.id));
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
};
