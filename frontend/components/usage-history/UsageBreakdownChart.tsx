import { formatCompactNumber } from "@frontend/lib/compact-number";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import { usageDimensionLabel } from "@frontend/lib/usage-history-user";
import type {
	UsageBreakdownDimension,
	UsageBreakdownMetric,
	UsageHistoryFilters,
} from "@frontend/types/usage-history";
import { Card, Group, Loader, Paper, Select, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface UsageBreakdownChartProps {
	filters: UsageHistoryFilters;
}

const DONUT_SIZE = 180;
const DONUT_RADIUS = 72;
const DONUT_INNER_RADIUS = 48;
const CENTER = DONUT_SIZE / 2;

const DONUT_COLORS = [
	"var(--mantine-color-indigo-6)",
	"var(--mantine-color-cyan-6)",
	"var(--mantine-color-green-6)",
	"var(--mantine-color-orange-6)",
	"var(--mantine-color-violet-6)",
	"var(--mantine-color-red-6)",
	"var(--mantine-color-teal-6)",
	"var(--mantine-color-yellow-6)",
	"var(--mantine-color-pink-6)",
	"var(--mantine-color-blue-6)",
];

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number) {
	return {
		x: cx + r * Math.cos(angleRad),
		y: cy + r * Math.sin(angleRad),
	};
}

function describeArc(
	cx: number,
	cy: number,
	outerR: number,
	innerR: number,
	startAngle: number,
	endAngle: number,
): string {
	const sweep = endAngle - startAngle;
	const largeArc = sweep > Math.PI ? 1 : 0;

	const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
	const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
	const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
	const innerEnd = polarToCartesian(cx, cy, innerR, endAngle);

	return [
		`M ${outerStart.x} ${outerStart.y}`,
		`A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
		`L ${innerEnd.x} ${innerEnd.y}`,
		`A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
		"Z",
	].join(" ");
}

function formatMetricDisplay(metric: UsageBreakdownMetric, value: number): string {
	if (metric === "cost") {
		return formatCompactNumber(value, {
			prefix: "$",
			standardFractionDigits: 2,
			compactFractionDigits: 2,
			exactFractionDigits: 4,
		}).compact;
	}
	return formatCompactNumber(value).compact;
}

export function UsageBreakdownChart({ filters }: UsageBreakdownChartProps) {
	const { t } = useTranslation("common");
	const [dimension, setDimension] = useState<UsageBreakdownDimension>("provider");
	const [metric, setMetric] = useState<UsageBreakdownMetric>("tokens");
	const [cluster, setCluster] = useState(true);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: ["usage-history", "breakdown", filters, dimension, metric, cluster],
		queryFn: () => usageHistoryApi.getBreakdown(filters, { dimension, metric, cluster }),
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

	const arcs = useMemo(() => {
		if (!data?.entries.length) return [];
		const entries = data.entries;
		const total = data.total;
		if (total === 0) return [];

		let currentAngle = -Math.PI / 2; // Start from top
		return entries.map((entry, index) => {
			const sweep = (entry.value / total) * Math.PI * 2;
			const startAngle = currentAngle;
			const endAngle = currentAngle + sweep;
			currentAngle = endAngle;
			return {
				entry,
				startAngle,
				endAngle,
				color: DONUT_COLORS[index % DONUT_COLORS.length],
			};
		});
	}, [data]);

	const hoveredEntry = hoveredIndex != null ? data?.entries[hoveredIndex] : null;

	return (
		<Card withBorder>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
					<Stack gap={2}>
						<Text fw={700}>{t("usageBreakdownTitle")}</Text>
						<Text size="xs" c="dimmed">
							{t("usageBreakdownDescription")}
						</Text>
					</Stack>
					<Group gap="xs" wrap="wrap">
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
							{t("usageBreakdownLoading")}
						</Text>
					</Group>
				) : !data?.entries.length ? (
					<Paper withBorder p="lg">
						<Text size="sm" c="dimmed" ta="center">
							{t("usageBreakdownEmpty")}
						</Text>
					</Paper>
				) : (
					<Group align="flex-start" gap="lg" wrap="wrap">
						<div style={{ position: "relative" }}>
							<svg
								width={DONUT_SIZE}
								height={DONUT_SIZE}
								viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
								role="img"
								aria-label={t("usageBreakdownTitle")}
							>
								{arcs.map((arc, index) => {
									const isHovered = hoveredIndex === index;
									// Skip tiny arcs (less than 0.5%)
									if (arc.endAngle - arc.startAngle < 0.005) return null;
									return (
										<path
											key={arc.entry.label}
											d={describeArc(
												CENTER,
												CENTER,
												isHovered ? DONUT_RADIUS + 4 : DONUT_RADIUS,
												isHovered ? DONUT_INNER_RADIUS - 2 : DONUT_INNER_RADIUS,
												arc.startAngle,
												arc.endAngle,
											)}
											fill={arc.color}
											opacity={hoveredIndex == null || isHovered ? 1 : 0.5}
											onPointerEnter={() => setHoveredIndex(index)}
											onPointerLeave={() => setHoveredIndex(null)}
											style={{ cursor: "pointer", transition: "opacity 0.15s" }}
										/>
									);
								})}
								{/* Center text */}
								<text
									x={CENTER}
									y={CENTER - 6}
									textAnchor="middle"
									fontSize={12}
									fill="var(--mantine-color-dimmed)"
								>
									{hoveredEntry
										? usageDimensionLabel(
												hoveredEntry.label,
												dimension,
												t("usageHistoryUnattributed"),
											)
										: t("usageBreakdownTotal")}
								</text>
								<text
									x={CENTER}
									y={CENTER + 12}
									textAnchor="middle"
									fontSize={14}
									fontWeight={700}
									fill="var(--mantine-color-text)"
								>
									{hoveredEntry
										? formatMetricDisplay(metric, hoveredEntry.value)
										: formatMetricDisplay(metric, data.total)}
								</text>
							</svg>
						</div>

						{/* Legend */}
						<Stack gap={4} style={{ flex: 1, minWidth: 160 }}>
							{data.entries.map((entry, index) => (
								<Group
									key={entry.label}
									gap="xs"
									wrap="nowrap"
									onPointerEnter={() => setHoveredIndex(index)}
									onPointerLeave={() => setHoveredIndex(null)}
									style={{
										cursor: "pointer",
										opacity: hoveredIndex == null || hoveredIndex === index ? 1 : 0.5,
										transition: "opacity 0.15s",
									}}
								>
									<div
										style={{
											width: 10,
											height: 10,
											borderRadius: 2,
											backgroundColor: DONUT_COLORS[index % DONUT_COLORS.length],
											flexShrink: 0,
										}}
									/>
									<Text size="xs" style={{ flex: 1 }} lineClamp={1}>
										{usageDimensionLabel(entry.label, dimension, t("usageHistoryUnattributed"))}
									</Text>
									<Text size="xs" fw={500} style={{ flexShrink: 0 }}>
										{formatMetricDisplay(metric, entry.value)}
									</Text>
									<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
										{entry.percentage.toFixed(1)}%
									</Text>
								</Group>
							))}
						</Stack>
					</Group>
				)}
			</Stack>
		</Card>
	);
}
