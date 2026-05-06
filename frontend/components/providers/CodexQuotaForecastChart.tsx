import { Group, Paper, Stack, Text } from "@mantine/core";
import { type PointerEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CodexPlanTier,
	CodexUsageForecast,
	PublicCodexPlanTier,
	PublicCodexQuotaOverview,
} from "../../lib/api/types";
import { relativeTime } from "../../lib/relative-time";

export const CODEX_TIER_COLORS: Record<CodexPlanTier, string> = {
	free: "gray",
	plus: "blue",
	team: "cyan",
	prolite: "violet",
	pro: "green",
	other: "dark",
};

export const CODEX_TIER_STROKES: Record<CodexPlanTier, string> = {
	free: "var(--mantine-color-gray-6)",
	plus: "var(--mantine-color-blue-6)",
	team: "var(--mantine-color-cyan-6)",
	prolite: "var(--mantine-color-violet-6)",
	pro: "var(--mantine-color-green-6)",
	other: "var(--mantine-color-dark-4)",
};

type PublicForecast = PublicCodexQuotaOverview["forecast"];
type ForecastLike = CodexUsageForecast | PublicForecast;
type ForecastPointLike = CodexUsageForecast["points"][number] | PublicForecast["points"][number];

export function getCodexTierLabel(t: (key: string) => string, tier: CodexPlanTier): string {
	if (tier === "free") return t("codexQuotaTierFree");
	if (tier === "plus") return t("codexQuotaTierPlus");
	if (tier === "team") return t("codexQuotaTierTeam");
	if (tier === "prolite") return t("codexQuotaTierProLite");
	if (tier === "pro") return t("codexQuotaTierPro");
	return t("codexQuotaTierOther");
}

