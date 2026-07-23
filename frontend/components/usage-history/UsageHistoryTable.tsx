import { formatCompactNumber, formatDuration } from "@frontend/lib/compact-number";
import { formatLocaleDateTime } from "@frontend/lib/intl-format";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
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
	IconCheck,
	IconClock,
	IconCodeDots,
	IconCopy,
	IconDeviceFloppy,
	IconDownload,
	IconExclamationCircle,
	IconToggleLeft,
	IconToggleRight,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../common/CopyButton";

interface UsageHistoryTableProps {
	records: UsageHistoryRecord[];
	loading?: boolean;
}

const MAX_RAW_DUMP_DISPLAY_CHARS = 120_000;

function formatRawDumpPreview(
	value: unknown,
	maxChars: number,
): { text: string; truncated: boolean } {
	const parts: string[] = [];
	const seen = new WeakSet<object>();
	let remaining = maxChars;
	let truncated = false;

	const append = (text: string): boolean => {
		if (remaining <= 0) {
			truncated = true;
			return false;
		}
		if (text.length > remaining) {
			parts.push(text.slice(0, remaining));
			remaining = 0;
			truncated = true;
			return false;
		}
		parts.push(text);
		remaining -= text.length;
		return true;
	};

	const writeIndent = (depth: number) => append("  ".repeat(depth));

	const write = (current: unknown, depth: number): boolean => {
		if (current == null || typeof current === "number" || typeof current === "boolean") {
			return append(JSON.stringify(current));
		}
		if (typeof current === "string") {
			const snippet = current.length > remaining ? current.slice(0, remaining) : current;
			return append(JSON.stringify(snippet));
		}
		if (typeof current !== "object") return append(JSON.stringify(String(current)));
		if (seen.has(current)) return append('"[Circular]"');
		seen.add(current);

		if (Array.isArray(current)) {
			if (current.length === 0) return append("[]");
			if (!append("[\n")) return false;
			for (let i = 0; i < current.length; i++) {
				if (!writeIndent(depth + 1)) return false;
				if (!write(current[i], depth + 1)) return false;
				if (!append(i === current.length - 1 ? "\n" : ",\n")) return false;
			}
			return writeIndent(depth) && append("]");
		}

		let wroteAny = false;
		if (!append("{\n")) return false;
		let first = true;
		const record = current as Record<string, unknown>;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			if (!first && !append(",\n")) return false;
			first = false;
			wroteAny = true;
			if (!writeIndent(depth + 1)) return false;
			if (!append(`${JSON.stringify(key)}: `)) return false;
			if (!write(record[key], depth + 1)) return false;
		}
		if (!wroteAny) {
			parts.pop();
			return append("{}");
		}
		return append("\n") && writeIndent(depth) && append("}");
	};

	write(value, 0);
	return { text: parts.join(""), truncated };
}

function buildRawDumpExport(record: UsageHistoryRecord): unknown {
	return {
		id: record.id,
		createdAt: record.createdAt,
		kind: record.kind,
		provider: record.provider,
		credentialId: record.credentialId,
		credentialName: record.credentialName,
		model: record.model,
		narratorId: record.narratorId,
		narratorTitle: record.narratorTitle,
		chapterId: record.chapterId,
		chapterTitle: record.chapterTitle,
		projectId: record.projectId,
		errorMessage: record.errorMessage ?? null,
		request: record.rawDump?.request ?? null,
		response: record.rawDump?.response ?? null,
		rawDump: record.rawDump ?? null,
	};
}

function rawDumpDownloadFileName(record: UsageHistoryRecord): string {
	const timestamp = Number.isFinite(Date.parse(record.createdAt))
		? new Date(record.createdAt).toISOString().replace(/[:.]/g, "-")
		: "unknown-time";
	return `api-request-${timestamp}-${record.id}.json`;
}

