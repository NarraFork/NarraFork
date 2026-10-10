import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Badge,
	Box,
	Group,
	Paper,
	Portal,
	Text,
	useComputedColorScheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconClipboard, IconKeyboard } from "@tabler/icons-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useTerminalWS } from "../../hooks/useTerminalWS";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { copyTextToClipboard } from "../../lib/clipboard";
import { Z } from "../../lib/z-index";
import { SelectionPopover } from "../common/SelectionPopover";
import { setupOsc52Handler } from "./osc52-handler";
import { type Modifiers, TerminalAuxKeys } from "./TerminalAuxKeys";
import { getTerminalTheme } from "./terminal-theme";

export const TERM_BG = "#1a1b26"; // Default fallback, actual bg comes from theme

const HANDLE_SIZE = 20;
const HANDLE_COLOR = "#4c6ef5"; // Mantine indigo
const TERMINAL_OUTPUT_FLUSH_FALLBACK_MS = 250;
const TERMINAL_SCROLLBACK_LINES = 2_000;
const TERMINAL_PENDING_BUFFER_MAX_CHARS = 1_000_000;
const TERMINAL_SELECTION_STATE_MAX_CHARS = 10_000;

function trimTerminalBufferText(data: string): string {
	return data.length > TERMINAL_PENDING_BUFFER_MAX_CHARS
		? data.slice(-TERMINAL_PENDING_BUFFER_MAX_CHARS)
		: data;
}

/** Teardrop-shaped selection handle rendered as an absolutely positioned element */
function SelectionHandleEl({
	pos,
	side,
	onDragStart,
}: {
	pos: { x: number; y: number } | null;
	side: "start" | "end";
	onDragStart: () => void;
}) {
	if (!pos) return null;
	const isStart = side === "start";
	return (
		<div
			onTouchStart={(e) => {
				e.stopPropagation();
				onDragStart();
			}}
			style={{
				position: "absolute",
				left: pos.x - HANDLE_SIZE / 2,
				top: pos.y,
				width: HANDLE_SIZE,
				height: HANDLE_SIZE,
				zIndex: 10,
				touchAction: "none",
				cursor: "grab",
			}}
		>
			{/* Vertical line connecting to text */}
			<div
				style={{
					position: "absolute",
					left: HANDLE_SIZE / 2 - 1,
					top: -4,
					width: 2,
					height: 6,
					backgroundColor: HANDLE_COLOR,
					borderRadius: 1,
				}}
			/>
			{/* Teardrop circle */}
			<div
				style={{
					width: HANDLE_SIZE,
					height: HANDLE_SIZE,
					borderRadius: isStart
						? `${HANDLE_SIZE / 2}px ${HANDLE_SIZE / 2}px 0 ${HANDLE_SIZE / 2}px`
						: `${HANDLE_SIZE / 2}px ${HANDLE_SIZE / 2}px ${HANDLE_SIZE / 2}px 0`,
					backgroundColor: HANDLE_COLOR,
					transform: isStart ? "rotate(-45deg)" : "rotate(45deg)",
					transformOrigin: "center",
				}}
			/>
		</div>
	);
}

/** Convert a character to its Ctrl equivalent (Ctrl+C = \x03, etc.) */
function ctrlChar(ch: string): string {
	const code = ch.toUpperCase().charCodeAt(0);
	if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
	return ch;
}

export interface TerminalPanelHandle {
	writeToTerminal: (text: string) => void;
}

interface TerminalPanelProps {
	terminalId: string;
	onSendToChat?: (text: string) => void;
	onExit?: (code: number) => void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
	function TerminalPanel({ terminalId, onSendToChat, onExit }, ref) {
		const containerRef = useRef<HTMLDivElement>(null);
		const termRef = useRef<Terminal | null>(null);
		const fitAddonRef = useRef<FitAddon | null>(null);
		const { t } = useTranslation("terminal");
		const { data: prefs } = useUserPreferences();
		const [oledMode] = useLocalPref("narrafork_oled");
		const computedScheme = useComputedColorScheme("dark");
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const terminalThemeKey = (prefs as any)?.terminalTheme ?? "auto";
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const terminalFontSize = (prefs as any)?.terminalFontSize ?? 14;
		const resolvedTheme = getTerminalTheme(terminalThemeKey, computedScheme, oledMode);
		const themeBg = resolvedTheme.background ?? TERM_BG;
		const [xtermSelection, setXtermSelection] = useState<string>("");
		const xtermSelectionRef = useRef("");
		const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
		const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY);
		const [mods, setMods] = useState<Modifiers>({ ctrl: false, alt: false });
		const modsRef = useRef(mods);
		modsRef.current = mods;