export function formatAccountEquivalent(value: number): string {
	return new Intl.NumberFormat(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(value);
}

export function formatResetTimestamp(timestamp?: number | null): string {
	if (!timestamp) return "-";
	return relativeTime(new Date(timestamp).toISOString());
}

function formatChartTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatQuotaForecastDuration(
	timestamp: number,
	t: (key: string, values?: Record<string, number | string>) => string,
): string {
	const diffMinutes = Math.round((timestamp - Date.now()) / 60_000);
	if (Math.abs(diffMinutes) < 1) return t("codexQuotaForecastNow");

	const absMinutes = Math.abs(diffMinutes);
	const hours = Math.floor(absMinutes / 60);
	const minutes = absMinutes % 60;
	const duration = t("codexQuotaForecastHoursMinutes", { hours, minutes });

	return diffMinutes > 0
		? t("codexQuotaForecastInDuration", { duration })
		: t("codexQuotaForecastAgoDuration", { duration });
}

function getForecastTiers(forecast: ForecastLike): CodexPlanTier[] {
	if ("tiers" in forecast) return forecast.tiers;
	return forecast.types;
}

function getPointValue(point: ForecastPointLike, tier: CodexPlanTier): number {
	if ("byTier" in point) return point.byTier[tier] ?? 0;
	return point.byType[tier as PublicCodexPlanTier] ?? 0;
}

export function CodexQuotaForecastChart({
	forecast,
	selectedTiers,
	compact = false,
	showLegend = true,
}: {
	forecast: ForecastLike;
	selectedTiers?: CodexPlanTier[];
	compact?: boolean;
	showLegend?: boolean;
}) {
	const { t } = useTranslation("settings");
	const svgRef = useRef<SVGSVGElement>(null);
	const [hoveredCursor, setHoveredCursor] = useState<{
		timestamp: number;
		x: number;
		overlayX: number;
		alignRight: boolean;
	} | null>(null);
	const points = forecast.points;
	const width = 680;
	const height = 190;
	const padding = { left: 42, right: 16, top: 14, bottom: 34 };
	const chartWidth = width - padding.left - padding.right;
	const chartHeight = height - padding.top - padding.bottom;
	const availableTiers = getForecastTiers(forecast);
	const tiers = selectedTiers ?? availableTiers;
	const visibleTiers = tiers.filter(
		(tier) => tier !== "other" && availableTiers.includes(tier),
	) as CodexPlanTier[];
	const maxValue = Math.max(
		1,
		...points.flatMap((point) => visibleTiers.map((tier) => getPointValue(point, tier))),
	);
	const minTime = points[0]?.timestamp ?? Date.now();
	const maxTime = points[points.length - 1]?.timestamp ?? minTime;
	const hasChartData = points.length >= 2;

	if (visibleTiers.length === 0) {
		return (
			<Paper withBorder p="sm">
				<Text size="xs" c="dimmed" ta="center">
					{t("codexQuotaNoTierSelected")}
				</Text>
			</Paper>
		);
	}

	if (!hasChartData) {
		return (
			<Paper withBorder p="sm">
				<Text size="xs" c="dimmed" ta="center">
					{t("codexQuotaForecastEmpty")}
				</Text>
			</Paper>
		);
	}

	const xFor = (timestamp: number) => {
		if (maxTime === minTime) return padding.left + chartWidth / 2;
		return padding.left + ((timestamp - minTime) / (maxTime - minTime)) * chartWidth;
	};
	const yFor = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight;
	const timeFor = (x: number) => {
		if (chartWidth <= 0 || maxTime === minTime) return minTime;
		return minTime + ((x - padding.left) / chartWidth) * (maxTime - minTime);
	};
	const getForecastValueAt = (timestamp: number, tier: CodexPlanTier) => {
		let value = getPointValue(points[0], tier);
		for (const point of points) {
			if (point.timestamp > timestamp) break;
			value = getPointValue(point, tier);
		}
		return value;
	};
	const buildStepPath = (tier: CodexPlanTier) => {
		const firstPoint = points[0];
		if (!firstPoint) return "";
		let path = `M ${xFor(firstPoint.timestamp)} ${yFor(getPointValue(firstPoint, tier))}`;
		for (const point of points.slice(1)) {
			const x = xFor(point.timestamp);
			path += ` H ${x} V ${yFor(getPointValue(point, tier))}`;
		}
		return path;
	};
	const updateHoveredPoint = (event: PointerEvent<SVGSVGElement>) => {
		const svg = svgRef.current;
		const screenCtm = svg?.getScreenCTM();
		if (!svg || !screenCtm) return;
		const svgPoint = svg.createSVGPoint();
		svgPoint.x = event.clientX;
		svgPoint.y = event.clientY;
		const point = svgPoint.matrixTransform(screenCtm.inverse());
		const rawX = Math.min(Math.max(point.x, padding.left), padding.left + chartWidth);
		const firstPoint = points[0];
		if (!firstPoint) return;
		const nearestResetPoint = points.reduce((nearest, forecastPoint) => {
			const currentDistance = Math.abs(xFor(forecastPoint.timestamp) - rawX);
			const nearestDistance = Math.abs(xFor(nearest.timestamp) - rawX);
			return currentDistance < nearestDistance ? forecastPoint : nearest;
		}, firstPoint);
		const shouldSnap = Math.abs(xFor(nearestResetPoint.timestamp) - rawX) <= 8;
		const x = shouldSnap ? xFor(nearestResetPoint.timestamp) : rawX;
		const timestamp = shouldSnap ? nearestResetPoint.timestamp : timeFor(rawX);
		const cursorPoint = svg.createSVGPoint();
		cursorPoint.x = x;
		cursorPoint.y = padding.top;
		const screenPoint = cursorPoint.matrixTransform(screenCtm);
		const rect = svg.getBoundingClientRect();
		const overlayX = Math.min(Math.max(screenPoint.x - rect.left, 0), rect.width);
		setHoveredCursor({ timestamp, x, overlayX, alignRight: overlayX > rect.width * 0.68 });
	};

	return (
		<Stack gap="xs">
			<div style={{ position: "relative" }}>
				<svg
					ref={svgRef}
					viewBox={`0 0 ${width} ${height}`}
					role="img"
					aria-label={t("codexQuotaForecastTitle")}
					onPointerMove={updateHoveredPoint}
					onPointerDown={updateHoveredPoint}
					onPointerLeave={() => setHoveredCursor(null)}
					onPointerCancel={() => setHoveredCursor(null)}
					style={{ width: "100%", height: compact ? 180 : 220, touchAction: "none" }}
				>
					<line
						x1={padding.left}
						y1={padding.top}
						x2={padding.left}
						y2={padding.top + chartHeight}
						stroke="var(--mantine-color-gray-4)"
					/>
					<line
						x1={padding.left}
						y1={padding.top + chartHeight}
						x2={padding.left + chartWidth}
						y2={padding.top + chartHeight}
						stroke="var(--mantine-color-gray-4)"
					/>
					<text x={padding.left - 8} y={padding.top + 4} textAnchor="end" fontSize="10" fill="gray">
						{formatAccountEquivalent(maxValue)}
					</text>
					<text
						x={padding.left - 8}
						y={padding.top + chartHeight}
						textAnchor="end"
						fontSize="10"
						fill="gray"
					>
						0
					</text>
					<text x={padding.left} y={height - 8} textAnchor="start" fontSize="10" fill="gray">
						{formatChartTimestamp(minTime)}
					</text>
					<text
						x={padding.left + chartWidth}
						y={height - 8}
						textAnchor="end"
						fontSize="10"
						fill="gray"
					>
						{formatChartTimestamp(maxTime)}
					</text>
					{visibleTiers.map((tier) => (
						<path
							key={tier}
							d={buildStepPath(tier)}
							fill="none"
							stroke={CODEX_TIER_STROKES[tier]}
							strokeWidth={2}
							strokeLinejoin="round"
							strokeLinecap="round"
						/>
					))}
					{points.map((point) => (
						<line
							key={point.timestamp}
							x1={xFor(point.timestamp)}
							y1={padding.top}
							x2={xFor(point.timestamp)}
							y2={padding.top + chartHeight}
							stroke="var(--mantine-color-gray-3)"
							strokeDasharray="3 4"
						/>
					))}
					{hoveredCursor ? (
						<>
							<line
								x1={hoveredCursor.x}
								y1={padding.top}
								x2={hoveredCursor.x}
								y2={padding.top + chartHeight}
								stroke="var(--mantine-color-gray-7)"
								strokeWidth={1.5}
								strokeDasharray="4 3"
							/>
							{visibleTiers.map((tier) => (
								<circle
									key={tier}
									cx={hoveredCursor.x}
									cy={yFor(getForecastValueAt(hoveredCursor.timestamp, tier))}
									r={4}
									fill="var(--mantine-color-body)"
									stroke={CODEX_TIER_STROKES[tier]}
									strokeWidth={2}
								/>
							))}
						</>
					) : null}
				</svg>
				{hoveredCursor ? (
					<Paper
						withBorder
						p="xs"
						shadow="md"
						style={{
							position: "absolute",
							left: hoveredCursor.overlayX,
							top: 8,
							minWidth: 210,
							pointerEvents: "none",
							transform: hoveredCursor.alignRight ? "translateX(-100%)" : "translateX(8px)",
							zIndex: 2,
						}}
					>
						<Stack gap={4}>
							<Text size="xs" fw={600}>
								{formatChartTimestamp(hoveredCursor.timestamp)}
							</Text>
							<Text size="xs" c="dimmed">
								{t("codexQuotaForecastTooltipDistance")}:{" "}
								{formatQuotaForecastDuration(hoveredCursor.timestamp, t)}
							</Text>
							{visibleTiers.map((tier) => (
								<Group key={tier} justify="space-between" gap="sm" wrap="nowrap">
									<Group gap={5} wrap="nowrap">
										<span
											style={{
												width: 8,
												height: 8,
												borderRadius: 999,
												background: CODEX_TIER_STROKES[tier],
												display: "inline-block",
												flexShrink: 0,
											}}
										/>
										<Text size="xs">{getCodexTierLabel(t, tier)}</Text>
									</Group>
									<Text size="xs" fw={600}>
										{formatAccountEquivalent(getForecastValueAt(hoveredCursor.timestamp, tier))}
									</Text>
								</Group>
							))}
						</Stack>
					</Paper>
				) : null}
			</div>
			{showLegend && (
				<Group gap="xs" wrap="wrap">
					{visibleTiers.map((tier) => (
						<Group key={tier} gap={4}>
							<span
								style={{
									width: 10,
									height: 10,
									borderRadius: 999,
									background: CODEX_TIER_STROKES[tier],
									display: "inline-block",
								}}
							/>
							<Text size="xs" c="dimmed">
								{getCodexTierLabel(t, tier)}
							</Text>
						</Group>
					))}
				</Group>
			)}
		</Stack>
	);
}
