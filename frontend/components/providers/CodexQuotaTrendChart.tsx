import { Group, Paper, Stack, Text } from "@mantine/core";
import { type PointerEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CodexPlanTier,
	CodexUsageForecast,
	PublicCodexPlanTier,
	PublicCodexQuotaOverview,
} from "../../lib/api/types";
import { CODEX_TIER_STROKES, getCodexTierLabel } from "../../lib/codex-tiers";
import { relativeTime } from "../../lib/relative-time";

type PublicTrend = PublicCodexQuotaOverview["trend"];
type TrendLike = CodexUsageForecast | PublicTrend;
type TrendPointLike = CodexUsageForecast["points"][number] | PublicTrend["points"][number];

const HOUR_MS = 60 * 60 * 1000;
const NEAR_WINDOW_MS = 5 * HOUR_MS;
const COMPRESSED_NEAR_WIDTH_RATIO = 0.68;
const COMPRESSED_GRID_TARGET_LINES = 42;

const GRID_STEPS_MS = [HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, 24 * HOUR_MS];

type TrendGridLine = {
	timestamp: number;
	variant: "near" | "compressed" | "boundary";
};

type ConsumptionProjection = {
	tier: CodexPlanTier;
	consumptionRatePerMs: number;
	endTime: number;
};

export function formatAccountEquivalent(value: number): string {
	return new Intl.NumberFormat(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(value);
}

export function formatResetTimestamp(timestamp?: number | null): string {
	if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "-";
	const date = new Date(timestamp);
	return Number.isFinite(date.getTime()) ? relativeTime(date.toISOString()) : "-";
}

function formatChartTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function getAlignedTimestamp(timestamp: number, stepMs: number): number {
	return Math.ceil(timestamp / stepMs) * stepMs;
}

function chooseCompressedGridStep(duration: number): number {
	const targetStep = duration / COMPRESSED_GRID_TARGET_LINES;
	return (
		GRID_STEPS_MS.find((step) => step >= targetStep) ?? GRID_STEPS_MS[GRID_STEPS_MS.length - 1]
	);
}

function buildTrendGridLines({
	minTime,
	nearEndTime,
	maxTime,
	isCompressed,
}: {
	minTime: number;
	nearEndTime: number;
	maxTime: number;
	isCompressed: boolean;
}): TrendGridLine[] {
	const lines: TrendGridLine[] = [];
	const nearStart = getAlignedTimestamp(minTime + 1, HOUR_MS);
	for (let timestamp = nearStart; timestamp < nearEndTime; timestamp += HOUR_MS) {
		lines.push({ timestamp, variant: "near" });
	}

	if (!isCompressed) return lines;

	lines.push({ timestamp: nearEndTime, variant: "boundary" });
	const compressedStep = chooseCompressedGridStep(maxTime - nearEndTime);
	const compressedStart = getAlignedTimestamp(nearEndTime + 1, compressedStep);
	for (let timestamp = compressedStart; timestamp < maxTime; timestamp += compressedStep) {
		lines.push({ timestamp, variant: "compressed" });
	}
	return lines;
}

export function formatQuotaTrendDuration(
	timestamp: number,
	t: (key: string, values?: Record<string, number | string>) => string,
	referenceTime = Date.now(),
): string {
	const diffMinutes = Math.round((timestamp - referenceTime) / 60_000);
	if (Math.abs(diffMinutes) < 1) return t("codexQuotaTrendNow");

	const absMinutes = Math.abs(diffMinutes);
	const days = Math.floor(absMinutes / 1440);
	const hours = Math.floor((absMinutes % 1440) / 60);
	const minutes = absMinutes % 60;
	const hoursMinutes =
		hours > 0 && minutes > 0
			? t("codexQuotaTrendHoursMinutes", { hours, minutes })
			: hours > 0
				? t("codexQuotaTrendHoursOnly", { hours })
				: minutes > 0
					? t("codexQuotaTrendMinutesOnly", { minutes })
					: "";
	const duration =
		days > 0
			? [t("codexQuotaTrendDaysOnly", { days }), hoursMinutes].filter(Boolean).join(" ")
			: hoursMinutes;

	return diffMinutes > 0
		? t("codexQuotaTrendInDuration", { duration })
		: t("codexQuotaTrendAgoDuration", { duration });
}

function getTrendTiers(trend: TrendLike): CodexPlanTier[] {
	if ("tiers" in trend) return trend.tiers;
	return trend.types;
}

function getPointValue(point: TrendPointLike, tier: CodexPlanTier): number | null {
	const value = "byTier" in point ? point.byTier[tier] : point.byType[tier as PublicCodexPlanTier];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getTrendGeneratedAt(trend: TrendLike): number {
	const generatedAt = new Date(trend.generatedAt).getTime();
	return Number.isFinite(generatedAt) ? generatedAt : Date.now();
}

function shouldRenderSeparateTick(timestamp: number, minTime: number, maxTime: number): boolean {
	const minTickDistance = 15 * 60_000;
	return timestamp > minTime + minTickDistance && timestamp < maxTime - minTickDistance;
}

type TickTextAnchor = "start" | "middle" | "end";
type TickLabelBounds = { left: number; right: number };

function estimateTickTextWidth(text: string, fontSize = 10): number {
	const baseWidth = Array.from(text).reduce((width, character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (/\s/.test(character)) return width + 3;
		if (codePoint >= 0x2e80) return width + 10;
		if (/[A-Z0-9]/.test(character)) return width + 6;
		return width + 5;
	}, 0);
	return (baseWidth * fontSize) / 10;
}

function getTickLabelBounds(
	timestamp: number,
	x: number,
	textAnchor: TickTextAnchor,
	t: (key: string, values?: Record<string, number | string>) => string,
	referenceTime: number,
	fontSize: number,
): TickLabelBounds {
	const width = Math.max(
		estimateTickTextWidth(formatChartTimestamp(timestamp), fontSize),
		estimateTickTextWidth(formatQuotaTrendDuration(timestamp, t, referenceTime), fontSize),
	);
	if (textAnchor === "start") return { left: x, right: x + width };
	if (textAnchor === "end") return { left: x - width, right: x };
	return { left: x - width / 2, right: x + width / 2 };
}

function tickLabelBoundsOverlap(
	first: TickLabelBounds,
	second: TickLabelBounds,
	padding = 6,
): boolean {
	return first.left < second.right + padding && second.left < first.right + padding;
}

export function CodexQuotaTrendChart({
	trend,
	selectedTiers,
	compact = false,
	showLegend = true,
}: {
	trend: TrendLike;
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
	const points = [...trend.points].sort((a, b) => a.timestamp - b.timestamp);
	const trendNow = getTrendGeneratedAt(trend);
	const width = compact ? 420 : 680;
	const height = compact ? 210 : 190;
	const padding = compact
		? { left: 44, right: 14, top: 18, bottom: 46 }
		: { left: 42, right: 16, top: 14, bottom: 34 };
	const chartWidth = width - padding.left - padding.right;
	const chartHeight = height - padding.top - padding.bottom;
	const axisFontSize = compact ? 13 : 11;
	const axisValueFontSize = compact ? 12 : 11;
	const axisLineGap = axisFontSize + 3;
	const axisTickY = height - axisLineGap - 5;
	const nowLabelFontSize = compact ? 12 : 11;
	const infoTextSize = compact ? "sm" : "xs";
	const tooltipTextSize = compact ? "sm" : "xs";
	const tooltipMarkerSize = compact ? 10 : 8;
	const availableTiers = getTrendTiers(trend);
	const tiers = selectedTiers ?? availableTiers;
	const visibleTiers = tiers.filter(
		(tier) =>
			tier !== "other" &&
			availableTiers.includes(tier) &&
			points.some((point) => getPointValue(point, tier) !== null),
	) as CodexPlanTier[];
	const finiteValues = points.flatMap((point) =>
		visibleTiers.flatMap((tier) => {
			const value = getPointValue(point, tier);
			return value === null ? [] : [value];
		}),
	);
	const maxValue = Math.max(1, ...finiteValues);
	const firstPointTime = points[0]?.timestamp ?? trendNow;
	const lastPointTime = points[points.length - 1]?.timestamp ?? trendNow;
	const minTime = Math.min(firstPointTime, trendNow);
	const preliminaryMaxTime = Math.max(lastPointTime, trendNow);
	const hasChartData = points.length >= 2;
	const getTrendValueAt = (timestamp: number, tier: CodexPlanTier): number | null => {
		const firstPoint = points[0];
		if (!firstPoint) return null;
		if (timestamp <= firstPoint.timestamp) return getPointValue(firstPoint, tier);

		if (timestamp > trendNow) {
			let latestPoint = firstPoint;
			for (const point of points) {
				if (point.timestamp > timestamp) break;
				latestPoint = point;
			}
			return getPointValue(latestPoint, tier);
		}

		let latestHistoricalPoint = firstPoint;
		for (let index = 1; index < points.length; index++) {
			const previousPoint = points[index - 1];
			const currentPoint = points[index];
			if (currentPoint.timestamp > trendNow) break;
			latestHistoricalPoint = currentPoint;
			if (timestamp > currentPoint.timestamp) continue;

			const previousValue = getPointValue(previousPoint, tier);
			const currentValue = getPointValue(currentPoint, tier);
			if (previousValue === null || currentValue === null) return null;
			const duration = currentPoint.timestamp - previousPoint.timestamp;
			if (duration <= 0) return currentValue;
			const ratio = (timestamp - previousPoint.timestamp) / duration;
			return previousValue + (currentValue - previousValue) * ratio;
		}

		return getPointValue(latestHistoricalPoint, tier);
	};
	const firstHistoricalPoint = points.find((point) => point.timestamp <= trendNow);
	const projectionReferenceTime = firstHistoricalPoint
		? Math.max(trendNow - HOUR_MS, firstHistoricalPoint.timestamp)
		: trendNow;
	const projectionDuration = trendNow - projectionReferenceTime;
	const getConsumedValueInProjectionWindow = (tier: CodexPlanTier) => {
		const samples = [
			{ timestamp: projectionReferenceTime, value: getTrendValueAt(projectionReferenceTime, tier) },
			...points
				.filter((point) => point.timestamp > projectionReferenceTime && point.timestamp < trendNow)
				.map((point) => ({ timestamp: point.timestamp, value: getPointValue(point, tier) })),
			{ timestamp: trendNow, value: getTrendValueAt(trendNow, tier) },
		]
			.filter((sample): sample is { timestamp: number; value: number } => sample.value !== null)
			.sort((a, b) => a.timestamp - b.timestamp);

		let consumedValue = 0;
		for (let index = 1; index < samples.length; index++) {
			consumedValue += Math.max(0, samples[index - 1].value - samples[index].value);
		}
		return consumedValue;
	};
	const projectionHorizon = Math.max(preliminaryMaxTime, trendNow + NEAR_WINDOW_MS);
	const consumptionProjections = visibleTiers.flatMap((tier): ConsumptionProjection[] => {
		if (projectionDuration < 60_000 || projectionHorizon <= trendNow) return [];

		const startValue = getTrendValueAt(trendNow, tier);
		const consumedValue = getConsumedValueInProjectionWindow(tier);
		if (startValue === null || startValue <= 0 || consumedValue <= 0.001) return [];

		return [
			{
				tier,
				consumptionRatePerMs: consumedValue / projectionDuration,
				endTime: projectionHorizon,
			},
		];
	});
	const maxTime = Math.max(
		preliminaryMaxTime,
		...consumptionProjections.map((projection) => projection.endTime),
	);
	const nearEndTime = Math.min(trendNow + NEAR_WINDOW_MS, maxTime);
	const nearDuration = Math.max(nearEndTime - minTime, 1);
	const compressedDuration = Math.max(maxTime - nearEndTime, 0);
	const isCompressedTimeScale = compressedDuration > HOUR_MS;
	const nearWidth = isCompressedTimeScale ? chartWidth * COMPRESSED_NEAR_WIDTH_RATIO : chartWidth;
	const compressedWidth = Math.max(chartWidth - nearWidth, 1);
	const gridLines = buildTrendGridLines({
		minTime,
		nearEndTime,
		maxTime,
		isCompressed: isCompressedTimeScale,
	});

	if (visibleTiers.length === 0) {
		return (
			<Paper withBorder p="sm">
				<Text size={infoTextSize} c="dimmed" ta="center">
					{t("codexQuotaNoTierSelected")}
				</Text>
			</Paper>
		);
	}

	if (!hasChartData) {
		return (
			<Paper withBorder p="sm">
				<Text size={infoTextSize} c="dimmed" ta="center">
					{t("codexQuotaTrendEmpty")}
				</Text>
			</Paper>
		);
	}

	const xFor = (timestamp: number) => {
		if (maxTime === minTime) return padding.left + chartWidth / 2;
		const clampedTimestamp = Math.min(Math.max(timestamp, minTime), maxTime);
		if (!isCompressedTimeScale) {
			return padding.left + ((clampedTimestamp - minTime) / (maxTime - minTime)) * chartWidth;
		}
		if (clampedTimestamp <= nearEndTime) {
			return padding.left + ((clampedTimestamp - minTime) / nearDuration) * nearWidth;
		}
		return (
			padding.left +
			nearWidth +
			((clampedTimestamp - nearEndTime) / compressedDuration) * compressedWidth
		);
	};
	const yFor = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight;
	const nowX = xFor(trendNow);
	const compressedBoundaryX = xFor(nearEndTime);
	const showNowMarker = maxTime > minTime && trendNow >= minTime && trendNow <= maxTime;
	const requiredTickBounds = [
		getTickLabelBounds(minTime, padding.left, "middle", t, trendNow, axisFontSize),
		getTickLabelBounds(maxTime, padding.left + chartWidth, "end", t, trendNow, axisFontSize),
	];
	const tickOverlapsRequiredLabels = (bounds: TickLabelBounds) =>
		requiredTickBounds.some((requiredBounds) => tickLabelBoundsOverlap(bounds, requiredBounds));
	const compressedBoundaryTickBounds = getTickLabelBounds(
		nearEndTime,
		compressedBoundaryX,
		"middle",
		t,
		trendNow,
		axisFontSize,
	);
	const showCompressedBoundaryMarker =
		isCompressedTimeScale && nearEndTime > minTime && nearEndTime < maxTime;
	const showCompressedBoundaryTick =
		showCompressedBoundaryMarker &&
		shouldRenderSeparateTick(nearEndTime, minTime, maxTime) &&
		!tickOverlapsRequiredLabels(compressedBoundaryTickBounds);
	const timeFor = (x: number) => {
		if (chartWidth <= 0 || maxTime === minTime) return minTime;
		const clampedX = Math.min(Math.max(x, padding.left), padding.left + chartWidth);
		if (!isCompressedTimeScale) {
			return minTime + ((clampedX - padding.left) / chartWidth) * (maxTime - minTime);
		}
		const localX = clampedX - padding.left;
		if (localX <= nearWidth) return minTime + (localX / nearWidth) * nearDuration;
		return nearEndTime + ((localX - nearWidth) / compressedWidth) * compressedDuration;
	};
	const buildHybridPaths = (tier: CodexPlanTier): string[] => {
		const paths: string[] = [];
		let path = "";
		let previousPoint: TrendPointLike | null = null;
		const flushPath = () => {
			if (path) paths.push(path);
			path = "";
		};

		for (const point of points) {
			const currentValue = getPointValue(point, tier);
			if (currentValue === null) {
				flushPath();
				previousPoint = null;
				continue;
			}

			if (!path) {
				path = `M ${xFor(point.timestamp)} ${yFor(currentValue)}`;
				previousPoint = point;
				continue;
			}

			if (point.timestamp <= trendNow) {
				path += ` L ${xFor(point.timestamp)} ${yFor(currentValue)}`;
				previousPoint = point;
				continue;
			}

			if (previousPoint && previousPoint.timestamp < trendNow) {
				const nowValue = getTrendValueAt(trendNow, tier);
				if (nowValue === null) {
					flushPath();
					path = `M ${xFor(point.timestamp)} ${yFor(currentValue)}`;
					previousPoint = point;
					continue;
				}
				path += ` L ${xFor(trendNow)} ${yFor(nowValue)}`;
			}

			path += ` H ${xFor(point.timestamp)} V ${yFor(currentValue)}`;
			previousPoint = point;
		}
		flushPath();
		return paths;
	};
	const buildConsumptionProjectionPath = (projection: ConsumptionProjection) => {
		const { tier, consumptionRatePerMs, endTime } = projection;
		const projectedValue = (timestamp: number, baseValue: number, baseTimestamp: number) =>
			Math.max(0, baseValue - consumptionRatePerMs * Math.max(0, timestamp - baseTimestamp));
		let segmentBaseTimestamp = trendNow;
		let baselineValueBeforeNextReset = getTrendValueAt(trendNow, tier) ?? 0;
		let projectedSegmentBaseValue = baselineValueBeforeNextReset;
		let currentTimestamp = trendNow;
		let currentProjectedValue = projectedValue(
			trendNow,
			projectedSegmentBaseValue,
			segmentBaseTimestamp,
		);
		let path = `M ${nowX} ${yFor(currentProjectedValue)}`;

		const appendSlopeTo = (timestamp: number) => {
			const nextProjectedValue = projectedValue(
				timestamp,
				projectedSegmentBaseValue,
				segmentBaseTimestamp,
			);
			if (currentProjectedValue > 0 && nextProjectedValue <= 0) {
				const depletionTime = Math.min(
					segmentBaseTimestamp + projectedSegmentBaseValue / consumptionRatePerMs,
					timestamp,
				);
				if (depletionTime > currentTimestamp) {
					path += ` L ${xFor(depletionTime)} ${yFor(0)}`;
				}
				if (depletionTime < timestamp) {
					path += ` L ${xFor(timestamp)} ${yFor(0)}`;
				}
			} else {
				path += ` L ${xFor(timestamp)} ${yFor(nextProjectedValue)}`;
			}
			currentTimestamp = timestamp;
			currentProjectedValue = nextProjectedValue;
		};

		for (const point of points) {
			if (point.timestamp <= trendNow || point.timestamp > endTime) continue;

			appendSlopeTo(point.timestamp);

			// Future forecast points are quota reset steps. The consumption projection should add
			// only the reset delta, not jump back to the no-consumption forecast value.
			const baselineValueAfterReset = getPointValue(point, tier);
			if (baselineValueAfterReset === null) continue;
			const resetDelta = baselineValueAfterReset - baselineValueBeforeNextReset;
			currentProjectedValue = Math.max(0, currentProjectedValue + resetDelta);
			path += ` V ${yFor(currentProjectedValue)}`;

			baselineValueBeforeNextReset = baselineValueAfterReset;
			projectedSegmentBaseValue = currentProjectedValue;
			segmentBaseTimestamp = point.timestamp;
		}

		if (currentTimestamp < endTime) {
			appendSlopeTo(endTime);
		}
		return path;
	};
	const renderTimeTick = (timestamp: number, x: number, textAnchor: "start" | "middle" | "end") => (
		<text x={x} y={axisTickY} textAnchor={textAnchor} fontSize={axisFontSize} fill="gray">
			<tspan x={x}>{formatChartTimestamp(timestamp)}</tspan>
			<tspan x={x} dy={axisLineGap} fill="var(--mantine-color-dimmed)">
				{formatQuotaTrendDuration(timestamp, t, trendNow)}
			</tspan>
		</text>
	);
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
		const nearestResetPoint = points.reduce((nearest, trendPoint) => {
			const currentDistance = Math.abs(xFor(trendPoint.timestamp) - rawX);
			const nearestDistance = Math.abs(xFor(nearest.timestamp) - rawX);
			return currentDistance < nearestDistance ? trendPoint : nearest;
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
					aria-label={t("codexQuotaTrendTitle")}
					onPointerMove={updateHoveredPoint}
					onPointerDown={updateHoveredPoint}
					onPointerLeave={() => setHoveredCursor(null)}
					onPointerCancel={() => setHoveredCursor(null)}
					style={{ width: "100%", height: compact ? 210 : 220, touchAction: "none" }}
				>
					{gridLines.map((line) => (
						<line
							key={`${line.variant}-${line.timestamp}`}
							x1={xFor(line.timestamp)}
							y1={padding.top}
							x2={xFor(line.timestamp)}
							y2={padding.top + chartHeight}
							stroke={
								line.variant === "boundary"
									? "var(--mantine-color-indigo-6)"
									: "var(--mantine-color-gray-3)"
							}
							strokeOpacity={
								line.variant === "boundary" ? 0.7 : line.variant === "compressed" ? 0.42 : 0.28
							}
							strokeDasharray={line.variant === "boundary" ? "5 4" : "2 6"}
						/>
					))}
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
					<text
						x={padding.left - 8}
						y={padding.top + 4}
						textAnchor="end"
						fontSize={axisValueFontSize}
						fill="gray"
					>
						{formatAccountEquivalent(maxValue)}
					</text>
					<text
						x={padding.left - 8}
						y={padding.top + chartHeight}
						textAnchor="end"
						fontSize={axisValueFontSize}
						fill="gray"
					>
						0
					</text>
					{renderTimeTick(minTime, padding.left, "middle")}
					{showCompressedBoundaryTick && renderTimeTick(nearEndTime, compressedBoundaryX, "middle")}
					{renderTimeTick(maxTime, padding.left + chartWidth, "end")}
					{visibleTiers.flatMap((tier) =>
						buildHybridPaths(tier).map((path) => (
							<path
								key={`${tier}-${path}`}
								data-tier={tier}
								d={path}
								fill="none"
								stroke={CODEX_TIER_STROKES[tier]}
								strokeWidth={2}
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
						)),
					)}
					{consumptionProjections.map((projection) => (
						<path
							key={`${projection.tier}-consumption-projection`}
							d={buildConsumptionProjectionPath(projection)}
							fill="none"
							stroke={CODEX_TIER_STROKES[projection.tier]}
							strokeWidth={1.75}
							strokeOpacity={0.72}
							strokeDasharray="6 5"
							strokeLinejoin="round"
							strokeLinecap="round"
						/>
					))}
					{points
						.filter((point) => point.timestamp > trendNow)
						.map((point) => (
							<line
								key={point.timestamp}
								x1={xFor(point.timestamp)}
								y1={padding.top}
								x2={xFor(point.timestamp)}
								y2={padding.top + chartHeight}
								stroke="var(--mantine-color-gray-4)"
								strokeOpacity={0.82}
							/>
						))}
					{showCompressedBoundaryMarker ? (
						<text
							x={Math.min(
								Math.max(compressedBoundaryX, padding.left + 28),
								padding.left + chartWidth - 28,
							)}
							y={Math.max(nowLabelFontSize, padding.top - 4)}
							textAnchor="middle"
							fontSize={nowLabelFontSize}
							fill="var(--mantine-color-indigo-6)"
						>
							{formatQuotaTrendDuration(nearEndTime, t, trendNow)}
						</text>
					) : null}
					{showNowMarker ? (
						<>
							<line
								x1={nowX}
								y1={padding.top}
								x2={nowX}
								y2={padding.top + chartHeight}
								stroke="var(--mantine-color-indigo-6)"
								strokeWidth={1.5}
								strokeDasharray="3 3"
							/>
							<text
								x={Math.min(Math.max(nowX, padding.left + 18), padding.left + chartWidth - 18)}
								y={Math.max(nowLabelFontSize, padding.top - 4)}
								textAnchor="middle"
								fontSize={nowLabelFontSize}
								fill="var(--mantine-color-indigo-6)"
							>
								{t("codexQuotaTrendNow")}
							</text>
						</>
					) : null}
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
							{visibleTiers.flatMap((tier) => {
								const value = getTrendValueAt(hoveredCursor.timestamp, tier);
								return value === null
									? []
									: [
											<circle
												key={tier}
												cx={hoveredCursor.x}
												cy={yFor(value)}
												r={4}
												fill="var(--mantine-color-body)"
												stroke={CODEX_TIER_STROKES[tier]}
												strokeWidth={2}
											/>,
										];
							})}
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
							width: compact ? "min(240px, calc(100vw - 24px))" : 210,
							maxWidth: "calc(100vw - 24px)",
							pointerEvents: "none",
							transform: hoveredCursor.alignRight ? "translateX(-100%)" : "translateX(8px)",
							zIndex: 2,
						}}
					>
						<Stack gap={4}>
							<Text size={tooltipTextSize} fw={600}>
								{formatChartTimestamp(hoveredCursor.timestamp)}
							</Text>
							<Text size={tooltipTextSize} c="dimmed">
								{t("codexQuotaTrendTooltipDistance")}:{" "}
								{formatQuotaTrendDuration(hoveredCursor.timestamp, t, trendNow)}
							</Text>

							{visibleTiers.flatMap((tier) => {
								const value = getTrendValueAt(hoveredCursor.timestamp, tier);
								return value === null
									? []
									: [
											<Group key={tier} justify="space-between" gap="sm" wrap="nowrap">
												<Group gap={5} wrap="nowrap">
													<span
														style={{
															width: tooltipMarkerSize,
															height: tooltipMarkerSize,
															borderRadius: 999,
															background: CODEX_TIER_STROKES[tier],
															display: "inline-block",
															flexShrink: 0,
														}}
													/>
													<Text size={tooltipTextSize}>{getCodexTierLabel(t, tier)}</Text>
												</Group>
												<Text size={tooltipTextSize} fw={600}>
													{formatAccountEquivalent(value)}
												</Text>
											</Group>,
										];
							})}
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
							<Text size={compact ? "sm" : "xs"} c="dimmed">
								{getCodexTierLabel(t, tier)}
							</Text>
						</Group>
					))}
					{consumptionProjections.length > 0 ? (
						<Group gap={4}>
							<svg width={18} height={10} aria-hidden="true">
								<line
									x1={1}
									y1={5}
									x2={17}
									y2={5}
									stroke="var(--mantine-color-dimmed)"
									strokeWidth={1.5}
									strokeDasharray="4 3"
								/>
							</svg>
							<Text size={compact ? "sm" : "xs"} c="dimmed">
								{t("codexQuotaTrendPastHourProjection")}
							</Text>
						</Group>
					) : null}
				</Group>
			)}
		</Stack>
	);
}
