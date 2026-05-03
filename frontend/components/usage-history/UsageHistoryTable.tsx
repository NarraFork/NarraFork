import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import type { UsageHistoryRecord } from "@frontend/types/usage-history";
import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Code,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	SimpleGrid,
	Stack,
	Table,
	Text,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconArrowDown,
	IconArrowUp,
	IconBrain,
	IconClock,
	IconCodeDots,
	IconDeviceFloppy,
	IconExclamationCircle,
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

function getKindLabel(
	t: (key: string, options: { defaultValue: string }) => string,
	kind: string,
): string {
	return t(`usageHistoryKind_${kind}`, { defaultValue: kind });
}

function formatTokenCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}K`;
	}
	return count.toLocaleString();
}

function TokensCell({
	record,
	compact = false,
}: {
	record: UsageHistoryRecord;
	compact?: boolean;
}) {
	const { t } = useTranslation("common");

	// For OpenAI/Codex: input_tokens includes cached_tokens, so we need to subtract
	// For Anthropic: input_tokens already excludes cache_read_input_tokens
	const isOpenAIStyle = record.provider === "codex" || record.provider === "openai";

	// Calculate actual billed input tokens (non-cached)
	const actualInputTokens = isOpenAIStyle
		? record.inputTokens - record.cachedInputTokens
		: record.inputTokens;

	const iconSize = compact ? 12 : 14;
	const textSize = compact ? "xs" : "sm";

	return (
		<Stack gap={compact ? 2 : 4} style={{ minWidth: compact ? undefined : 100 }}>
			<Group gap={compact ? 8 : 12} wrap="nowrap">
				<Group gap={4} wrap="nowrap">
					<IconArrowUp size={iconSize} color="var(--mantine-color-violet-6)" />
					<Text size={textSize} fw={500}>
						{formatTokenCount(actualInputTokens)}
					</Text>
				</Group>
				<Group gap={4} wrap="nowrap">
					<IconArrowDown size={iconSize} color="var(--mantine-color-green-6)" />
					<Text size={textSize} fw={500}>
						{formatTokenCount(record.outputTokens)}
					</Text>
				</Group>
			</Group>
			{(record.cachedInputTokens > 0 || record.reasoningTokens > 0) && (
				<Group gap={compact ? 8 : 12} wrap="nowrap">
					{record.cachedInputTokens > 0 && (
						<Group gap={4} wrap="nowrap">
							<IconDeviceFloppy size={iconSize} color="var(--mantine-color-blue-6)" />
							<Text size={textSize} fw={500}>
								{formatTokenCount(record.cachedInputTokens)}
							</Text>
						</Group>
					)}
					{record.reasoningTokens > 0 && (
						<Group gap={4} wrap="nowrap">
							<IconBrain size={iconSize} color="var(--mantine-color-yellow-6)" />
							<Text size={textSize} fw={500}>
								{formatTokenCount(record.reasoningTokens)}
							</Text>
						</Group>
					)}
				</Group>
			)}
			{record.cacheCreationInputTokens > 0 && (
				<Text size="xs" c="dimmed">
					{t("usageHistoryTokenCacheWrite")}: {record.cacheCreationInputTokens.toLocaleString()}
				</Text>
			)}
		</Stack>
	);
}

function DetailField({
	label,
	value,
	monospace = false,
	compact = false,
}: {
	label: string;
	value: string;
	monospace?: boolean;
	compact?: boolean;
}) {
	return (
		<Stack gap={compact ? 1 : 2}>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text
				size={compact ? "xs" : "sm"}
				ff={monospace ? "monospace" : undefined}
				style={{ wordBreak: "break-word" }}
			>
				{value}
			</Text>
		</Stack>
	);
}

export function UsageHistoryTable({ records, loading }: UsageHistoryTableProps) {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
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

	const toggleHint = (showId: boolean) =>
		showId ? t("usageHistoryToggleShowName") : t("usageHistoryToggleShowId");

	return (
		<>
			{isMobile ? (
				<Stack gap="xs">
					<Group grow gap="xs">
						<Button
							size="compact-xs"
							variant={showNarratorId ? "filled" : "light"}
							onClick={() => setShowNarratorId(!showNarratorId)}
						>
							{t("usageHistoryTableNarrator")} · {toggleHint(showNarratorId)}
						</Button>
						<Button
							size="compact-xs"
							variant={showCredentialId ? "filled" : "light"}
							onClick={() => setShowCredentialId(!showCredentialId)}
						>
							{t("usageHistoryTableCredential")} · {toggleHint(showCredentialId)}
						</Button>
					</Group>

					{records.map((record) => (
						<Card key={record.id} withBorder radius="sm" padding="xs">
							<Stack gap="xs">
								<Group justify="space-between" align="start" wrap="nowrap" gap="xs">
									<Stack gap={1} style={{ minWidth: 0, flex: 1 }}>
										<Text size="xs" fw={500}>
											{new Date(record.createdAt).toLocaleString()}
										</Text>
										{record.chapterTitle ? (
											<Text size="10px" c="dimmed" lineClamp={2}>
												{record.chapterTitle}
											</Text>
										) : (
											<Text size="10px" c="dimmed">
												{t("usageHistorySystemRequest")}
											</Text>
										)}
									</Stack>
									<Group gap={4} wrap="nowrap">
										<Badge color="gray" variant="outline" size="sm">
											{getKindLabel(t, record.kind)}
										</Badge>
										{record.errorMessage ? (
											<Badge color="red" variant="light" size="sm">
												{t("usageHistoryError")}
											</Badge>
										) : null}
										<Badge color={getProviderColor(record.provider)} variant="light" size="sm">
											{record.provider ?? "-"}
										</Badge>
									</Group>
								</Group>

								{record.errorMessage ? (
									<Text size="xs" c="red" lineClamp={2}>
										{record.errorMessage}
									</Text>
								) : null}

								<SimpleGrid cols={1} spacing="xs">
									<DetailField
										label={t("usageHistoryTableNarrator")}
										value={
											showNarratorId
												? (record.narratorId ?? "-")
												: (record.narratorTitle ??
													record.narratorId ??
													t("usageHistorySystemRequest"))
										}
										monospace={showNarratorId}
										compact
									/>
									<DetailField
										label={t("usageHistoryTableCredential")}
										value={
											showCredentialId
												? record.credentialId || "-"
												: record.credentialName || record.credentialId || "-"
										}
										monospace={showCredentialId || !record.credentialName}
										compact
									/>
									<DetailField
										label={t("usageHistoryTableModel")}
										value={record.model ?? "-"}
										compact
									/>
								</SimpleGrid>

								<Divider />

								<Paper p="xs" withBorder radius="sm">
									<TokensCell record={record} compact />
								</Paper>

								<SimpleGrid cols={2} spacing="xs">
									<DetailField
										label={t("usageHistoryTableTTFT")}
										value={formatDuration(record.ttftMs)}
										compact
									/>
									<DetailField
										label={t("usageHistoryTableDuration")}
										value={formatDuration(record.durationMs)}
										compact
									/>
								</SimpleGrid>

								<DetailField
									label={t("usageHistoryTableCost")}
									value={
											? record.meterUsage != null
												? `${record.meterUsage.toFixed(2)} ${record.meterUnit || "credits"}`
												: "-"
											: record.costUsd != null
												? `$${record.costUsd.toFixed(6)}`
												: "-"
									}
									compact
								/>

								{record.hasRawDump ? (
									<Button
										size="compact-xs"
										variant="light"
										leftSection={<IconCodeDots size={14} />}
										onClick={() => setSelectedRecordId(record.id)}
									>
										{t("usageHistoryViewRawDump")}
									</Button>
								) : null}
							</Stack>
						</Card>
					))}
				</Stack>
			) : (
				<ScrollArea type="auto" offsetScrollbars>
					<Table striped highlightOnHover withTableBorder withColumnBorders miw={1100}>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("usageHistoryTableTime")}</Table.Th>
								<Table.Th>
									<Group gap={8} wrap="nowrap">
										{t("usageHistoryTableNarrator")}
										<Tooltip label={toggleHint(showNarratorId)}>
											<ActionIcon
												size="xs"
												variant="subtle"
												color="gray"
												onClick={() => setShowNarratorId(!showNarratorId)}
											>
												{showNarratorId ? (
													<IconToggleRight size={16} />
												) : (
													<IconToggleLeft size={16} />
												)}
											</ActionIcon>
										</Tooltip>
									</Group>
								</Table.Th>
								<Table.Th>{t("usageHistoryTableKind")}</Table.Th>
								<Table.Th>{t("usageHistoryTableProvider")}</Table.Th>
								<Table.Th>
									<Group gap={8} wrap="nowrap">
										{t("usageHistoryTableCredential")}
										<Tooltip label={toggleHint(showCredentialId)}>
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
											<Group gap={6} wrap="nowrap">
												<Text size="sm">{new Date(record.createdAt).toLocaleString()}</Text>
												{record.errorMessage ? (
													<Tooltip label={record.errorMessage} multiline maw={400}>
														<Badge
															color="red"
															variant="light"
															size="xs"
															leftSection={<IconExclamationCircle size={10} />}
														>
															{t("usageHistoryError")}
														</Badge>
													</Tooltip>
												) : null}
											</Group>
											{record.chapterTitle ? (
												<Text size="xs" c="dimmed">
													{record.chapterTitle}
												</Text>
											) : (
												<Text size="xs" c="dimmed">
													{t("usageHistorySystemRequest")}
												</Text>
											)}
										</Stack>
									</Table.Td>
									<Table.Td>
										<Text size="sm" ff={showNarratorId ? "monospace" : undefined}>
											{showNarratorId
												? (record.narratorId ?? "-")
												: (record.narratorTitle ??
													record.narratorId ??
													t("usageHistorySystemRequest"))}
										</Text>
									</Table.Td>
									<Table.Td>
										<Badge color="gray" variant="outline">
											{getKindLabel(t, record.kind)}
										</Badge>
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
				</ScrollArea>
			)}

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