		// Flag to suppress terminal response sequences from being sent back as input.
		// When term.write() processes PTY output, xterm.js may synchronously fire
		// onData with response sequences (DA, color queries, DECRPM, etc.).
		// We set this flag during write() to distinguish those from real user input.
		const writingRef = useRef(false);
		const outputBufferRef = useRef<string[]>([]);
		const outputBufferCharsRef = useRef(0);
		const outputRafRef = useRef<number | null>(null);
		const outputTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		// Pending data queue: buffers WS data arriving before xterm is initialized
		type PendingData =
			| { type: "output"; data: string }
			| { type: "scrollback"; data: string; dims: { cols: number; rows: number } };
		const pendingDataRef = useRef<PendingData[]>([]);
		const pendingDataCharsRef = useRef(0);
		const termReadyRef = useRef(false);

		// Pinch-to-zoom state
		const pinchingRef = useRef(false);
		const pinchBaseDistRef = useRef(0);
		const pinchBaseFontRef = useRef(14);
		const pinchResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		// Long-press-to-select state
		const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const longPressTouchRef = useRef<{ x: number; y: number } | null>(null);
		// Selection handle state for drag-to-adjust
		const [selHandles, setSelHandles] = useState<{
			start: { col: number; row: number };
			end: { col: number; row: number };
		} | null>(null);
		const selHandleDragRef = useRef<"start" | "end" | null>(null);
		// Flag set synchronously when a handle is touched, so the native
		// touchstart listener on the container can skip the long-press timer.
		const handleTouchedRef = useRef(false);
		// Ctrl+V paste popover state
		const [pastePopover, setPastePopover] = useState<{ top: number; left: number } | null>(null);
		const pastePopoverRef = useRef<HTMLDivElement>(null);
		const onExitRef = useRef(onExit);
		onExitRef.current = onExit;

		const resizeRef = useRef<(cols: number, rows: number) => void>(() => {});
		const fitRafRef = useRef<number | null>(null);
		const pendingFitRef = useRef({ notifyResize: false, forceNotify: false });

		const writeTerminalOutput = useCallback((data: string) => {
			const term = termRef.current;
			if (!term || data.length === 0) return false;
			writingRef.current = true;
			try {
				term.write(data);
			} finally {
				writingRef.current = false;
			}
			return true;
		}, []);

		const trimOutputBuffer = useCallback(() => {
			while (
				outputBufferRef.current.length > 1 &&
				outputBufferCharsRef.current > TERMINAL_PENDING_BUFFER_MAX_CHARS
			) {
				const removed = outputBufferRef.current.shift();
				outputBufferCharsRef.current -= removed?.length ?? 0;
			}
			const first = outputBufferRef.current[0];
			if (first && outputBufferCharsRef.current > TERMINAL_PENDING_BUFFER_MAX_CHARS) {
				const trimmed = first.slice(-TERMINAL_PENDING_BUFFER_MAX_CHARS);
				outputBufferRef.current[0] = trimmed;
				outputBufferCharsRef.current = trimmed.length;
			}
		}, []);

		const flushPendingOutput = useCallback(() => {
			if (outputRafRef.current !== null) {
				cancelAnimationFrame(outputRafRef.current);
				outputRafRef.current = null;
			}
			if (outputTimeoutRef.current !== null) {
				clearTimeout(outputTimeoutRef.current);
				outputTimeoutRef.current = null;
			}
			if (outputBufferRef.current.length === 0) return true;
			const chunks = outputBufferRef.current;
			const charCount = outputBufferCharsRef.current;
			const data = chunks.join("");
			outputBufferRef.current = [];
			outputBufferCharsRef.current = 0;
			if (writeTerminalOutput(data)) return true;
			outputBufferRef.current = chunks;
			outputBufferCharsRef.current = charCount;
			return false;
		}, [writeTerminalOutput]);

