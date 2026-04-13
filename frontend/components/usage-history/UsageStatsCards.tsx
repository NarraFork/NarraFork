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

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function StatCard({
	icon,
	label,
	value,
	subtitle,
}: {
	icon: ReactNode;
	label: string;
	value: string;
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
				{subtitle ? (
					<Text size="xs" c="dimmed">
						{subtitle}
					</Text>
				) : null}
			</Stack>
		</Card>
	);
}

export function UsageStatsCards({ stats }: { stats: UsageHistoryStats }) {
	return (
		<SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
			<StatCard
				icon={<IconFileText size={18} />}
				label="请求数"
				value={stats.totalRequests.toLocaleString()}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label="总 Tokens"
				value={stats.totalTokens.toLocaleString()}
				subtitle={`输入 ${stats.totalInputTokens.toLocaleString()} · 输出 ${stats.totalOutputTokens.toLocaleString()}`}
			/>
			<StatCard
				icon={<IconBolt size={18} />}
				label="平均 TTFT"
				value={formatDuration(stats.averageTtftMs)}
			/>
			<StatCard
				icon={<IconClock size={18} />}
				label="平均耗时"
				value={formatDuration(stats.averageDurationMs)}
			/>
			<StatCard
				icon={<IconCoin size={18} />}
				label="总成本"
				value={`$${stats.totalCost.toFixed(4)}`}
			/>
			<StatCard
				icon={<IconBrain size={18} />}
				label="推理 Tokens"
				value={stats.totalReasoningTokens.toLocaleString()}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label="缓存读取"
				value={stats.totalCacheReadTokens.toLocaleString()}
			/>
			<StatCard
				icon={<IconDatabase size={18} />}
				label="缓存写入"
				value={stats.totalCacheCreationTokens.toLocaleString()}
				subtitle={`5m ${stats.totalCacheCreation5mTokens.toLocaleString()} · 1h ${stats.totalCacheCreation1hTokens.toLocaleString()}`}
			/>
		</SimpleGrid>
	);
}
