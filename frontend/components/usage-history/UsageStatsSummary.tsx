import {
	formatCompactNumber,
	formatDuration,
	formatExactDuration,
} from "@frontend/lib/compact-number";
import { formatReferenceCost, referenceCostStatus } from "@frontend/lib/usage-cost";
import type { UsageHistoryStats } from "@frontend/types/usage-history";
import { Card, Grid, Group, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconActivity,
	IconBolt,
	IconBrain,
	IconClock,
	IconCoin,
	IconDatabase,
	IconFileText,
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

						{/* 主数字行 */}
						<Group gap="xl" wrap="wrap">
							<Stack gap={2}>
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

							<Stack gap={2}>
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

							<Stack gap={2}>
								<Group gap={6}>
									<IconCoin size={14} color="var(--mantine-color-green-6)" />
									<Text size="xs" c="dimmed">
										{t("usageHistoryStatTotalCost")}
									</Text>
								</Group>
								<Text fw={700} size="lg">
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
							</Stack>
						</Group>

						{/* 细分行 */}
						<Group gap="md" wrap="wrap">
							<Text size="xs" c="dimmed">
								{t("usageHistoryTokenInput")} {inputTokens.compact}
								{inputTokens.isCompact ? ` (${inputTokens.exact})` : ""}
							</Text>
							<Text size="xs" c="dimmed">
								{t("usageHistoryTokenOutput")} {outputTokens.compact}
								{outputTokens.isCompact ? ` (${outputTokens.exact})` : ""}
							</Text>
							<Text size="xs" c="dimmed">
								{t("usageHistoryStatCacheRead")} {cacheReadTokens.compact}
								{cacheReadTokens.isCompact ? ` (${cacheReadTokens.exact})` : ""}
							</Text>
							<Tooltip label={cacheWriteTooltip} multiline>
								<Text size="xs" c="dimmed" style={{ cursor: "help" }}>
									{t("usageHistoryStatCacheWrite")} {cacheCreationTokens.compact}
									{cacheCreationTokens.isCompact ? ` (${cacheCreationTokens.exact})` : ""}
								</Text>
							</Tooltip>
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
							<Stack gap={2}>
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

							<Stack gap={2}>
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

							<Stack gap={2}>
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
