import { useMobileViewport } from "@frontend/hooks/useMobileViewport";
import { Box, Center, Drawer, Group, Loader, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	createFileRoute,
	useLocation,
	useNavigate,
	useRouter,
	useSearch,
} from "@tanstack/react-router";
import type { Direction } from "dockview-react";
import type React from "react";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChapterForkModal } from "../../components/chapter/ChapterForkModal";
import { clearHighlightCache } from "../../components/narrator/markdown/highlight-cache";
import { serializeSeedEnvelope } from "../../components/narrator/panels/layout-envelope";
import { twoNarratorWorkspaceSeed } from "../../components/narrator/workspace/dockview-layout";
import { clearShikiTokenCache } from "../../lib/shiki-token-cache";

// Lazy-loaded heavy panels — not needed for first paint (mobile drawers)
const NarratorTerminal = lazy(() =>
	import("../../components/terminal/NarratorTerminal").then((m) => ({
		default: m.NarratorTerminal,
	})),
);
const SpecPanel = lazy(() =>
	import("../../components/narrator/spec/SpecPanel").then((m) => ({
		default: m.SpecPanel,
	})),
);
const NarratorPanel = lazy(() =>
	import("../../components/narrator/NarratorPanel").then((m) => ({
		default: memo(m.NarratorPanel),
	})),
);

import { FocusChatHost } from "../../components/narrator/dock/FocusChatHost";
import { NarratorDock } from "../../components/narrator/dock/NarratorDock";
import { NarratorDockProvider } from "../../components/narrator/dock/NarratorDockContext";
import { useChapter } from "../../hooks/useChapters";
import { useMobileDrawerHistory } from "../../hooks/useMobileDrawerHistory";
import { useNarrator } from "../../hooks/useNarrator";
import { useTerminalCapability } from "../../hooks/usePlatform";
import {
	addRecentTabsBatch,
	addSubagentRecentTab,
	recordRecentTabVisit,
	shouldAddSubagentRecentTab,
} from "../../hooks/useRecentTabs";
import { useCreateNarratorTerminal, useNarratorTerminals } from "../../hooks/useTerminals";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../../lib/history-state";
import {
	isNarratorSubject,
	onPanelDragEnd,
	onPanelDragMove,
	type PanelDragState,
} from "../../lib/panel-drag";
import {
	APP_SHELL_FULL_BLEED_HEIGHT,
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
	safeAreaDrawerHeaderHeight,
	safeAreaDrawerHeaderPaddingTop,
} from "../../lib/safe-area";

export const Route = createFileRoute("/narrators/$narratorId")({
	component: NarratorDetailPage,
});

/** Drop zone overlay styles for drag-to-split — static, no need to recreate per render. */
const DROP_OVERLAY_STYLES: Record<string, React.CSSProperties> = {
	left: { left: 0, top: 0, width: "50%", height: "100%" },
	right: { right: 0, top: 0, width: "50%", height: "100%" },
	top: { left: 0, top: 0, width: "100%", height: "50%" },
	bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
};

/**
 * Mobile tool drawers (terminal / spec) share the narrator header's chrome so
 * every panel header is the same height: `py="xs"` (8px) + a `size="sm"` control
 * (28px) + 1px border ≈ 45px. The body fills the rest. `NarratorDetailsPanel`'s
 * own drawer mirrors these values.
 */
const MOBILE_DRAWER_HEADER_HEIGHT = 45;
const MOBILE_DRAWER_STYLES = {
	header: {
		minHeight: safeAreaDrawerHeaderHeight(MOBILE_DRAWER_HEADER_HEIGHT),
		paddingTop: safeAreaDrawerHeaderPaddingTop(8),
		paddingBottom: 8,
		paddingLeft: 16,
		paddingRight: 16,
		borderBottom: "1px solid var(--mantine-color-default-border)",
	},
	body: {
		height: safeAreaDrawerBodyHeight(MOBILE_DRAWER_HEADER_HEIGHT),
		padding: 0,
		...SAFE_AREA_DRAWER_BODY_STYLE,
	},
} as const;

