import { Box, Center, Drawer, Loader, Stack, Text } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { SessionTerminal } from "../../components/terminal/SessionTerminal";
import { useChapter } from "../../hooks/useChapters";
import { useNarrator } from "../../hooks/useNarrator";
import { usePageUnload } from "../../hooks/usePageUnload";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { api } from "../../lib/api";

export const Route = createFileRoute("/sessions/$sessionId")({
	component: SessionDetailPage,
});

const MIN_PANEL_WIDTH = 200;
const DEFAULT_TERMINAL_RATIO = 0.4;

function terminalStorageKey(narratorId: string) {
	return `narrafork_terminal_open_${narratorId}`;
}

function SessionDetailPage() {
	const { sessionId } = Route.useParams();
	const location = useLocation();
	const highlightMessageId = location.hash?.startsWith("msg-") ? location.hash.slice(4) : undefined;
	const isMobile = useMediaQuery("(max-width: 768px)");
	const { t } = useTranslation("sessions");

	// Unload heavy components when the tab has been hidden for a while
	const unloaded = usePageUnload();

	// Fetch narrator data for recent tab tracking
	const { data: narrator } = useNarrator(sessionId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const { data: chapter } = useChapter(chapterId ?? "");

	// Record recent tab visit
	const narratorTitle = narrator?.title;
	const narratorCwd = narrator?.cwd;
	const narratorStatus = narrator?.status;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterTitle = (chapter as any)?.title as string | undefined;
	useEffect(() => {
		if (!narratorTitle) return;
		if (chapterId) {
			// Chapter-bound narrator: record as chapter tab
			addRecentTab({
				type: "chapter",
				id: chapterId,
				narratorId: sessionId,
				title: narratorTitle || "Chapter",
				subtitle: chapterTitle,
				status: narratorStatus,
			});
		} else {
			// Standalone session
			addRecentTab({
				type: "session",
				id: sessionId,
				title: narratorTitle || "New conversation",
				subtitle: narratorCwd,
				status: narratorStatus,
			});
		}
	}, [sessionId, chapterId, narratorTitle, narratorCwd, narratorStatus, chapterTitle]);

	// Mark narrator as read (done → idle) when visiting the session page
	useEffect(() => {
		api.markNarratorRead(sessionId).catch(() => {});
	}, [sessionId]);

	// Check if there's a running terminal for this narrator
	const { data: existingTerminals } = useNarratorTerminals(sessionId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const hasRunningTerminal = (existingTerminals ?? []).some((t: any) => t.status === "running");

	// Terminal drawer for mobile
	const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);

	// Desktop terminal panel visibility — restore from localStorage if a running terminal exists
	const [terminalOpen, setTerminalOpen] = useState(false);
	const initializedRef = useRef(false);

	useEffect(() => {
		if (initializedRef.current) return;
		const saved = localStorage.getItem(terminalStorageKey(sessionId));
		if (saved === "true" && hasRunningTerminal) {
			setTerminalOpen(true);
			initializedRef.current = true;
		} else if (existingTerminals !== undefined) {
			// Data loaded but no saved state or no running terminal
			initializedRef.current = true;
		}
	}, [sessionId, hasRunningTerminal, existingTerminals]);

	// Close terminal panel on unmount (navigating away)
	useEffect(() => {
		return () => {
			localStorage.removeItem(terminalStorageKey(sessionId));
		};
	}, [sessionId]);

	// Terminal width for desktop (as ratio of container)
	const [terminalRatio, setTerminalRatio] = useState(DEFAULT_TERMINAL_RATIO);
	const containerRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// Cross-component communication refs
	const writeToTerminalRef = useRef<((text: string) => void) | null>(null);
	const appendInputRef = useRef<((text: string) => void) | null>(null);

	// Terminal → Chat: append selected text to chat input
	const handleSendToChat = useCallback((text: string) => {
		appendInputRef.current?.(text);
	}, []);

	// Chat → Terminal: write selected text to terminal
	const handleSendToTerminal = useCallback((text: string) => {
		writeToTerminalRef.current?.(text);
	}, []);

	// Receive write function from SessionTerminal
	const handleWriteRef = useCallback((fn: ((text: string) => void) | null) => {
		writeToTerminalRef.current = fn;
	}, []);

	// Toggle terminal and persist
	const toggleTerminal = useCallback(() => {
		setTerminalOpen((v) => {
			const next = !v;
			localStorage.setItem(terminalStorageKey(sessionId), String(next));
			return next;
		});
	}, [sessionId]);

	// Auto-close terminal when process exits
	const handleTerminalExit = useCallback(() => {
		setTerminalOpen(false);
		localStorage.setItem(terminalStorageKey(sessionId), "false");
		if (isMobile) closeDrawer();
	}, [sessionId, isMobile, closeDrawer]);

	// Desktop drag handle for resizing (mouse + touch)
	const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
		e.preventDefault();
		dragging.current = true;

		const getClientX = (ev: MouseEvent | TouchEvent) =>
			"touches" in ev ? ev.touches[0].clientX : ev.clientX;

		const onMove = (ev: MouseEvent | TouchEvent) => {
			if (!dragging.current || !containerRef.current) return;
			const rect = containerRef.current.getBoundingClientRect();
			const terminalWidth = rect.right - getClientX(ev);
			const ratio = terminalWidth / rect.width;
			const minRatio = MIN_PANEL_WIDTH / rect.width;
			setTerminalRatio(Math.max(minRatio, Math.min(1 - minRatio, ratio)));
		};

		const onEnd = () => {
			dragging.current = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onEnd);
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onEnd);
		document.addEventListener("touchmove", onMove, { passive: false });
		document.addEventListener("touchend", onEnd);
	}, []);

	// Mobile layout
	if (unloaded) {
		return (
			<Box
				h="calc(100dvh - 60px)"
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
			>
				<Center h="100%">
					<Stack align="center" gap="sm">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("sessionUnloaded")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("sessionUnloadedHint")}
						</Text>
					</Stack>
				</Center>
			</Box>
		);
	}

	// Mobile layout
	if (isMobile) {
		return (
			<Box
				h="calc(100dvh - 60px)"
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
				style={{ display: "flex", flexDirection: "column", position: "relative" }}
			>
				<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
					<NarratorPanel
						key={sessionId}
						narratorId={sessionId}
						highlightMessageId={highlightMessageId}
						onSendToTerminal={handleSendToTerminal}
						appendInputRef={appendInputRef}
						terminalOpen={drawerOpened}
						onToggleTerminal={drawerOpened ? closeDrawer : openDrawer}
					/>
				</Box>

				{/* Mobile terminal drawer */}
				<Drawer
					opened={drawerOpened}
					onClose={closeDrawer}
					position="right"
					size="100%"
					title="Terminal"
					styles={{ body: { height: "calc(100% - 60px)", padding: 0 } }}
				>
					<SessionTerminal
						narratorId={sessionId}
						onSendToChat={handleSendToChat}
						onWriteRef={handleWriteRef}
						onExit={handleTerminalExit}
					/>
				</Drawer>
			</Box>
		);
	}

	// Desktop layout: side by side
	return (
		<Box
			ref={containerRef}
			h="calc(100dvh - 60px)"
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", flexDirection: "row", position: "relative" }}
		>
			{/* Chat panel */}
			<Box style={{ flex: 1, minWidth: MIN_PANEL_WIDTH, overflow: "hidden" }}>
				<NarratorPanel
					key={sessionId}
					narratorId={sessionId}
					highlightMessageId={highlightMessageId}
					onSendToTerminal={terminalOpen ? handleSendToTerminal : undefined}
					appendInputRef={appendInputRef}
					terminalOpen={terminalOpen}
					onToggleTerminal={toggleTerminal}
				/>
			</Box>

			{terminalOpen && (
				<>
					{/* Drag handle */}
					<Box
						onMouseDown={onDragStart}
						onTouchStart={onDragStart}
						style={{
							width: 6,
							cursor: "col-resize",
							backgroundColor: "var(--mantine-color-gray-3)",
							flexShrink: 0,
							transition: "background-color 0.15s",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = "var(--mantine-color-blue-4)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = "var(--mantine-color-gray-3)";
						}}
					/>

					{/* Terminal panel */}
					<Box
						style={{
							width: `${terminalRatio * 100}%`,
							minWidth: MIN_PANEL_WIDTH,
							flexShrink: 0,
							overflow: "hidden",
						}}
					>
						<SessionTerminal
							narratorId={sessionId}
							onSendToChat={handleSendToChat}
							onWriteRef={handleWriteRef}
							onExit={handleTerminalExit}
						/>
					</Box>
				</>
			)}
		</Box>
	);
}