function downloadJsonFile(fileName: string, value: unknown): void {
	const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
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

function TokenAmount({
	value,
	compact = false,
	textSize,
}: {
	value: number;
	compact?: boolean;
	textSize: "xs" | "sm";
}) {
	const formatted = formatCompactNumber(value);
	return (
		<Stack gap={0}>
			<Text size={textSize} fw={500} lh={1.2}>
				{formatted.compact}
			</Text>
			{formatted.isCompact ? (
				<Text size={compact ? "9px" : "10px"} c="dimmed" lh={1.1}>
					{formatted.exact}
				</Text>
			) : null}
		</Stack>
	);
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
	const cacheWriteTokens = formatCompactNumber(record.cacheCreationInputTokens);

	return (
		<Stack gap={compact ? 2 : 4} style={{ minWidth: compact ? undefined : 100 }}>
			<Group gap={compact ? 8 : 12} wrap="nowrap">
				<Group gap={4} wrap="nowrap" align="flex-start">
					<IconArrowUp size={iconSize} color="var(--mantine-color-violet-6)" />
					<TokenAmount value={actualInputTokens} compact={compact} textSize={textSize} />
				</Group>
				<Group gap={4} wrap="nowrap" align="flex-start">
					<IconArrowDown size={iconSize} color="var(--mantine-color-green-6)" />
					<TokenAmount value={record.outputTokens} compact={compact} textSize={textSize} />
				</Group>
			</Group>
			{(record.cachedInputTokens > 0 || record.reasoningTokens > 0) && (
				<Group gap={compact ? 8 : 12} wrap="nowrap">
					{record.cachedInputTokens > 0 && (
						<Group gap={4} wrap="nowrap" align="flex-start">
							<IconDeviceFloppy size={iconSize} color="var(--mantine-color-blue-6)" />
							<TokenAmount value={record.cachedInputTokens} compact={compact} textSize={textSize} />
						</Group>
					)}
					{record.reasoningTokens > 0 && (
						<Group gap={4} wrap="nowrap" align="flex-start">
							<IconBrain size={iconSize} color="var(--mantine-color-yellow-6)" />
							<TokenAmount value={record.reasoningTokens} compact={compact} textSize={textSize} />
						</Group>
					)}
				</Group>
			)}
			{record.cacheCreationInputTokens > 0 && (
				<Text size="xs" c="dimmed">
					{t("usageHistoryTokenCacheWrite")}: {cacheWriteTokens.compact}
					{cacheWriteTokens.isCompact ? ` (${cacheWriteTokens.exact})` : ""}
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

function CopyableErrorBadge({ message }: { message: string }) {
	const { t } = useTranslation("common");

	return (
		<CopyButton value={message} timeout={1500}>
			{({ copied, copy }) => (
				<Tooltip
					label={copied ? t("copied") : `${t("usageHistoryCopyError")}: ${message}`}
					multiline
					maw={400}
				>
					<Badge
						color={copied ? "green" : "red"}
						variant="light"
						size="xs"
						leftSection={copied ? <IconCheck size={10} /> : <IconExclamationCircle size={10} />}
						onClick={(event) => {
							event.stopPropagation();
							copy();
						}}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							event.stopPropagation();
							copy();
						}}
						role="button"
						tabIndex={0}
						aria-label={t("usageHistoryCopyError")}
						style={{ cursor: "copy", userSelect: "none" }}
					>
						{copied ? t("copied") : t("usageHistoryError")}
					</Badge>
				</Tooltip>
			)}
		</CopyButton>
	);
}

function CopyableErrorText({ message }: { message: string }) {
	const { t } = useTranslation("common");

	return (
		<CopyButton value={message} timeout={1500}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? t("copied") : t("usageHistoryCopyError")} withArrow>
					<Text
						size="xs"
						c={copied ? "green" : "red"}
						lineClamp={2}
						onClick={(event) => {
							event.stopPropagation();
							copy();
						}}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							event.stopPropagation();
							copy();
						}}
						role="button"
						tabIndex={0}
						aria-label={t("usageHistoryCopyError")}
						style={{ cursor: "copy", wordBreak: "break-word" }}
					>
						{message}
					</Text>
				</Tooltip>
			)}
		</CopyButton>
	);
}

