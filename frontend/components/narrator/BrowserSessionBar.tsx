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
	IconCamera,
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
	useSetBrowserSessionTtl,
	useStopBrowserTracing,
} from "../../hooks/useBrowserSessions";
import { getToken } from "../../lib/api";

export function BrowserSessionBar({
	narratorId,
	sessionCount,
}: {
	narratorId: string;
	sessionCount?: number;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	// Only fetch full session list when the bar is expanded — avoids API call on page load.
	// The parent provides sessionCount from WS events to show/hide the bar without fetching.
	const { data: sessions } = useBrowserSessions(opened ? narratorId : "");

	// Show the bar if WS told us there are sessions, or if we already fetched them
	const count = sessions?.length ?? sessionCount ?? 0;
	if (count === 0) return null;

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
			<Collapse in={opened}>
				<Box px="md" pb="xs" style={{ maxHeight: 300, overflowY: "auto" }}>
					{sessions?.map((session) => (
						<SessionCard key={session.id} narratorId={narratorId} session={session} />
					))}
				</Box>
			</Collapse>
		</Box>
	);
}

/** Format bytes into a human-readable string. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Estimated trace growth rate: ~2 MB/s (typical Chrome trace with default categories). */
const TRACE_RATE_BYTES_PER_MS = 2000;

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

function SessionCard({
	narratorId,
	session,
}: {
	narratorId: string;
	session: {
		id: string;
		url: string;
		lastActivity: number;
		ttlMs: number;
		expiresAt: number;
		headless?: boolean;
		tracing: { active: boolean; startedAt: number } | null;
		networkRequestCount?: number;
		networkCaptureEnabled?: boolean;
	};
}) {
	const { t } = useTranslation("narrator");
	const closeMutation = useCloseBrowserSession();
	const setTtlMutation = useSetBrowserSessionTtl();
	const stopTracingMutation = useStopBrowserTracing();
	const [showScreenshot, setShowScreenshot] = useState(false);
	const [screenshotKey, setScreenshotKey] = useState(0);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const revokedRef = useRef<string | null>(null);
	const screenshotAbortRef = useRef<AbortController | null>(null);

	// Live estimated trace size — ticks every second while tracing is active
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
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			if (controller.signal.aborted) {
				URL.revokeObjectURL(url);
				return;
			}
			// Revoke previous blob URL to avoid memory leak
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
			}
			revokedRef.current = url;
			setBlobUrl(url);
		} catch {
			if (!controller.signal.aborted) setError(true);
		} finally {
			if (screenshotAbortRef.current === controller) screenshotAbortRef.current = null;
			if (!controller.signal.aborted) setLoading(false);
		}
	}, [narratorId, session.id]);

	// Fetch when screenshot is shown or refreshed
	useEffect(() => {
		if (showScreenshot && screenshotKey > 0) {
			fetchScreenshot();
		}
	}, [showScreenshot, screenshotKey, fetchScreenshot]);

	useEffect(() => {
		if (showScreenshot) return;
		screenshotAbortRef.current?.abort();
		screenshotAbortRef.current = null;
		if (revokedRef.current) {
			URL.revokeObjectURL(revokedRef.current);
			revokedRef.current = null;
			setBlobUrl(null);
		}
	}, [showScreenshot]);

	// Cleanup in-flight screenshot request and blob URL on unmount
	useEffect(() => {
		return () => {
			screenshotAbortRef.current?.abort();
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
				revokedRef.current = null;
			}
		};
	}, []);

	const handleRefresh = useCallback(() => {
		setScreenshotKey((k) => k + 1);
	}, []);

	const handleToggleScreenshot = useCallback(() => {
		setShowScreenshot((v) => {
			if (!v) {
				setScreenshotKey((k) => k + 1);
			}
			return !v;
		});
	}, []);

	const elapsed = Date.now() - session.lastActivity;
	const elapsedLabel =
		elapsed < 60_000
			? "<1m"
			: elapsed < 3600_000
				? `${Math.floor(elapsed / 60_000)}m`
				: `${Math.floor(elapsed / 3600_000)}h`;
	const expiresInLabel = formatCompactDuration(session.expiresAt - Date.now());
	const ttlLabel = formatCompactDuration(session.ttlMs);

	const isTracing = session.tracing?.active ?? false;
	const networkRequestCount = session.networkRequestCount ?? 0;
	const networkCaptureEnabled = session.networkCaptureEnabled ?? false;

	return (
		<Box
			mt={4}
			p="xs"
			style={{
				borderRadius: "var(--mantine-radius-sm)",
				border: `1px solid var(--mantine-color-${isTracing ? "red-7" : "default-border"})`,
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap={6}>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Text size="xs" ff="monospace" truncate title={session.url}>
						{session.url}
					</Text>
					<Group gap={6} mt={2}>
						<Badge size="xs" variant="outline" color="dimmed">
							{session.id.slice(0, 8)}
						</Badge>
						<Text size="xs" c="dimmed">
							{t("browser.lastActive", { time: elapsedLabel })}
						</Text>
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
					<Tooltip
						label={showScreenshot ? t("browser.hideScreenshot") : t("browser.screenshotAlt")}
						fz="xs"
					>
						<ActionIcon
							variant="subtle"
							size="sm"
							color={showScreenshot ? "teal" : "gray"}
							onClick={handleToggleScreenshot}
						>
							<IconCamera size={14} />
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
			<Collapse in={showScreenshot}>
				<Box mt="xs">
					{loading ? (
						<Group gap={6} justify="center" py="xs">
							<Loader size="xs" />
							<Text size="xs" c="dimmed">
								{t("browser.refreshScreenshot")}
							</Text>
						</Group>
					) : error ? (
						<Group gap={6}>
							<Text size="xs" c="red">
								{t("browser.screenshotFailed")}
							</Text>
							<ActionIcon variant="subtle" size="sm" color="gray" onClick={handleRefresh}>
								<IconRefresh size={12} />
							</ActionIcon>
						</Group>
					) : blobUrl ? (
						<>
							<img
								src={blobUrl}
								alt={t("browser.screenshotAlt")}
								style={{
									maxWidth: "100%",
									maxHeight: 300,
									borderRadius: "var(--mantine-radius-sm)",
									objectFit: "contain",
									display: "block",
								}}
							/>
							<ActionIcon variant="subtle" size="sm" color="gray" mt={4} onClick={handleRefresh}>
								<IconRefresh size={12} />
							</ActionIcon>
						</>
					) : null}
				</Box>
			</Collapse>
		</Box>
	);
}
