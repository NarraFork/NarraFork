import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Collapse,
	Group,
	Loader,
	Menu,
	Modal,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconArrowsMaximize,
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconNetwork,
	IconPlayerStop,
	IconPlug,
	IconRefresh,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useBrowserSessions,
	useCloseBrowserSession,
	useInteractBrowserSession,
	useLoadOptionalTool,
	useOptionalToolState,
	useSetBrowserSessionTtl,
	useStopBrowserTracing,
} from "../../../hooks/useBrowserSessions";
import { useNarratorBrowserSessionsCapability } from "../../../hooks/usePlatform";
import { ApiError, authorizedFetch, getToken, readFetchError } from "../../../lib/api";
import {
	SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
	SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
	safeAreaFullscreenModalBodyStyle,
} from "../../../lib/safe-area";
import {
	type BrowserPreviewViewport,
	getBrowserPreviewExpandedWidth,
	getBrowserPreviewNavigationUrl,
	openBrowserPreviewNavigation,
	translateBrowserPreviewCoordinate,
} from "./browser-preview";

interface BrowserPanelProps {
	narratorId: string;
	sessionCount?: number;
	/** Latest visual-change event — triggers auto-refresh. The seq disambiguates
	 *  repeated changes to the same session so each one re-runs the effect. */
	visualChange?: { sessionId: string; seq: number } | null;
	/**
	 * When true (dock surface), render as a full panel: no collapsible toggle
	 * header (the dock's ToolPanelShell provides title + count badge), sessions
	 * are always shown and always fetched.
	 */
	chromeless?: boolean;
}

