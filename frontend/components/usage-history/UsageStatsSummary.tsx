import {
	formatCompactNumber,
	formatDuration,
	formatExactDuration,
} from "@frontend/lib/compact-number";
import { formatReferenceCost, referenceCostStatus } from "@frontend/lib/usage-cost";
import type { UsageHistoryStats } from "@frontend/types/usage-history";
import { Card, Grid, Group, Stack, Text } from "@mantine/core";
import {
	IconActivity,
	IconBolt,
	IconBrain,
	IconClock,
	IconCoin,
	IconDatabase,
	IconFileText,
	IconPercentage,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export function UsageStatsSummary({ stats }: { stats: UsageHistoryStats }) {
	const { t } = useTranslation("common");
	const totalRequests = formatCompactNumber(stats.totalRequests);
	const totalTokens = formatCompactNumber(stats.totalTokens);
	const inputTokens = formatCompactNumber(stats.totalInputTokens);
	const outputTokens = formatCompactNumber(stats.totalOutputTokens);
	const totalCost = formatCompactNumber(stats.totalCost, {
		prefix: "$",
		standardFractionDigits: 4,
		compactFractionDigits: 2,
		exactFractionDigits: 6,
	});
	const reasoningTokens = formatCompactNumber(stats.totalReasoningTokens);
	const cacheReadTokens = formatCompactNumber(stats.totalCacheReadTokens);
	const cacheCreationTokens = formatCompactNumber(stats.totalCacheCreationTokens);
	const cacheCreation5mTokens = formatCompactNumber(stats.totalCacheCreation5mTokens);
	const cacheCreation1hTokens = formatCompactNumber(stats.totalCacheCreation1hTokens);

	const cacheWriteTooltip = `5m: ${cacheCreation5mTokens.compact} (${cacheCreation5mTokens.exact}) · 1h: ${cacheCreation1hTokens.compact} (${cacheCreation1hTokens.exact})`;

	// 服务端仅聚合有缓存读取的请求；普通 token 总量不能作为该比率的分母。
	const cacheHitRatePercent = stats.cacheHitRate == null ? null : stats.cacheHitRate * 100;
	const cacheHitRate =
		cacheHitRatePercent === null
			? t("usageHistoryCacheHitRateEmpty")
			: `${Math.round(cacheHitRatePercent)}%`;
	const cacheHitRateExact =
		cacheHitRatePercent === null ? null : `${cacheHitRatePercent.toFixed(2)}%`;

	return (
		<Grid>
			{/* 左卡：用量概览 */}
			<Grid.Col span={{ base: 12, md: 7 }}>
				<Card withBorder h="100%">
					<Stack gap="sm">
						<Group gap="xs">
							<IconActivity size={16} color="var(--mantine-color-indigo-6)" />
							<Text size="sm" fw={600}>
								{t("usageStatsSummaryOverview")}
							</Text>
						</Group>

						{/* 主数字行：四类 token + 缓存命中率 + 请求数（格式一致：图标+标签 → 大号数值 → 精确值） */}
						<Group gap="xl" wrap="wrap">
							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconDatabase size={14} color="var(--mantine-color-blue-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatTotalTokens")}
									</Text>
								</Group>
								<Text fw={700} size="xl">
									{totalTokens.compact}
								</Text>
								{totalTokens.isCompact && (
									<Text size="xs" c="dimmed">
										{totalTokens.exact}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconBolt size={14} color="var(--mantine-color-violet-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryTokenInput")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{inputTokens.compact}
								</Text>
								{inputTokens.isCompact && (
									<Text size="xs" c="dimmed">
										{inputTokens.exact}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconActivity size={14} color="var(--mantine-color-green-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryTokenOutput")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{outputTokens.compact}
								</Text>
								{outputTokens.isCompact && (
									<Text size="xs" c="dimmed">
										{outputTokens.exact}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconDatabase size={14} color="var(--mantine-color-cyan-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatCacheRead")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{cacheReadTokens.compact}
								</Text>
								{cacheReadTokens.isCompact && (
									<Text size="xs" c="dimmed">
										{cacheReadTokens.exact}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconDatabase size={14} color="var(--mantine-color-teal-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatCacheWrite")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{cacheCreationTokens.compact}
								</Text>
								{cacheCreationTokens.isCompact ? (
									<Text size="xs" c="dimmed">
										{cacheCreationTokens.exact}
									</Text>
								) : (
									<Text size="xs" c="dimmed">
										{cacheWriteTooltip}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconPercentage size={14} color="var(--mantine-color-yellow-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatCacheHitRate")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{cacheHitRate}
								</Text>
								{cacheHitRateExact && (
									<Text size="xs" c="dimmed">
										{cacheHitRateExact}
									</Text>
								)}
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconFileText size={14} color="var(--mantine-color-gray-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatRequests")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{totalRequests.compact}
								</Text>
								{totalRequests.isCompact && (
									<Text size="xs" c="dimmed">
										{totalRequests.exact}
									</Text>
								)}
							</Stack>
						</Group>

						{/* 细分行：参考成本 */}
						<Group gap="md" wrap="wrap">
							<Group gap={6}>
								<IconCoin size={14} color="var(--mantine-color-green-6)" />
								<Text size="xs" c="dimmed">
									{t("usageHistoryStatTotalCost")}
								</Text>
							</Group>
							<Text size="xs" c="dimmed">
								{formatReferenceCost(
									stats,
									stats.totalCost,
									{ unknown: t("usageCostUnknown"), partial: t("usageCostPartial") },
									totalCost.compact,
								)}
							</Text>
							{referenceCostStatus(stats, stats.totalCost) !== "complete" && (
								<Text size="xs" c="orange">
									{t("usageCostIncompleteNote")}
								</Text>
							)}
							{totalCost.isCompact &&
								referenceCostStatus(stats, stats.totalCost) === "complete" && (
									<Text size="xs" c="dimmed">
										{totalCost.exact}
									</Text>
								)}
						</Group>
					</Stack>
				</Card>
			</Grid.Col>

			{/* 右卡：性能 */}
			<Grid.Col span={{ base: 12, md: 5 }}>
				<Card withBorder h="100%">
					<Stack gap="sm">
						<Group gap="xs">
							<IconClock size={16} color="var(--mantine-color-orange-6)" />
							<Text size="sm" fw={600}>
								{t("usageStatsSummaryPerformance")}
							</Text>
						</Group>

						{/* 主数字行 */}
						<Group gap="xl" wrap="wrap">
							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconClock size={14} color="var(--mantine-color-orange-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatAverageDuration")}
									</Text>
								</Group>
								<Text fw={700} size="xl">
									{formatDuration(stats.averageDurationMs)}
								</Text>
								<Text size="xs" c="dimmed">
									{formatExactDuration(stats.averageDurationMs)}
								</Text>
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconBolt size={14} color="var(--mantine-color-yellow-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatAverageTtft")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{formatDuration(stats.averageTtftMs)}
								</Text>
								<Text size="xs" c="dimmed">
									{formatExactDuration(stats.averageTtftMs)}
								</Text>
							</Stack>

							<Stack gap={2} align="center">
								<Group gap={6}>
									<IconBrain size={14} color="var(--mantine-color-violet-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatReasoningTokens")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
									{reasoningTokens.compact}
								</Text>
								{reasoningTokens.isCompact && (
									<Text size="xs" c="dimmed">
										{reasoningTokens.exact}
									</Text>
								)}
							</Stack>
						</Group>
					</Stack>
				</Card>
			</Grid.Col>
		</Grid>
	);
}
