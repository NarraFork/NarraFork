import { Box, Center, Drawer, Loader, Stack, Text } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import type React from "react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clearHighlightCache } from "../../components/narrator/highlight-cache";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import type { FileModPanelExternalProps } from "../../components/narrator/narrator-panel-types";
import {
	createBranch,
	createLeafWith,
	type SplitDirection,
} from "../../components/narrator/split-tree";

// Lazy-loaded heavy panels — not needed for first paint
const NarratorTerminal = lazy(() =>
	import("../../components/terminal/NarratorTerminal").then((m) => ({
		default: m.NarratorTerminal,
	})),
);
const FileModificationsPanel = lazy(() =>
	import("../../components/narrator/FileModificationsDrawer").then((m) => ({
		default: m.FileModificationsPanel,
	})),
);

import { useChapter } from "../../hooks/useChapters";
import { useNarrator } from "../../hooks/useNarrator";
import { usePageUnload } from "../../hooks/usePageUnload";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { useCreateNarratorTerminal, useNarratorTerminals } from "../../hooks/useTerminals";
import { api } from "../../lib/api";
import {
	type NarratorDragState,
	onNarratorDragEnd,
	onNarratorDragMove,
} from "../../lib/narrator-drag";

export const Route = createFileRoute("/narrators/$narratorId")({
	component: NarratorDetailPage,
});

const MIN_PANEL_WIDTH = 200;
const DEFAULT_TERMINAL_RATIO = 0.4;

/** Drop zone overlay styles for drag-to-split — static, no need to recreate per render. */
const DROP_OVERLAY_STYLES: Record<string, React.CSSProperties> = {
	left: { left: 0, top: 0, width: "50%", height: "100%" },
	right: { right: 0, top: 0, width: "50%", height: "100%" },
	top: { left: 0, top: 0, width: "100%", height: "50%" },
	bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
};

function terminalStorageKey(narratorId: string) {
	return `narrafork_terminal_open_${narratorId}`;
}

