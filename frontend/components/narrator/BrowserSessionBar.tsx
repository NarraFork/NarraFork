import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Group,
	Loader,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconCamera,
	IconChevronDown,
	IconChevronRight,
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

function SessionCard({
	narratorId,
	session,
}: {
	narratorId: string;
	session: {
		id: string;
		url: string;
		lastActivity: number;
		tracing: { active: boolean; startedAt: number } | null;
	};
}) {
	const { t } = useTranslation("narrator");
	const closeMutation = useCloseBrowserSession();
	const stopTracingMutation = useStopBrowserTracing();
	const [showScreenshot, setShowScreenshot] = useState(false);
	const [screenshotKey, setScreenshotKey] = useState(0);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const revokedRef = useRef<string | null>(null);

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
		setLoading(true);
		setError(false);
		try {
			const res = await fetch(
				`/api/narrators/${narratorId}/browser-sessions/${session.id}/screenshot`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			// Revoke previous blob URL to avoid memory leak
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
			}
			revokedRef.current = url;
			setBlobUrl(url);
		} catch {
			setError(true);
		} finally {
			setLoading(false);
		}
	}, [narratorId, session.id]);

	// Fetch when screenshot is shown or refreshed
	useEffect(() => {
		if (showScreenshot && screenshotKey > 0) {
			fetchScreenshot();
		}
	}, [showScreenshot, screenshotKey, fetchScreenshot]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (revokedRef.current) {
				URL.revokeObjectURL(revokedRef.current);
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

	const isTracing = session.tracing?.active ?? false;

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
