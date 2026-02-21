/**
 * Terminal scrollback buffer manager.
 * Stores raw terminal output, tracks ANSI state (mouse mode, cursor visibility,
 * alternate screen), and persists to disk for recovery after server restart.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "../lib/logger";

const MAX_BUFFER_CHARS = 1_000_000;
const ESC = "\x1b";

function getBuffersDir(): string {
	const dir = resolve(homedir(), ".narrafork", "buffers");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

interface BufferChunk {
	data: string;
	timestamp: number;
}

interface BufferFileV1 {
	version: 1;
	content: string; // base64 encoded
	mouseMode: {
		x10: boolean;
		buttonEvent: boolean;
		anyEvent: boolean;
		sgr: boolean;
	};
	cursorVisible: boolean;
}

export class BufferManager {
	private chunks: BufferChunk[] = [];
	private totalChars = 0;
	private terminalId: string;
	private dirty = false;
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	/** Mouse tracking mode state — restored on buffer replay */
	private mouseMode = {
		x10: false, // ESC[?1000h/l
		buttonEvent: false, // ESC[?1002h/l
		anyEvent: false, // ESC[?1003h/l
		sgr: false, // ESC[?1006h/l
	};

	/** Cursor visibility (DECTCEM) — TUIs like Claude Code hide the native cursor */
	private cursorVisible = true;

	constructor(terminalId: string) {
		this.terminalId = terminalId;
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
		this.trackTerminalState(data);
		this.chunks.push({ data, timestamp: Date.now() });
		this.totalChars += data.length;
		while (this.totalChars > MAX_BUFFER_CHARS && this.chunks.length > 1) {
			const removed = this.chunks.shift();
			if (removed) this.totalChars -= removed.data.length;
		}
		this.dirty = true;
	}

	private trackTerminalState(data: string): void {
		if (data.includes(`${ESC}[?1000h`)) this.mouseMode.x10 = true;
		if (data.includes(`${ESC}[?1000l`)) this.mouseMode.x10 = false;
		if (data.includes(`${ESC}[?1002h`)) this.mouseMode.buttonEvent = true;
		if (data.includes(`${ESC}[?1002l`)) this.mouseMode.buttonEvent = false;
		if (data.includes(`${ESC}[?1003h`)) this.mouseMode.anyEvent = true;
		if (data.includes(`${ESC}[?1003l`)) this.mouseMode.anyEvent = false;
		if (data.includes(`${ESC}[?1006h`)) this.mouseMode.sgr = true;
		if (data.includes(`${ESC}[?1006l`)) this.mouseMode.sgr = false;
		if (data.includes(`${ESC}[?25h`)) this.cursorVisible = true;
		if (data.includes(`${ESC}[?25l`)) this.cursorVisible = false;
	}

	/** Filter sequences that cause display issues during buffer replay */
	private filterProblematicSequences(data: string): string {
		return (
			data
				// Alternate screen buffer
				.replace(new RegExp(`${ESC}\\[\\?1049[hl]`, "g"), "")
				.replace(new RegExp(`${ESC}\\[\\?47[hl]`, "g"), "")
				.replace(new RegExp(`${ESC}\\[\\?1047[hl]`, "g"), "")
				// DECRQSS responses
				.replace(/\d+;\d+\$y/g, "")
				// CPR (Cursor Position Report) responses
				.replace(new RegExp(`${ESC}\\[\\d+;\\d+R`, "g"), "")
				// DA (Device Attributes) responses
				.replace(new RegExp(`${ESC}\\[[\\?>\\d;]*c`, "g"), "")
		);
	}

	/** Get buffer contents for replay, with state restoration */
	getContents(): string {
		const raw = this.chunks.map((c) => c.data).join("");
		let output = this.filterProblematicSequences(raw);
		// Restore cursor visibility if hidden (TUIs hide native cursor)
		if (!this.cursorVisible) {
			output = `${ESC}[?25l${output}`;
		}
		return output;
	}

	/** Get current terminal state for client notification */
	getState(): { mouseTracking: boolean; cursorVisible: boolean } {
		const mouseTracking =
			this.mouseMode.x10 ||
			this.mouseMode.buttonEvent ||
			this.mouseMode.anyEvent ||
			this.mouseMode.sgr;
		return { mouseTracking, cursorVisible: this.cursorVisible };
	}

	clear(): void {
		this.chunks = [];
		this.totalChars = 0;
		this.mouseMode = { x10: false, buttonEvent: false, anyEvent: false, sgr: false };
		this.cursorVisible = true;
		this.dirty = true;
	}

	saveToDisk(): void {
		const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
		try {
			const raw = this.chunks.map((c) => c.data).join("");
			const content = this.filterProblematicSequences(raw);
			const fileData: BufferFileV1 = {
				version: 1,
				content: Buffer.from(content).toString("base64"),
				mouseMode: { ...this.mouseMode },
				cursorVisible: this.cursorVisible,
			};
			writeFileSync(filePath, JSON.stringify(fileData), "utf-8");
			this.dirty = false;
		} catch (err) {
			logger.error("Failed to save buffer", { terminalId: this.terminalId, error: String(err) });
		}
	}

	loadFromDisk(): boolean {
		const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
		try {
			if (!existsSync(filePath)) return false;
			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed.version === 1 && typeof parsed.content === "string") {
				const content = Buffer.from(parsed.content, "base64").toString();
				this.chunks = [{ data: content, timestamp: Date.now() }];
				this.totalChars = content.length;
				if (parsed.mouseMode) {
					this.mouseMode = {
						x10: !!parsed.mouseMode.x10,
						buttonEvent: !!parsed.mouseMode.buttonEvent,
						anyEvent: !!parsed.mouseMode.anyEvent,
						sgr: !!parsed.mouseMode.sgr,
					};
				}
				this.cursorVisible = parsed.cursorVisible !== false;
				logger.debug("Loaded buffer from disk", {
					terminalId: this.terminalId,
					bytes: this.totalChars,
				});
				return true;
			}
			return false;
		} catch (err) {
			logger.error("Failed to load buffer", { terminalId: this.terminalId, error: String(err) });
			return false;
		}
	}

	deleteFromDisk(): void {
		const filePath = join(getBuffersDir(), `${this.terminalId}.buf`);
		try {
			if (existsSync(filePath)) unlinkSync(filePath);
		} catch {
			// ignore
		}
	}

	/** Cleanup: stop flush timer, save final state, optionally delete */
	dispose(deleteBuffer = false): void {
		this.stopPeriodicFlush();
		if (deleteBuffer) {
			this.deleteFromDisk();
		} else if (this.dirty) {
			this.saveToDisk();
		}
	}
}
