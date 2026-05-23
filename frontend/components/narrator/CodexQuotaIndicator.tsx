import { Box, Group, Paper, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderRuntimeCapability } from "../../hooks/usePlatform";
import { api, type PublicCodexQuotaOverview, type PublicCodexQuotaSegment } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	CODEX_TIER_STROKES,
	CodexQuotaTrendChart,
	formatAccountEquivalent,
	formatResetTimestamp,
	getCodexTierLabel,
} from "../providers/CodexQuotaTrendChart";

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function getSegmentRatio(segment: PublicCodexQuotaSegment): number {
	if (segment.totalAccountEquivalents <= 0) return 0;
	return clampRatio(segment.remainingAccountEquivalents / segment.totalAccountEquivalents);
}

const CODEX_QUOTA_QUERY_KEY = ["codex", "quota-overview"] as const;
const CODEX_QUOTA_QUERY_GC_TIME_MS = 60_000;
const TOUCH_HOVER_SUPPRESS_MS = 900;

function hasChartData(overview: PublicCodexQuotaOverview): boolean {
	return overview.trend.types.length > 0 && overview.trend.points.length >= 2;
}

function isPublicCodexQuotaOverview(value: unknown): value is PublicCodexQuotaOverview {
	return !!value && typeof value === "object" && "segments" in value && "trend" in value;
}

function SegmentBars({
	segments,
	compact = false,
}: {
	segments: PublicCodexQuotaSegment[];
	compact?: boolean;
}) {
	const barWidth = compact ? 3 : 4;
	const barHeight = compact ? 18 : 22;
	const gap = compact ? 1 : 2;

	if (segments.length === 0) {
		return (
			<Box
				w={compact ? 10 : 12}
				h={barHeight}
				style={{
					borderRadius: 3,
					background: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
					border: "1px solid var(--mantine-color-default-border)",
				}}
			/>
		);
	}

	return (
		<Group gap={gap} align="flex-end" wrap="nowrap" h={compact ? 20 : 24}>
			{segments.map((segment) => {
				const ratio = getSegmentRatio(segment);
				return (
					<Box
						key={segment.type}
						w={barWidth}
						h={barHeight}
						style={{
							position: "relative",
							overflow: "hidden",
							borderRadius: 3,
							background: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
							border: "1px solid var(--mantine-color-default-border)",
						}}
					>
						<Box
							style={{
								position: "absolute",
								left: 0,
								right: 0,
								bottom: 0,
								height: `${Math.round(ratio * 100)}%`,
								minHeight: ratio > 0 ? 2 : 0,
								background: CODEX_TIER_STROKES[segment.type],
								transition: "height 160ms ease",
							}}
						/>
					</Box>
				);
			})}
		</Group>
	);
}

