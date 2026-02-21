import { Box, useMantineColorScheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
		const { colorScheme } = useMantineColorScheme();
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const terminalThemeKey = (prefs as any)?.terminalTheme ?? "auto";
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const terminalFontSize = (prefs as any)?.terminalFontSize ?? 14;
		const resolvedTheme = getTerminalTheme(
			terminalThemeKey,
			colorScheme === "auto" ? "dark" : colorScheme,
		);
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

		const { write, resize } = useTerminalWS(terminalId, {
			onOutput: (data) => {
				writingRef.current = true;
				termRef.current?.write(data);
				writingRef.current = false;
			},
			onScrollback: (data) => {
				writingRef.current = true;
				termRef.current?.write(data);
				writingRef.current = false;
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
					let nextHandles: {
						start: { col: number; row: number };
						end: { col: number; row: number };
					} | null = null;
					setSelHandles((prev) => {
						if (!prev) return prev;
						const next = { ...prev };
						if (selHandleDragRef.current === "start") {
							next.start = cell;
						} else {
							next.end = cell;
						}
						nextHandles = next;
						return next;
					});
					if (nextHandles as typeof selHandles) {
						const h = nextHandles as unknown as NonNullable<typeof selHandles>;
						applyHandleSelection(h.start, h.end);
					}
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
				if (longPressTimerRef.current) {
					// Timer still running = short tap, dismiss handles if active
					clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
					if (longPressTouchRef.current && !selHandleDragRef.current) {
						// Short tap: dismiss selection handles
						setSelHandles(null);
						setSelectionAnchor(null);
						term.clearSelection();
						setXtermSelection("");
					}
				}
				longPressTouchRef.current = null;
				selHandleDragRef.current = null;
			}

			container.addEventListener("touchstart", onLongPressStart, { passive: true });
			container.addEventListener("touchmove", onLongPressMove, { passive: false });
			container.addEventListener("touchend", onLongPressEnd, { passive: true });

			return () => {
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
			selHandleDragRef.current = which;
		}, []);

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
				{isMobile && <TerminalAuxKeys onKey={handleAuxKey} mods={mods} onToggleMod={toggleMod} />}
			</Box>
		);
	},
);