export function BrowserPanel({
	narratorId,
	sessionCount,
	visualChange,
	chromeless = false,
}: BrowserPanelProps) {
	const { t } = useTranslation("narrator");
	const browserSessionsCapability = useNarratorBrowserSessionsCapability();
	const [opened, setOpened] = useState(false);
	// In the dock the panel is always visible, so always fetch; as an embedded
	// widget it only fetches once expanded.
	const expanded = chromeless || opened;
	const enabled = browserSessionsCapability.supported !== false && expanded;
	const { data: sessions } = useBrowserSessions(enabled ? narratorId : "");
	// Only the dock surface offers the load button, so skip the extra request for
	// the embedded widget.
	const { data: toolState } = useOptionalToolState(narratorId, "browser", enabled && chromeless);
	if (browserSessionsCapability.supported === false) return null;

	const count = sessions?.length ?? sessionCount ?? 0;
	// The dock always renders the panel shell; only the embedded widget hides
	// itself when there are no sessions.
	if (count === 0 && !chromeless) return null;

	const sessionGrid = (
		<Box
			px="sm"
			pb="xs"
			style={{
				maxHeight: chromeless ? undefined : 600,
				overflowY: "auto",
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
				gap: 8,
			}}
		>
			{sessions?.map((session) => (
				<BrowserSessionCard
					key={session.id}
					narratorId={narratorId}
					session={session}
					visualChange={visualChange}
				/>
			))}
		</Box>
	);

	// Dock: no own header (shell provides it); content fills the panel.
	if (chromeless) {
		return (
			<Box style={{ height: "100%", overflowY: "auto", paddingTop: 8 }}>
				{count === 0 ? (
					toolState && !toolState.loaded ? (
						<BrowserToolLoadPrompt
							narratorId={narratorId}
							disabledByTrait={toolState.disabledByTrait}
						/>
					) : (
						<Text size="xs" c="dimmed" ta="center" pt="md">
							{t("browser.title")}
						</Text>
					)
				) : (
					sessionGrid
				)}
			</Box>
		);
	}

	return (
		<Box
			style={{
				borderTop: "1px solid var(--mantine-color-default-border)",
				flexShrink: 0,
			}}
		>
			<UnstyledButton
				w="100%"
				px="md"
				py={4}
				onClick={() => setOpened((v) => !v)}
				style={{ display: "flex", alignItems: "center" }}
			>
				<Group gap={6} wrap="nowrap" style={{ flex: 1 }}>
					<IconWorldWww size={14} color="var(--mantine-color-teal-5)" />
					<Text size="xs" fw={500} c="teal">
						{t("browser.title")}
					</Text>
					<Badge size="xs" variant="light" color="teal" circle>
						{count}
					</Badge>
				</Group>
				{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
			</UnstyledButton>
			<Collapse expanded={opened}>{sessionGrid}</Collapse>
		</Box>
	);
}

/**
 * Shown in the Browser dock when the narrator's session has no Browser tool.
 * Loading it is equivalent to typing `/load browser`, so the narrator also gets
 * the usual model-visible notice about the newly available tool.
 */
function BrowserToolLoadPrompt({
	narratorId,
	disabledByTrait,
}: {
	narratorId: string;
	disabledByTrait: boolean;
}) {
	const { t } = useTranslation("narrator");
	const loadMutation = useLoadOptionalTool();

	return (
		<Stack gap={8} align="center" px="md" pt="lg">
			<IconWorldWww size={28} color="var(--mantine-color-dimmed)" />
			<Text size="sm" fw={500}>
				{t("browser.toolNotLoaded")}
			</Text>
			<Text size="xs" c="dimmed" ta="center" maw={340}>
				{disabledByTrait ? t("browser.toolDisabledByTrait") : t("browser.toolNotLoadedDesc")}
			</Text>
			{!disabledByTrait && (
				<Button
					size="xs"
					variant="light"
					color="teal"
					leftSection={<IconPlug size={14} />}
					loading={loadMutation.isPending}
					onClick={() =>
						loadMutation.mutate(
							{ narratorId, toolId: "browser" },
							{
								onSuccess: (result) => {
									notifications.show({
										title: result.alreadyLoaded ? t("toolAlreadyLoaded") : t("toolLoaded"),
										message: result.toolName,
										color: result.alreadyLoaded ? "yellow" : "green",
									});
								},
								onError: (err) => {
									notifications.show({
										title: t("browser.toolLoadFailed"),
										message: err instanceof Error ? err.message : String(err),
										color: "red",
									});
								},
							},
						)
					}
				>
					{t("browser.loadTool")}
				</Button>
			)}
		</Stack>
	);
}

const TTL_PRESETS = [
	{ label: "10m", value: 10 * 60_000 },
	{ label: "1h", value: 60 * 60_000 },
	{ label: "6h", value: 6 * 60 * 60_000 },
	{ label: "24h", value: 24 * 60 * 60_000 },
];

function formatCompactDuration(ms: number): string {
	if (ms <= 0) return "0m";
	if (ms < 60_000) return "<1m";
	if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
	return `${Math.ceil(ms / 86_400_000)}d`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TRACE_RATE_BYTES_PER_MS = 2000;
const MAX_SCREENSHOT_BLOB_BYTES = 20 * 1024 * 1024;
const BROWSER_PREVIEW_DRAG_THRESHOLD_PX = 4;
const BROWSER_POST_CLICK_REFRESH_DELAY_MS = 750;

interface SessionInfo {
	id: string;
	url: string;
	lastActivity: number;
	ttlMs: number;
	expiresAt: number;
	headless?: boolean;
	tracing: { active: boolean; startedAt: number } | null;
	networkRequestCount?: number;
	networkCaptureEnabled?: boolean;
	viewport: BrowserPreviewViewport;
}

interface BrowserInteractionParams {
	action: "click" | "scroll" | "drag" | "type";
	coordinate?: { x: number; y: number };
	endCoordinate?: { x: number; y: number };
	direction?: "up" | "down";
	amount?: number;
	text?: string;
	key?: string;
	keys?: Array<{ text?: string; key?: string }>;
}

interface BrowserPreviewSurfaceProps {
	blobUrl: string | null;
	loading: boolean;
	error: boolean;
	viewport: BrowserPreviewViewport;
	interactionPending: boolean;
	expanded?: boolean;
	onRetry: () => void;
	onRemoteClick: (coordinate: { x: number; y: number }) => void;
	onRemoteScroll: (
		coordinate: { x: number; y: number },
		direction: "up" | "down",
		amount: number,
	) => void;
	onRemoteDrag: (
		coordinate: { x: number; y: number },
		endCoordinate: { x: number; y: number },
	) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

function BrowserPreviewSurface({
	blobUrl,
	loading,
	error,
	viewport,
	interactionPending,
	expanded = false,
	onRetry,
	onRemoteClick,
	onRemoteScroll,
	onRemoteDrag,
	onKeyDown,
}: BrowserPreviewSurfaceProps) {
	const { t } = useTranslation("narrator");
	const imgRef = useRef<HTMLImageElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const dragStartRef = useRef<{
		coordinate: { x: number; y: number };
		clientX: number;
		clientY: number;
	} | null>(null);
	const isDraggingRef = useRef(false);
	const suppressNextClickRef = useRef(false);

	const translateCoordinate = useCallback(
		(clientX: number, clientY: number): { x: number; y: number } | null => {
			const rect = imgRef.current?.getBoundingClientRect();
			if (!rect) return null;
			return translateBrowserPreviewCoordinate(rect, viewport, clientX, clientY);
		},
		[viewport],
	);

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLImageElement>) => {
			if (suppressNextClickRef.current) {
				suppressNextClickRef.current = false;
				return;
			}
			if (isDraggingRef.current || interactionPending) return;
			containerRef.current?.focus();
			const coordinate = translateCoordinate(event.clientX, event.clientY);
			if (coordinate) onRemoteClick(coordinate);
		},
		[interactionPending, onRemoteClick, translateCoordinate],
	);

	const handleWheel = useCallback(
		(event: React.WheelEvent<HTMLDivElement>) => {
			if (event.deltaY === 0) return;
			event.preventDefault();
			event.stopPropagation();
			if (interactionPending) return;
			const coordinate = translateCoordinate(event.clientX, event.clientY);
			if (!coordinate) return;
			onRemoteScroll(
				coordinate,
				event.deltaY > 0 ? "down" : "up",
				Math.min(Math.abs(event.deltaY) * 2, 1000),
			);
		},
		[interactionPending, onRemoteScroll, translateCoordinate],
	);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLImageElement>) => {
			if (interactionPending) return;
			const coordinate = translateCoordinate(event.clientX, event.clientY);
			if (!coordinate) return;
			dragStartRef.current = {
				coordinate,
				clientX: event.clientX,
				clientY: event.clientY,
			};
			isDraggingRef.current = false;
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		[interactionPending, translateCoordinate],
	);

	const handlePointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
		const start = dragStartRef.current;
		if (!start || isDraggingRef.current) return;
		const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
		if (distance >= BROWSER_PREVIEW_DRAG_THRESHOLD_PX) isDraggingRef.current = true;
	}, []);

	const resetPointerGesture = useCallback(() => {
		dragStartRef.current = null;
		isDraggingRef.current = false;
	}, []);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLImageElement>) => {
			const start = dragStartRef.current;
			if (!start) return;
			if (!isDraggingRef.current) {
				resetPointerGesture();
				return;
			}
			const endCoordinate = translateCoordinate(event.clientX, event.clientY);
			if (!endCoordinate) {
				resetPointerGesture();
				return;
			}
			suppressNextClickRef.current = true;
			onRemoteDrag(start.coordinate, endCoordinate);
			resetPointerGesture();
		},
		[onRemoteDrag, resetPointerGesture, translateCoordinate],
	);

	return (
		<Box
			ref={containerRef}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onWheel={handleWheel}
			style={{
				position: "relative",
				width: expanded ? getBrowserPreviewExpandedWidth(viewport.width) : undefined,
				marginInline: expanded ? "auto" : undefined,
				borderRadius: "var(--mantine-radius-sm)",
				overflow: expanded ? "visible" : "hidden",
				backgroundColor: "var(--mantine-color-dark-8)",
				minHeight: expanded ? undefined : 120,
				outline: "none",
			}}
		>
			{loading && !blobUrl ? (
				<Group gap={6} justify="center" py="xl">
					<Loader size="xs" />
					<Text size="xs" c="dimmed">
						{t("browser.refreshScreenshot")}
					</Text>
				</Group>
			) : error && !blobUrl ? (
				<Group gap={6} justify="center" py="xl">
					<Text size="xs" c="red">
						{t("browser.screenshotFailed")}
					</Text>
					<ActionIcon variant="subtle" size="sm" color="gray" onClick={onRetry}>
						<IconRefresh size={12} />
					</ActionIcon>
				</Group>
			) : blobUrl ? (
				<>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: interactive remote browser canvas */}
					<img
						ref={imgRef}
						src={blobUrl}
						alt={t("browser.screenshotAlt")}
						onClick={handleClick}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onPointerCancel={resetPointerGesture}
						style={{
							width: "100%",
							display: "block",
							cursor: interactionPending ? "wait" : "crosshair",
							userSelect: "none",
							touchAction: "none",
						}}
						draggable={false}
					/>
				</>
			) : null}
			{interactionPending && (
				<Box style={{ position: "absolute", top: 4, right: 4, zIndex: 3 }}>
					<Loader size="xs" color="teal" />
				</Box>
			)}
		</Box>
	);
}