		const enqueueOutput = useCallback(
			(data: string) => {
				const chunk = trimTerminalBufferText(data);
				if (!chunk) return;
				outputBufferRef.current.push(chunk);
				outputBufferCharsRef.current += chunk.length;
				trimOutputBuffer();
				if (outputRafRef.current === null) {
					outputRafRef.current = requestAnimationFrame(() => {
						outputRafRef.current = null;
						flushPendingOutput();
					});
				}
				if (outputTimeoutRef.current === null) {
					outputTimeoutRef.current = setTimeout(() => {
						outputTimeoutRef.current = null;
						flushPendingOutput();
					}, TERMINAL_OUTPUT_FLUSH_FALLBACK_MS);
				}
			},
			[flushPendingOutput, trimOutputBuffer],
		);

		const runFit = useCallback((notifyResize: boolean, forceNotify: boolean) => {
			const term = termRef.current;
			const fitAddon = fitAddonRef.current;
			if (!term || !fitAddon) return;
			const prev = { cols: term.cols, rows: term.rows };
			fitAddon.fit();
			if (notifyResize && (forceNotify || term.cols !== prev.cols || term.rows !== prev.rows)) {
				resizeRef.current(term.cols, term.rows);
			}
		}, []);

		const scheduleFit = useCallback(
			(notifyResize = false, forceNotify = false) => {
				pendingFitRef.current = {
					notifyResize: pendingFitRef.current.notifyResize || notifyResize,
					forceNotify: pendingFitRef.current.forceNotify || forceNotify,
				};
				if (fitRafRef.current !== null) return;
				fitRafRef.current = requestAnimationFrame(() => {
					fitRafRef.current = null;
					const pending = pendingFitRef.current;
					pendingFitRef.current = { notifyResize: false, forceNotify: false };
					runFit(pending.notifyResize, pending.forceNotify);
				});
			},
			[runFit],
		);

		const trimPendingData = useCallback(() => {
			while (
				pendingDataRef.current.length > 1 &&
				pendingDataCharsRef.current > TERMINAL_PENDING_BUFFER_MAX_CHARS
			) {
				const removed = pendingDataRef.current.shift();
				pendingDataCharsRef.current -= removed?.data.length ?? 0;
			}
			const first = pendingDataRef.current[0];
			if (first && pendingDataCharsRef.current > TERMINAL_PENDING_BUFFER_MAX_CHARS) {
				first.data = first.data.slice(-TERMINAL_PENDING_BUFFER_MAX_CHARS);
				pendingDataCharsRef.current = first.data.length;
			}
		}, []);

		const appendPendingOutput = useCallback(
			(data: string) => {
				const chunk = trimTerminalBufferText(data);
				if (!chunk) return;
				pendingDataRef.current.push({ type: "output", data: chunk });
				pendingDataCharsRef.current += chunk.length;
				trimPendingData();
			},
			[trimPendingData],
		);

		const replacePendingScrollback = useCallback(
			(data: string, dims: { cols: number; rows: number }) => {
				const chunk = trimTerminalBufferText(data);
				pendingDataRef.current = [{ type: "scrollback", data: chunk, dims }];
				pendingDataCharsRef.current = chunk.length;
			},
			[],
		);

