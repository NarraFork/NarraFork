import {
	type CompactNumberValue,
	formatCompactNumber,
	formatDuration,
	formatExactDuration,
} from "@frontend/lib/compact-number";
import {
	formatLocaleDate,
	formatLocaleDateTime,
	formatLocaleNumber,
} from "@frontend/lib/intl-format";
import { referenceCostStatus } from "@frontend/lib/usage-cost";
import type {
	UsageHistoryGranularity,
	UsageHistoryTimeSeriesPoint,
	UsageHistoryTimeSeriesResponse,
} from "@frontend/types/usage-history";
import { Card, Group, Loader, Paper, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type UsageMetricKey =
	| "requestCount"
	| "totalTokens"
	| "totalInputTokens"
	| "totalOutputTokens"
	| "totalReasoningTokens"
	| "totalCacheReadTokens"
	| "totalCacheCreationTokens"
	| "cacheHitRate"
	| "totalCost"
	| "averageTtftMs"
	| "averageDurationMs"
	| "errorCount"
	| "meterUsage";

interface UsageMetricConfig {
	value: UsageMetricKey;
	label: string;
	stroke: string;
	getValue: (point: UsageHistoryTimeSeriesPoint) => number | null;
}

interface UsageHistoryChartProps {
	data?: UsageHistoryTimeSeriesResponse;
	loading?: boolean;
	granularity: UsageHistoryGranularity;
	onGranularityChange: (granularity: UsageHistoryGranularity) => void;
}

const CHART_WIDTH = 760;
const CHART_HEIGHT = 260;
const PADDING = { left: 58, right: 18, top: 18, bottom: 48 };
const CHART_INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const CHART_INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;

function formatTimestamp(timestamp: string, granularity: UsageHistoryGranularity): string {
	if (granularity === "hour") {
		return formatLocaleDateTime(timestamp, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
		});
	}
	if (granularity === "day") {
		return formatLocaleDate(timestamp, { month: "short", day: "numeric" });
	}
	return formatLocaleDate(timestamp, { year: "numeric", month: "short" });
}

