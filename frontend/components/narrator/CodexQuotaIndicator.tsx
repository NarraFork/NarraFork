import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Box, Group, Paper, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderRuntimeCapability } from "../../hooks/usePlatform";
import { api, type PublicCodexQuotaOverview, type PublicCodexQuotaSegment } from "../../lib/api";
import { CODEX_TIER_STROKES, getCodexTierLabel } from "../../lib/codex-tiers";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	CodexQuotaTrendChart,
	formatAccountEquivalent,
	formatResetTimestamp,
} from "../providers/CodexQuotaTrendChart";

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

type QuotaCoverage = "modeled" | "mixed" | "unknown";

function hasCoverageMetadata(modeled?: number, unmodeled?: number): boolean {
	return modeled !== undefined && unmodeled !== undefined;
}

function hasPartialCoverageMetadata(modeled?: number, unmodeled?: number): boolean {
	return modeled !== undefined || unmodeled !== undefined;
}

function getQuotaCoverage(
	modeled: number | undefined,
	unmodeled: number | undefined,
	legacyModeled: boolean,
): QuotaCoverage {
	if (hasCoverageMetadata(modeled, unmodeled)) {
		if ((unmodeled ?? 0) <= 0) return "modeled";
		return (modeled ?? 0) > 0 ? "mixed" : "unknown";
	}
	if (hasPartialCoverageMetadata(modeled, unmodeled)) return "unknown";
	return legacyModeled ? "modeled" : "unknown";
}

function getSegmentCoverage(segment: PublicCodexQuotaSegment): QuotaCoverage {
	return getQuotaCoverage(
		segment.modeledAccountCount,
		segment.unmodeledAccountCount,
		segment.averageRemainingPercent !== null,
	);
}

function getOverviewCoverage(overview: PublicCodexQuotaOverview): QuotaCoverage {
	const legacyModeled =
		(overview.segments.length === 0 && overview.totalAccountEquivalents === 0) ||
		(overview.segments.length > 0 &&
			overview.segments.every((segment) => segment.averageRemainingPercent !== null));
	return getQuotaCoverage(
		overview.modeledAccountCount,
		overview.unmodeledAccountCount,
		legacyModeled,
	);
}

function getSegmentRatio(segment: PublicCodexQuotaSegment): number | null {
	if (getSegmentCoverage(segment) === "unknown") return null;
	const denominator = hasCoverageMetadata(
		segment.modeledAccountCount,
		segment.unmodeledAccountCount,
	)
		? (segment.modeledAccountCount ?? 0)
		: segment.totalAccountEquivalents;
	if (denominator <= 0) return 0;
	return clampRatio(segment.remainingAccountEquivalents / denominator);
}

const CODEX_QUOTA_QUERY_KEY = ["codex", "quota-overview"] as const;
const CODEX_QUOTA_QUERY_GC_TIME_MS = 60_000;
const TOUCH_HOVER_SUPPRESS_MS = 900;

function hasChartData(overview: PublicCodexQuotaOverview): boolean {
	return overview.trend.types.length > 0 && overview.trend.points.length >= 2;
}

