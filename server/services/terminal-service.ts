import type { Subprocess } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, terminals } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { sendToTerminal } from "../websocket/terminal-ws";

const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash";

interface ActiveTerminal {
	process: Subprocess;
	pty: InstanceType<typeof Bun.Terminal>;
	terminalId: string;
	scrollback: string[];
	scrollbackSize: number;
}

const activeTerminals = new Map<string, ActiveTerminal>();
const MAX_SCROLLBACK_SIZE = 100_000; // chars

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

		// Create PTY and spawn shell directly — no dtach intermediary
		const pty = new Bun.Terminal({
			cols,
			rows,
			data(_term, data) {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				if (text) {
					logger.debug("Terminal output", {
						terminalId: id,
						len: text.length,
					});
					const active = activeTerminals.get(id);
					if (active) {
						active.scrollback.push(text);
						active.scrollbackSize += text.length;
						while (active.scrollbackSize > MAX_SCROLLBACK_SIZE && active.scrollback.length > 1) {
							active.scrollbackSize -= active.scrollback[0].length;
							active.scrollback.shift();
						}
					}
					sendToTerminal(id, { type: "output", data: text });
				}
			},
		});

		const proc = Bun.spawn([DEFAULT_SHELL, "-l"], {
			cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
			},
			terminal: pty,
		});

		activeTerminals.set(id, {
			process: proc,
			pty,
			terminalId: id,
			scrollback: [],
			scrollbackSize: 0,
		});

		// Monitor process exit
		proc.exited.then(async (code) => {
			activeTerminals.delete(id);
			pty.close();
			await db
				.update(terminals)
				.set({ status: "exited", exitCode: code ?? 0 })
				.where(eq(terminals.id, id));
			sendToTerminal(id, { type: "exit", code: code ?? 0 });
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
				status: "running",
				createdAt: now,
			})
			.returning();

		logger.info("Terminal created", { id, chapterId, narratorId });
		return terminal;
	},

	write(terminalId: string, data: string) {
		const active = activeTerminals.get(terminalId);
		if (!active) {
			logger.warn("Terminal write: no active terminal", { terminalId });
			return;
		}
		logger.debug("Terminal write", {
			terminalId,
			len: data.length,
			hex: Buffer.from(data).toString("hex").slice(0, 40),
		});
		active.pty.write(new TextEncoder().encode(data));
	},

	resize(terminalId: string, cols: number, rows: number) {
		const active = activeTerminals.get(terminalId);
		if (!active) return;
		active.pty.resize(cols, rows);
		logger.debug("Terminal resized", { terminalId, cols, rows });
	},

	async kill(terminalId: string) {
		const active = activeTerminals.get(terminalId);
		if (active) {
			active.process.kill();
			active.pty.close();
			activeTerminals.delete(terminalId);
		}

		const terminal = await db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
		});
		if (!terminal) throw new NotFoundError("Terminal", terminalId);

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

	async listByNarrator(narratorId: string) {
		return db.query.terminals.findMany({
			where: eq(terminals.narratorId, narratorId),
		});
	},

	getScrollback(terminalId: string): string | null {
		const active = activeTerminals.get(terminalId);
		if (!active || active.scrollback.length === 0) return null;
		return active.scrollback.join("");
	},

	/** On startup, mark any previously-running terminals as exited (no dtach to recover). */
	async recoverOnStartup() {
		const running = await db.query.terminals.findMany({
			where: eq(terminals.status, "running"),
		});
		if (running.length > 0) {
			for (const terminal of running) {
				await db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, terminal.id));
			}
			logger.info("Marked stale terminals as exited", { count: running.length });
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
};
