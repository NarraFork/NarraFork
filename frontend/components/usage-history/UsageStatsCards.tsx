import {
	type CompactNumberValue,
	formatCompactNumber,
	formatDuration,
	formatExactDuration,
} from "@frontend/lib/compact-number";
import type { UsageHistoryStats } from "@frontend/types/usage-history";
import { Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import {
	IconBolt,
	IconBrain,
	IconClock,
	IconCoin,
	IconDatabase,
	IconFileText,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

function StatCard({
	icon,
	label,
	value,
	exactValue,
	subtitle,
}: {
	icon: ReactNode;
	label: string;
	value: string;
	exactValue?: string;
	subtitle?: string;
}) {
	return (
		<Card withBorder>
			<Stack gap="xs">
				<Group gap="xs">
					{icon}
					<Text size="sm" c="dimmed">
						{label}
					</Text>
				</Group>
				<Text fw={700} size="xl">
					{value}
				</Text>
				{exactValue ? (
					<Text size="xs" c="dimmed">
						{exactValue}
					</Text>
				) : null}
				{subtitle ? (
					<Text size="xs" c="dimmed">
						{subtitle}
					</Text>
				) : null}
			</Stack>
		</Card>
	);
}

function exactLine(
	t: (key: string, options?: Record<string, string>) => string,
	value: CompactNumberValue,
): string | undefined {
	return value.isCompact ? t("usageHistoryExactValue", { value: value.exact }) : undefined;
}

export function UsageStatsCards({ stats }: { stats: UsageHistoryStats }) {
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

	return (
		<SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
			<StatCard
				icon={<IconFileText size={18} />}
				label={t("usageHistoryStatRequests")}
				value={totalRequests.compact}
				exactValue={exactLine(t, totalRequests)}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label={t("usageHistoryStatTotalTokens")}
				value={totalTokens.compact}
				exactValue={exactLine(t, totalTokens)}
				subtitle={`${t("usageHistoryTokenInput")} ${inputTokens.compact} (${inputTokens.exact}) · ${t("usageHistoryTokenOutput")} ${outputTokens.compact} (${outputTokens.exact})`}
			/>
			<StatCard
				icon={<IconBolt size={18} />}
				label={t("usageHistoryStatAverageTtft")}
				value={formatDuration(stats.averageTtftMs)}
				exactValue={t("usageHistoryExactValue", {
					value: formatExactDuration(stats.averageTtftMs),
				})}
			/>
			<StatCard
				icon={<IconClock size={18} />}
				label={t("usageHistoryStatAverageDuration")}
				value={formatDuration(stats.averageDurationMs)}
				exactValue={t("usageHistoryExactValue", {
					value: formatExactDuration(stats.averageDurationMs),
				})}
			/>
			<StatCard
				icon={<IconCoin size={18} />}
				label={t("usageHistoryStatTotalCost")}
				value={totalCost.compact}
				exactValue={exactLine(t, totalCost)}
			/>
			<StatCard
				icon={<IconBrain size={18} />}
				label={t("usageHistoryStatReasoningTokens")}
				value={reasoningTokens.compact}
				exactValue={exactLine(t, reasoningTokens)}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label={t("usageHistoryStatCacheRead")}
				value={cacheReadTokens.compact}
				exactValue={exactLine(t, cacheReadTokens)}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label={t("usageHistoryStatCacheWrite")}
				value={cacheCreationTokens.compact}
				exactValue={exactLine(t, cacheCreationTokens)}
				subtitle={`5m ${cacheCreation5mTokens.compact} (${cacheCreation5mTokens.exact}) · 1h ${cacheCreation1hTokens.compact} (${cacheCreation1hTokens.exact})`}
			/>
		</SimpleGrid>
	);
}
