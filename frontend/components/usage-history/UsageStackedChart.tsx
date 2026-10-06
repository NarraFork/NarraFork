import { formatCompactNumber } from "@frontend/lib/compact-number";
import { formatLocaleDate, formatLocaleDateTime } from "@frontend/lib/intl-format";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import { usageDimensionLabel } from "@frontend/lib/usage-history-user";
import type {
	UsageBreakdownDimension,
	UsageBreakdownMetric,
	UsageHistoryFilters,
	UsageHistoryGranularity,
} from "@frontend/types/usage-history";
import {
	Card,
	Group,
	Loader,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { type PointerEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface UsageStackedChartProps {
	filters: UsageHistoryFilters;
}

const CHART_WIDTH = 760;
const CHART_HEIGHT = 240;
const PADDING = { left: 58, right: 18, top: 18, bottom: 48 };
const CHART_INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const CHART_INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function formatTimestamp(timestamp: string, granularity: UsageHistoryGranularity): string {
	if (granularity === "hour") {
		return formatLocaleDateTime(timestamp, { month: "short", day: "numeric", hour: "2-digit" });
	}
	if (granularity === "day") {
		return formatLocaleDate(timestamp, { month: "short", day: "numeric" });
	}
	return formatLocaleDate(timestamp, { year: "numeric", month: "short" });
}

function getTickIndexes(count: number): number[] {
	if (count <= 0) return [];
	if (count <= 3) return Array.from({ length: count }, (_, i) => i);
	return [0, Math.floor((count - 1) / 2), count - 1];
}

function formatMetricValue(metric: UsageBreakdownMetric, value: number): string {
	if (metric === "cost") {
		return formatCompactNumber(value, {
			prefix: "$",
			standardFractionDigits: 2,
			compactFractionDigits: 2,
		}).compact;
	}
	return formatCompactNumber(value).compact;
}

export function UsageStackedChart({ filters }: UsageStackedChartProps) {
	const { t } = useTranslation("common");
	const svgRef = useRef<SVGSVGElement>(null);
	const [dimension, setDimension] = useState<UsageBreakdownDimension>("provider");
	const [metric, setMetric] = useState<UsageBreakdownMetric>("tokens");
	const [granularity, setGranularity] = useState<UsageHistoryGranularity>("day");
	const [cluster, setCluster] = useState(true);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: [
			"usage-history",
			"timeseries-stacked",
			filters,
			dimension,
			metric,
			granularity,
			cluster,
		],
		queryFn: () =>
			usageHistoryApi.getTimeSeriesStacked(filters, { dimension, metric, granularity, cluster }),
		gcTime: 60_000,
	});

	const dimensionOptions = useMemo(
		() => [
			{ value: "provider", label: t("usageBreakdownDimProvider") },
			{ value: "model", label: t("usageBreakdownDimModel") },
			{ value: "kind", label: t("usageBreakdownDimKind") },
			{ value: "user", label: t("usageBreakdownDimUser") },
		],
		[t],
	);

	const metricOptions = useMemo(
		() => [
			{ value: "requests", label: t("usageBreakdownMetricRequests") },
			{ value: "tokens", label: t("usageBreakdownMetricTokens") },
			{ value: "cost", label: t("usageBreakdownMetricCost") },
			{ value: "inputTokens", label: t("usageBreakdownMetricInput") },
			{ value: "outputTokens", label: t("usageBreakdownMetricOutput") },
			{ value: "reasoningTokens", label: t("usageBreakdownMetricReasoning") },
		],
		[t],
	);

	// Compute stacked bars
	const { bars, maxValue, timestamps } = useMemo(() => {
		if (!data?.series.length || !data.timestamps.length) {
			return { bars: [], maxValue: 1, timestamps: [] };
		}

		const ts = data.timestamps;
		const stackedValues: number[][] = [];

		// For each timestamp, compute stacked values
		for (let i = 0; i < ts.length; i++) {
			const stack: number[] = [];
			let cumulative = 0;
			for (const series of data.series) {
				const value = series.data[i]?.value ?? 0;
				stack.push(cumulative);
				cumulative += value;
			}
			stack.push(cumulative); // Final top
			stackedValues.push(stack);
		}

		const maxVal = Math.max(1, ...stackedValues.map((s) => s[s.length - 1]));

		return { bars: stackedValues, maxValue: maxVal, timestamps: ts };
	}, [data]);

	const hasData = bars.length > 0 && bars.some((stack) => stack[stack.length - 1] > 0);
	const tickIndexes = getTickIndexes(timestamps.length);
	const barWidth = timestamps.length > 0 ? CHART_INNER_WIDTH / timestamps.length : 0;
	const gridRatios = [0, 0.25, 0.5, 0.75, 1];

	const getSvgPoint = (clientX: number) => {
		const svg = svgRef.current;
		const screenCtm = svg?.getScreenCTM();
		if (!svg || !screenCtm) return null;
		const point = svg.createSVGPoint();
		point.x = clientX;
		point.y = 0;
		return point.matrixTransform(screenCtm.inverse());
	};

	const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
		if (timestamps.length === 0) return;
		const svgPoint = getSvgPoint(event.clientX);
		if (!svgPoint) return;
		const ratio = clamp((svgPoint.x - PADDING.left) / CHART_INNER_WIDTH, 0, 1);
		const nextIndex = clamp(Math.round(ratio * (timestamps.length - 1)), 0, timestamps.length - 1);
		setHoveredIndex(nextIndex);
	};

	const hoveredTimestamp = hoveredIndex != null ? timestamps[hoveredIndex] : null;

	return (
		<Card withBorder>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
					<Stack gap={2}>
						<Text fw={700}>{t("usageStackedTitle")}</Text>
						<Text size="xs" c="dimmed">
							{t("usageStackedDescription")}
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
							onChange={(v) => setGranularity(v as UsageHistoryGranularity)}
						/>
						<Select
							size="xs"
							w={120}
							allowDeselect={false}
							value={dimension}
							data={dimensionOptions}
							onChange={(v) => v && setDimension(v as UsageBreakdownDimension)}
						/>
						<Select
							size="xs"
							w={140}
							allowDeselect={false}
							value={metric}
							data={metricOptions}
							onChange={(v) => v && setMetric(v as UsageBreakdownMetric)}
						/>
						{dimension === "model" && (
							<Switch
								size="xs"
								label={t("usageBreakdownCluster")}
								checked={cluster}
								onChange={(e) => setCluster(e.currentTarget.checked)}
							/>
						)}
					</Group>
				</Group>

				{isLoading ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("usageStackedLoading")}
						</Text>
					</Group>
				) : !hasData ? (
					<Paper withBorder p="lg">
						<Text size="sm" c="dimmed" ta="center">
							{t("usageStackedEmpty")}
						</Text>
					</Paper>
				) : (
					<div style={{ position: "relative" }}>
						<svg
							ref={svgRef}
							viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
							role="img"
							aria-label={t("usageStackedTitle")}
							onPointerMove={handlePointerMove}
							onPointerLeave={() => setHoveredIndex(null)}
							onPointerCancel={() => setHoveredIndex(null)}
							style={{ width: "100%", height: 260, touchAction: "none" }}
						>
							{/* Grid lines */}
							{gridRatios.map((ratio) => {
								const y = PADDING.top + CHART_INNER_HEIGHT - ratio * CHART_INNER_HEIGHT;
								const gridValue = maxValue * ratio;
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
											{formatMetricValue(metric, gridValue)}
										</text>
									</g>
								);
							})}

							{/* Axes */}
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

							{/* Stacked bars */}
							{bars.map((stack, barIndex) => {
								const x = PADDING.left + barIndex * barWidth;
								const effectiveBarWidth = Math.max(barWidth - 1, 1);
								const isHovered = hoveredIndex === barIndex;
								const ts = timestamps[barIndex];

								return data?.series.map((series, seriesIndex) => {
									const bottom = stack[seriesIndex];
									const top = stack[seriesIndex + 1];
									const value = top - bottom;
									if (value <= 0) return null;

									const y1 =
										PADDING.top + CHART_INNER_HEIGHT - (top / maxValue) * CHART_INNER_HEIGHT;
									const y2 =
										PADDING.top + CHART_INNER_HEIGHT - (bottom / maxValue) * CHART_INNER_HEIGHT;
									const height = Math.max(y2 - y1, 0.5);

									return (
										<rect
											key={`${ts}-${series.label}`}
											x={x}
											y={y1}
											width={effectiveBarWidth}
											height={height}
											fill={series.color}
											opacity={hoveredIndex == null || isHovered ? 0.85 : 0.4}
											style={{ transition: "opacity 0.1s" }}
										/>
									);
								});
							})}

							{/* Hover indicator line */}
							{hoveredIndex != null && (
								<line
									x1={PADDING.left + hoveredIndex * barWidth + barWidth / 2}
									y1={PADDING.top}
									x2={PADDING.left + hoveredIndex * barWidth + barWidth / 2}
									y2={PADDING.top + CHART_INNER_HEIGHT}
									stroke="var(--mantine-color-gray-7)"
									strokeWidth={1}
									strokeDasharray="4 3"
								/>
							)}

							{/* X-axis labels */}
							{tickIndexes.map((index) => {
								const x = PADDING.left + index * barWidth + barWidth / 2;
								return (
									<text
										key={timestamps[index]}
										x={x}
										y={PADDING.top + CHART_INNER_HEIGHT + 22}
										textAnchor={
											index === 0 ? "start" : index === timestamps.length - 1 ? "end" : "middle"
										}
										fontSize={11}
										fill="gray"
									>
										{formatTimestamp(timestamps[index], granularity)}
									</text>
								);
							})}
						</svg>

						{/* Tooltip */}
						{hoveredTimestamp && data && (
							<Paper
								withBorder
								shadow="md"
								p="xs"
								style={{
									position: "absolute",
									left: `${((PADDING.left + (hoveredIndex ?? 0) * barWidth + barWidth / 2) / CHART_WIDTH) * 100}%`,
									top: 10,
									minWidth: 160,
									pointerEvents: "none",
									transform:
										(hoveredIndex ?? 0) > timestamps.length * 0.65
											? "translateX(-100%)"
											: "translateX(8px)",
									zIndex: 2,
								}}
							>
								<Stack gap={4}>
									<Text size="sm" fw={600}>
										{formatTimestamp(hoveredTimestamp, granularity)}
									</Text>
									{data.series.map((series) => {
										const value = series.data[hoveredIndex ?? 0]?.value ?? 0;
										if (value === 0) return null;
										return (
											<Group key={series.label} justify="space-between" gap="md" wrap="nowrap">
												<Group gap={6} wrap="nowrap">
													<div
														style={{
															width: 8,
															height: 8,
															borderRadius: 2,
															backgroundColor: series.color,
														}}
													/>
													<Text size="xs" c="dimmed" lineClamp={1}>
														{usageDimensionLabel(
															series.label,
															dimension,
															t("usageHistoryUnattributed"),
														)}
													</Text>
												</Group>
												<Text size="xs" fw={600}>
													{formatMetricValue(metric, value)}
												</Text>
											</Group>
										);
									})}
								</Stack>
							</Paper>
						)}

						{/* Legend */}
						{data && (
							<Group gap="md" mt="xs" justify="center" wrap="wrap">
								{data.series.map((series) => (
									<Group key={series.label} gap={6} wrap="nowrap">
										<div
											style={{
												width: 10,
												height: 10,
												borderRadius: 2,
												backgroundColor: series.color,
											}}
										/>
										<Text size="xs">
											{usageDimensionLabel(series.label, dimension, t("usageHistoryUnattributed"))}
										</Text>
									</Group>
								))}
							</Group>
						)}
					</div>
				)}
			</Stack>
		</Card>
	);
}
