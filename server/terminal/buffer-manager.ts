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
import { join } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { type IBuffer, type IMarker, Terminal } from "@xterm/headless";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5000;

const ESC = "\x1b";

let _buffersDir: string | null = null;
function getBuffersDir(): string {
	if (_buffersDir) return _buffersDir;
	const dir = getNarraforkPath("buffers");
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

/**
 * Bytes the VT parser must send back to the program it is emulating.
 *
 * Not every escape sequence a program sends is purely visual: DA, DSR
 * (`CSI 6n`, the cursor position report), DECRPM and DECRQSS all expect an
 * answer on stdin. A program that asks and waits — atuin's
 * inline search UI, codex CLI, nushell/reedline — blocks until its own
 * timeout expires (crossterm waits ~2s) and then reports
 * "The cursor position could not be read within a normal duration".
 */
export interface BufferReadCursor {
	readonly marker: IMarker;
	/** Last populated row already included in the snapshot; follows row moves. */
	readonly observedEndMarker?: IMarker;
	readonly prefixUnknown: boolean;
	dispose(): void;
	readonly offset: number;
	readonly textBefore: string;
	readonly sequence: number;
	/** Current layout; resize retains old frames and replaces the live markers. */
	readonly columns: number;
	readonly layoutRevision: number;
}

export const MAX_BUFFER_READ_CURSORS = 256;
export const MAX_CURSOR_PENDING_FRAMES = 32;
export const MAX_LAYOUT_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_LAYOUT_SCAN_CELLS = 4_000_000;
export const MAX_LAYOUT_VIEW_CHARACTERS = 256 * 1024;

export type BufferReadFrame =
	| {
			kind: "snapshot";
			text: string;
			markerLost: boolean;
			observedPrefixEnd?: number;
			prefixUnknown?: boolean;
	  }
	| { kind: "baseline"; text: string }
	| { kind: "error"; message: string };

interface LayoutView {
	text: string;
	starts: number[];
	ends: number[];
	bytes: number;
	refs: number;
}
interface PendingFrame {
	view: LayoutView;
	start: number;
	kind: "snapshot" | "baseline";
	markerLost: boolean;
	observedPrefixEnd?: number;
	prefixUnknown?: boolean;
}
interface ReadCursorState {
	marker: IMarker;
	/** Clones must preserve a naturally lost start despite owning a fresh marker. */
	markerLost?: boolean;
	observedEndMarker?: IMarker;
	prefixUnknown: boolean;
	columns: number;
	layoutRevision: number;
	pending: PendingFrame[];
	error?: string;
}

export type BufferReadObserver = (cursor: BufferReadCursor | undefined, sequence: number) => void;

export interface BufferManagerOptions {
	/**
	 * Receives parser replies, ready to be written to the PTY. Not called
	 * while a saved snapshot is being replayed (see {@link replay}) or after
	 * {@link BufferManager.dispose}: that byte stream is history, and answering
	 * queries inside it would inject stray characters into a live shell.
	 */
	onReply?: (data: string) => void;
	/**
	 * Runs once before the headless terminal is disposed, while its contents can
	 * still be read. Terminal watches use it for a last match on the final output.
	 */
	beforeDispose?: () => Promise<void> | void;
}

/**
 * Plain text of the normal buffer from row `start` to the end. Soft-wrapped rows
 * are joined without a line break, so a long line reads as one line.
 */
export function joinBufferLines(
	buffer: IBuffer,
	start: number,
	endRow = buffer.length,
	trimTrailingEmpty = true,
): string {
	const lines: string[] = [];
	let current = "";
	for (let y = Math.max(0, start); y < Math.min(endRow, buffer.length); y++) {
		const line = buffer.getLine(y);
		if (!line) break;
		const continues = buffer.getLine(y + 1)?.isWrapped ?? false;
		// A row that continues onto the next keeps its trailing spaces: they are content.
		current += line.translateToString(!continues);
		if (!continues) {
			lines.push(current);
			current = "";
		}
	}
	if (current) lines.push(current);
	// A partial observed prefix must retain blank rows/newlines that are still
	// present before subsequent new output; otherwise its boundary moves backwards.
	if (!trimTrailingEmpty) return lines.join("\n");
	// Rows below the cursor are blank until output reaches them.
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end).join("\n");
}