function formatRangeTimestamp(timestamp: string, granularity: UsageHistoryGranularity): string {
	if (granularity === "hour") {
		return formatLocaleDateTime(timestamp, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	return formatLocaleDate(timestamp, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function getTickIndexes(pointCount: number): number[] {
	if (pointCount <= 0) return [];
	if (pointCount <= 3) return Array.from({ length: pointCount }, (_, index) => index);
	return [0, Math.floor((pointCount - 1) / 2), pointCount - 1];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function getMeterUnit(
	points: UsageHistoryTimeSeriesPoint[],
	t: (key: string) => string,
): string | undefined {
	const units = new Set(points.flatMap((point) => (point.meterUnit ? [point.meterUnit] : [])));
	if (units.size === 0) return undefined;
	if (units.size === 1) return [...units][0];
	return t("usageHistoryMeterUnitMixed");
}

function formatMetricValue(
	metric: UsageMetricKey,
	value: number | null,
	meterUnit: string | undefined,
	emptyLabel = "—",
): CompactNumberValue {
	if (value == null) return { compact: emptyLabel, exact: emptyLabel, isCompact: false };
	if (metric === "cacheHitRate") {
		return { compact: `${Math.round(value)}%`, exact: `${value.toFixed(2)}%`, isCompact: false };
	}
	if (metric === "totalCost") {
		return formatCompactNumber(value, {
			prefix: "$",
			standardFractionDigits: 4,
			compactFractionDigits: 2,
			exactFractionDigits: 6,
		});
	}
	if (metric === "averageTtftMs" || metric === "averageDurationMs") {
		return {
			compact: formatDuration(value),
			exact: formatExactDuration(value),
			isCompact: false,
		};
	}
	if (metric === "meterUsage") {
		return formatCompactNumber(value, {
			unit: meterUnit,
			standardFractionDigits: 2,
			compactFractionDigits: 1,
			exactFractionDigits: 4,
		});
	}
	return formatCompactNumber(value);
}

export function buildUsageChartPath(
	values: Array<number | null>,
	xFor: (index: number) => number,
	yFor: (value: number) => number,
): string {
	return values
		.map((value, index) => {
			if (value == null) return "";
			const command = index === 0 || values[index - 1] == null ? "M" : "L";
			return `${command} ${xFor(index)} ${yFor(value)}`;
		})
		.filter(Boolean)
		.join(" ");
}

export function UsageHistoryChart({
	data,
	loading,
	granularity,
	onGranularityChange,
}: UsageHistoryChartProps) {
	const { t } = useTranslation("common");
	const svgRef = useRef<SVGSVGElement>(null);
	const [metric, setMetric] = useState<UsageMetricKey>("totalTokens");
	const [compareMetric, setCompareMetric] = useState<UsageMetricKey | "">("");
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const points = data?.points ?? [];
	const hasUsageData = points.some((point) => point.requestCount > 0);
	const meterUnit = useMemo(() => getMeterUnit(points, t), [points, t]);

	const metricOptions = useMemo<UsageMetricConfig[]>(() => {
		const metrics: UsageMetricConfig[] = [
			{
				value: "requestCount",
				label: t("usageHistoryMetricRequests"),
				stroke: "var(--mantine-color-indigo-6)",
				getValue: (point) => point.requestCount,
			},
			{
				value: "totalTokens",
				label: t("usageHistoryMetricTotalTokens"),
				stroke: "var(--mantine-color-blue-6)",
				getValue: (point) => point.totalTokens,
			},
			{
				value: "totalInputTokens",
				label: t("usageHistoryMetricInputTokens"),
				stroke: "var(--mantine-color-violet-6)",
				getValue: (point) => point.totalInputTokens,
			},
			{
				value: "totalOutputTokens",
				label: t("usageHistoryMetricOutputTokens"),
				stroke: "var(--mantine-color-green-6)",
				getValue: (point) => point.totalOutputTokens,
			},
			{
				value: "totalReasoningTokens",
				label: t("usageHistoryMetricReasoningTokens"),
				stroke: "var(--mantine-color-yellow-6)",
				getValue: (point) => point.totalReasoningTokens,
			},
			{
				value: "totalCacheReadTokens",
				label: t("usageHistoryMetricCacheRead"),
				stroke: "var(--mantine-color-cyan-6)",
				getValue: (point) => point.totalCacheReadTokens,
			},
			{
				value: "totalCacheCreationTokens",
				label: t("usageHistoryMetricCacheWrite"),
				stroke: "var(--mantine-color-teal-6)",
				getValue: (point) => point.totalCacheCreationTokens,
			},
			{
				value: "cacheHitRate",
				label: t("usageHistoryMetricCacheHitRate"),
				stroke: "var(--mantine-color-cyan-7)",
				getValue: (point) => (point.cacheHitRate == null ? null : point.cacheHitRate * 100),
			},
			{
				value: "totalCost",
				label: t("usageHistoryMetricCost"),
				stroke: "var(--mantine-color-green-7)",
				getValue: (point) => point.totalCost,
			},
			{
				value: "averageTtftMs",
				label: t("usageHistoryMetricAverageTtft"),
				stroke: "var(--mantine-color-orange-6)",
				getValue: (point) => point.averageTtftMs,
			},
			{
				value: "averageDurationMs",
				label: t("usageHistoryMetricAverageDuration"),
				stroke: "var(--mantine-color-red-6)",
				getValue: (point) => point.averageDurationMs,
			},
			{
				value: "errorCount",
				label: t("usageHistoryMetricErrors"),
				stroke: "var(--mantine-color-red-7)",
				getValue: (point) => point.errorCount,
			},
		];

		if (points.some((point) => point.meterUsage > 0)) {
			metrics.push({
				value: "meterUsage",
				label: t("usageHistoryMetricMeterUsage"),
				stroke: "var(--mantine-color-grape-6)",
				getValue: (point) => point.meterUsage,
			});
		}

		return metrics;
	}, [points, t]);

	useEffect(() => {
		if (!metricOptions.some((option) => option.value === metric)) {
			setMetric(metricOptions[0]?.value ?? "requestCount");
		}
	}, [metric, metricOptions]);

	const selectedMetric =
		metricOptions.find((option) => option.value === metric) ?? metricOptions[0];
	const values = points.map((point) => selectedMetric.getValue(point));
	const maxValue = Math.max(1, ...values.filter((value) => value != null));
	const hasSelectedMetricData = values.some((value) => value != null);
	const isIntegerMetric =
		metric !== "totalCost" &&
		metric !== "averageTtftMs" &&
		metric !== "averageDurationMs" &&
		metric !== "meterUsage" &&
		metric !== "cacheHitRate";
	const xFor = (index: number) => {
		if (points.length <= 1) return PADDING.left + CHART_INNER_WIDTH / 2;
		return PADDING.left + (index / (points.length - 1)) * CHART_INNER_WIDTH;
	};
	const yFor = (value: number) =>
		PADDING.top + CHART_INNER_HEIGHT - (value / maxValue) * CHART_INNER_HEIGHT;
	const path = buildUsageChartPath(values, xFor, yFor);

	// Compare metric (second line)
	const selectedCompareMetric = compareMetric
		? metricOptions.find((option) => option.value === compareMetric)
		: null;
	const compareValues = selectedCompareMetric
		? points.map((point) => selectedCompareMetric.getValue(point))
		: [];
	const compareMaxValue = Math.max(1, ...compareValues.filter((value) => value != null));
	const yForCompare = (value: number) =>
		PADDING.top + CHART_INNER_HEIGHT - (value / compareMaxValue) * CHART_INNER_HEIGHT;
	const comparePath = buildUsageChartPath(compareValues, xFor, yForCompare);

	const tickIndexes = getTickIndexes(points.length);
	const gridRatios = [0, 0.25, 0.5, 0.75, 1];
	const hoveredPoint = hoveredIndex == null ? null : points[hoveredIndex];
	const hoveredValue = hoveredPoint ? selectedMetric.getValue(hoveredPoint) : null;
	const hoveredCompareValue =
		hoveredPoint && selectedCompareMetric ? selectedCompareMetric.getValue(hoveredPoint) : null;
	const hoveredDisplay = formatMetricValue(
		metric,
		hoveredValue,
		hoveredPoint?.meterUnit ?? meterUnit,
		t("usageHistoryCacheHitRateEmpty"),
	);

	const getSvgPoint = (clientX: number, clientY: number) => {
		const svg = svgRef.current;
		const screenCtm = svg?.getScreenCTM();
		if (!svg || !screenCtm) return null;
		const point = svg.createSVGPoint();
		point.x = clientX;
		point.y = clientY;
		return point.matrixTransform(screenCtm.inverse());
	};

	const getLocalXForSvgX = (svgX: number) => {
		const svg = svgRef.current;
		const screenCtm = svg?.getScreenCTM();
		const containerRect = svg?.parentElement?.getBoundingClientRect();
		if (!svg || !screenCtm || !containerRect) return null;
		const point = svg.createSVGPoint();
		point.x = svgX;
		point.y = 0;
		return point.matrixTransform(screenCtm).x - containerRect.left;
	};

	const hoveredSvgX = xFor(hoveredIndex ?? 0);
	const hoveredLocalX = hoveredPoint ? getLocalXForSvgX(hoveredSvgX) : null;

	const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
		if (points.length === 0) return;
		const svgPoint = getSvgPoint(event.clientX, event.clientY);
		if (!svgPoint) return;
		const ratio = clamp((svgPoint.x - PADDING.left) / CHART_INNER_WIDTH, 0, 1);
		const nextIndex = clamp(Math.round(ratio * (points.length - 1)), 0, points.length - 1);
		setHoveredIndex(nextIndex);
	};

	return (
		<Card withBorder>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
					<Stack gap={2}>
						<Text fw={700}>{t("usageHistoryChartTitle")}</Text>
						<Text size="xs" c="dimmed">
							{t("usageHistoryChartDescription")}
						</Text>
					</Stack>
					<Group gap="xs" wrap="wrap">
						<SegmentedControl
							size="xs"
							value={granularity}
							data={[
								{ value: "hour", label: t("usageHistoryGranularityHour") },
								{ value: "day", label: t("usageHistoryGranularityDay") },
								{ value: "month", label: t("usageHistoryGranularityMonth") },
							]}
							onChange={(value) => onGranularityChange(value as UsageHistoryGranularity)}
						/>
						<Select
							size="xs"
							w={220}
							allowDeselect={false}
							value={metric}
							data={metricOptions.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
							onChange={(value) => value && setMetric(value as UsageMetricKey)}
						/>
						<Select
							size="xs"
							w={180}
							placeholder={t("usageHistoryCompareMetric")}
							clearable
							value={compareMetric || null}
							data={metricOptions
								.filter((option) => option.value !== metric)
								.map((option) => ({
									value: option.value,
									label: option.label,
								}))}
							onChange={(value) => setCompareMetric((value as UsageMetricKey) || "")}
						/>
					</Group>
				</Group>

				{(metric === "totalCost" || compareMetric === "totalCost") &&
					points.some((point) => referenceCostStatus(point, point.totalCost) !== "complete") && (
						<Text size="xs" c="orange">
							{t("usageCostIncompleteNote")}
						</Text>
					)}
				{hasUsageData &&
					((metric === "cacheHitRate" &&
						!hasSelectedMetricData &&
						compareValues.some((value) => value != null)) ||
						(compareMetric === "cacheHitRate" &&
							!compareValues.some((value) => value != null))) && (
						<Text size="xs" c="dimmed">
							{t("usageHistoryMetricCacheHitRate")}: {t("usageHistoryCacheHitRateEmpty")}
						</Text>
					)}
				{loading ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("usageHistoryChartLoading")}
						</Text>
					</Group>
				) : !hasUsageData ||
					(!hasSelectedMetricData && !compareValues.some((value) => value != null)) ? (
					<Paper withBorder p="lg">
						<Text size="sm" c="dimmed" ta="center">
							{t(
								metric === "cacheHitRate"
									? "usageHistoryCacheHitRateEmpty"
									: "usageHistoryChartEmpty",
							)}
						</Text>
					</Paper>
				) : (
					<div style={{ position: "relative" }}>
						<svg
							ref={svgRef}
							viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
							role="img"
							aria-label={t("usageHistoryChartTitle")}
							onPointerMove={handlePointerMove}
							onPointerDown={handlePointerMove}
							onPointerLeave={() => setHoveredIndex(null)}
							onPointerCancel={() => setHoveredIndex(null)}
							style={{ width: "100%", height: 280, touchAction: "none" }}
						>
							{gridRatios.map((ratio) => {
								const y = PADDING.top + CHART_INNER_HEIGHT - ratio * CHART_INNER_HEIGHT;
								let gridValue = maxValue * ratio;
								// Round to integers for count/token metrics to avoid "0.3", "0.5" labels
								if (isIntegerMetric) gridValue = Math.round(gridValue);
								const display = formatMetricValue(metric, gridValue, meterUnit);
								return (
									<g key={ratio}>
										<line
											x1={PADDING.left}
											y1={y}
											x2={PADDING.left + CHART_INNER_WIDTH}
											y2={y}
											stroke="var(--mantine-color-gray-3)"
											strokeOpacity={0.35}
										/>
										<text x={PADDING.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="gray">
											{display.compact}
										</text>
									</g>
								);
							})}
							<line
								x1={PADDING.left}
								y1={PADDING.top}
								x2={PADDING.left}
								y2={PADDING.top + CHART_INNER_HEIGHT}
								stroke="var(--mantine-color-gray-4)"
							/>
							<line
								x1={PADDING.left}
								y1={PADDING.top + CHART_INNER_HEIGHT}
								x2={PADDING.left + CHART_INNER_WIDTH}
								y2={PADDING.top + CHART_INNER_HEIGHT}
								stroke="var(--mantine-color-gray-4)"
							/>
							{tickIndexes.map((index) => {
								const x = xFor(index);
								const point = points[index];
								return (
									<text
										key={point.timestamp}
										x={x}
										y={PADDING.top + CHART_INNER_HEIGHT + 22}
										textAnchor={
											index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"
										}
										fontSize={11}
										fill="gray"
									>
										{formatTimestamp(point.timestamp, granularity)}
									</text>
								);
							})}
							<path
								d={path}
								fill="none"
								stroke={selectedMetric.stroke}
								strokeWidth={2.5}
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
							{/* Preserve isolated samples without drawing missing buckets as zero. */}
							{values.map((value, index) =>
								value != null && values[index - 1] == null && values[index + 1] == null ? (
									<circle
										key={points[index].timestamp}
										cx={xFor(index)}
										cy={yFor(value)}
										r={5}
										fill={selectedMetric.stroke}
									/>
								) : null,
							)}
							{/* Compare metric line */}
							{selectedCompareMetric && comparePath && (
								<>
									<path
										d={comparePath}
										fill="none"
										stroke={selectedCompareMetric.stroke}
										strokeWidth={2}
										strokeLinejoin="round"
										strokeLinecap="round"
										strokeDasharray="6 3"
										opacity={0.75}
									/>
									{compareValues.map((value, index) =>
										value != null &&
										compareValues[index - 1] == null &&
										compareValues[index + 1] == null ? (
											<circle
												key={points[index].timestamp}
												cx={xFor(index)}
												cy={yForCompare(value)}
												r={4}
												fill={selectedCompareMetric.stroke}
											/>
										) : null,
									)}
								</>
							)}
							{hoveredPoint ? (
								<>
									<line
										x1={hoveredSvgX}
										y1={PADDING.top}
										x2={hoveredSvgX}
										y2={PADDING.top + CHART_INNER_HEIGHT}
										stroke="var(--mantine-color-gray-7)"
										strokeWidth={1.5}
										strokeDasharray="4 3"
									/>
									{hoveredValue != null && (
										<circle
											cx={hoveredSvgX}
											cy={yFor(hoveredValue)}
											r={4.5}
											fill="var(--mantine-color-body)"
											stroke={selectedMetric.stroke}
											strokeWidth={2}
										/>
									)}
									{selectedCompareMetric && hoveredCompareValue != null && (
										<circle
											cx={hoveredSvgX}
											cy={yForCompare(hoveredCompareValue)}
											r={3.5}
											fill="var(--mantine-color-body)"
											stroke={selectedCompareMetric.stroke}
											strokeWidth={2}
										/>
									)}
								</>
							) : null}
						</svg>
						{hoveredPoint ? (
							<Paper
								withBorder
								shadow="md"
								p="xs"
								style={{
									position: "absolute",
									left:
										hoveredLocalX == null ? `${(hoveredSvgX / CHART_WIDTH) * 100}%` : hoveredLocalX,
									top: 10,
									minWidth: 190,
									pointerEvents: "none",
									transform:
										hoveredSvgX > CHART_WIDTH * 0.68 ? "translateX(-100%)" : "translateX(8px)",
									zIndex: 2,
								}}
							>
								<Stack gap={4}>
									<Text size="sm" fw={600}>
										{formatRangeTimestamp(hoveredPoint.timestamp, granularity)}
									</Text>
									<Group justify="space-between" gap="md" wrap="nowrap">
										<Text size="xs" c="dimmed">
											{selectedMetric.label}
										</Text>
										<Text size="sm" fw={700}>
											{hoveredDisplay.compact}
										</Text>
									</Group>
									<Text size="xs" c="dimmed">
										{t("usageHistoryExactValue", { value: hoveredDisplay.exact })}
									</Text>
									{selectedCompareMetric &&
										hoveredPoint &&
										(() => {
											const compareValue = selectedCompareMetric.getValue(hoveredPoint);
											const compareDisplay = formatMetricValue(
												compareMetric as UsageMetricKey,
												compareValue,
												hoveredPoint.meterUnit ?? meterUnit,
												t("usageHistoryCacheHitRateEmpty"),
											);
											return (
												<>
													<Group justify="space-between" gap="md" wrap="nowrap">
														<Text size="xs" c="dimmed">
															{selectedCompareMetric.label}
														</Text>
														<Text size="sm" fw={700} c={selectedCompareMetric.stroke}>
															{compareDisplay.compact}
														</Text>
													</Group>
													<Text size="xs" c="dimmed">
														{t("usageHistoryExactValue", { value: compareDisplay.exact })}
													</Text>
												</>
											);
										})()}
								</Stack>
							</Paper>
						) : null}
					</div>
				)}

				{data?.truncated ? (
					<Text size="xs" c="dimmed">
						{t("usageHistoryChartTruncated", {
							start: formatRangeTimestamp(data.effectiveStartDate, granularity),
							end: formatRangeTimestamp(data.effectiveEndDate, granularity),
							bucketCount: formatLocaleNumber(data.bucketCount),
							maxBuckets: formatLocaleNumber(data.maxBuckets),
						})}
					</Text>
				) : null}
			</Stack>
		</Card>
	);
}
