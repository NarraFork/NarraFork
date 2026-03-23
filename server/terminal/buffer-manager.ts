/**
 * Terminal scrollback buffer manager.
 * Uses @xterm/headless + @xterm/addon-serialize to maintain a server-side
 * terminal emulator that fully parses all ANSI/VT sequences. On getContents(),
 * the serialize addon produces a clean state snapshot — no manual regex
 * filtering or alternate-screen tracking needed.
 *
 * IMPORTANT: xterm.js write() is asynchronous (data is queued and processed on
 * the next tick). We wrap it in a promise so that getContents() and resize()
 * always operate on fully-processed state.
 */

import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { logger } from "../lib/logger";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5000;

const ESC = "\x1b";

let _buffersDir: string | null = null;
function getBuffersDir(): string {
	if (_buffersDir) return _buffersDir;
	const dir = resolve(homedir(), ".narrafork", "buffers");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	_buffersDir = dir;
	return dir;
}

interface BufferFileV3 {
	version: 3;
	serialized: string; // base64 encoded serialize addon output
	cols: number;
	rows: number;
	mouseMode: {
		x10: boolean;
		buttonEvent: boolean;
		anyEvent: boolean;
		sgr: boolean;
	};
}

export class BufferManager {
	private terminalId: string;
	private xterm: Terminal;
	private serializeAddon: SerializeAddon;
	private dirty = false;
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Chain of pending xterm.write() calls. The drain loop consumes
	 * pendingWrites in batches so that getContents()/resize()/saveToDisk()
	 * can await full processing before reading state.
	 *
	 * IMPORTANT: Previous implementation chained a new Promise per append()
	 * call, creating an ever-growing Promise chain that held references to
	 * every data string until the chain resolved. Under high-frequency
	 * terminal output (npm install, make, etc.) this caused GB-level memory
	 * leaks. The current batch-drain approach keeps at most one pending
	 * Promise + one pending string array regardless of throughput.
	 */
	private writeChain: Promise<void> = Promise.resolve();

	/** Buffered data waiting to be written to xterm in the next drain cycle. */
	private pendingWrites: string[] = [];

	/** Whether a drain loop is currently scheduled/running. */
	private draining = false;

	/**
	 * Mouse tracking mode state — still tracked manually because the
	 * serialize addon does not serialize mouse mode escape sequences.
	 * xterm-headless parses them but serialize doesn't output them.
	 */
	private mouseMode = {
		x10: false, // ESC[?1000h/l
		buttonEvent: false, // ESC[?1002h/l
		anyEvent: false, // ESC[?1003h/l
		sgr: false, // ESC[?1006h/l
	};

	constructor(terminalId: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
		this.terminalId = terminalId;
		this.xterm = new Terminal({
			cols,
			rows,
			scrollback: DEFAULT_SCROLLBACK,
			allowProposedApi: true,
		});
		this.serializeAddon = new SerializeAddon();
		this.xterm.loadAddon(this.serializeAddon);
	}

	/** Start periodic disk flush (call after creation or restore) */
	startPeriodicFlush(intervalMs = 5000): void {
		this.stopPeriodicFlush();
		this.flushTimer = setInterval(() => {
			if (this.dirty) this.saveToDisk();
		}, intervalMs);
	}