function CopyErrorAction({ message, asButton = false }: { message: string; asButton?: boolean }) {
	const { t } = useTranslation("common");

	return (
		<CopyButton value={message} timeout={1500}>
			{({ copied, copy }) =>
				asButton ? (
					<Button
						size="compact-xs"
						variant="light"
						color={copied ? "green" : "red"}
						leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
						onClick={(event) => {
							event.stopPropagation();
							copy();
						}}
					>
						{copied ? t("copied") : t("usageHistoryCopyError")}
					</Button>
				) : (
					<Tooltip label={copied ? t("copied") : t("usageHistoryCopyError")} withArrow>
						<ActionIcon
							variant="subtle"
							color={copied ? "green" : "red"}
							onClick={(event) => {
								event.stopPropagation();
								copy();
							}}
							aria-label={t("usageHistoryCopyError")}
						>
							{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
						</ActionIcon>
					</Tooltip>
				)
			}
		</CopyButton>
	);
}

function DownloadRawDumpAction({
	record,
	loading,
	onDownload,
	asButton = false,
}: {
	record: UsageHistoryRecord;
	loading: boolean;
	onDownload: (record: UsageHistoryRecord) => void;
	asButton?: boolean;
}) {
	const { t } = useTranslation("common");

	if (asButton) {
		return (
			<Button
				size="compact-xs"
				variant="light"
				leftSection={<IconDownload size={14} />}
				loading={loading}
				onClick={(event) => {
					event.stopPropagation();
					onDownload(record);
				}}
			>
				{t("usageHistoryDownloadRequestResponse")}
			</Button>
		);
	}

	return (
		<Tooltip label={t("usageHistoryDownloadRequestResponse")} withArrow>
			<ActionIcon
				variant="subtle"
				color="blue"
				loading={loading}
				onClick={(event) => {
					event.stopPropagation();
					onDownload(record);
				}}
				aria-label={t("usageHistoryDownloadRequestResponse")}
			>
				<IconDownload size={16} />
			</ActionIcon>
		</Tooltip>
	);
}

export function UsageHistoryTable({ records, loading }: UsageHistoryTableProps) {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [showNarratorId, setShowNarratorId] = useState(false);
	const [showCredentialId, setShowCredentialId] = useState(false);
	const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
	const [downloadingRecordId, setDownloadingRecordId] = useState<string | null>(null);

	const { data: selectedRecord, isLoading: isLoadingRawDump } = useQuery({
		queryKey: ["usage-history", "detail", selectedRecordId],
		queryFn: () => usageHistoryApi.getRecord(selectedRecordId as string),
		enabled: !!selectedRecordId,
		gcTime: 0,
	});
	const rawDumpDisplay = useMemo(() => {
		if (!selectedRecord?.rawDump) return null;
		return formatRawDumpPreview(selectedRecord.rawDump, MAX_RAW_DUMP_DISPLAY_CHARS);
	}, [selectedRecord?.rawDump]);

	const handleDownloadRawDump = async (record: UsageHistoryRecord) => {
		setDownloadingRecordId(record.id);
		try {
			const fullRecord = record.rawDump ? record : await usageHistoryApi.getRecord(record.id);
			if (!fullRecord.rawDump) return;
			downloadJsonFile(rawDumpDownloadFileName(fullRecord), buildRawDumpExport(fullRecord));
		} catch (error) {
			console.error("Failed to download raw dump", error);
			window.alert(
				error instanceof Error && error.message ? error.message : t("usageHistoryDownloadFailed"),
			);
		} finally {
			setDownloadingRecordId(null);
		}
	};

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
											{formatLocaleDateTime(record.createdAt)}
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

								{record.errorMessage ? <CopyableErrorText message={record.errorMessage} /> : null}
								{record.errorMessage ? (
									<Group gap="xs">
										<CopyErrorAction message={record.errorMessage} asButton />
										{record.hasRawDump ? (
											<DownloadRawDumpAction
												record={record}
												loading={downloadingRecordId === record.id}
												onDownload={handleDownloadRawDump}
												asButton
											/>
										) : null}
									</Group>
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
												<Text size="sm">{formatLocaleDateTime(record.createdAt)}</Text>
												{record.errorMessage ? (
													<CopyableErrorBadge message={record.errorMessage} />
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
										{record.hasRawDump || record.errorMessage ? (
											<Group gap={4} wrap="nowrap">
												{record.errorMessage ? (
													<CopyErrorAction message={record.errorMessage} />
												) : null}
												{record.errorMessage && record.hasRawDump ? (
													<DownloadRawDumpAction
														record={record}
														loading={downloadingRecordId === record.id}
														onDownload={handleDownloadRawDump}
													/>
												) : null}
												{record.hasRawDump ? (
													<Tooltip label={t("usageHistoryViewRawDump")}>
														<ActionIcon
															variant="subtle"
															color="gray"
															onClick={() => setSelectedRecordId(record.id)}
															aria-label={t("usageHistoryViewRawDump")}
														>
															<IconCodeDots size={16} />
														</ActionIcon>
													</Tooltip>
												) : null}
											</Group>
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
				{selectedRecord?.errorMessage || selectedRecord?.hasRawDump ? (
					<Group justify="flex-end" mb="sm" gap="xs">
						{selectedRecord.errorMessage ? (
							<CopyErrorAction message={selectedRecord.errorMessage} asButton />
						) : null}
						{selectedRecord.hasRawDump ? (
							<DownloadRawDumpAction
								record={selectedRecord}
								loading={downloadingRecordId === selectedRecord.id}
								onDownload={handleDownloadRawDump}
								asButton
							/>
						) : null}
					</Group>
				) : null}
				{isLoadingRawDump ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("usageHistoryRawDumpLoading")}
						</Text>
					</Group>
				) : rawDumpDisplay ? (
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
						{rawDumpDisplay.text}
						{rawDumpDisplay.truncated ? `\n\n${t("usageHistoryRawDumpTruncated")}` : null}
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