		const { write, resize, disconnected } = useTerminalWS(terminalId, {
			onOutput: (data) => {
				if (!termReadyRef.current) {
					appendPendingOutput(data);
					return;
				}
				enqueueOutput(data);
			},
			onScrollback: (data, dims) => {
				flushPendingOutput();
				if (!termReadyRef.current) {
					// Scrollback is a full snapshot — replace all pending data
					replacePendingScrollback(data, dims);
					return;
				}
				const term = termRef.current;
				if (!term) return;
				const scrollbackData = trimTerminalBufferText(data);
				writingRef.current = true;
				try {
					// Resize to match the server-side buffer dimensions so line wrapping is correct
					term.resize(dims.cols, dims.rows);
					term.reset();
					term.write(scrollbackData);
				} finally {
					writingRef.current = false;
				}
				// Fit back to actual container size and notify server
				scheduleFit(true, true);
			},
			onExit: (code) => {
				flushPendingOutput();
				writeTerminalOutput(`\r\n${t("processExited", { code })}\r\n`);
				onExitRef.current?.(code);
			},
			onError: (message) => {
				flushPendingOutput();
				writeTerminalOutput(`\r\n${t("error", { message })}\r\n`);
			},
			onRequestResize: () => {
				const term = termRef.current;
				if (term) resizeRef.current(term.cols, term.rows);
			},
		});

		resizeRef.current = resize;

		useImperativeHandle(ref, () => ({ writeToTerminal: (text: string) => write(text) }), [write]);

		const handleSelectionChange = useCallback(() => {
			const sel = termRef.current?.getSelection()?.trim() ?? "";
			xtermSelectionRef.current = sel;
			setXtermSelection(sel.slice(0, TERMINAL_SELECTION_STATE_MAX_CHARS));
		}, []);