	stopPeriodicFlush(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	append(data: string): void {
		this.trackMouseMode(data);
		this.pendingWrites.push(data);
		this.dirty = true;
		if (!this.draining) this.drain();
	}

	/**
	 * Drain all pendingWrites into xterm in batches.
	 * Joins accumulated strings into a single write() call per iteration,
	 * keeping the Promise chain O(1) instead of O(n) per append().
	 */
	private drain(): void {
		this.draining = true;
		this.writeChain = this.writeChain.then(async () => {
			while (this.pendingWrites.length > 0) {
				const batch = this.pendingWrites.join("");
				this.pendingWrites.length = 0;
				await new Promise<void>((resolve) => this.xterm.write(batch, resolve));
			}
			this.draining = false;
		});
	}

	/** Wait for all pending writes to be processed by the headless xterm */
	async flush(): Promise<void> {
		await this.writeChain;
	}

	/**
	 * Get buffer contents as a clean state snapshot.
	 * Waits for pending writes to complete first.
	 */
	async getContents(): Promise<string> {
		await this.writeChain;
		return this.serializeAddon.serialize({
			scrollback: this.xterm.options.scrollback,
		});
	}

	/** Get current terminal state for client notification */
	getState(): { mouseTracking: boolean; cursorVisible: boolean } {
		const mouseTracking =
			this.mouseMode.x10 ||
			this.mouseMode.buttonEvent ||
			this.mouseMode.anyEvent ||
			this.mouseMode.sgr;
		return { mouseTracking, cursorVisible: true };
	}

	/** Current dimensions of the internal headless terminal */
	get cols(): number {
		return this.xterm.cols;
	}
	get rows(): number {
		return this.xterm.rows;
	}

	/** Resize the internal headless terminal after pending writes complete */
	async resize(cols: number, rows: number): Promise<void> {
		await this.writeChain;
		this.xterm.resize(cols, rows);
	}

	clear(): void {
		this.writeChain = this.writeChain.then(() => {
			this.xterm.reset();
		});
		this.mouseMode = { x10: false, buttonEvent: false, anyEvent: false, sgr: false };
		this.dirty = true;
	}

	saveToDisk(): void {
		// Fire-and-forget: flush then save. The periodic timer will retry if needed.
		this.writeChain
			.then(async () => {
				const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
				const serialized = this.serializeAddon.serialize({
					scrollback: this.xterm.options.scrollback,
				});
				const fileData: BufferFileV3 = {
					version: 3,
					serialized: Buffer.from(serialized).toString("base64"),
					cols: this.xterm.cols,
					rows: this.xterm.rows,
					mouseMode: { ...this.mouseMode },
				};
				await Bun.write(filePath, JSON.stringify(fileData));
				this.dirty = false;
			})
			.catch((err) => {
				logger.error("Failed to save buffer", {
					terminalId: this.terminalId,
					error: String(err),
				});
			});
	}

	async loadFromDisk(): Promise<boolean> {
		const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
		try {
			const file = Bun.file(filePath);
			if (!(await file.exists())) return false;
			const raw = await file.text();
			const parsed = JSON.parse(raw);

			if (parsed.version === 3 && typeof parsed.serialized === "string") {
				const content = Buffer.from(parsed.serialized, "base64").toString();
				if (parsed.cols && parsed.rows) {
					this.xterm.resize(parsed.cols, parsed.rows);
				}
				this.writeChain = this.writeChain.then(
					() => new Promise<void>((resolve) => this.xterm.write(content, resolve)),
				);
				if (parsed.mouseMode) {
					this.mouseMode = { ...parsed.mouseMode };
				}
				logger.debug("Loaded buffer from disk (V3)", {
					terminalId: this.terminalId,
				});
				return true;
			}

			if ((parsed.version === 1 || parsed.version === 2) && typeof parsed.content === "string") {
				const content = Buffer.from(parsed.content, "base64").toString();
				this.writeChain = this.writeChain.then(
					() => new Promise<void>((resolve) => this.xterm.write(content, resolve)),
				);
				if (parsed.mouseMode) {
					this.mouseMode = {
						x10: !!parsed.mouseMode.x10,
						buttonEvent: !!parsed.mouseMode.buttonEvent,
						anyEvent: !!parsed.mouseMode.anyEvent,
						sgr: !!parsed.mouseMode.sgr,
					};
				}
				logger.debug("Loaded buffer from disk (V1/V2 compat)", {
					terminalId: this.terminalId,
				});
				return true;
			}

			return false;
		} catch (err) {
			logger.error("Failed to load buffer", {
				terminalId: this.terminalId,
				error: String(err),
			});
			return false;
		}
	}

	async deleteFromDisk(): Promise<void> {
		const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
		try {
			await unlink(filePath);
		} catch {
			// ignore
		}
	}

	/** Cleanup: stop flush timer, save final state, optionally delete */
	async dispose(deleteBuffer = false): Promise<void> {
		this.stopPeriodicFlush();
		if (deleteBuffer) {
			await this.deleteFromDisk();
		} else if (this.dirty) {
			this.saveToDisk();
		}
		this.xterm.dispose();
	}

	/**
	 * Track mouse mode escape sequences manually.
	 * xterm-headless parses these but the serialize addon doesn't output them,
	 * so we need to maintain this state for the bufferState WS message.
	 */
	private trackMouseMode(data: string): void {
		if (data.includes(`${ESC}[?1000h`)) this.mouseMode.x10 = true;
		if (data.includes(`${ESC}[?1000l`)) this.mouseMode.x10 = false;
		if (data.includes(`${ESC}[?1002h`)) this.mouseMode.buttonEvent = true;
		if (data.includes(`${ESC}[?1002l`)) this.mouseMode.buttonEvent = false;
		if (data.includes(`${ESC}[?1003h`)) this.mouseMode.anyEvent = true;
		if (data.includes(`${ESC}[?1003l`)) this.mouseMode.anyEvent = false;
		if (data.includes(`${ESC}[?1006h`)) this.mouseMode.sgr = true;
		if (data.includes(`${ESC}[?1006l`)) this.mouseMode.sgr = false;
	}
}
