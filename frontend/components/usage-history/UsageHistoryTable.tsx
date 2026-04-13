import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import type { UsageHistoryRecord } from "@frontend/types/usage-history";
import {
	ActionIcon,
	Badge,
	Code,
	Group,
	Loader,
	Modal,
	Stack,
	Table,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	IconBrain,
	IconClock,
	IconCodeDots,
	IconInfoCircle,
	IconToggleLeft,
	IconToggleRight,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

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
	const { t } = useTranslation("common");
	const [showNarratorId, setShowNarratorId] = useState(false);
	const [showCredentialId, setShowCredentialId] = useState(false);
	const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

	const { data: selectedRecord, isLoading: isLoadingRawDump } = useQuery({
		queryKey: ["usage-history", "detail", selectedRecordId],
		queryFn: () => usageHistoryApi.getRecord(selectedRecordId as string),
		enabled: !!selectedRecordId,
	});

	if (loading) {
		return <Text c="dimmed">{t("loading", "加载中...")}</Text>;
	}
	if (records.length === 0) {
		return <Text c="dimmed">{t("noData", "暂无数据")}</Text>;
	}

	return (
		<>
			<Table striped highlightOnHover withTableBorder withColumnBorders>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>{t("usageHistoryTableTime")}</Table.Th>
						<Table.Th>
							<Group gap={8} wrap="nowrap">
								{t("usageHistoryTableNarrator")}
								<Tooltip
									label={
										showNarratorId ? t("usageHistoryToggleShowName") : t("usageHistoryToggleShowId")
									}
								>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="gray"
										onClick={() => setShowNarratorId(!showNarratorId)}
									>
										{showNarratorId ? <IconToggleRight size={16} /> : <IconToggleLeft size={16} />}
									</ActionIcon>
								</Tooltip>
							</Group>
						</Table.Th>
						<Table.Th>{t("usageHistoryTableProvider")}</Table.Th>
						<Table.Th>
							<Group gap={8} wrap="nowrap">
								{t("usageHistoryTableCredential")}
								<Tooltip
									label={
										showCredentialId
											? t("usageHistoryToggleShowName")
											: t("usageHistoryToggleShowId")
									}
								>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="gray"
										onClick={() => setShowCredentialId(!showCredentialId)}
									>
										{showCredentialId ? (
											<IconToggleRight size={16} />
										) : (
											<IconToggleLeft size={16} />
										)}
									</ActionIcon>
								</Tooltip>
							</Group>
						</Table.Th>
						<Table.Th>{t("usageHistoryTableModel")}</Table.Th>
						<Table.Th>{t("usageHistoryTableTokens")}</Table.Th>
						<Table.Th>{t("usageHistoryTableTTFT")}</Table.Th>
						<Table.Th>{t("usageHistoryTableDuration")}</Table.Th>
						<Table.Th>{t("usageHistoryTableCost")}</Table.Th>
						<Table.Th>{t("usageHistoryTableActions")}</Table.Th>
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
								<Text size="sm" ff={showNarratorId ? "monospace" : undefined}>
									{showNarratorId ? record.narratorId : (record.narratorTitle ?? record.narratorId)}
								</Text>
							</Table.Td>
							<Table.Td>
								<Badge color={getProviderColor(record.provider)} variant="light">
									{record.provider ?? "-"}
								</Badge>
							</Table.Td>
							<Table.Td>
								<Text
									size="sm"
									ff={showCredentialId || !record.credentialName ? "monospace" : undefined}
								>
									{showCredentialId
										? record.credentialId || "-"
										: record.credentialName || record.credentialId || "-"}
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
									<Text size="sm" fw={500} c={record.meterUsage ? "blue" : "dimmed"}>
										{record.meterUsage != null
											? `${record.meterUsage.toFixed(2)} ${record.meterUnit || "credits"}`
											: "-"}
									</Text>
								) : (
									<Text size="sm" fw={500} c={record.costUsd ? "green" : "dimmed"}>
										{record.costUsd != null ? `$${record.costUsd.toFixed(6)}` : "-"}
									</Text>
								)}
							</Table.Td>
							<Table.Td>
								{record.hasRawDump ? (
									<Tooltip label={t("usageHistoryViewRawDump")}>
										<ActionIcon
											variant="subtle"
											color="gray"
											onClick={() => setSelectedRecordId(record.id)}
										>
											<IconCodeDots size={16} />
										</ActionIcon>
									</Tooltip>
								) : (
									<Text size="sm" c="dimmed">
										-
									</Text>
								)}
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>

			<Modal
				opened={!!selectedRecordId}
				onClose={() => setSelectedRecordId(null)}
				title={t("usageHistoryRawDumpTitle")}
				size="xl"
				centered
			>
				{isLoadingRawDump ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("usageHistoryRawDumpLoading")}
						</Text>
					</Group>
				) : selectedRecord?.rawDump ? (
					<Code
						block
						style={{
							maxHeight: "70vh",
							overflow: "auto",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							fontSize: 12,
						}}
					>
						{JSON.stringify(selectedRecord.rawDump, null, 2)}
					</Code>
				) : (
					<Text size="sm" c="dimmed">
						{t("usageHistoryRawDumpEmpty")}
					</Text>
				)}
			</Modal>
		</>
	);
}
