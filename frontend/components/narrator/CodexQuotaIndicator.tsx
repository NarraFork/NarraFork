import { Box, Group, Paper, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type PublicCodexQuotaOverview, type PublicCodexQuotaSegment } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	CODEX_TIER_STROKES,
	CodexQuotaForecastChart,
	formatAccountEquivalent,
	formatResetTimestamp,
	getCodexTierLabel,
} from "../providers/CodexQuotaForecastChart";

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function getSegmentRatio(segment: PublicCodexQuotaSegment): number {
	if (segment.totalAccountEquivalents <= 0) return 0;
	return clampRatio(segment.remainingAccountEquivalents / segment.totalAccountEquivalents);
}

const CODEX_QUOTA_QUERY_KEY = ["codex", "quota-overview"] as const;
const TOUCH_HOVER_SUPPRESS_MS = 900;

function hasChartData(overview: PublicCodexQuotaOverview): boolean {
	return overview.forecast.types.length > 0 && overview.forecast.points.length >= 2;
}

function isPublicCodexQuotaOverview(value: unknown): value is PublicCodexQuotaOverview {
	return !!value && typeof value === "object" && "segments" in value && "forecast" in value;
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
		enabled,
		refetchOnMount: "always",
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (!enabled) return;
		const handle = narratorWSManager.addListener(
			{ types: ["codex_quota_overview_updated"] },
			(data) => {
				if (isPublicCodexQuotaOverview(data.overview)) {
					queryClient.setQueryData(CODEX_QUOTA_QUERY_KEY, data.overview);
				}
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [enabled, queryClient]);

	useEffect(() => {
		return () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		};
	}, []);

	if (!enabled) return null;

	const segments = overview?.segments ?? [];
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
			width={compact ? "min(360px, calc(100vw - 24px))" : "min(520px, calc(100vw - 24px))"}
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
				style={{ maxWidth: "calc(100vw - 24px)", overflow: "visible" }}
			>
				<Stack gap="sm">
					<Group justify="space-between" align="flex-start" wrap="nowrap">
						<Stack gap={2}>
							<Text size="sm" fw={600}>
								{t("codexQuotaIndicatorLabel")}
							</Text>
							<Text size="xs" c="dimmed">
								{overview?.unit === "account_equivalent" ? ts("codexQuotaForecastUnit") : ""}
							</Text>
						</Stack>
						<Text size="lg" fw={700} style={{ whiteSpace: "nowrap" }}>
							{summaryLabel}
						</Text>
					</Group>

					{showErrorState ? (
						<Paper withBorder p="xs">
							<Stack gap={2}>
								<Text size="xs" c="red" ta="center" fw={500}>
									{t("codexQuotaIndicatorError")}
								</Text>
								{errorMessage && (
									<Text size="xs" c="dimmed" ta="center" lineClamp={2}>
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
												width: 8,
												height: 8,
												borderRadius: 999,
												background: CODEX_TIER_STROKES[segment.type],
												display: "inline-block",
												flexShrink: 0,
											}}
										/>
										<Text size="xs" truncate>
											{getCodexTierLabel(ts, segment.type)}
										</Text>
									</Group>
									<Text size="xs" fw={600} style={{ flexShrink: 0 }}>
										{formatAccountEquivalent(segment.remainingAccountEquivalents)} /{" "}
										{formatAccountEquivalent(segment.totalAccountEquivalents)}
									</Text>
								</Group>
							))}
						</Stack>
					) : (
						<Paper withBorder p="xs">
							<Text size="xs" c="dimmed" ta="center">
								{t("codexQuotaIndicatorEmpty")}
							</Text>
						</Paper>
					)}

					{overview && hasChartData(overview) && (
						<CodexQuotaForecastChart forecast={overview.forecast} compact showLegend={false} />
					)}

					{isError && overview && (
						<Text size="xs" c="red" ta="center">
							{t("codexQuotaIndicatorError")}
						</Text>
					)}

					<Text size="xs" c="dimmed">
						{overview?.nextResetAt
							? ts("codexQuotaNextReset", {
									when: formatResetTimestamp(overview.nextResetAt),
								})
							: ts("codexQuotaNoResetScheduled")}
					</Text>
					<UnstyledButton onClick={handleOpenSettings} style={{ alignSelf: "flex-start" }}>
						<Text
							size="xs"
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