const PUBLIC_CODEX_TIERS = new Set(["free", "plus", "team", "k12", "prolite", "pro"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalCoverageCount(value: unknown): boolean {
	return value === undefined || (isFiniteNonnegative(value) && Number.isInteger(value));
}

function isNullableFiniteNonnegative(value: unknown): boolean {
	return value === null || isFiniteNonnegative(value);
}

function isPublicCodexQuotaSegment(value: unknown): value is PublicCodexQuotaSegment {
	if (!isRecord(value) || typeof value.type !== "string" || !PUBLIC_CODEX_TIERS.has(value.type)) {
		return false;
	}
	return (
		isFiniteNonnegative(value.remainingAccountEquivalents) &&
		isFiniteNonnegative(value.totalAccountEquivalents) &&
		(value.averageRemainingPercent === null ||
			isFiniteNonnegative(value.averageRemainingPercent)) &&
		isNullableFiniteNonnegative(value.nextResetAt) &&
		isOptionalCoverageCount(value.trackedAccountCount) &&
		isOptionalCoverageCount(value.modeledAccountCount) &&
		isOptionalCoverageCount(value.unmodeledAccountCount)
	);
}

function isPublicCodexTrendPoint(value: unknown): boolean {
	if (
		!isRecord(value) ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp) ||
		!isRecord(value.byType)
	) {
		return false;
	}
	return Object.entries(value.byType).every(
		([tier, amount]) => PUBLIC_CODEX_TIERS.has(tier) && isFiniteNonnegative(amount),
	);
}

export function isPublicCodexQuotaOverview(value: unknown): value is PublicCodexQuotaOverview {
	if (!isRecord(value)) return false;
	const trend = value.trend;
	if (!isRecord(trend)) return false;
	return (
		typeof value.generatedAt === "string" &&
		value.unit === "account_equivalent" &&
		isFiniteNonnegative(value.totalRemainingAccountEquivalents) &&
		isFiniteNonnegative(value.totalAccountEquivalents) &&
		isOptionalCoverageCount(value.trackedAccountCount) &&
		isOptionalCoverageCount(value.modeledAccountCount) &&
		isOptionalCoverageCount(value.unmodeledAccountCount) &&
		Array.isArray(value.segments) &&
		value.segments.every(isPublicCodexQuotaSegment) &&
		typeof trend.generatedAt === "string" &&
		Array.isArray(trend.types) &&
		trend.types.every((tier) => typeof tier === "string" && PUBLIC_CODEX_TIERS.has(tier)) &&
		Array.isArray(trend.points) &&
		trend.points.every(isPublicCodexTrendPoint) &&
		isNullableFiniteNonnegative(value.nextResetAt) &&
		typeof value.usageQueueRunning === "boolean" &&
		typeof value.schedulerStarted === "boolean"
	);
}

export function applyPublicCodexQuotaOverviewIfValid(
	value: unknown,
	apply: (overview: PublicCodexQuotaOverview) => void,
): boolean {
	if (!isPublicCodexQuotaOverview(value)) return false;
	apply(value);
	return true;
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
				const coverage = getSegmentCoverage(segment);
				return (
					<Box
						key={segment.type}
						data-coverage={coverage}
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
								height: ratio === null ? "100%" : `${Math.round(ratio * 100)}%`,
								minHeight: ratio !== null && ratio > 0 ? 2 : 0,
								background:
									ratio === null ? "var(--mantine-color-gray-5)" : CODEX_TIER_STROKES[segment.type],
								opacity: ratio === null ? 0.45 : 1,
								transition: "height 160ms ease",
							}}
						/>
					</Box>
				);
			})}
		</Group>
	);
}