export class BufferManager {
	private terminalId: string;
	private xterm: Terminal;
	private serializeAddon: SerializeAddon;
	private dirty = false;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private onReply: ((data: string) => void) | undefined;
	private beforeDispose: (() => Promise<void> | void) | undefined;
	/** True while a restored snapshot is being fed to the parser (replies muted). */
	private replaying = false;
	/** True once dispose() ran, so late parser replies cannot touch a dead PTY. */
	private disposed = false;

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
	private readSequence = 0;
	private layoutSequence = 0;
	private readonly ownedReadCursors = new Map<BufferReadCursor, ReadCursorState>();
	private layoutSnapshotBytes = 0;
	/** At most one bounded live view; shared by reads until parser/layout mutation. */
	private currentReadView: LayoutView | undefined;

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

	constructor(
		terminalId: string,
		cols = DEFAULT_COLS,
		rows = DEFAULT_ROWS,
		options: BufferManagerOptions = {},
	) {
		this.terminalId = terminalId;
		this.onReply = options.onReply;
		this.beforeDispose = options.beforeDispose;
		this.xterm = new Terminal({
			cols,
			rows,
			scrollback: DEFAULT_SCROLLBACK,
			allowProposedApi: true,
		});
		this.serializeAddon = new SerializeAddon();
		this.xterm.loadAddon(this.serializeAddon);
		// The headless terminal keeps its own cursor state, parsed from the same
		// byte stream as the browser and with the same dimensions, so it can
		// answer queries with no round trip to a client.
		this.xterm.onData((data) => {
			if (this.replaying || this.disposed) return;
			try {
				this.onReply?.(data);
			} catch (err) {
				// A reply is best-effort: a PTY that has already closed must not
				// abort the parser write, which would reject writeChain and take
				// getContents()/resize()/saveToDisk() down with it.
				logger.debug("Dropped terminal reply", {
					terminalId: this.terminalId,
					error: String(err),
				});
			}
		});
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
		this.setCurrentReadView(undefined);
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
				this.setCurrentReadView(undefined);
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
	async getContents(observe?: BufferReadObserver): Promise<string> {
		await this.writeChain;
		const contents = this.serializeAddon.serialize({
			scrollback: this.xterm.options.scrollback,
		});
		if (observe) {
			// No await between serialization and the point: later parsed output must
			// remain after this frontier even if permission checks delay the response.
			const sequence = ++this.readSequence;
			const cursor = this.captureReadCursor(sequence);
			try {
				observe(cursor, sequence);
			} catch (error) {
				cursor?.dispose();
				throw error;
			}
		}
		return contents;
	}

	private captureReadCursor(sequence: number): BufferReadCursor | undefined {
		if (
			this.disposed ||
			this.xterm.buffer.active.type !== "normal" ||
			this.ownedReadCursors.size >= MAX_BUFFER_READ_CURSORS
		)
			return undefined;
		const marker = this.xterm.registerMarker(0);
		if (!marker) return undefined;
		const normal = this.xterm.buffer.normal;
		let last = normal.length - 1;
		while (last > marker.line && !normal.getLine(last)?.translateToString(true)) last--;
		const observedEndMarker =
			last === marker.line
				? marker
				: this.xterm.registerMarker(last - (normal.baseY + normal.cursorY));
		if (!observedEndMarker) {
			marker.dispose();
			return undefined;
		}
		const textBefore = joinBufferLines(normal, marker.line);
		return this.createReadCursor(
			{
				marker,
				observedEndMarker,
				prefixUnknown: false,
				columns: this.xterm.cols,
				layoutRevision: this.layoutSequence,
				pending: [],
			},
			textBefore,
			textBefore.length,
			sequence,
		);
	}

	/** A fresh future-only point, captured with its baseline in one synchronous step. */
	async markReadCursor(): Promise<BufferReadCursor | undefined> {
		await this.writeChain;
		return this.captureReadCursor(++this.readSequence);
	}

	/** The watch owns the clone; disposing it must not consume the stored observation. */
	cloneReadCursor(source: BufferReadCursor): BufferReadCursor | undefined {
		if (
			this.disposed ||
			this.xterm.buffer.active.type !== "normal" ||
			!this.ownedReadCursors.has(source) ||
			this.ownedReadCursors.size >= MAX_BUFFER_READ_CURSORS
		)
			return undefined;
		const original = this.ownedReadCursors.get(source);
		if (!original) return undefined;
		const normal = this.xterm.buffer.normal;
		const lost = original.markerLost || source.marker.isDisposed || source.marker.line < 0;
		const line = lost ? 0 : source.marker.line;
		const marker = this.xterm.registerMarker(line - (normal.baseY + normal.cursorY));
		if (!marker) return undefined;
		const end = source.observedEndMarker;
		const endLost = !end || end.isDisposed || end.line < 0;
		const observedEndMarker = endLost
			? undefined
			: end.line === line
				? marker
				: this.xterm.registerMarker(end.line - (normal.baseY + normal.cursorY));
		if (!endLost && !observedEndMarker) {
			marker.dispose();
			return undefined;
		}
		const pending = original.pending.slice();
		for (const frame of pending) this.retainView(frame.view);
		return this.createReadCursor(
			{
				marker,
				markerLost: lost,
				observedEndMarker,
				prefixUnknown: !(lost && endLost) && (source.prefixUnknown || lost),
				columns: source.columns,
				layoutRevision: source.layoutRevision,
				pending,
				error: original.error,
			},
			source.textBefore,
			source.offset,
			source.sequence,
		);
	}

	private createReadCursor(
		state: ReadCursorState,
		textBefore: string,
		offset: number,
		sequence: number,
	): BufferReadCursor {
		const cursor: BufferReadCursor = {
			get marker() {
				return state.marker;
			},
			get observedEndMarker() {
				return state.observedEndMarker;
			},
			get prefixUnknown() {
				return state.prefixUnknown;
			},
			get columns() {
				return state.columns;
			},
			get layoutRevision() {
				return state.layoutRevision;
			},
			textBefore,
			offset,
			sequence,
			dispose: () => {
				if (!this.ownedReadCursors.delete(cursor)) return;
				this.disposeStateMarkers(state);
				for (const frame of state.pending) this.releaseView(frame.view);
				state.pending.length = 0;
				if (this.ownedReadCursors.size === 0) this.setCurrentReadView(undefined);
			},
		};
		this.ownedReadCursors.set(cursor, state);
		return cursor;
	}

	private disposeStateMarkers(state: ReadCursorState): void {
		state.marker.dispose();
		if (state.observedEndMarker !== state.marker) state.observedEndMarker?.dispose();
	}

	private setCurrentReadView(view: LayoutView | undefined): void {
		if (this.currentReadView === view) return;
		if (this.currentReadView) this.releaseView(this.currentReadView);
		this.currentReadView = view;
		if (view) this.retainView(view);
	}

	private retainView(view: LayoutView): void {
		if (view.refs++ === 0) this.layoutSnapshotBytes += view.bytes;
	}

	private releaseView(view: LayoutView): void {
		if (--view.refs === 0) this.layoutSnapshotBytes -= view.bytes;
	}

	/** One bounded scan per layout, shared by every cursor and clone. */
	private captureLayout(budget: { cells: number }): LayoutView {
		const normal = this.xterm.buffer.normal;
		const cells = normal.length * this.xterm.cols;
		if (cells > budget.cells) throw new Error("Terminal cursor layout scan budget exceeded");
		budget.cells -= cells;
		const starts: number[] = [];
		const ends: number[] = [];
		const pieces: string[] = [];
		let length = 0;
		for (let y = 0; y < normal.length; y++) {
			starts.push(length);
			const continues = normal.getLine(y + 1)?.isWrapped ?? false;
			const row = normal.getLine(y)?.translateToString(!continues) ?? "";
			length += row.length;
			ends.push(length);
			pieces.push(row);
			if (!continues && y + 1 < normal.length) {
				pieces.push("\n");
				length++;
			}
			if (length > MAX_LAYOUT_VIEW_CHARACTERS)
				throw new Error("Terminal cursor layout view character budget exceeded");
		}
		const text = pieces.join("").replace(/\n+$/, "");
		// Account for UTF-16 plus row offset storage, conservatively.
		return { text, starts, ends, refs: 0, bytes: length * 2 + starts.length * 16 };
	}

	private snapshotFrame(state: ReadCursorState, view: LayoutView): PendingFrame {
		const lost = state.markerLost || state.marker.isDisposed || state.marker.line < 0;
		const row = lost ? 0 : state.marker.line;
		const start = Math.min(view.text.length, view.starts[row] ?? view.text.length);
		const end = state.observedEndMarker;
		const endLost = !end || end.isDisposed || end.line < 0;
		return {
			kind: "snapshot",
			view,
			start,
			markerLost: lost,
			prefixUnknown: state.prefixUnknown,
			observedPrefixEnd:
				!endLost && end.line >= row
					? Math.max(0, (view.ends[end.line] ?? start) - start)
					: lost && endLost
						? 0
						: undefined,
		};
	}

	private enqueueFrame(state: ReadCursorState, frame: PendingFrame): void {
		if (state.error) return;
		if (state.pending.length >= MAX_CURSOR_PENDING_FRAMES) {
			state.error = "Terminal cursor pending frame budget exceeded";
			return;
		}
		if (
			frame.view.refs === 0 &&
			this.layoutSnapshotBytes + frame.view.bytes > MAX_LAYOUT_SNAPSHOT_BYTES
		) {
			state.error = "Terminal cursor shared layout byte budget exceeded";
			return;
		}
		this.retainView(frame.view);
		state.pending.push(frame);
	}

	private materializeFrame(frame: PendingFrame): BufferReadFrame {
		const text = () => frame.view.text.slice(frame.start);
		if (frame.kind === "baseline")
			return {
				kind: "baseline",
				get text() {
					return text();
				},
			};
		return {
			kind: "snapshot",
			get text() {
				return text();
			},
			markerLost: frame.markerLost,
			observedPrefixEnd: frame.observedPrefixEnd,
			prefixUnknown: frame.prefixUnknown,
		};
	}

	/** Consume retained layout checkpoints before inspecting the current parsed layout. */
	async readCursor(cursor: BufferReadCursor): Promise<BufferReadFrame[]> {
		await this.writeChain;
		const state = this.ownedReadCursors.get(cursor);
		if (!state) return [{ kind: "error", message: "Terminal cursor is not owned by this buffer" }];
		const frames = state.pending.splice(0).map((frame) => {
			const result = this.materializeFrame(frame);
			this.releaseView(frame.view);
			return result;
		});
		if (!state.error) {
			try {
				const view = this.currentReadView ?? this.captureLayout({ cells: MAX_LAYOUT_SCAN_CELLS });
				if (view.refs === 0 && this.layoutSnapshotBytes + view.bytes > MAX_LAYOUT_SNAPSHOT_BYTES) {
					throw new Error("Terminal cursor shared layout byte budget exceeded");
				}
				this.setCurrentReadView(view);
				frames.push(this.materializeFrame(this.snapshotFrame(state, view)));
			} catch (error) {
				state.error = String(error);
			}
		}
		if (state.error) frames.push({ kind: "error", message: state.error });
		return frames;
	}

	/**
	 * Mark the cursor row of the normal buffer, after pending output is parsed.
	 * The marker follows its row as output scrolls and is disposed once the row
	 * leaves the scrollback. Returns undefined while a full-screen app has the
	 * alternate buffer active, or after dispose.
	 */
	async markCursorRow(): Promise<IMarker | undefined> {
		await this.writeChain;
		if (this.disposed || this.xterm.buffer.active.type !== "normal") return undefined;
		return this.xterm.registerMarker(0);
	}

	/**
	 * Plain text of the normal buffer from `marker`'s row to the end, or the whole
	 * normal buffer when the marker is gone (`markerLost`: everything still in the
	 * buffer was written after it). Reads only the rows it returns.
	 */
	async readFromMarker(
		marker: IMarker,
		observedEndMarker?: IMarker,
	): Promise<{ text: string; markerLost: boolean; observedPrefixEnd?: number }> {
		await this.writeChain;
		if (this.disposed) return { text: "", markerLost: true, observedPrefixEnd: 0 };
		const normal = this.xterm.buffer.normal;
		const lost = marker.isDisposed || marker.line < 0;
		const start = lost ? 0 : marker.line;
		let observedPrefixEnd: number | undefined;
		if (observedEndMarker) {
			const endLost = observedEndMarker.isDisposed || observedEndMarker.line < 0;
			if (!endLost && observedEndMarker.line >= start) {
				observedPrefixEnd = joinBufferLines(
					normal,
					start,
					observedEndMarker.line + 1,
					false,
				).length;
			} else if (lost && endLost) {
				observedPrefixEnd = 0;
			}
		}
		return {
			text: joinBufferLines(normal, start),
			markerLost: lost,
			observedPrefixEnd,
		};
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

	/** Revision is monotonic even when a later resize restores the original columns. */
	get layoutRevision(): number {
		return this.layoutSequence;
	}

	/** Resize the internal headless terminal after pending writes complete */
	async resize(cols: number, rows: number): Promise<void> {
		await this.writeChain;
		if (this.disposed || (cols === this.xterm.cols && rows === this.xterm.rows)) return;
		this.setCurrentReadView(undefined);
		const states = [...this.ownedReadCursors.values()].filter((state) => !state.error);
		const budget = { cells: MAX_LAYOUT_SCAN_CELLS };
		if (states.length) {
			try {
				const view = this.captureLayout(budget);
				for (const state of states) this.enqueueFrame(state, this.snapshotFrame(state, view));
			} catch (error) {
				for (const state of states) state.error = String(error);
			}
		}
		this.layoutSequence++;
		this.xterm.resize(cols, rows);
		if (!states.some((state) => !state.error)) return;
		try {
			const view = this.captureLayout(budget);
			const normal = this.xterm.buffer.normal;
			const cursorRow = normal.baseY + normal.cursorY;
			// A match may begin on any earlier logical line (for example RE\nADY).
			// Reflow cannot reliably map the old frontier, so rebaseline the entire
			// retained normal buffer; baseline match counts exclude all old history.
			const startRow = 0;
			let endRow = normal.length - 1;
			while (endRow > startRow && (view.starts[endRow] ?? 0) >= view.text.length) endRow--;
			for (const state of states) {
				if (state.error) continue;
				// Old markers were frozen before reflow; never interpret their disposal as new output.
				this.disposeStateMarkers(state);
				const marker = this.xterm.registerMarker(startRow - cursorRow);
				const end = endRow === startRow ? marker : this.xterm.registerMarker(endRow - cursorRow);
				if (!marker || !end) {
					marker?.dispose();
					end?.dispose();
					state.error = "Terminal cursor could not register layout markers";
					continue;
				}
				state.marker = marker;
				state.markerLost = false;
				state.observedEndMarker = end;
				state.prefixUnknown = false;
				state.columns = this.xterm.cols;
				state.layoutRevision = this.layoutSequence;
				this.enqueueFrame(state, {
					kind: "baseline",
					view,
					start: Math.min(view.text.length, view.starts[startRow] ?? 0),
					markerLost: false,
				});
			}
		} catch (error) {
			for (const state of states) if (!state.error) state.error = String(error);
		}
	}

	clear(): void {
		this.writeChain = this.writeChain.then(() => {
			this.setCurrentReadView(undefined);
			this.xterm.reset();
		});
		this.mouseMode = { x10: false, buttonEvent: false, anyEvent: false, sgr: false };
		this.dirty = true;
	}

	/**
	 * Save buffer to disk. Returns a promise that resolves with the number of
	 * bytes written. Callers that need durability (e.g. shutdown) should await
	 * the returned promise.
	 */
	saveToDisk(): Promise<number> {
		const p = this.writeChain
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
				const written = await Bun.write(filePath, JSON.stringify(fileData));
				this.dirty = false;
				return written;
			})
			.catch((err) => {
				logger.error("Failed to save buffer", {
					terminalId: this.terminalId,
					error: String(err),
				});
				return 0;
			});
		// Store the promise so that subsequent writeChain consumers wait for it.
		this.writeChain = p.then(() => {});
		return p;
	}

