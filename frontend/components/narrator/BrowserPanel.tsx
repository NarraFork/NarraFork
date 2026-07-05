import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Group,
	Loader,
	Menu,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconNetwork,
	IconPlayerStop,
	IconRefresh,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useBrowserSessions,
	useCloseBrowserSession,
	useInteractBrowserSession,
	useSetBrowserSessionTtl,
	useStopBrowserTracing,
} from "../../hooks/useBrowserSessions";
import { useNarratorBrowserSessionsCapability } from "../../hooks/usePlatform";
import { ApiError, getToken, readFetchError } from "../../lib/api";

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
	const { data: sessions } = useBrowserSessions(
		browserSessionsCapability.supported === false || !expanded ? "" : narratorId,
	);
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
					<Text size="xs" c="dimmed" ta="center" pt="md">
						{t("browser.title")}
					</Text>
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
	viewport: { width: number; height: number };
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
	const closeMutation = useCloseBrowserSession();
	const setTtlMutation = useSetBrowserSessionTtl();
	const stopTracingMutation = useStopBrowserTracing();
	const interactMutation = useInteractBrowserSession();

	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const revokedRef = useRef<string | null>(null);
	const screenshotAbortRef = useRef<AbortController | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);
	const isDraggingRef = useRef(false);
	// Set when a drag completes so the synthetic `click` that the browser fires
	// right after `pointerup` is swallowed instead of sent as a second action.
	const suppressNextClickRef = useRef(false);

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
		if (visualChange?.sessionId === session.id) {
			setScreenshotKey((k) => k + 1);
		}
	}, [visualChange?.sessionId, visualChange?.seq, session.id]);

	const fetchScreenshot = useCallback(async () => {
		const token = getToken();
		if (!token) return;
		screenshotAbortRef.current?.abort();
		const controller = new AbortController();
		screenshotAbortRef.current = controller;
		setLoading(true);
		setError(false);
		try {
			const res = await fetch(
				`/api/narrators/${narratorId}/browser-sessions/${session.id}/screenshot`,
				{ headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
			);
			if (!res.ok) {
				const err = await readFetchError(res, `HTTP ${res.status}`);
				throw new ApiError(err.message, res.status, err.data);
			}
			const blob = await res.blob();
			if (blob.size > MAX_SCREENSHOT_BLOB_BYTES) throw new Error("Screenshot too large");
			const url = URL.createObjectURL(blob);
			if (controller.signal.aborted) {
				URL.revokeObjectURL(url);
				return;
			}
			if (revokedRef.current) URL.revokeObjectURL(revokedRef.current);
			revokedRef.current = url;
			setBlobUrl(url);
		} catch (_err) {
			if (!controller.signal.aborted) setError(true);
		} finally {
			if (screenshotAbortRef.current === controller) screenshotAbortRef.current = null;
			if (!controller.signal.aborted) setLoading(false);
		}
	}, [narratorId, session.id]);

	useEffect(() => {
		if (screenshotKey > 0) fetchScreenshot();
	}, [screenshotKey, fetchScreenshot]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			screenshotAbortRef.current?.abort();
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
				revokedRef.current = null;
			}
		};
	}, []);

	// Coordinate translation helper
	const translateCoordinate = useCallback(
		(clientX: number, clientY: number): { x: number; y: number } | null => {
			const img = imgRef.current;
			if (!img) return null;
			const rect = img.getBoundingClientRect();
			const relX = clientX - rect.left;
			const relY = clientY - rect.top;
			const scaleX = session.viewport.width / rect.width;
			const scaleY = session.viewport.height / rect.height;
			return {
				x: Math.round(relX * scaleX),
				y: Math.round(relY * scaleY),
			};
		},
		[session.viewport.width, session.viewport.height],
	);

	// Update blob from interact response
	const updateBlobFromResponse = useCallback((blob: Blob) => {
		const url = URL.createObjectURL(blob);
		if (revokedRef.current) URL.revokeObjectURL(revokedRef.current);
		revokedRef.current = url;
		setBlobUrl(url);
	}, []);

	// Click handler
	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLImageElement>) => {
			if (suppressNextClickRef.current) {
				suppressNextClickRef.current = false;
				return;
			}
			if (isDraggingRef.current) return;
			// Focus the container so keyboard events are captured
			containerRef.current?.focus();
			const coord = translateCoordinate(e.clientX, e.clientY);
			if (!coord) return;
			interactMutation.mutate(
				{
					narratorId,
					sessionId: session.id,
					params: { action: "click", coordinate: coord },
				},
				{ onSuccess: (blob) => updateBlobFromResponse(blob) },
			);
		},
		[narratorId, session.id, translateCoordinate, interactMutation, updateBlobFromResponse],
	);

	// Scroll handler
	const handleWheel = useCallback(
		(e: React.WheelEvent<HTMLImageElement>) => {
			e.preventDefault();
			const coord = translateCoordinate(e.clientX, e.clientY);
			if (!coord) return;
			const direction = e.deltaY > 0 ? "down" : "up";
			const amount = Math.min(Math.abs(e.deltaY) * 2, 1000);
			interactMutation.mutate(
				{
					narratorId,
					sessionId: session.id,
					params: { action: "scroll", coordinate: coord, direction, amount },
				},
				{ onSuccess: (blob) => updateBlobFromResponse(blob) },
			);
		},
		[narratorId, session.id, translateCoordinate, interactMutation, updateBlobFromResponse],
	);

	// Drag handlers
	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLImageElement>) => {
			const coord = translateCoordinate(e.clientX, e.clientY);
			if (!coord) return;
			dragStartRef.current = coord;
			isDraggingRef.current = false;
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
		},
		[translateCoordinate],
	);

	const handlePointerMove = useCallback((_e: React.PointerEvent<HTMLImageElement>) => {
		if (!dragStartRef.current) return;
		isDraggingRef.current = true;
	}, []);

	const handlePointerUp = useCallback(
		(e: React.PointerEvent<HTMLImageElement>) => {
			if (!dragStartRef.current) return;
			if (!isDraggingRef.current) {
				dragStartRef.current = null;
				return;
			}
			const endCoord = translateCoordinate(e.clientX, e.clientY);
			if (!endCoord) {
				dragStartRef.current = null;
				isDraggingRef.current = false;
				return;
			}
			// A real drag happened — swallow the browser's trailing click.
			suppressNextClickRef.current = true;
			interactMutation.mutate(
				{
					narratorId,
					sessionId: session.id,
					params: {
						action: "drag",
						coordinate: dragStartRef.current,
						endCoordinate: endCoord,
					},
				},
				{ onSuccess: (blob) => updateBlobFromResponse(blob) },
			);
			dragStartRef.current = null;
			isDraggingRef.current = false;
		},
		[narratorId, session.id, translateCoordinate, interactMutation, updateBlobFromResponse],
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
		interactMutation.mutate(
			{
				narratorId,
				sessionId: session.id,
				params: { action: "type", keys: queue },
			},
			{ onSuccess: (blob) => updateBlobFromResponse(blob) },
		);
	}, [narratorId, session.id, interactMutation, updateBlobFromResponse]);

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

			e.preventDefault();
			e.stopPropagation();

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
				// Unhandled key (Shift, Ctrl alone, etc.) — ignore
				return;
			}

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
					<Text size="xs" ff="monospace" truncate title={session.url}>
						{session.url}
					</Text>
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
					<Tooltip label={t("browser.refreshScreenshot")} fz="xs">
						<ActionIcon
							variant="subtle"
							size="sm"
							color="gray"
							onClick={() => setScreenshotKey((k) => k + 1)}
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
			<Box
				ref={containerRef}
				tabIndex={0}
				onKeyDown={handleKeyDown}
				style={{
					position: "relative",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
					backgroundColor: "var(--mantine-color-dark-8)",
					minHeight: 120,
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
						<ActionIcon
							variant="subtle"
							size="sm"
							color="gray"
							onClick={() => setScreenshotKey((k) => k + 1)}
						>
							<IconRefresh size={12} />
						</ActionIcon>
					</Group>
				) : blobUrl ? (
					// biome-ignore lint/a11y/useKeyWithClickEvents: interactive screenshot canvas, keyboard not applicable
					<img
						ref={imgRef}
						src={blobUrl}
						alt={t("browser.screenshotAlt")}
						onClick={handleClick}
						onWheel={handleWheel}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						style={{
							width: "100%",
							display: "block",
							cursor: interactMutation.isPending ? "wait" : "crosshair",
							userSelect: "none",
							touchAction: "none",
						}}
						draggable={false}
					/>
				) : null}
				{interactMutation.isPending && (
					<Box
						style={{
							position: "absolute",
							top: 4,
							right: 4,
						}}
					>
						<Loader size="xs" color="teal" />
					</Box>
				)}
			</Box>
		</Box>
	);
}