export function CodexQuotaIndicatorContent({
	overview,
	compact = false,
}: {
	overview: PublicCodexQuotaOverview;
	compact?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const detailTitleSize = compact ? "md" : "sm";
	const detailTextSize = compact ? "sm" : "xs";
	const detailValueSize = compact ? "xl" : "lg";
	const detailMarkerSize = compact ? 10 : 8;
	const coverage = getOverviewCoverage(overview);
	const trackedCount = overview.trackedAccountCount;
	const modeledDenominator = overview.modeledAccountCount ?? overview.totalAccountEquivalents;
	const summaryLabel =
		coverage === "unknown"
			? trackedCount === undefined
				? t("codexQuotaIndicatorUnknown")
				: t("codexQuotaIndicatorUnknownSummary", { count: trackedCount })
			: `${formatAccountEquivalent(overview.totalRemainingAccountEquivalents)} / ${formatAccountEquivalent(
					modeledDenominator,
				)}`;

	return (
		<Stack gap="sm" data-coverage={coverage}>
			<Group justify="space-between" align="flex-start" wrap="nowrap">
				<Stack gap={2} style={{ minWidth: 0 }}>
					<Text size={detailTitleSize} fw={600}>
						{t("codexQuotaIndicatorLabel")}
					</Text>
					<Text size={detailTextSize} c="dimmed">
						{overview.unit === "account_equivalent" ? ts("codexQuotaTrendUnit") : ""}
					</Text>
				</Stack>
				<Text size={detailValueSize} fw={700} ta="right" style={{ whiteSpace: "nowrap" }}>
					{summaryLabel}
				</Text>
			</Group>

			<SegmentBars segments={overview.segments} compact={compact} />

			{overview.segments.length > 0 ? (
				<Stack gap={4}>
					{overview.segments.map((segment) => {
						const segmentCoverage = getSegmentCoverage(segment);
						const segmentUnknownCount = segment.unmodeledAccountCount ?? 0;
						const segmentModeledDenominator =
							segment.modeledAccountCount ?? segment.totalAccountEquivalents;
						return (
							<Group key={segment.type} justify="space-between" gap="sm" wrap="nowrap">
								<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
									<span
										style={{
											width: detailMarkerSize,
											height: detailMarkerSize,
											borderRadius: 999,
											background:
												segmentCoverage === "unknown"
													? "var(--mantine-color-gray-5)"
													: CODEX_TIER_STROKES[segment.type],
											display: "inline-block",
											flexShrink: 0,
										}}
									/>
									<Text size={detailTextSize} truncate>
										{getCodexTierLabel(ts, segment.type)}
									</Text>
								</Group>
								<Stack gap={0} align="flex-end" style={{ flexShrink: 0 }}>
									<Text size={detailTextSize} fw={600}>
										{segmentCoverage === "unknown"
											? segment.trackedAccountCount === undefined
												? t("codexQuotaIndicatorUnknown")
												: t("codexQuotaIndicatorUnknownSummary", {
														count: segment.trackedAccountCount,
													})
											: `${formatAccountEquivalent(segment.remainingAccountEquivalents)} / ${formatAccountEquivalent(
													segmentModeledDenominator,
												)}`}
									</Text>
									{segmentCoverage === "mixed" && (
										<Text size={detailTextSize} c="orange">
											{t("codexQuotaIndicatorUnknownCount", { count: segmentUnknownCount })}
										</Text>
									)}
								</Stack>
							</Group>
						);
					})}
				</Stack>
			) : coverage !== "unknown" ? (
				<Paper withBorder p="xs">
					<Text size={detailTextSize} c="dimmed" ta="center">
						{t("codexQuotaIndicatorEmpty")}
					</Text>
				</Paper>
			) : null}

			{hasChartData(overview) && (
				<CodexQuotaTrendChart trend={overview.trend} compact showLegend={false} />
			)}

			<Text size={detailTextSize} c="dimmed">
				{overview.nextResetAt
					? ts("codexQuotaNextReset", {
							when: formatResetTimestamp(overview.nextResetAt),
						})
					: coverage === "modeled"
						? ts("codexQuotaNoResetScheduled")
						: ts("codexQuotaResetUnknown")}
			</Text>
		</Stack>
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
	const codexRuntimeCapability = useProviderRuntimeCapability("codex");
	const codexRoutesSupported = codexRuntimeCapability?.routes?.supported !== false;
	const canReadQuotaOverview =
		codexRoutesSupported && codexRuntimeCapability?.routes?.quotaOverview !== false;
	const queryEnabled = enabled && canReadQuotaOverview;
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
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
				applyPublicCodexQuotaOverviewIfValid(data.overview, (nextOverview) => {
					queryClient.setQueryData(CODEX_QUOTA_QUERY_KEY, nextOverview);
				});
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
	const detailTextSize = useReadableText ? "sm" : "xs";
	const canOpenSettings = isAdmin;
	const errorMessage = error instanceof Error ? error.message : "";
	const showErrorState = isError && !overview;
	const overviewCoverage = overview ? getOverviewCoverage(overview) : "modeled";
	const indicatorAriaLabel = overview
		? overviewCoverage === "unknown"
			? `${t("codexQuotaIndicatorLabel")}: ${
					overview.trackedAccountCount === undefined
						? t("codexQuotaIndicatorUnknown")
						: t("codexQuotaIndicatorUnknownSummary", {
								count: overview.trackedAccountCount,
							})
				}`
			: `${t("codexQuotaIndicatorLabel")}: ${formatAccountEquivalent(
					overview.totalRemainingAccountEquivalents,
				)} / ${formatAccountEquivalent(overview.modeledAccountCount ?? overview.totalAccountEquivalents)}${
					overviewCoverage === "mixed"
						? `, ${t("codexQuotaIndicatorUnknownCount", {
								count: overview.unmodeledAccountCount ?? 0,
							})}`
						: ""
				}`
		: t("codexQuotaIndicatorLabel");
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
					aria-label={indicatorAriaLabel}
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
					{overview ? (
						<CodexQuotaIndicatorContent overview={overview} compact={useReadableText} />
					) : showErrorState ? (
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
					) : (
						<Paper withBorder p="xs">
							<Text size={detailTextSize} c="dimmed" ta="center">
								{t("codexQuotaIndicatorEmpty")}
							</Text>
						</Paper>
					)}

					{isError && overview && (
						<Text size={detailTextSize} c="red" ta="center">
							{t("codexQuotaIndicatorError")}
						</Text>
					)}
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