export function CodexQuotaIndicator({
	enabled,
	isAdmin,
	compact = false,
}: {
	enabled: boolean;
	isAdmin: boolean;
	compact?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const codexRuntimeCapability = useProviderRuntimeCapability("codex");
	const codexRoutesSupported = codexRuntimeCapability?.routes?.supported !== false;
	const canReadQuotaOverview =
		codexRoutesSupported && codexRuntimeCapability?.routes?.quotaOverview !== false;
	const queryEnabled = enabled && canReadQuotaOverview;
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [detailsOpened, setDetailsOpened] = useState(false);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const suppressHoverUntilRef = useRef(0);
	const {
		data: overview,
		isError,
		error,
	} = useQuery({
		queryKey: CODEX_QUOTA_QUERY_KEY,
		queryFn: api.codexQuotaOverview,
		enabled: queryEnabled,
		refetchOnMount: "always",
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		gcTime: CODEX_QUOTA_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
		if (!queryEnabled) return;
		const handle = narratorWSManager.addListener(
			{ types: ["codex_quota_overview_updated"] },
			(data) => {
				if (isPublicCodexQuotaOverview(data.overview)) {
					queryClient.setQueryData(CODEX_QUOTA_QUERY_KEY, data.overview);
				}
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [queryEnabled, queryClient]);

	useEffect(() => {
		return () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		};
	}, []);

	if (!queryEnabled) return null;

	const segments = overview?.segments ?? [];
	const useReadableText = compact || isMobile;
	const detailTitleSize = useReadableText ? "md" : "sm";
	const detailTextSize = useReadableText ? "sm" : "xs";
	const detailValueSize = useReadableText ? "xl" : "lg";
	const detailMarkerSize = useReadableText ? 10 : 8;
	const canOpenSettings = isAdmin;
	const errorMessage = error instanceof Error ? error.message : "";
	const showErrorState = isError && !overview;
	const summaryLabel = showErrorState
		? t("codexQuotaIndicatorError")
		: overview
			? `${formatAccountEquivalent(overview.totalRemainingAccountEquivalents)} / ${formatAccountEquivalent(
					overview.totalAccountEquivalents,
				)}`
			: t("codexQuotaIndicatorEmpty");
	const clearCloseTimer = () => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};
	const openDetails = () => {
		clearCloseTimer();
		setDetailsOpened(true);
	};
	const openDetailsFromMouse = () => {
		if (Date.now() < suppressHoverUntilRef.current) return;
		openDetails();
	};
	const markTouchInteraction = () => {
		suppressHoverUntilRef.current = Date.now() + TOUCH_HOVER_SUPPRESS_MS;
	};
	const scheduleCloseDetails = () => {
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(() => {
			closeTimerRef.current = null;
			setDetailsOpened(false);
		}, 120);
	};
	const handleOpenSettings = () => {
		if (!canOpenSettings) {
			notifications.show({ message: t("codexQuotaIndicatorAdminOnly"), color: "yellow" });
			return;
		}
		setDetailsOpened(false);
		navigate({ to: "/settings/providers", search: { provider: "codex" } });
	};

	return (
		<Popover
			width={compact ? "min(420px, calc(100vw - 20px))" : "min(560px, calc(100vw - 24px))"}
			shadow="md"
			withArrow
			position="top-end"
			opened={detailsOpened}
			onChange={setDetailsOpened}
		>
			<Popover.Target>
				<UnstyledButton
					onMouseEnter={openDetailsFromMouse}
					onMouseLeave={scheduleCloseDetails}
					onClick={openDetailsFromMouse}
					onPointerDown={(event) => {
						if (event.pointerType === "touch") {
							event.preventDefault();
							markTouchInteraction();
							clearCloseTimer();
							setDetailsOpened((opened) => !opened);
						}
					}}
					aria-label={t("codexQuotaIndicatorLabel")}
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						minWidth: compact ? 18 : 22,
						height: compact ? 20 : 24,
						cursor: "pointer",
						transform: "translateY(-1px)",
					}}
				>
					<SegmentBars segments={segments} compact={compact} />
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown
				onMouseEnter={openDetailsFromMouse}
				onMouseLeave={scheduleCloseDetails}
				style={{
					maxWidth: compact ? "calc(100vw - 20px)" : "calc(100vw - 24px)",
					overflow: "visible",
				}}
			>
				<Stack gap="sm">
					<Group justify="space-between" align="flex-start" wrap="nowrap">
						<Stack gap={2}>
							<Text size={detailTitleSize} fw={600}>
								{t("codexQuotaIndicatorLabel")}
							</Text>
							<Text size={detailTextSize} c="dimmed">
								{overview?.unit === "account_equivalent" ? ts("codexQuotaTrendUnit") : ""}
							</Text>
						</Stack>
						<Text size={detailValueSize} fw={700} style={{ whiteSpace: "nowrap" }}>
							{summaryLabel}
						</Text>
					</Group>

					{showErrorState ? (
						<Paper withBorder p="xs">
							<Stack gap={2}>
								<Text size={detailTextSize} c="red" ta="center" fw={500}>
									{t("codexQuotaIndicatorError")}
								</Text>
								{errorMessage && (
									<Text size={detailTextSize} c="dimmed" ta="center" lineClamp={2}>
										{errorMessage}
									</Text>
								)}
							</Stack>
						</Paper>
					) : segments.length > 0 ? (
						<Stack gap={4}>
							{segments.map((segment) => (
								<Group key={segment.type} justify="space-between" gap="sm" wrap="nowrap">
									<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
										<span
											style={{
												width: detailMarkerSize,
												height: detailMarkerSize,
												borderRadius: 999,
												background: CODEX_TIER_STROKES[segment.type],
												display: "inline-block",
												flexShrink: 0,
											}}
										/>
										<Text size={detailTextSize} truncate>
											{getCodexTierLabel(ts, segment.type)}
										</Text>
									</Group>
									<Text size={detailTextSize} fw={600} style={{ flexShrink: 0 }}>
										{formatAccountEquivalent(segment.remainingAccountEquivalents)} /{" "}
										{formatAccountEquivalent(segment.totalAccountEquivalents)}
									</Text>
								</Group>
							))}
						</Stack>
					) : (
						<Paper withBorder p="xs">
							<Text size={detailTextSize} c="dimmed" ta="center">
								{t("codexQuotaIndicatorEmpty")}
							</Text>
						</Paper>
					)}

					{overview && hasChartData(overview) && (
						<CodexQuotaTrendChart trend={overview.trend} compact showLegend={false} />
					)}

					{isError && overview && (
						<Text size={detailTextSize} c="red" ta="center">
							{t("codexQuotaIndicatorError")}
						</Text>
					)}

					<Text size={detailTextSize} c="dimmed">
						{overview?.nextResetAt
							? ts("codexQuotaNextReset", {
									when: formatResetTimestamp(overview.nextResetAt),
								})
							: ts("codexQuotaNoResetScheduled")}
					</Text>
					<UnstyledButton onClick={handleOpenSettings} style={{ alignSelf: "flex-start" }}>
						<Text
							size={detailTextSize}
							c={canOpenSettings ? "blue" : "yellow"}
							td={canOpenSettings ? "underline" : undefined}
						>
							{canOpenSettings
								? t("codexQuotaIndicatorOpenSettings")
								: t("codexQuotaIndicatorAdminOnly")}
						</Text>
					</UnstyledButton>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}
