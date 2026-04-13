import type { UsageHistoryRecord } from "@frontend/types/usage-history";
import { Badge, Group, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconBrain, IconClock, IconInfoCircle } from "@tabler/icons-react";

interface UsageHistoryTableProps {
	records: UsageHistoryRecord[];
	loading?: boolean;
}

function formatDuration(ms: number | null): string {
	if (ms == null) return "-";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function getProviderColor(provider: string | null) {
	switch (provider) {
		case "anthropic":
			return "orange";
		case "openai":
			return "green";
			return "blue";
		case "codex":
			return "cyan";
			return "grape";
		default:
			return "gray";
	}
}

function TokensCell({ record }: { record: UsageHistoryRecord }) {
	const total =
		record.inputTokens +
		record.outputTokens +
		record.cachedInputTokens +
		record.cacheCreationInputTokens;
	return (
		<Tooltip
			multiline
			w={260}
			label={
				<Stack gap={4}>
					<Text size="xs">输入: {record.inputTokens.toLocaleString()}</Text>
					<Text size="xs">输出: {record.outputTokens.toLocaleString()}</Text>
					{record.cachedInputTokens > 0 && (
						<Text size="xs">缓存读取: {record.cachedInputTokens.toLocaleString()}</Text>
					)}
					{record.cacheCreationInputTokens > 0 && (
						<Text size="xs">缓存写入: {record.cacheCreationInputTokens.toLocaleString()}</Text>
					)}
					{record.cacheCreation5mTokens > 0 && (
						<Text size="xs">缓存写入 5m: {record.cacheCreation5mTokens.toLocaleString()}</Text>
					)}
					{record.cacheCreation1hTokens > 0 && (
						<Text size="xs">缓存写入 1h: {record.cacheCreation1hTokens.toLocaleString()}</Text>
					)}
					{record.reasoningTokens > 0 && (
						<Text size="xs">推理 tokens: {record.reasoningTokens.toLocaleString()}</Text>
					)}
				</Stack>
			}
		>
			<Group gap={6} wrap="nowrap">
				<Text size="sm" fw={500}>
					{total.toLocaleString()}
				</Text>
				<IconInfoCircle size={14} />
			</Group>
		</Tooltip>
	);
}

export function UsageHistoryTable({ records, loading }: UsageHistoryTableProps) {
	if (loading) {
		return <Text c="dimmed">加载中...</Text>;
	}
	if (records.length === 0) {
		return <Text c="dimmed">暂无请求历史</Text>;
	}

	return (
		<Table striped highlightOnHover withTableBorder withColumnBorders>
			<Table.Thead>
				<Table.Tr>
					<Table.Th>时间</Table.Th>
					<Table.Th>叙述者</Table.Th>
					<Table.Th>提供商</Table.Th>
					<Table.Th>凭证</Table.Th>
					<Table.Th>模型</Table.Th>
					<Table.Th>Tokens</Table.Th>
					<Table.Th>TTFT</Table.Th>
					<Table.Th>耗时</Table.Th>
					<Table.Th>成本</Table.Th>
				</Table.Tr>
			</Table.Thead>
			<Table.Tbody>
				{records.map((record) => (
					<Table.Tr key={record.id}>
						<Table.Td>
							<Stack gap={2}>
								<Text size="sm">{new Date(record.createdAt).toLocaleString()}</Text>
								{record.chapterTitle && (
									<Text size="xs" c="dimmed">
										{record.chapterTitle}
									</Text>
								)}
							</Stack>
						</Table.Td>
						<Table.Td>
							<Text size="sm">{record.narratorTitle ?? record.narratorId}</Text>
						</Table.Td>
						<Table.Td>
							<Badge color={getProviderColor(record.provider)} variant="light">
								{record.provider ?? "-"}
							</Badge>
						</Table.Td>
						<Table.Td>
							<Text size="sm" ff="monospace">
								{record.credentialId ?? "-"}
							</Text>
						</Table.Td>
						<Table.Td>
							<Text size="sm">{record.model ?? "-"}</Text>
						</Table.Td>
						<Table.Td>
							<TokensCell record={record} />
						</Table.Td>
						<Table.Td>
							<Group gap={4} wrap="nowrap">
								<IconClock size={14} />
								<Text size="sm">{formatDuration(record.ttftMs)}</Text>
							</Group>
						</Table.Td>
						<Table.Td>
							<Group gap={4} wrap="nowrap">
								<IconBrain size={14} />
								<Text size="sm">{formatDuration(record.durationMs)}</Text>
							</Group>
						</Table.Td>
						<Table.Td>
							<Text size="sm" fw={500} c={record.costUsd ? "green" : "dimmed"}>
								{record.costUsd != null ? `$${record.costUsd.toFixed(6)}` : "-"}
							</Text>
						</Table.Td>
					</Table.Tr>
				))}
			</Table.Tbody>
		</Table>
	);
}