		const handleSendSelection = useCallback(
			(text: string) => {
				const termText = xtermSelectionRef.current;
				onSendToChat?.(termText || text);
				termRef.current?.clearSelection();
				xtermSelectionRef.current = "";
				setXtermSelection("");
				setSelHandles(null);
				setSelectionAnchor(null);
			},
			[onSendToChat],
		);
		// biome-ignore lint/correctness/useExhaustiveDependencies: resolvedTheme and terminalFontSize are handled by a separate live-update effect below
		useEffect(() => {
			if (!containerRef.current) return;
			const term = new Terminal({
				cursorBlink: true,
				fontSize: terminalFontSize,
				fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
				scrollback: TERMINAL_SCROLLBACK_LINES,
				theme: resolvedTheme,
			});
			const fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(containerRef.current);
			termRef.current = term;
			fitAddonRef.current = fitAddon;
			runFit(false, false);

			// OSC 52 clipboard handler
			const disposeOsc52 = setupOsc52Handler(term);

			termReadyRef.current = true;

			// Flush any data received before xterm was ready
			if (pendingDataRef.current.length > 0) {
				writingRef.current = true;
				try {
					for (const pending of pendingDataRef.current) {
						if (pending.type === "scrollback") {
							term.resize(pending.dims.cols, pending.dims.rows);
							term.reset();
						}
						term.write(pending.data);
					}
				} finally {
					writingRef.current = false;
				}
				pendingDataRef.current = [];
				pendingDataCharsRef.current = 0;
				// Fit to actual container size after replaying scrollback
				scheduleFit(true, true);
			}

			// Intercept Ctrl+C when text is selected: copy to clipboard instead of sending SIGINT
			// Intercept Ctrl+V: show popover to choose between paste and sending raw Ctrl+V
			term.attachCustomKeyEventHandler((e) => {
				if (e.type !== "keydown" || e.shiftKey || e.altKey || e.metaKey) return true;
				if (!e.ctrlKey) return true;

				if (e.key === "c") {
					const sel = term.getSelection();
					if (sel) {
						copyTextToClipboard(sel).catch(() => {});
						term.clearSelection();
						return false;
					}
				}

				if (e.key === "v") {
					e.preventDefault();
					// Position popover near the cursor in the terminal
					const screenEl = term.element?.querySelector(".xterm-screen");
					if (screenEl) {
						const rect = screenEl.getBoundingClientRect();
						const cellW = rect.width / term.cols;
						const cellH = rect.height / term.rows;
						const cursorX = term.buffer.active.cursorX;
						const cursorY = term.buffer.active.cursorY;
						setPastePopover({
							top: rect.top + cursorY * cellH,
							left: rect.left + cursorX * cellW,
						});
					}
					return false;
				}

				return true;
			});

			term.onData((data) => {
				// During term.write() (PTY output processing), xterm.js may
				// synchronously fire onData with terminal response sequences
				// (DA, DSR, DECRPM, OSC color replies, etc.). These must not be
				// sent back to the PTY or they appear as garbled text.
				if (writingRef.current) return;

				const m = modsRef.current;
				let out = data;
				if (m.ctrl || m.alt) {
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						if (m.ctrl) out = ctrlChar(data);
						if (m.alt) out = `\x1b${out}`;
					}
					setMods({ ctrl: false, alt: false });
				}
				write(out);
			});

			const selDisposable = term.onSelectionChange(() => handleSelectionChange());

			const resizeObserver = new ResizeObserver(() => {
				if (pinchingRef.current) {
					scheduleFit();
					return;
				}
				scheduleFit(true);
			});
			resizeObserver.observe(containerRef.current);
			// Pinch-to-zoom on mobile
			const container = containerRef.current;
			const FONT_MIN = 8;
			const FONT_MAX = 32;

			function pinchDist(e: TouchEvent): number {
				const [a, b] = [e.touches[0], e.touches[1]];
				return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
			}
			function schedulePtyResize() {
				if (pinchResizeTimerRef.current) clearTimeout(pinchResizeTimerRef.current);
				pinchResizeTimerRef.current = setTimeout(() => {
					pinchResizeTimerRef.current = null;
					scheduleFit(true, true);
				}, 300);
			}
			function onTouchStart(e: TouchEvent) {
				if (e.touches.length === 2) {
					e.preventDefault();
					// Cancel any pending long-press
					if (longPressTimerRef.current) {
						clearTimeout(longPressTimerRef.current);
						longPressTimerRef.current = null;
					}
					longPressTouchRef.current = null;
					pinchingRef.current = true;
					pinchBaseDistRef.current = pinchDist(e);
					pinchBaseFontRef.current = term.options.fontSize ?? 14;
				}
			}
			function onTouchMove(e: TouchEvent) {
				if (!pinchingRef.current || e.touches.length !== 2) return;
				e.preventDefault();
				const ratio = pinchDist(e) / pinchBaseDistRef.current;
				// 0.5px steps for smoother scaling
				const newSize =
					Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, pinchBaseFontRef.current * ratio)) * 2) /
					2;
				if (newSize !== term.options.fontSize) {
					term.options.fontSize = newSize;
					scheduleFit();
				}
			}
			function onTouchEnd(e: TouchEvent) {
				if (!pinchingRef.current) return;
				if (e.touches.length < 2) {
					pinchingRef.current = false;
					schedulePtyResize();
				}
			}

			container.addEventListener("touchstart", onTouchStart, { passive: false });
			container.addEventListener("touchmove", onTouchMove, { passive: false });
			container.addEventListener("touchend", onTouchEnd, { passive: true });

			// Long-press to select word on mobile + selection handles
			const LONG_PRESS_MS = 500;
			const LONG_PRESS_MOVE_THRESHOLD = 10;

			function touchToCell(clientX: number, clientY: number) {
				const screenEl = term.element?.querySelector(".xterm-screen");
				if (!screenEl) return null;
				const rect = screenEl.getBoundingClientRect();
				const x = clientX - rect.left;
				const y = clientY - rect.top;
				const cellW = rect.width / term.cols;
				const cellH = rect.height / term.rows;
				const col = Math.min(Math.max(Math.floor(x / cellW), 0), term.cols - 1);
				const row = Math.min(Math.max(Math.floor(y / cellH), 0), term.rows - 1);
				return { col, row };
			}

			function selectWordAt(col: number, row: number) {
				const bufferRow = row + term.buffer.active.viewportY;
				const line = term.buffer.active.getLine(bufferRow);
				if (!line) return;
				const lineText = line.translateToString(false);
				if (col >= lineText.length) return;
				const ch = lineText[col];
				if (!ch || /\s/.test(ch)) return;
				// Find word boundaries (non-whitespace run)
				const wordRe = /\S/;
				let start = col;
				while (start > 0 && wordRe.test(lineText[start - 1])) start--;
				let end = col;
				while (end < lineText.length - 1 && wordRe.test(lineText[end + 1])) end++;
				term.select(start, bufferRow, end - start + 1);
				// Set selection handles (viewport-relative row)
				setSelHandles({
					start: { col: start, row },
					end: { col: end, row },
				});
			}

			/** Apply selection from handle positions and update xterm */
			function applyHandleSelection(
				s: { col: number; row: number },
				e: { col: number; row: number },
			) {
				const sRow = s.row + term.buffer.active.viewportY;
				const eRow = e.row + term.buffer.active.viewportY;
				// Normalize so start <= end
				let startRow = sRow;
				let startCol = s.col;
				let endRow = eRow;
				let endCol = e.col;
				if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
					[startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
				}
				if (startRow === endRow) {
					term.select(startCol, startRow, endCol - startCol + 1);
				} else {
					// Multi-row: select from startCol to end of first row, then full rows, then start of last row to endCol
					// xterm.select only supports single-row, so select the full range
					const totalCols =
						term.cols - startCol + Math.max(0, endRow - startRow - 1) * term.cols + (endCol + 1);
					term.select(startCol, startRow, totalCols);
				}
			}

			function onLongPressStart(e: TouchEvent) {
				if (e.touches.length !== 1 || pinchingRef.current) return;
				// A selection handle was just touched — skip long-press detection
				// so we don't interfere with handle dragging.
				if (handleTouchedRef.current) {
					handleTouchedRef.current = false;
					return;
				}
				// If selection handles are active and user taps elsewhere, dismiss them
				const touch = e.touches[0];
				longPressTouchRef.current = { x: touch.clientX, y: touch.clientY };
				if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
				longPressTimerRef.current = setTimeout(() => {
					longPressTimerRef.current = null;
					if (!longPressTouchRef.current) return;
					const cell = touchToCell(longPressTouchRef.current.x, longPressTouchRef.current.y);
					if (cell) {
						selectWordAt(cell.col, cell.row);
						setSelectionAnchor({ x: longPressTouchRef.current.x, y: longPressTouchRef.current.y });
						// Haptic feedback
						if (navigator.vibrate) navigator.vibrate(30);
					}
					longPressTouchRef.current = null;
				}, LONG_PRESS_MS);
			}

			function onLongPressMove(e: TouchEvent) {
				// If dragging a selection handle, update selection
				if (selHandleDragRef.current && e.touches.length === 1) {
					e.preventDefault();
					const touch = e.touches[0];
					const cell = touchToCell(touch.clientX, touch.clientY);
					if (!cell) return;
					// Compute new handles synchronously so we can apply the
					// xterm selection immediately (setState is batched/async).
					setSelHandles((prev) => {
						if (!prev) return prev;
						const next = { ...prev };
						if (selHandleDragRef.current === "start") {
							next.start = cell;
						} else {
							next.end = cell;
						}
						applyHandleSelection(next.start, next.end);
						return next;
					});
					return;
				}
				if (!longPressTouchRef.current || !longPressTimerRef.current) return;
				const touch = e.touches[0];
				const dx = touch.clientX - longPressTouchRef.current.x;
				const dy = touch.clientY - longPressTouchRef.current.y;
				if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) {
					clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
					longPressTouchRef.current = null;
				}
			}

			function onLongPressEnd() {
				// If we were dragging a selection handle, just finish the drag
				// without clearing the selection or handles.
				if (selHandleDragRef.current) {
					selHandleDragRef.current = null;
					if (longPressTimerRef.current) {
						clearTimeout(longPressTimerRef.current);
						longPressTimerRef.current = null;
					}
					longPressTouchRef.current = null;
					return;
				}
				if (longPressTimerRef.current) {
					// Timer still running = short tap, dismiss handles if active
					clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
					if (longPressTouchRef.current) {
						// Short tap: dismiss selection handles
						setSelHandles(null);
						setSelectionAnchor(null);
						term.clearSelection();
						xtermSelectionRef.current = "";
						setXtermSelection("");
					}
				}
				longPressTouchRef.current = null;
			}

			container.addEventListener("touchstart", onLongPressStart, { passive: true });
			container.addEventListener("touchmove", onLongPressMove, { passive: false });
			container.addEventListener("touchend", onLongPressEnd, { passive: true });

			return () => {
				termReadyRef.current = false;
				pendingDataRef.current = [];
				pendingDataCharsRef.current = 0;
				if (outputRafRef.current !== null) {
					cancelAnimationFrame(outputRafRef.current);
					outputRafRef.current = null;
				}
				if (outputTimeoutRef.current !== null) {
					clearTimeout(outputTimeoutRef.current);
					outputTimeoutRef.current = null;
				}
				outputBufferRef.current = [];
				outputBufferCharsRef.current = 0;
				if (fitRafRef.current !== null) {
					cancelAnimationFrame(fitRafRef.current);
					fitRafRef.current = null;
				}
				pendingFitRef.current = { notifyResize: false, forceNotify: false };
				disposeOsc52();
				selDisposable.dispose();
				resizeObserver.disconnect();
				container.removeEventListener("touchstart", onTouchStart);
				container.removeEventListener("touchmove", onTouchMove);
				container.removeEventListener("touchend", onTouchEnd);
				container.removeEventListener("touchstart", onLongPressStart);
				container.removeEventListener("touchmove", onLongPressMove);
				container.removeEventListener("touchend", onLongPressEnd);
				if (pinchResizeTimerRef.current) {
					clearTimeout(pinchResizeTimerRef.current);
					pinchResizeTimerRef.current = null;
				}
				if (longPressTimerRef.current) {
					clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
				}

				// xterm 5.5 schedules Viewport.syncScrollArea() with setTimeout during
				// open(). React StrictMode can run this cleanup immediately and dispose
				// the renderer before that callback runs, causing xterm to read
				// `dimensions` from an already-disposed renderer. Let xterm finish its
				// queued initialization before disposing this effect's own instance.
				setTimeout(() => {
					term.dispose();
					if (termRef.current === term) termRef.current = null;
					if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
				}, 0);
			};
		}, [write, runFit, scheduleFit, handleSelectionChange]);

		// Live-update theme and font size without recreating the terminal
		useEffect(() => {
			const term = termRef.current;
			if (!term) return;
			term.options.theme = resolvedTheme;
			if (term.options.fontSize !== terminalFontSize) {
				term.options.fontSize = terminalFontSize;
				scheduleFit();
			}
		}, [resolvedTheme, terminalFontSize, scheduleFit]);

		const handleAuxKey = useCallback(
			(data: string) => {
				write(data);
				termRef.current?.focus();
			},
			[write],
		);

		const toggleMod = useCallback((mod: keyof Modifiers) => {
			setMods((prev) => ({ ...prev, [mod]: !prev[mod] }));
		}, []);

		/** Convert viewport cell (col, row) to pixel position relative to container */
		const cellToPixel = useCallback((col: number, row: number): { x: number; y: number } | null => {
			const term = termRef.current;
			if (!term) return null;
			const screenEl = term.element?.querySelector(".xterm-screen");
			if (!screenEl || !containerRef.current) return null;
			const screenRect = screenEl.getBoundingClientRect();
			const containerRect = containerRef.current.getBoundingClientRect();
			const cellW = screenRect.width / term.cols;
			const cellH = screenRect.height / term.rows;
			return {
				x: screenRect.left - containerRect.left + col * cellW + cellW / 2,
				y: screenRect.top - containerRect.top + row * cellH + cellH,
			};
		}, []);

		const startHandleDrag = useCallback((which: "start" | "end") => {
			handleTouchedRef.current = true;
			selHandleDragRef.current = which;
		}, []);

		const handlePasteFromClipboard = useCallback(() => {
			const failPaste = () => {
				notifications.show({
					color: "yellow",
					message: t("pasteFromClipboardUnavailable"),
				});
			};
			// Plain HTTP cannot read the clipboard; keyboard paste still works via the
			// terminal's native paste event and does not need the Clipboard API.
			if (
				typeof navigator === "undefined" ||
				typeof navigator.clipboard?.readText !== "function" ||
				(typeof window !== "undefined" && window.isSecureContext === false)
			) {
				failPaste();
			} else {
				navigator.clipboard
					.readText()
					.then((text) => {
						if (text) write(text);
					})
					.catch(() => {
						failPaste();
					});
			}
			setPastePopover(null);
			termRef.current?.focus();
		}, [write, t]);

		const handleSendCtrlV = useCallback(() => {
			write("\x16");
			setPastePopover(null);
			termRef.current?.focus();
		}, [write]);

		// Dismiss paste popover on outside click
		useEffect(() => {
			if (!pastePopover) return;
			const onMouseDown = (e: MouseEvent) => {
				if (pastePopoverRef.current?.contains(e.target as Node)) return;
				setPastePopover(null);
			};
			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key === "Escape") setPastePopover(null);
			};
			document.addEventListener("mousedown", onMouseDown);
			document.addEventListener("keydown", onKeyDown);
			return () => {
				document.removeEventListener("mousedown", onMouseDown);
				document.removeEventListener("keydown", onKeyDown);
			};
		}, [pastePopover]);

		return (
			<Box
				h="100%"
				style={{
					display: "flex",
					flexDirection: "column",
					overscrollBehavior: "contain",
					overflow: "hidden",
				}}
			>
				<Box
					ref={containerRef}
					style={{
						flex: 1,
						minHeight: 0,
						backgroundColor: themeBg,
						padding: 4,
						position: "relative",
						isolation: "isolate",
						overscrollBehavior: "contain",
					}}
				>
					{onSendToChat && (
						<SelectionPopover
							containerRef={containerRef}
							onAction={handleSendSelection}
							label={t("sendToChat")}
							externalSelection={xtermSelection}
							externalAnchor={selectionAnchor}
						/>
					)}
					{disconnected && (
						<Badge
							size="xs"
							variant="filled"
							color="red"
							style={{
								position: "absolute",
								top: 4,
								right: 4,
								zIndex: 10,
								pointerEvents: "none",
							}}
						>
							{t("disconnected")}
						</Badge>
					)}
					{selHandles && (
						<>
							<SelectionHandleEl
								pos={cellToPixel(selHandles.start.col, selHandles.start.row)}
								side="start"
								onDragStart={() => startHandleDrag("start")}
							/>
							<SelectionHandleEl
								pos={cellToPixel(selHandles.end.col + 1, selHandles.end.row)}
								side="end"
								onDragStart={() => startHandleDrag("end")}
							/>
						</>
					)}
				</Box>
				{pastePopover && (
					<Portal>
						<Paper
							ref={pastePopoverRef}
							shadow="md"
							radius="md"
							px={4}
							py={4}
							style={{
								position: "fixed",
								top: Math.max(4, pastePopover.top - 40),
								left: Math.max(4, Math.min(window.innerWidth - 160, pastePopover.left)),
								zIndex: Z.popover,
							}}
						>
							<Group gap={4}>
								<ActionIcon
									variant="filled"
									color="indigo"
									size="sm"
									radius="xl"
									onClick={handlePasteFromClipboard}
									title={t("pasteContent")}
								>
									<IconClipboard size={14} />
								</ActionIcon>
								<Text
									size="xs"
									c="dimmed"
									style={{ cursor: "pointer" }}
									onClick={handlePasteFromClipboard}
								>
									{t("pasteContent")}
								</Text>
								<Box w={4} />
								<ActionIcon
									variant="filled"
									color="gray"
									size="sm"
									radius="xl"
									onClick={handleSendCtrlV}
									title={t("sendCtrlV")}
								>
									<IconKeyboard size={14} />
								</ActionIcon>
								<Text size="xs" c="dimmed" style={{ cursor: "pointer" }} onClick={handleSendCtrlV}>
									{t("sendCtrlV")}
								</Text>
							</Group>
						</Paper>
					</Portal>
				)}
				{isMobile && <TerminalAuxKeys onKey={handleAuxKey} mods={mods} onToggleMod={toggleMod} />}
			</Box>
		);
	},
);