function NarratorDetailPage() {
	const { narratorId } = Route.useParams();
	// biome-ignore lint/suspicious/noExplicitAny: loose search params
	const search = useSearch({ strict: false }) as any;
	const from = search?.from as string | undefined;
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
	const parentNarratorId = (narrator as any)?.parentNarratorId as string | null | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = isSubagent ? null : ((narrator as any)?.chapterId as string | null | undefined);
	const { data: chapter } = useChapter(chapterId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const projectId = (chapter as any)?.projectId as string | undefined;

	// For subagents: fetch parent narrator to resolve chapter/project for graph navigation
	const { data: parentNarrator } = useNarrator(
		isSubagent && parentNarratorId ? parentNarratorId : "",
	);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const parentChapterId = (parentNarrator as any)?.chapterId as string | null | undefined;
	const { data: parentChapter } = useChapter(parentChapterId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const parentProjectId = (parentChapter as any)?.projectId as string | undefined;

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

	const qc = useQueryClient();

	// Notify backend when leaving this narrator page so interrupted status resets to idle
	useEffect(() => {
		return () => {
			api.leaveNarrator(narratorId).catch(() => {});
			// Free syntax highlight cache when leaving narrator pages to reduce memory
			clearHighlightCache();
		};
	}, [narratorId]);

	// Check if there's a running terminal for this narrator
	const { data: existingTerminals } = useNarratorTerminals(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const hasRunningTerminal = (existingTerminals ?? []).some((t: any) => t.status === "running");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const runningCount = (existingTerminals ?? []).filter((t: any) => t.status === "running").length;
	const createTerminal = useCreateNarratorTerminal(narratorId);

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
	const initializedForRef = useRef<string | null>(null);

	useEffect(() => {
		if (initializedForRef.current === narratorId) return;
		const saved = localStorage.getItem(terminalStorageKey(narratorId));
		if (saved === "true" && hasRunningTerminal) {
			setTerminalOpen(true);
			initializedForRef.current = narratorId;
		} else if (existingTerminals !== undefined) {
			// Data loaded but no saved state or no running terminal — reset panel
			setTerminalOpen(saved === "true" && hasRunningTerminal);
			initializedForRef.current = narratorId;
		}
	}, [narratorId, hasRunningTerminal, existingTerminals]);

	// Terminal width for desktop (as ratio of container)
	const [terminalRatio, setTerminalRatio] = useState(DEFAULT_TERMINAL_RATIO);
	const containerRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// Desktop file modifications panel
	const [fileModOpen, setFileModOpen] = useState(false);
	const [fileModPanelProps, setFileModPanelProps] = useState<FileModPanelExternalProps | null>(
		null,
	);
	// When file mod panel opens, we keep terminal visible (they share the right side)
	// The right side shows whichever was opened last; for simplicity, they are mutually exclusive.
	const handleToggleFileModPanel = useCallback(() => {
		setFileModOpen((prev) => {
			if (!prev) {
				// Opening file mod panel — close terminal
				setTerminalOpen(false);
				localStorage.setItem(terminalStorageKey(narratorId), "false");
			}
			return !prev;
		});
	}, [narratorId]);

	// Mobile: open drawer and auto-create terminal if none running
	const openDrawerWithTerminal = useCallback(() => {
		if (!hasRunningTerminal) {
			createTerminal.mutate({ name: "Terminal 1" });
		}
		openDrawer();
	}, [hasRunningTerminal, createTerminal, openDrawer]);
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

	// Toggle terminal and persist; auto-create a terminal when opening with none running
	const toggleTerminal = useCallback(() => {
		const willOpen = !terminalOpen;
		setTerminalOpen(willOpen);
		localStorage.setItem(terminalStorageKey(narratorId), String(willOpen));
		if (willOpen && !hasRunningTerminal) {
			createTerminal.mutate({ name: "Terminal 1" });
		}
		// Close file mod panel when opening terminal
		if (willOpen) setFileModOpen(false);
	}, [narratorId, terminalOpen, hasRunningTerminal, createTerminal]);

	const { t: tc } = useTranslation("chapters");
	const { t: tCommon } = useTranslation("common");
	const navigate = useNavigate();

	// When navigated from narraflow graph, show minimize button to return to graph
	const onMinimize = useCallback(() => {
		if (projectId && chapterId) {
			navigate({
				to: "/projects/$projectId",
				params: { projectId },
				search: { focus: chapterId },
			});
		}
	}, [navigate, projectId, chapterId]);
	const showMinimize = from === "graph" && !!projectId && !!chapterId;

	// Subagent back navigation: return to parent narrator, or to graph if opened from graph
	const onBack = useCallback(() => {
		if (isSubagent) {
			if (from === "graph" && parentProjectId && parentChapterId) {
				navigate({
					to: "/projects/$projectId",
					params: { projectId: parentProjectId },
					search: { focus: parentChapterId },
				});
			} else if (parentNarratorId) {
				navigate({
					to: "/narrators/$narratorId",
					params: { narratorId: parentNarratorId },
					search: from ? { from } : undefined,
				});
			} else {
				navigate({ to: ".." });
			}
		} else {
			navigate({ to: ".." });
		}
	}, [isSubagent, from, parentProjectId, parentChapterId, parentNarratorId, navigate]);

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

				// Add the forked chapter to recent tabs immediately
				if (primary?.id) {
					addRecentTab({
						type: "chapter",
						id: data.id,
						narratorId: primary.id,
						title: data.title ?? "Fork",
						subtitle: data.title,
						status: primary.status,
					});
				}

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

	// ── Drag-to-split: drop zone for creating workspace ──
	type DropSide = "left" | "right" | "top" | "bottom" | null;
	const [dropSide, setDropSide] = useState<DropSide>(null);
	const dropSideRef = useRef<DropSide>(null);
	const pageBoxRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const computeSide = (rect: DOMRect, x: number, y: number): DropSide => {
			const relX = (x - rect.left) / rect.width;
			const relY = (y - rect.top) / rect.height;
			// Edge threshold: 30% from each edge
			if (relX < 0.3) return "left";
			if (relX > 0.7) return "right";
			if (relY < 0.3) return "top";
			if (relY > 0.7) return "bottom";
			return "right"; // default to right split
		};

		const unsubMove = onNarratorDragMove((state: NarratorDragState) => {
			// Don't allow dropping the same narrator
			if (state.narratorId === narratorId) {
				if (dropSideRef.current) {
					dropSideRef.current = null;
					setDropSide(null);
				}
				return;
			}
			const el = pageBoxRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				state.x >= rect.left &&
				state.x <= rect.right &&
				state.y >= rect.top &&
				state.y <= rect.bottom;
			if (inside) {
				const side = computeSide(rect, state.x, state.y);
				dropSideRef.current = side;
				setDropSide(side);
			} else if (dropSideRef.current) {
				dropSideRef.current = null;
				setDropSide(null);
			}
		});

		const unsubEnd = onNarratorDragEnd((final: NarratorDragState | null) => {
			const side = dropSideRef.current;
			dropSideRef.current = null;
			setDropSide(null);
			if (!final || !side || final.narratorId === narratorId) return;

			// Create workspace with two panels
			const direction: SplitDirection =
				side === "left" || side === "right" ? "horizontal" : "vertical";
			const currentLeaf = createLeafWith(narratorId);
			const droppedLeaf = createLeafWith(final.narratorId);
			const children =
				side === "left" || side === "top" ? [droppedLeaf, currentLeaf] : [currentLeaf, droppedLeaf];
			const tree = createBranch(direction, children);

			api
				.createWorkspace({ tree: JSON.stringify(tree) })
				.then((ws) => {
					addRecentTab({
						type: "workspace",
						id: ws.id,
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
						title: (ws as any).title || "Workspace",
					});
					// Mark both narrator tabs as belonging to this workspace
					addRecentTab({
						type: "narrator",
						id: narratorId,
						title: "",
						workspaceId: ws.id,
						updateOnly: true,
					});
					addRecentTab({
						type: "narrator",
						id: final.narratorId,
						title: "",
						workspaceId: ws.id,
						updateOnly: true,
					});
					navigate({
						to: "/narrators/workspace/$workspaceId",
						params: { workspaceId: ws.id },
					});
				})
				.catch(() => {});
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [narratorId, navigate]);

	// Desktop drag handle for resizing (mouse + touch)
	const dragCleanupRef = useRef<(() => void) | null>(null);
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
			dragCleanupRef.current = null;
		};

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onEnd);
		document.addEventListener("touchmove", onMove, { passive: false });
		document.addEventListener("touchend", onEnd);
		dragCleanupRef.current = onEnd;
	}, []);

	// Cleanup drag listeners on unmount (in case user navigates mid-drag)
	useEffect(() => {
		return () => {
			dragCleanupRef.current?.();
		};
	}, []);

	// Merged ref for both terminal resize and drop zone detection
	const mergedRef = useCallback((el: HTMLDivElement | null) => {
		(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
		pageBoxRef.current = el;
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
						onToggleTerminal={
							isSubagent ? undefined : drawerOpened ? closeDrawer : openDrawerWithTerminal
						}
						onMinimize={showMinimize ? onMinimize : undefined}
						onBack={isSubagent ? onBack : undefined}
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
					<Suspense
						fallback={
							<Center h="100%">
								<Loader size="sm" />
							</Center>
						}
					>
						<NarratorTerminal
							narratorId={narratorId}
							onSendToChat={handleSendToChat}
							onWriteRef={handleWriteRef}
							onExit={handleTerminalExit}
						/>
					</Suspense>
				</Drawer>
			</Box>
		);
	}

	// Desktop layout: side by side

	return (
		<Box
			ref={mergedRef}
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
					onMinimize={showMinimize ? onMinimize : undefined}
					onBack={isSubagent ? onBack : undefined}
					fileModPanelOpen={isSubagent ? undefined : fileModOpen}
					onToggleFileModPanel={isSubagent ? undefined : handleToggleFileModPanel}
					onFileModPropsChange={isSubagent ? undefined : setFileModPanelProps}
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
							borderLeft: "1px solid var(--mantine-color-default-border)",
						}}
					/>

					{/* Terminal panel */}
					<Box
						style={{
							width: `${terminalRatio * 100}%`,
							minWidth: MIN_PANEL_WIDTH,
							flexShrink: 0,
							overflow: "hidden",
							paddingLeft: 4,
						}}
					>
						<Suspense
							fallback={
								<Center h="100%">
									<Loader size="sm" />
								</Center>
							}
						>
							<NarratorTerminal
								narratorId={narratorId}
								onSendToChat={handleSendToChat}
								onWriteRef={handleWriteRef}
								onExit={handleTerminalExit}
							/>
						</Suspense>
					</Box>
				</>
			)}

			{!isSubagent && fileModOpen && !terminalOpen && (
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
							borderLeft: "1px solid var(--mantine-color-default-border)",
						}}
					/>

					{/* File modifications panel */}
					<Box
						style={{
							width: `${terminalRatio * 100}%`,
							minWidth: MIN_PANEL_WIDTH,
							flexShrink: 0,
							overflow: "hidden",
							paddingLeft: 4,
						}}
					>
						<Suspense
							fallback={
								<Center h="100%">
									<Loader size="sm" />
								</Center>
							}
						>
							<FileModificationsPanel
								narratorId={narratorId}
								onClose={() => setFileModOpen(false)}
								pendingPermission={fileModPanelProps?.pendingPermission}
								onPermissionDecision={fileModPanelProps?.onPermissionDecision}
								deletePreviewMessageId={fileModPanelProps?.deletePreviewMessageId}
								onConfirmDelete={fileModPanelProps?.onConfirmDelete}
								onCancelDelete={fileModPanelProps?.onCancelDelete}
							/>
						</Suspense>
					</Box>
				</>
			)}

			{/* Drop zone overlay for drag-to-split */}
			{dropSide && (
				<Box
					style={{
						position: "absolute",
						...DROP_OVERLAY_STYLES[dropSide],
						backgroundColor: "var(--mantine-color-indigo-9)",
						opacity: 0.2,
						borderRadius: 4,
						pointerEvents: "none",
						transition: "all 100ms ease",
						zIndex: 100,
					}}
				/>
			)}
		</Box>
	);
}
