import { Box, Center, Drawer, Loader, Stack, Text } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { NarratorTerminal } from "../../components/terminal/NarratorTerminal";
import { useChapter } from "../../hooks/useChapters";
import { useNarrator } from "../../hooks/useNarrator";
import { usePageUnload } from "../../hooks/usePageUnload";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { api } from "../../lib/api";

export const Route = createFileRoute("/narrators/$narratorId")({
	component: NarratorDetailPage,
});

const MIN_PANEL_WIDTH = 200;
const DEFAULT_TERMINAL_RATIO = 0.4;

function terminalStorageKey(narratorId: string) {
	return `narrafork_terminal_open_${narratorId}`;
}

function NarratorDetailPage() {
	const { narratorId } = Route.useParams();
	const location = useLocation();
	const highlightMessageId = location.hash?.startsWith("msg-") ? location.hash.slice(4) : undefined;
	const isMobile = useMediaQuery("(max-width: 768px)");
	const { t } = useTranslation("narrators");

	// Unload heavy components when the tab has been hidden for a while
	const unloaded = usePageUnload();

	// Fetch narrator data for recent tab tracking
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isSubagent = (narrator as any)?.type === "subagent";
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = isSubagent ? null : ((narrator as any)?.chapterId as string | null | undefined);
	const { data: chapter } = useChapter(chapterId ?? "");

	// Record recent tab visit (skip for subagent narrators)
	const narratorTitle = narrator?.title;
	const narratorCwd = narrator?.cwd;
	const narratorStatus = narrator?.status;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterTitle = (chapter as any)?.title as string | undefined;

	// First visit: register the tab on the server (once per narratorId)
	useEffect(() => {
		if (!narrator || isSubagent) return;
		if (chapterId) {
			// Chapter-bound narrator: record as chapter tab
			const displayTitle = narratorTitle || chapterTitle || "Chapter";
			addRecentTab({
				type: "chapter",
				id: chapterId,
				narratorId: narratorId,
				title: displayTitle,
				subtitle: chapterTitle,
				status: narratorStatus,
			});
		} else {
			addRecentTab({
				type: "narrator",
				id: narratorId,
				title: narratorTitle || "New conversation",
				subtitle: narratorCwd,
				status: narratorStatus,
			});
		}
	}, [
		narratorId,
		chapterId,
		narrator,
		narratorTitle,
		narratorCwd,
		narratorStatus,
		chapterTitle,
		isSubagent,
	]);

	// Mark narrator as read (done → idle) when visiting the narrator page.
	// Preserve error sessions: if errorMessage exists, keep it in error state.
	const qc = useQueryClient();
	const narratorErrorMessage = narrator?.errorMessage;
	useEffect(() => {
		if (isSubagent || narratorErrorMessage) return;
		api
			.markNarratorRead(narratorId)
			.then(() => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			})
			.catch(() => {});
	}, [narratorId, qc, isSubagent, narratorErrorMessage]);

	// Check if there's a running terminal for this narrator
	const { data: existingTerminals } = useNarratorTerminals(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const hasRunningTerminal = (existingTerminals ?? []).some((t: any) => t.status === "running");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const runningCount = (existingTerminals ?? []).filter((t: any) => t.status === "running").length;

	// Terminal drawer for mobile
	const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);

	// Intercept browser back button to close mobile terminal drawer instead of navigating away
	const closedByPopState = useRef(false);
	useEffect(() => {
		if (!drawerOpened) return;
		closedByPopState.current = false;
		history.pushState({ terminalDrawer: true }, "");
		const onPopState = () => {
			closedByPopState.current = true;
			closeDrawer();
		};
		window.addEventListener("popstate", onPopState);
		return () => {
			window.removeEventListener("popstate", onPopState);
			if (!closedByPopState.current) {
				history.back();
			}
		};
	}, [drawerOpened, closeDrawer]);

	// Desktop terminal panel visibility — restore from localStorage if a running terminal exists
	const [terminalOpen, setTerminalOpen] = useState(false);
	const initializedRef = useRef(false);

	useEffect(() => {
		if (initializedRef.current) return;
		const saved = localStorage.getItem(terminalStorageKey(narratorId));
		if (saved === "true" && hasRunningTerminal) {
			setTerminalOpen(true);
			initializedRef.current = true;
		} else if (existingTerminals !== undefined) {
			// Data loaded but no saved state or no running terminal
			initializedRef.current = true;
		}
	}, [narratorId, hasRunningTerminal, existingTerminals]);

	// Close terminal panel on unmount (navigating away)
	useEffect(() => {
		return () => {
			localStorage.removeItem(terminalStorageKey(narratorId));
		};
	}, [narratorId]);

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

	// Receive write function from NarratorTerminal
	const handleWriteRef = useCallback((fn: ((text: string) => void) | null) => {
		writeToTerminalRef.current = fn;
	}, []);

	// Toggle terminal and persist
	const toggleTerminal = useCallback(() => {
		setTerminalOpen((v) => {
			const next = !v;
			localStorage.setItem(terminalStorageKey(narratorId), String(next));
			return next;
		});
	}, [narratorId]);

	const { t: tc } = useTranslation("chapters");
	const { t: tCommon } = useTranslation("common");
	const navigate = useNavigate();

	// Fork-from-message: directly fork without modal
	const forkFromMessage = useMutation({
		mutationFn: (messageUuid: string) => {
			if (!chapterId) throw new Error("No chapter");
			return api.forkChapter(chapterId, {
				inheritMode: "full",
				forkAtMessageUuid: messageUuid,
			});
		},
		onSuccess: async (data) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
			if (data?.id) {
				const narrators = await api.listNarrators({ chapterId: data.id });
				// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
				const primary = narrators?.find((n: any) => n.type === "primary");
				notifications.show({
					title: tc("forkSuccess"),
					message: tc("forkCreatedClick", { title: data.title ?? "Fork" }),
					color: "green",
					autoClose: 6000,
					onClick: () => {
						if (primary?.id) {
							navigate({
								to: "/narrators/$narratorId",
								params: { narratorId: primary.id },
							});
						} else {
							navigate({
								to: "/chapters/$chapterId",
								params: { chapterId: data.id },
							});
						}
					},
					style: { cursor: "pointer" },
				});
			}
		},
		onError: (err) => {
			notifications.show({
				title: tc("forkFailed"),
				message: err instanceof Error ? err.message : tCommon("unknownError"),
				color: "red",
			});
		},
	});
	const handleForkFromMessage = useCallback(
		(messageUuid: string) => {
			if (!chapterId) return;
			forkFromMessage.mutate(messageUuid);
		},
		[chapterId, forkFromMessage],
	);

	// Auto-close terminal panel only when the last terminal exits
	const handleTerminalExit = useCallback(() => {
		if (runningCount <= 1) {
			setTerminalOpen(false);
			localStorage.setItem(terminalStorageKey(narratorId), "false");
			if (isMobile) closeDrawer();
		}
	}, [narratorId, isMobile, closeDrawer, runningCount]);

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
							{t("narratorUnloaded")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("narratorUnloadedHint")}
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
						key={narratorId}
						narratorId={narratorId}
						highlightMessageId={highlightMessageId}
						onForkFromMessage={chapterId ? handleForkFromMessage : undefined}
						onSendToTerminal={isSubagent ? undefined : handleSendToTerminal}
						appendInputRef={isSubagent ? undefined : appendInputRef}
						terminalOpen={isSubagent ? undefined : drawerOpened}
						onToggleTerminal={isSubagent ? undefined : drawerOpened ? closeDrawer : openDrawer}
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
					<NarratorTerminal
						narratorId={narratorId}
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
					key={narratorId}
					narratorId={narratorId}
					highlightMessageId={highlightMessageId}
					onForkFromMessage={chapterId ? handleForkFromMessage : undefined}
					onSendToTerminal={
						isSubagent ? undefined : terminalOpen ? handleSendToTerminal : undefined
					}
					appendInputRef={isSubagent ? undefined : appendInputRef}
					terminalOpen={isSubagent ? undefined : terminalOpen}
					onToggleTerminal={isSubagent ? undefined : toggleTerminal}
				/>
			</Box>

			{!isSubagent && terminalOpen && (
				<>
					{/* Drag handle */}
					<Box
						onMouseDown={onDragStart}
						onTouchStart={onDragStart}
						style={{
							position: "relative",
							width: 6,
							cursor: "col-resize",
							flexShrink: 0,
							borderRight: "1px solid var(--mantine-color-dark-4)",
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
						<NarratorTerminal
							narratorId={narratorId}
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
