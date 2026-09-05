import { formatCompactNumber, formatDuration } from "@frontend/lib/compact-number";
import { formatLocaleDateTime } from "@frontend/lib/intl-format";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import type { UsageHistoryRawDumpSpill, UsageHistoryRecord } from "@frontend/types/usage-history";
import {
	ActionIcon,
	Alert,
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
import { formatFileSize } from "@shared/text-file-types";
import {
	IconAlertTriangle,
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
	IconFileDownload,
	IconToggleLeft,
	IconToggleRight,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
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

/**
 * Read the spill pointer off a dump of unknown shape.
 *
 * The dump arrives as a stored JSON blob, so it may predate the current pointer shape or
 * carry none at all. A pointer is only honoured when it asserts one of the two truncations
 * it can describe; anything else means "no evidence anything was cut", and inventing that
 * warning would be worse than omitting it.
 *
 * `truncated` is accepted on its own even though the server always writes `inlineTruncated`
 * alongside it: the two facts are independent, and the severe one (no complete copy exists)
 * must not be silenced by the absence of the mild one.
 */
function readRawDumpSpill(dump: unknown): UsageHistoryRawDumpSpill | null {
	if (dump == null || typeof dump !== "object" || Array.isArray(dump)) return null;
	const spill = (dump as { spill?: unknown }).spill;
	if (spill == null || typeof spill !== "object" || Array.isArray(spill)) return null;
	const pointer = spill as UsageHistoryRawDumpSpill;
	if (pointer.inlineTruncated !== true && pointer.truncated !== true) return null;
	return pointer;
}

function finiteBytes(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function rawDumpDownloadFileName(record: UsageHistoryRecord): string {
	const timestamp = Number.isFinite(Date.parse(record.createdAt))
		? new Date(record.createdAt).toISOString().replace(/[:.]/g, "-")
		: "unknown-time";
	return `api-request-${timestamp}-${record.id}.json`;
}

function saveBlob(fileName: string, blob: Blob): void {
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
		case "codex":
			return "cyan";
		default:
			return "gray";
	}
}

/**
 * Whether a request record originates from an external agent (kind=external,
 * or legacy rows written by external harnesses with kind=narrator but no
 * narrator association, e.g. provider=dsh).
 */
function isExternalRequest(record: UsageHistoryRecord): boolean {
	const kind = record.kind?.trim().toLowerCase();
	return kind === "external" || kind === "dsh" || record.provider?.trim().toLowerCase() === "dsh";
}

function getKindLabel(
	t: (key: string, options: { defaultValue: string }) => string,
	kind: string,
): string {
	const normalizedKind = kind.trim().toLowerCase() === "dsh" ? "external" : kind;
	return t(`usageHistoryKind_${normalizedKind}`, { defaultValue: normalizedKind });
}

/**
 * Narrator-cell label for a request with no narrator association. External
 * agent requests (kind=external, or legacy dsh rows) default to
 * "外部Agent请求" but prefer the agent-supplied label when the writing agent
 * attached its own text; everything else falls back to the generic
 * system-request label.
 */
function getNarratorLabel(t: TFunction, record: UsageHistoryRecord): string {
	if (isExternalRequest(record)) {
		return record.agentLabel?.trim() || t("usageHistoryExternalAgent");
	}
	return t("usageHistorySystemRequest");
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

/**
 * State the truncations that apply to the dump shown below, worst first.
 *
 * Three unrelated things can cut a dump short, and they differ in what the user can do
 * about it — so they must not be phrased as one:
 *
 *  1. `spill.truncated` — the FILE itself was shed to fit the server's per-file ceiling.
 *     No complete copy exists anywhere; downloading does not recover it. This is the only
 *     permanent loss, so it sets the alert's severity and leads the text.
 *  2. `spill.inlineTruncated` — the database row holds only a head. Downloading the dump
 *     returns the whole file, so this is informational.
 *  3. `displayCapped` — the preview below stops at a character budget to keep the modal
 *     responsive. Nothing is lost; it is a rendering limit.
 *
 * (3) keeps its in-place marker at the end of the preview (that marker is what says WHERE
 * the text stops), and is restated here only when an alert is already being shown, so a
 * reader of the alert is not left thinking the cut they can see has a different cause.
 */
function RawDumpSpillAlert({
	spill,
	displayCapped,
}: {
	spill: UsageHistoryRawDumpSpill;
	displayCapped: boolean;
}) {
	const { t } = useTranslation("common");
	const incomplete = spill.truncated === true;
	const keptBytes = finiteBytes(spill.bytes);
	const originalBytes = finiteBytes(spill.originalBytes);

	return (
		<Alert
			mb="sm"
			color={incomplete ? "orange" : "yellow"}
			variant="light"
			icon={incomplete ? <IconAlertTriangle size={18} /> : <IconFileDownload size={18} />}
			title={
				incomplete ? t("usageHistoryRawDumpIncompleteTitle") : t("usageHistoryRawDumpSpillTitle")
			}
		>
			<Stack gap={4}>
				{incomplete ? (
					<>
						<Text size="sm" fw={500}>
							{t("usageHistoryRawDumpIncompleteBody")}
						</Text>
						{spill.inlineTruncated === true ? (
							<Text size="sm">{t("usageHistoryRawDumpIncompleteHead")}</Text>
						) : null}
					</>
				) : (
					<Text size="sm">{t("usageHistoryRawDumpSpillBody")}</Text>
				)}

				{incomplete ? (
					// `bytes` is what survived, not the dump's size, so the "Complete dump: …"
					// wording must not be reused here.
					originalBytes !== null && keptBytes !== null && originalBytes > keptBytes ? (
						<Text size="xs" c="dimmed">
							{t("usageHistoryRawDumpIncompleteBytes", {
								original: formatFileSize(originalBytes),
								kept: formatFileSize(keptBytes),
								lost: formatFileSize(originalBytes - keptBytes),
							})}
						</Text>
					) : originalBytes !== null ? (
						<Text size="xs" c="dimmed">
							{t("usageHistoryRawDumpIncompleteOriginal", {
								size: formatFileSize(originalBytes),
							})}
						</Text>
					) : keptBytes !== null ? (
						<Text size="xs" c="dimmed">
							{t("usageHistoryRawDumpIncompleteKept", { size: formatFileSize(keptBytes) })}
						</Text>
					) : null
				) : keptBytes !== null ? (
					<Text size="xs" c="dimmed">
						{t("usageHistoryRawDumpSpillSize", { size: formatFileSize(keptBytes) })}
					</Text>
				) : null}

				{displayCapped ? (
					<Text size="xs" c="dimmed">
						{t("usageHistoryRawDumpDisplayCapNote")}
					</Text>
				) : null}

				{spill.fileName ? (
					<Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
						{t("usageHistoryRawDumpSpillFile", { fileName: spill.fileName })}
					</Text>
				) : null}
			</Stack>
		</Alert>
	);
}

export function UsageHistoryTable({ records, loading }: UsageHistoryTableProps) {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [showNarratorId, setShowNarratorId] = useState(false);
	const [showCredentialId, setShowCredentialId] = useState(false);
	const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
	const [downloadingRecordId, setDownloadingRecordId] = useState<string | null>(null);
	const [sortField, setSortField] = useState<string | null>(null);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const sortedRecords = useMemo(() => {
		if (!sortField) return records;
		const getValue = (r: UsageHistoryRecord): number => {
			switch (sortField) {
				case "tokens":
					return r.inputTokens + r.outputTokens;
				case "cost":
					return r.costUsd ?? 0;
				case "ttft":
					return r.ttftMs ?? 0;
				case "duration":
					return r.durationMs ?? 0;
				default:
					return 0;
			}
		};
		return [...records].sort((a, b) => {
			const diff = getValue(a) - getValue(b);
			return sortDir === "asc" ? diff : -diff;
		});
	}, [records, sortField, sortDir]);

	const toggleSort = (field: string) => {
		if (sortField === field) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortField(field);
			setSortDir("desc");
		}
	};

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
	/**
	 * The row is only a head whenever the dump spilled to a file, and the panel below shows
	 * exactly that head. Without this the truncation is invisible and a user diagnoses a
	 * rejected request from a body that stops mid-way. The pointer also carries whether the
	 * FILE was shed — see {@link RawDumpSpillAlert} for why the two must read differently.
	 */
	const rawDumpSpill = useMemo(
		() => readRawDumpSpill(selectedRecord?.rawDump),
		[selectedRecord?.rawDump],
	);

	/**
	 * Always fetch from the server's download endpoint.
	 *
	 * Serializing the record already in memory would download whatever the row happened to
	 * hold — a truncated preview whenever the dump spilled to a file. The endpoint returns
	 * the complete dump either way.
	 */
	const handleDownloadRawDump = async (record: UsageHistoryRecord) => {
		setDownloadingRecordId(record.id);
		try {
			const { blob, fileName } = await usageHistoryApi.downloadRawDump(record.id);
			saveBlob(fileName ?? rawDumpDownloadFileName(record), blob);
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
		return <Text c="dimmed">{t("usageHistoryTableLoading")}</Text>;
	}
	if (records.length === 0) {
		return <Text c="dimmed">{t("usageHistoryTableEmpty")}</Text>;
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

					{sortedRecords.map((record) => (
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
												{getNarratorLabel(t, record)}
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
												: (record.narratorTitle ?? record.narratorId ?? getNarratorLabel(t, record))
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
										record.meterUsage != null
											? `${record.meterUsage.toFixed(2)} ${record.meterUnit || "credits"}`
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
								<Table.Th
									style={{ cursor: "pointer", userSelect: "none" }}
									onClick={() => toggleSort("tokens")}
								>
									{t("usageHistoryTableTokens")}
									{sortField === "tokens" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
								</Table.Th>
								<Table.Th
									style={{ cursor: "pointer", userSelect: "none" }}
									onClick={() => toggleSort("ttft")}
								>
									{t("usageHistoryTableTTFT")}
									{sortField === "ttft" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
								</Table.Th>
								<Table.Th
									style={{ cursor: "pointer", userSelect: "none" }}
									onClick={() => toggleSort("duration")}
								>
									{t("usageHistoryTableDuration")}
									{sortField === "duration" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
								</Table.Th>
								<Table.Th
									style={{ cursor: "pointer", userSelect: "none" }}
									onClick={() => toggleSort("cost")}
								>
									{t("usageHistoryTableCost")}
									{sortField === "cost" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
								</Table.Th>
								<Table.Th>{t("usageHistoryTableActions")}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{sortedRecords.map((record) => (
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
													{getNarratorLabel(t, record)}
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
													getNarratorLabel(t, record))}
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
										{record.meterUsage != null ? (
											<Text size="sm" fw={500} c="blue">
												{`${record.meterUsage.toFixed(2)} ${record.meterUnit || "credits"}`}
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
				{rawDumpSpill && !isLoadingRawDump ? (
					<RawDumpSpillAlert
						spill={rawDumpSpill}
						displayCapped={rawDumpDisplay?.truncated === true}
					/>
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
