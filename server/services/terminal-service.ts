import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { Subprocess } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, terminals } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { sendToTerminal } from "../websocket/terminal-ws";

const SOCKET_DIR = "/tmp/narrafork/terminals";
const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash";

interface ActiveTerminal {
	process: Subprocess;
	socketPath: string;
	terminalId: string;
}

const activeTerminals = new Map<string, ActiveTerminal>();

export const terminalService = {
	async create(chapterId: string, name?: string, cols = 80, rows = 24) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, chapterId),
		});
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (!chapter.worktreePath) {
			throw new Error("Chapter has no worktree (dormant?)");
		}

		const id = generateId();
		const now = new Date().toISOString();
		const socketPath = `${SOCKET_DIR}/${id}.sock`;

		// Ensure socket directory exists
		mkdirSync(SOCKET_DIR, { recursive: true });

		// Spawn dtach to create a detached session with a real PTY
		const createProc = Bun.spawn(["dtach", "-n", socketPath, "-E", "-r", "none", DEFAULT_SHELL], {
			cwd: chapter.worktreePath,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLUMNS: String(cols),
				LINES: String(rows),
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		await createProc.exited;

		// Wait briefly for socket to appear
		await Bun.sleep(100);
		if (!existsSync(socketPath)) {
			throw new Error(`dtach socket not created at ${socketPath}`);
		}

		const [terminal] = await db
			.insert(terminals)
			.values({
				id,
				chapterId,
				name: name ?? "Terminal",
				cwd: chapter.worktreePath,
				dtachSocket: socketPath,
				status: "running",
				createdAt: now,
			})
			.returning();

		logger.info("Terminal created", { id, chapterId, socketPath });

		// Attach to start piping I/O
		await this.attach(id);
		return terminal;
	},

	async attach(terminalId: string) {
		if (activeTerminals.has(terminalId)) return;

		const terminal = await this.getById(terminalId);
		if (!terminal.dtachSocket || !existsSync(terminal.dtachSocket)) {
			await db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, terminalId));
			return;
		}

		const proc = Bun.spawn(["dtach", "-a", terminal.dtachSocket, "-E", "-r", "none"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		activeTerminals.set(terminalId, {
			process: proc,
			socketPath: terminal.dtachSocket,
			terminalId,
		});

		// Pipe stdout to WebSocket clients
		this._pipeOutput(terminalId, proc);

		logger.info("Terminal attached", { terminalId });
	},

	/** @internal Pipe subprocess stdout to WS clients, handle exit */
	_pipeOutput(terminalId: string, proc: Subprocess) {
		const stdout = proc.stdout;
		if (!stdout) return;

		const reader = (stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();

		(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					if (text) {
						sendToTerminal(terminalId, { type: "output", data: text });
					}
				}
			} catch (err) {
				logger.debug("Terminal stdout ended", { terminalId, error: String(err) });
			}
		})();

		// Monitor process exit
		proc.exited.then(async (code) => {
			activeTerminals.delete(terminalId);
			await db
				.update(terminals)
				.set({ status: "exited", exitCode: code ?? 0 })
				.where(eq(terminals.id, terminalId));
			sendToTerminal(terminalId, { type: "exit", code: code ?? 0 });
			logger.info("Terminal exited", { terminalId, code });
		});
	},

	write(terminalId: string, data: string) {
		const active = activeTerminals.get(terminalId);
		const stdin = active?.process.stdin;
		if (!stdin || typeof stdin === "number") return;
		stdin.write(new TextEncoder().encode(data));
	},

	resize(terminalId: string, cols: number, rows: number) {
		// dtach manages the PTY master; resize through pipes requires
		// direct Unix socket communication with MSG_WINCH packets.
		// For now, store the size — a future enhancement can implement
		// dtach wire protocol for proper resize.
		logger.debug("Terminal resize requested (stored only)", { terminalId, cols, rows });
	},

	async kill(terminalId: string) {
		const active = activeTerminals.get(terminalId);
		if (active) {
			active.process.kill();
			activeTerminals.delete(terminalId);
		}

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) throw new NotFoundError("Terminal", terminalId);

		// Clean up dtach socket
		if (terminal.dtachSocket && existsSync(terminal.dtachSocket)) {
			try {
				unlinkSync(terminal.dtachSocket);
			} catch {
				// socket may already be gone
			}
		}

		await db
			.update(terminals)
			.set({ status: "exited", exitCode: -1 })
			.where(eq(terminals.id, terminalId));

		sendToTerminal(terminalId, { type: "exit", code: -1 });
		logger.info("Terminal killed", { terminalId });
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

	async recoverOnStartup() {
		const running = await db.query.terminals.findMany({
			where: eq(terminals.status, "running"),
		});
		let recovered = 0;
		let stale = 0;
		for (const terminal of running) {
			if (terminal.dtachSocket && existsSync(terminal.dtachSocket)) {
				try {
					await this.attach(terminal.id);
					recovered++;
				} catch (err) {
					logger.warn("Failed to recover terminal", {
						terminalId: terminal.id,
						error: String(err),
					});
				}
			} else {
				await db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, terminal.id));
				stale++;
			}
		}
		if (running.length > 0) {
			logger.info("Terminal recovery complete", { recovered, stale });
		}
	},

	async cleanupForChapter(chapterId: string) {
		const chapterTerminals = await db.query.terminals.findMany({
			where: eq(terminals.chapterId, chapterId),
		});
		for (const terminal of chapterTerminals) {
			if (terminal.status === "running") {
				try {
					await this.kill(terminal.id);
				} catch {
					// best effort
				}
			}
		}
		await db.delete(terminals).where(eq(terminals.chapterId, chapterId));
	},
};
