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
import { IconClipboard, IconKeyboard } from "@tabler/icons-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useTerminalWS } from "../../hooks/useTerminalWS";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { SelectionPopover } from "../common/SelectionPopover";
import { setupOsc52Handler } from "./osc52-handler";
import { type Modifiers, TerminalAuxKeys } from "./TerminalAuxKeys";
import { getTerminalTheme } from "./terminal-theme";

export const TERM_BG = "#1a1b26"; // Default fallback, actual bg comes from theme

const HANDLE_SIZE = 20;
const HANDLE_COLOR = "#4c6ef5"; // Mantine indigo

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
		const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
		const isMobile = useMediaQuery("(max-width: 768px)");
		const [kbHeight, setKbHeight] = useState(0);
		const [mods, setMods] = useState<Modifiers>({ ctrl: false, alt: false });
		const modsRef = useRef(mods);
		modsRef.current = mods;

		// Flag to suppress terminal response sequences from being sent back as input.
		// When term.write() processes PTY output, xterm.js may synchronously fire
		// onData with response sequences (DA, color queries, DECRPM, etc.).
		// We set this flag during write() to distinguish those from real user input.
		const writingRef = useRef(false);

		// Pending data queue: buffers WS data arriving before xterm is initialized
		type PendingData =
			| { type: "output"; data: string }
			| { type: "scrollback"; data: string; dims: { cols: number; rows: number } };
		const pendingDataRef = useRef<PendingData[]>([]);
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
		// Track virtual keyboard height on mobile
		useEffect(() => {
			if (!isMobile) {
				setKbHeight(0);
				return;
			}
			const vv = window.visualViewport;
			if (!vv) return;
			const update = () => {
				const offset = window.innerHeight - vv.height - vv.offsetTop;
				setKbHeight(Math.max(0, offset));
			};
			vv.addEventListener("resize", update);
			vv.addEventListener("scroll", update);
			update();
			return () => {
				vv.removeEventListener("resize", update);
				vv.removeEventListener("scroll", update);
			};
		}, [isMobile]);

		// Lock body scroll when soft keyboard is visible to prevent page from scrolling
		useEffect(() => {
			if (!isMobile || kbHeight <= 0) return;
			const html = document.documentElement;
			const body = document.body;
			const prevHtmlOverflow = html.style.overflow;
			const prevBodyOverflow = body.style.overflow;
			html.style.overflow = "hidden";
			body.style.overflow = "hidden";
			return () => {
				html.style.overflow = prevHtmlOverflow;
				body.style.overflow = prevBodyOverflow;
			};
		}, [isMobile, kbHeight]);

		const onExitRef = useRef(onExit);
		onExitRef.current = onExit;

		const resizeRef = useRef<(cols: number, rows: number) => void>(() => {});

		const { write, resize, disconnected } = useTerminalWS(terminalId, {
			onOutput: (data) => {
				if (!termReadyRef.current) {
					pendingDataRef.current.push({ type: "output", data });
					return;
				}
				writingRef.current = true;
				termRef.current?.write(data);
				writingRef.current = false;
			},
			onScrollback: (data, dims) => {
				if (!termReadyRef.current) {
					// Scrollback is a full snapshot — replace all pending data
					pendingDataRef.current = [{ type: "scrollback", data, dims }];
					return;
				}
				const term = termRef.current;
				const fitAddon = fitAddonRef.current;
				if (!term) return;
				writingRef.current = true;
				// Resize to match the server-side buffer dimensions so line wrapping is correct
				term.resize(dims.cols, dims.rows);
				term.reset();
				term.write(data);
				writingRef.current = false;
				// Fit back to actual container size and notify server
				if (fitAddon) {
					fitAddon.fit();
					resize(term.cols, term.rows);
				}
			},
			onExit: (code) => {
				termRef.current?.write(`\r\n${t("processExited", { code })}\r\n`);
				onExitRef.current?.(code);
			},
			onError: (message) => {
				termRef.current?.write(`\r\n${t("error", { message })}\r\n`);
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
			setXtermSelection(sel);
		}, []);

		const xtermSelectionRef = useRef("");
		xtermSelectionRef.current = xtermSelection;

		const handleSendSelection = useCallback(
			(text: string) => {
				const termText = xtermSelectionRef.current;
				onSendToChat?.(termText || text);
				termRef.current?.clearSelection();
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
				theme: resolvedTheme,
			});
			const fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(containerRef.current);
			fitAddon.fit();

			// OSC 52 clipboard handler
			const disposeOsc52 = setupOsc52Handler(term);

			termRef.current = term;
			fitAddonRef.current = fitAddon;
			termReadyRef.current = true;

			// Flush any data received before xterm was ready
			if (pendingDataRef.current.length > 0) {
				writingRef.current = true;
				for (const pending of pendingDataRef.current) {
					if (pending.type === "scrollback") {
						term.resize(pending.dims.cols, pending.dims.rows);
						term.reset();
					}
					term.write(pending.data);
				}
				writingRef.current = false;
				pendingDataRef.current = [];
				// Fit to actual container size after replaying scrollback
				fitAddon.fit();
				resize(term.cols, term.rows);
			}

			// Intercept Ctrl+C when text is selected: copy to clipboard instead of sending SIGINT
			// Intercept Ctrl+V: show popover to choose between paste and sending raw Ctrl+V
			term.attachCustomKeyEventHandler((e) => {
				if (e.type !== "keydown" || e.shiftKey || e.altKey || e.metaKey) return true;
				if (!e.ctrlKey) return true;

				if (e.key === "c") {
					const sel = term.getSelection();
					if (sel) {
						navigator.clipboard.writeText(sel).catch(() => {});
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
					fitAddon.fit();
					return;
				}
				const prev = { cols: term.cols, rows: term.rows };
				fitAddon.fit();
				if (term.cols !== prev.cols || term.rows !== prev.rows) {
					resize(term.cols, term.rows);
				}
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
					fitAddon.fit();
					resize(term.cols, term.rows);
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
					fitAddon.fit();
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
				disposeOsc52();
				selDisposable.dispose();
				resizeObserver.disconnect();
				container.removeEventListener("touchstart", onTouchStart);
				container.removeEventListener("touchmove", onTouchMove);
				container.removeEventListener("touchend", onTouchEnd);
				container.removeEventListener("touchstart", onLongPressStart);
				container.removeEventListener("touchmove", onLongPressMove);
				container.removeEventListener("touchend", onLongPressEnd);
				if (pinchResizeTimerRef.current) clearTimeout(pinchResizeTimerRef.current);
				if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
				term.dispose();
				termRef.current = null;
				fitAddonRef.current = null;
			};
		}, [write, resize, handleSelectionChange]);

		// Live-update theme and font size without recreating the terminal
		useEffect(() => {
			const term = termRef.current;
			if (!term) return;
			term.options.theme = resolvedTheme;
			if (term.options.fontSize !== terminalFontSize) {
				term.options.fontSize = terminalFontSize;
				fitAddonRef.current?.fit();
			}
		}, [resolvedTheme, terminalFontSize]);

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
			navigator.clipboard
				.readText()
				.then((text) => {
					if (text) write(text);
				})
				.catch(() => {});
			setPastePopover(null);
			termRef.current?.focus();
		}, [write]);

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
					paddingBottom: isMobile ? kbHeight : 0,
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
								zIndex: 1000,
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