	/**
	 * Feed a restored snapshot to the parser with replies muted.
	 *
	 * A snapshot is history, not a live program: it may contain the very
	 * sequences that expect an answer (`serialize` emits cursor moves, and can
	 * emit whatever the program once printed). Answering them would push stray
	 * bytes into the shell's input, so the parser speaks only for live output.
	 */
	private replay(content: string): Promise<void> {
		this.setCurrentReadView(undefined);
		this.replaying = true;
		return new Promise<void>((resolve) => {
			try {
				this.xterm.write(content, () => {
					this.replaying = false;
					resolve();
				});
			} catch (err) {
				// A throw here used to leave `replaying` set, so every later
				// query on this terminal stayed silent. Unmute and let the
				// write chain continue.
				this.replaying = false;
				logger.debug("Dropped terminal snapshot replay", {
					terminalId: this.terminalId,
					error: String(err),
				});
				resolve();
			}
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
				this.writeChain = this.writeChain.then(() => this.replay(content));
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
				this.writeChain = this.writeChain.then(() => this.replay(content));
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
		const beforeDispose = this.beforeDispose;
		this.beforeDispose = undefined;
		try {
			await beforeDispose?.();
		} catch (err) {
			logger.warn("Terminal beforeDispose hook failed", {
				terminalId: this.terminalId,
				error: String(err),
			});
		}
		if (deleteBuffer) {
			await this.deleteFromDisk();
		} else if (this.dirty) {
			await this.saveToDisk();
		}
		this.disposed = true;
		for (const cursor of this.ownedReadCursors.keys()) cursor.dispose();
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