function BrowserSessionCard({
	narratorId,
	session,
	visualChange,
}: {
	narratorId: string;
	session: SessionInfo;
	visualChange?: { sessionId: string; seq: number } | null;
}) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const closeMutation = useCloseBrowserSession();
	const setTtlMutation = useSetBrowserSessionTtl();
	const stopTracingMutation = useStopBrowserTracing();
	const interactMutation = useInteractBrowserSession();

	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const revokedRef = useRef<string | null>(null);
	const screenshotAbortRef = useRef<AbortController | null>(null);
	const previewRequestSeqRef = useRef(0);
	const localInteractionPendingRef = useRef(false);
	const postClickRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Auto-fetch screenshot on mount
	const [screenshotKey, setScreenshotKey] = useState(1);

	// Live estimated trace size
	const [estimatedSize, setEstimatedSize] = useState(0);
	useEffect(() => {
		if (!session.tracing?.active) {
			setEstimatedSize(0);
			return;
		}
		const update = () => {
			const elapsed = Date.now() - (session.tracing?.startedAt ?? Date.now());
			setEstimatedSize(elapsed * TRACE_RATE_BYTES_PER_MS);
		};
		update();
		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [session.tracing?.active, session.tracing?.startedAt]);

	// Auto-refresh when visual change event fires for this session.
	// Keyed on `seq` so consecutive changes to the same session each re-run.
	// biome-ignore lint/correctness/useExhaustiveDependencies: seq intentionally re-triggers refresh for repeated changes to the same session
	useEffect(() => {
		if (visualChange?.sessionId === session.id && !localInteractionPendingRef.current) {
			setScreenshotKey((key) => key + 1);
		}
	}, [visualChange?.sessionId, visualChange?.seq, session.id]);

	const applyPreviewBlob = useCallback((blob: Blob, requestSeq: number) => {
		if (blob.size > MAX_SCREENSHOT_BLOB_BYTES) {
			if (previewRequestSeqRef.current === requestSeq) setError(true);
			return;
		}
		if (previewRequestSeqRef.current !== requestSeq) return;

		const url = URL.createObjectURL(blob);
		if (revokedRef.current) URL.revokeObjectURL(revokedRef.current);
		revokedRef.current = url;
		setBlobUrl(url);
		setError(false);
	}, []);

	const fetchScreenshot = useCallback(async () => {
		if (localInteractionPendingRef.current) return;
		const token = getToken();
		if (!token) return;
		const requestSeq = ++previewRequestSeqRef.current;
		screenshotAbortRef.current?.abort();
		const controller = new AbortController();
		screenshotAbortRef.current = controller;
		setLoading(true);
		setError(false);
		try {
			const res = await authorizedFetch(
				`/api/narrators/${narratorId}/browser-sessions/${session.id}/screenshot`,
				{ signal: controller.signal },
			);
			if (!res.ok) {
				const err = await readFetchError(res, `HTTP ${res.status}`);
				throw new ApiError(err.message, res.status, err.data);
			}
			const blob = await res.blob();
			if (controller.signal.aborted || previewRequestSeqRef.current !== requestSeq) return;
			applyPreviewBlob(blob, requestSeq);
		} catch (_err) {
			if (!controller.signal.aborted && previewRequestSeqRef.current === requestSeq) {
				setError(true);
			}
		} finally {
			if (screenshotAbortRef.current === controller) screenshotAbortRef.current = null;
			if (!controller.signal.aborted && previewRequestSeqRef.current === requestSeq) {
				setLoading(false);
			}
		}
	}, [applyPreviewBlob, narratorId, session.id]);

	useEffect(() => {
		if (screenshotKey > 0) fetchScreenshot();
	}, [screenshotKey, fetchScreenshot]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			screenshotAbortRef.current?.abort();
			previewRequestSeqRef.current++;
			if (postClickRefreshTimerRef.current) clearTimeout(postClickRefreshTimerRef.current);
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
				revokedRef.current = null;
			}
		};
	}, []);

	const executeInteraction = useCallback(
		(params: BrowserInteractionParams) => {
			if (localInteractionPendingRef.current) return;
			if (postClickRefreshTimerRef.current) {
				clearTimeout(postClickRefreshTimerRef.current);
				postClickRefreshTimerRef.current = null;
			}
			const requestSeq = ++previewRequestSeqRef.current;
			localInteractionPendingRef.current = true;
			screenshotAbortRef.current?.abort();
			setLoading(false);
			interactMutation.mutate(
				{ narratorId, sessionId: session.id, params },
				{
					onSuccess: (blob) => {
						applyPreviewBlob(blob, requestSeq);
						if (params.action === "click") {
							if (postClickRefreshTimerRef.current) {
								clearTimeout(postClickRefreshTimerRef.current);
							}
							postClickRefreshTimerRef.current = setTimeout(() => {
								postClickRefreshTimerRef.current = null;
								setScreenshotKey((key) => key + 1);
								void queryClient.invalidateQueries({
									queryKey: ["browser-sessions", narratorId],
								});
							}, BROWSER_POST_CLICK_REFRESH_DELAY_MS);
						}
					},
					onError: () => {
						if (previewRequestSeqRef.current === requestSeq) setError(true);
					},
					onSettled: () => {
						localInteractionPendingRef.current = false;
					},
				},
			);
		},
		[applyPreviewBlob, interactMutation, narratorId, queryClient, session.id],
	);

	const handleRemoteClick = useCallback(
		(coordinate: { x: number; y: number }) => {
			executeInteraction({ action: "click", coordinate });
		},
		[executeInteraction],
	);

	const handleRemoteScroll = useCallback(
		(coordinate: { x: number; y: number }, direction: "up" | "down", amount: number) => {
			executeInteraction({ action: "scroll", coordinate, direction, amount });
		},
		[executeInteraction],
	);

	const handleRemoteDrag = useCallback(
		(coordinate: { x: number; y: number }, endCoordinate: { x: number; y: number }) => {
			executeInteraction({ action: "drag", coordinate, endCoordinate });
		},
		[executeInteraction],
	);

	// Keyboard input batching — all keystrokes go into a queue, flushed after 150ms of inactivity.
	// The queue preserves order: [{text:"hel"}, {key:"Backspace"}, {text:"lo"}] etc.
	// Consecutive printable chars are merged into a single {text} entry.
	const keyQueueRef = useRef<Array<{ text?: string; key?: string }>>([]);
	const keyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushKeyQueue = useCallback(() => {
		if (keyTimerRef.current) {
			clearTimeout(keyTimerRef.current);
			keyTimerRef.current = null;
		}
		const queue = keyQueueRef.current;
		if (queue.length === 0) return;
		keyQueueRef.current = [];
		executeInteraction({ action: "type", keys: queue });
	}, [executeInteraction]);

	// Cleanup flush timer on unmount
	useEffect(() => {
		return () => {
			if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
		};
	}, []);

	// Keyboard handler — map DOM KeyboardEvent to browser key presses
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			// Don't capture if user is typing in an input/textarea within the panel
			const tag = (e.target as HTMLElement).tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			if (localInteractionPendingRef.current) return;

			// Map special keys
			const specialKeys: Record<string, string> = {
				Enter: "Enter",
				Tab: "Tab",
				Escape: "Escape",
				Backspace: "Backspace",
				Delete: "Delete",
				ArrowUp: "ArrowUp",
				ArrowDown: "ArrowDown",
				ArrowLeft: "ArrowLeft",
				ArrowRight: "ArrowRight",
				Home: "Home",
				End: "End",
				PageUp: "PageUp",
				PageDown: "PageDown",
				" ": "Space",
				F1: "F1",
				F2: "F2",
				F3: "F3",
				F4: "F4",
				F5: "F5",
				F6: "F6",
				F7: "F7",
				F8: "F8",
				F9: "F9",
				F10: "F10",
				F11: "F11",
				F12: "F12",
			};

			const queue = keyQueueRef.current;
			const mappedKey = specialKeys[e.key];

			if (mappedKey) {
				queue.push({ key: mappedKey });
			} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				// Merge consecutive printable chars into one {text} entry
				const last = queue[queue.length - 1];
				if (last?.text != null) {
					last.text += e.key;
				} else {
					queue.push({ text: e.key });
				}
			} else {
				// Unhandled key (Shift, Ctrl alone, etc.) — leave it to the local UI.
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			// Reset the debounce timer
			if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
			keyTimerRef.current = setTimeout(flushKeyQueue, 150);
		},
		[flushKeyQueue],
	);

	const isTracing = session.tracing?.active ?? false;
	const networkRequestCount = session.networkRequestCount ?? 0;
	const networkCaptureEnabled = session.networkCaptureEnabled ?? false;
	const expiresInLabel = formatCompactDuration(session.expiresAt - Date.now());
	const ttlLabel = formatCompactDuration(session.ttlMs);
	const currentUrl = session.url;
	const navigationUrl = getBrowserPreviewNavigationUrl(currentUrl);
	const previewViewport = session.viewport;
	const handleNavigationClick = useCallback(
		(event: React.MouseEvent<HTMLAnchorElement>) => {
			event.preventDefault();
			event.stopPropagation();
			if (navigationUrl) openBrowserPreviewNavigation(navigationUrl);
		},
		[navigationUrl],
	);

	return (
		<Box
			p="xs"
			style={{
				borderRadius: "var(--mantine-radius-sm)",
				border: `1px solid var(--mantine-color-${isTracing ? "red-7" : "default-border"})`,
				display: "flex",
				flexDirection: "column",
			}}
		>
			{/* Header */}
			<Group justify="space-between" wrap="nowrap" gap={6} mb={4}>
				<Box style={{ flex: 1, minWidth: 0 }}>
					{navigationUrl ? (
						<Anchor
							href={navigationUrl}
							target="_blank"
							rel="noopener noreferrer"
							onClick={handleNavigationClick}
							size="xs"
							ff="monospace"
							truncate
							title={currentUrl}
							style={{ display: "block" }}
						>
							{currentUrl}
						</Anchor>
					) : (
						<Text size="xs" ff="monospace" truncate title={currentUrl}>
							{currentUrl}
						</Text>
					)}
					<Group gap={6} mt={2}>
						<Badge size="xs" variant="outline" color="dimmed">
							{session.id.slice(0, 8)}
						</Badge>
						<Tooltip label={t("browser.autoCloseTooltip", { ttl: ttlLabel })} fz="xs">
							<Text size="xs" c="dimmed">
								{t("browser.expiresIn", { time: expiresInLabel })}
							</Text>
						</Tooltip>
						<Tooltip
							label={`${t("browser.networkRequests", { count: networkRequestCount })} · ${t(
								networkCaptureEnabled ? "browser.networkCaptureOn" : "browser.networkCaptureOff",
							)}`}
							fz="xs"
						>
							<Badge
								size="xs"
								variant="light"
								color={networkCaptureEnabled ? "blue" : "gray"}
								leftSection={<IconNetwork size={10} />}
							>
								{networkRequestCount}
							</Badge>
						</Tooltip>
						{isTracing && (
							<>
								<Badge
									size="xs"
									variant="filled"
									color="red"
									leftSection={
										<Box
											style={{
												width: 6,
												height: 6,
												borderRadius: "50%",
												background: "white",
												animation: "pulse-dot 1.2s ease-in-out infinite",
											}}
										/>
									}
								>
									{t("browser.tracingActive")}
								</Badge>
								<Text size="xs" c="red" ff="monospace">
									~{formatSize(estimatedSize)}
								</Text>
							</>
						)}
					</Group>
				</Box>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					{isTracing && (
						<Tooltip label={t("browser.stopTracing")} fz="xs">
							<ActionIcon
								variant="subtle"
								size="sm"
								color="red"
								loading={stopTracingMutation.isPending}
								onClick={() => stopTracingMutation.mutate({ narratorId, sessionId: session.id })}
							>
								<IconPlayerStop size={14} />
							</ActionIcon>
						</Tooltip>
					)}
					<Tooltip label={t("browser.expandPreview")} fz="xs">
						<ActionIcon
							variant="subtle"
							size="sm"
							color="gray"
							aria-label={t("browser.expandPreview")}
							onClick={() => setExpanded(true)}
						>
							<IconArrowsMaximize size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("browser.refreshScreenshot")} fz="xs">
						<ActionIcon
							variant="subtle"
							size="sm"
							color="gray"
							aria-label={t("browser.refreshScreenshot")}
							onClick={() => setScreenshotKey((key) => key + 1)}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
					<Menu position="bottom-end" withinPortal>
						<Menu.Target>
							<ActionIcon
								variant="subtle"
								size="sm"
								color="gray"
								loading={setTtlMutation.isPending}
								title={t("browser.setAutoClose")}
							>
								<IconClock size={14} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>{t("browser.autoClose")}</Menu.Label>
							{TTL_PRESETS.map((preset) => (
								<Menu.Item
									key={preset.value}
									onClick={() =>
										setTtlMutation.mutate({
											narratorId,
											sessionId: session.id,
											ttlMs: preset.value,
										})
									}
								>
									{preset.label}
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
					<Tooltip label={t("browser.closeSession")} fz="xs">
						<ActionIcon
							variant="subtle"
							size="sm"
							color="red"
							loading={closeMutation.isPending}
							onClick={() => closeMutation.mutate({ narratorId, sessionId: session.id })}
						>
							<IconX size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			{/* Screenshot area */}
			{!expanded && (
				<BrowserPreviewSurface
					blobUrl={blobUrl}
					loading={loading}
					error={error}
					viewport={previewViewport}
					interactionPending={interactMutation.isPending}
					onRetry={() => setScreenshotKey((key) => key + 1)}
					onRemoteClick={handleRemoteClick}
					onRemoteScroll={handleRemoteScroll}
					onRemoteDrag={handleRemoteDrag}
					onKeyDown={handleKeyDown}
				/>
			)}

			<Modal
				opened={expanded}
				onClose={() => setExpanded(false)}
				fullScreen
				title={
					<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
						{navigationUrl ? (
							<Anchor
								href={navigationUrl}
								target="_blank"
								rel="noopener noreferrer"
								onClick={handleNavigationClick}
								size="sm"
								ff="monospace"
								truncate
								title={currentUrl}
								style={{ flex: 1, minWidth: 0, display: "block" }}
							>
								{currentUrl}
							</Anchor>
						) : (
							<Text size="sm" ff="monospace" truncate title={currentUrl} style={{ flex: 1 }}>
								{currentUrl}
							</Text>
						)}
						<Tooltip label={t("browser.refreshScreenshot")} fz="xs">
							<ActionIcon
								variant="subtle"
								size="sm"
								color="gray"
								onClick={() => setScreenshotKey((key) => key + 1)}
							>
								<IconRefresh size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				}
				closeButtonProps={{ "aria-label": t("browser.closeExpandedPreview") }}
				styles={{
					content: SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
					header: SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
					body: {
						display: "flex",
						flexDirection: "column",
						minHeight: 0,
						overflow: "auto",
						padding: 8,
						...safeAreaFullscreenModalBodyStyle(8),
					},
				}}
			>
				<BrowserPreviewSurface
					blobUrl={blobUrl}
					loading={loading}
					error={error}
					viewport={previewViewport}
					interactionPending={interactMutation.isPending}
					expanded
					onRetry={() => setScreenshotKey((key) => key + 1)}
					onRemoteClick={handleRemoteClick}
					onRemoteScroll={handleRemoteScroll}
					onRemoteDrag={handleRemoteDrag}
					onKeyDown={handleKeyDown}
				/>
			</Modal>
		</Box>
	);
}