function NarratorDetailPage() {
	const { narratorId } = Route.useParams();
	const router = useRouter();
	// biome-ignore lint/suspicious/noExplicitAny: loose search params
	const search = useSearch({ strict: false }) as any;
	const from = search?.from as string | undefined;
	const scrollToMessageId = search?.scrollTo as string | undefined;
	const location = useLocation();
	const hashMessageId = location.hash?.startsWith("msg-") ? location.hash.slice(4) : undefined;
	// scrollTo search param takes precedence over hash-based highlight
	const highlightMessageId = scrollToMessageId ?? hashMessageId;
	const isMobile = useMobileViewport();

	// Fetch narrator data for recent tab tracking
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isSubagent = !!(narrator as any)?.variant?.startsWith("subagent:");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isScheduled = Array.isArray((narrator as any)?.traits)
		? // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			((narrator as any).traits as string[]).includes("scheduled")
		: false;
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
	const { data: userPrefs, isLoading: userPrefsLoading } = useUserPreferences();

	// First visit: register the tab on the server (once per narratorId)
	useEffect(() => {
		if (!narrator) return;
		if (isSubagent) {
			if (
				!shouldAddSubagentRecentTab({
					isLoading: userPrefsLoading,
					addSubagentToRecentTabs: userPrefs?.addSubagentToRecentTabs,
				})
			) {
				return;
			}
			addSubagentRecentTab({
				id: narratorId,
				parentNarratorId,
				title: narratorTitle,
				cwd: narratorCwd,
				status: narratorStatus,
				isScheduled,
			});
			return;
		}
		if (chapterId) {
			// Chapter-bound narrator: record as chapter tab
			const displayTitle = narratorTitle || chapterTitle || "Chapter";
			void recordRecentTabVisit({
				type: "chapter",
				id: chapterId,
				narratorId: narratorId,
				title: displayTitle,
				subtitle: chapterTitle,
				status: narratorStatus,
				isScheduled,
			});
		} else {
			void recordRecentTabVisit({
				type: "narrator",
				id: narratorId,
				title: narratorTitle || "New conversation",
				subtitle: narratorCwd,
				status: narratorStatus,
				isScheduled,
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
		isScheduled,
		parentNarratorId,
		userPrefs?.addSubagentToRecentTabs,
		userPrefsLoading,
	]);

	// Notify backend when leaving this narrator page so interrupted status resets to idle
	useEffect(() => {
		return () => {
			api.leaveNarrator(narratorId).catch(() => {});
			// Free syntax highlight caches when leaving narrator pages to reduce memory.
			// Two caches, one per render path: HTML for the chunked list, tokens for the
			// pretext virtual list.
			clearHighlightCache();
			clearShikiTokenCache();
		};
	}, [narratorId]);

	// Check if there's a running terminal for this narrator
	const { data: existingTerminals } = useNarratorTerminals(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const hasRunningTerminal = (existingTerminals ?? []).some((t: any) => t.status === "running");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const runningCount = (existingTerminals ?? []).filter((t: any) => t.status === "running").length;
	const createTerminal = useCreateNarratorTerminal(narratorId);
	const terminalCapability = useTerminalCapability();
	const terminalSupported = terminalCapability.supported;

	// Terminal drawer for mobile
	const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
	// Spec drawer for mobile
	const [specDrawerOpened, { open: openSpecDrawer, close: closeSpecDrawer }] = useDisclosure(false);

	// Intercept browser back button to close mobile terminal drawer instead of navigating away.
	//
	// Gated on `isMobile` for the same reason the drawer itself is: only the mobile branch of
	// this route renders it, so on desktop `drawerOpened` can only be a stale `true` left over
	// from a narrow window that was then widened. Pushing a sentinel for a drawer that is not
	// mounted makes Back a no-op with nothing visible to close.
	useEffect(() => {
		if (!drawerOpened || !isMobile) return;
		return pushHistorySentinel(router.history, APP_HISTORY_SENTINEL.terminalDrawer, closeDrawer)
			.dispose;
	}, [drawerOpened, isMobile, closeDrawer, router.history]);
	useMobileDrawerHistory(specDrawerOpened, closeSpecDrawer);

	// Mobile: open drawer and auto-create terminal if none running
	const openDrawerWithTerminal = useCallback(() => {
		if (terminalSupported && !hasRunningTerminal) {
			createTerminal.mutate({ name: "Terminal 1" });
		}
		openDrawer();
	}, [terminalSupported, hasRunningTerminal, createTerminal, openDrawer]);
	const writeToTerminalRef = useRef<((text: string) => void) | null>(null);
	const appendInputRef = useRef<((text: string) => void) | null>(null);

	// Terminal → Chat: append selected text to chat input (mobile drawer)
	const handleSendToChat = useCallback((text: string) => {
		appendInputRef.current?.(text);
	}, []);

	// Chat → Terminal: write selected text to terminal (mobile drawer)
	const handleSendToTerminal = useCallback((text: string) => {
		writeToTerminalRef.current?.(text);
	}, []);

	// Receive write function from NarratorTerminal (mobile drawer)
	const handleWriteRef = useCallback((fn: ((text: string) => void) | null) => {
		writeToTerminalRef.current = fn;
	}, []);

	const { t: tn } = useTranslation("narrator");
	const { t: tt } = useTranslation("terminal");
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

	const [forkMessageId, setForkMessageId] = useState<string | null>(null);
	const handleForkFromMessage = useCallback(
		(messageId: string) => {
			if (chapterId) setForkMessageId(messageId);
		},
		[chapterId],
	);

	// Mobile drawer: auto-close when the last terminal exits
	const handleTerminalExit = useCallback(() => {
		if (runningCount <= 1 && isMobile) {
			closeDrawer();
		}
	}, [isMobile, closeDrawer, runningCount]);

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

		const unsubMove = onPanelDragMove((state: PanelDragState) => {
			// Ignore self-drags and in-dock tool-panel rearrangements: only a real
			// narrator dragged onto this page may create a workspace.
			if (state.id === narratorId || !isNarratorSubject(state)) {
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

		const unsubEnd = onPanelDragEnd((final: PanelDragState | null) => {
			const side = dropSideRef.current;
			dropSideRef.current = null;
			setDropSide(null);
			if (!final || !side || final.id === narratorId || !isNarratorSubject(final)) return;

			// Create a workspace seeded with two narrator panels. The dropped panel
			// sits on the drop side; the current narrator takes the other half. We
			// persist an api-free seed envelope (not a legacy split-tree) that the
			// DockviewWorkspace materialises on mount.
			const dropFirst = side === "left" || side === "top";
			const direction: Direction = side === "left" || side === "right" ? "right" : "below";
			const [firstId, secondId] = dropFirst ? [final.id, narratorId] : [narratorId, final.id];
			const seed = twoNarratorWorkspaceSeed(firstId, secondId, direction);

			api
				.createWorkspace({ tree: serializeSeedEnvelope(seed) })
				.then(async (ws) => {
					await addRecentTabsBatch([
						{
							type: "workspace",
							id: ws.id,
							// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
							title: (ws as any).title || "Workspace",
						},
						{
							type: "narrator",
							id: narratorId,
							title: "",
							workspaceId: ws.id,
							updateOnly: true,
						},
						{
							type: "narrator",
							id: final.id,
							title: "",
							workspaceId: ws.id,
							updateOnly: true,
						},
					]).catch(() => {});
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

	// Ref for drag-to-split drop zone detection
	const mergedRef = useCallback((el: HTMLDivElement | null) => {
		pageBoxRef.current = el;
	}, []);

	// The provider and portal owner never cross the responsive identity boundary.
	return (
		<NarratorDockProvider
			key={narratorId}
			narratorId={narratorId}
			chapterId={chapterId}
			onForkFromMessage={chapterId ? handleForkFromMessage : null}
			highlightMessageId={highlightMessageId}
			onBack={isSubagent ? onBack : null}
			onMinimize={showMinimize ? onMinimize : null}
		>
			<Box
				ref={mergedRef}
				h={APP_SHELL_FULL_BLEED_HEIGHT}
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
				style={{
					display: "flex",
					flexDirection: "column",
					position: "relative",
					overflow: "hidden",
					isolation: "isolate",
				}}
			>
				<FocusChatHost
					narratorId={narratorId}
					isMobile={isMobile}
					renderChat={({ compact, onHeaderPointerDown, onViewSubagentSession }) => (
						<Suspense
							fallback={
								<Center h="100%">
									<Loader size="sm" />
								</Center>
							}
						>
							<NarratorPanel
								narratorId={narratorId}
								narrator={narrator}
								ownsHorizontalSafeArea={isMobile}
								compact={compact}
								onHeaderPointerDown={isMobile ? undefined : onHeaderPointerDown}
								onViewSubagentSession={onViewSubagentSession}
								highlightMessageId={highlightMessageId}
								onForkFromMessage={chapterId ? handleForkFromMessage : undefined}
								onSendToTerminal={isMobile && !isSubagent ? handleSendToTerminal : undefined}
								appendInputRef={isMobile && !isSubagent ? appendInputRef : undefined}
								terminalOpen={isMobile && !isSubagent ? drawerOpened : undefined}
								onToggleTerminal={
									isMobile && !isSubagent
										? drawerOpened
											? closeDrawer
											: openDrawerWithTerminal
										: undefined
								}
								onMinimize={showMinimize ? onMinimize : undefined}
								onBack={isSubagent ? onBack : undefined}
								specPanelOpen={isMobile ? specDrawerOpened : undefined}
								onToggleSpecPanel={
									isMobile ? (specDrawerOpened ? closeSpecDrawer : openSpecDrawer) : undefined
								}
							/>
						</Suspense>
					)}
				>
					{!isMobile && <NarratorDock device="desktop" />}
					{isMobile && (
						<>
							{/* Mobile terminal drawer */}
							<Drawer
								opened={drawerOpened}
								onClose={closeDrawer}
								position="right"
								size="100%"
								title={
									<Text size="sm" fw={600} truncate>
										{tt("terminal")}
									</Text>
								}
								closeButtonProps={{ size: "sm" }}
								styles={MOBILE_DRAWER_STYLES}
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

							{/* Mobile spec drawer — chromeless panel; title + save/reload live in
				    the drawer header (mirrors the desktop dock). */}
							<Drawer
								opened={specDrawerOpened}
								onClose={() => {
									closeSpecDrawer();
								}}
								position="right"
								size="100%"
								title={
									<Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
										<Text size="sm" fw={600} truncate style={{ flex: 1 }}>
											{tn("spec.title")}
										</Text>
									</Group>
								}
								closeButtonProps={{ size: "sm" }}
								styles={MOBILE_DRAWER_STYLES}
							>
								<Suspense
									fallback={
										<Center h="100%">
											<Loader size="sm" />
										</Center>
									}
								>
									<SpecPanel narratorId={narratorId} onClose={closeSpecDrawer} chromeless />
								</Suspense>
							</Drawer>
						</>
					)}
				</FocusChatHost>

				{/* Drop zone overlay for drag-to-split (drag another narrator here) */}
				{chapterId && forkMessageId && (
					<ChapterForkModal
						chapterId={chapterId}
						chapterStatus={(chapter as { status?: string } | undefined)?.status}
						forkAtMessageId={forkMessageId}
						opened
						onClose={() => setForkMessageId(null)}
					/>
				)}

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
		</NarratorDockProvider>
	);
}
