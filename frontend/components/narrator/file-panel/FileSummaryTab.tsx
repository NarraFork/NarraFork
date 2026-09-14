import { useFileDiff, useFileModifications, useRevertFile } from "@frontend/hooks/useNarrator";
import { toRelativePath } from "@frontend/lib/format";
import {
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	NativeSelect,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconArrowBackUp,
	IconChevronDown,
	IconChevronRight,
	IconFile,
	IconFilePlus,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";

import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../../common/TruncatedPath";
import { DiffView, normalizeDiffLineEndings } from "../diff/DiffView";

const MAX_FILE_SUMMARY_FILES = 1_000;
const fileKey = (deviceId: string, filePath: string) => JSON.stringify([deviceId, filePath]);
const displayFilePath = (deviceId: string, filePath: string, basePath: string | null) =>
	deviceId === "local" ? toRelativePath(filePath, basePath) : `${deviceId}:${filePath}`;

function FileDiffContent({
	narratorId,
	snapshotId,
	filePath,
	upToMessageId,
	fromMessageId,
}: {
	narratorId: string;
	snapshotId: string;
	filePath: string;
	upToMessageId?: string | null;
	fromMessageId?: string | null;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useFileDiff(
		narratorId,
		snapshotId,
		true,
		upToMessageId,
		fromMessageId,
	);

	if (isLoading) {
		return (
			<Center py="md">
				<Loader size="sm" />
			</Center>
		);
	}
	if (!data) return null;

	const original = normalizeDiffLineEndings(data.original ?? "");
	const current = normalizeDiffLineEndings(data.current ?? "");

	if (original === current) {
		return (
			<Text size="xs" c="dimmed" py="xs" ta="center">
				{t("fileMod_noChanges")}
			</Text>
		);
	}

	const lang = filePath.split(".").pop() ?? "";

	return <DiffView oldStr={original} newStr={current} maxHeight={400} language={lang} />;
}

interface TimelineEntry {
	messageId: string;
	createdAt: string;
	seq: number;
	role: string;
	hasEdits: boolean;
}

const formatTime = (iso: string) => {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Two-select range boundary selector for file modifications */
function RangeBoundarySelector({
	timeline,
	fromId,
	toId,
	onChange,
}: {
	timeline: TimelineEntry[];
	fromId: string | null; // null = beginning
	toId: string | null; // null = current (latest)
	onChange: (fromId: string | null, toId: string | null) => void;
}) {
	const { t } = useTranslation("narrator");

	// Build option lists with role labels
	const roleLabel = useCallback(
		(entry: TimelineEntry, idx: number) => {
			const time = formatTime(entry.createdAt);
			const prefix =
				entry.role === "user"
					? t("fileMod_roleUser")
					: entry.role === "assistant"
						? t("fileMod_roleAssistant")
						: t("fileMod_roleSystem");
			const editMark = entry.hasEdits ? " *" : "";
			return `#${idx + 1} ${prefix} ${time}${editMark}`;
		},
		[t],
	);

	// "From" options: "All" + every message
	const fromOptions = useMemo(() => {
		const opts = [{ value: "", label: t("fileMod_rangeAll") }];
		for (let i = 0; i < timeline.length; i++) {
			opts.push({ value: timeline[i].messageId, label: roleLabel(timeline[i], i) });
		}
		return opts;
	}, [timeline, t, roleLabel]);
	// "To" options: every message + "Current"
	const toOptions = useMemo(() => {
		const opts: Array<{ value: string; label: string }> = [];
		for (let i = 0; i < timeline.length; i++) {
			opts.push({ value: timeline[i].messageId, label: roleLabel(timeline[i], i) });
		}
		opts.push({ value: "", label: t("fileMod_rangeCurrent") });
		return opts;
	}, [timeline, t, roleLabel]);

	if (timeline.length <= 1) return null;

	return (
		<Box
			px="sm"
			py={6}
			style={{
				flexShrink: 0,
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
		>
			<Group gap="xs" wrap="nowrap" align="flex-end">
				<NativeSelect
					size="xs"
					label={t("fileMod_rangeFrom")}
					data={fromOptions}
					value={fromId ?? ""}
					onChange={(e) => onChange(e.currentTarget.value || null, toId)}
					style={{ flex: 1, minWidth: 0 }}
				/>
				<NativeSelect
					size="xs"
					label={t("fileMod_rangeTo")}
					data={toOptions}
					value={toId ?? ""}
					onChange={(e) => onChange(fromId, e.currentTarget.value || null)}
					style={{ flex: 1, minWidth: 0 }}
				/>
			</Group>
		</Box>
	);
}

export function FileSummaryTab({
	narratorId,
	basePath,
}: {
	narratorId: string;
	basePath: string | null;
}) {
	const { t } = useTranslation("narrator");

	// Always fetch full data first to get timeline
	const { data: fullData, isLoading: fullLoading } = useFileModifications(narratorId);
	const timeline = useMemo(() => fullData?.timeline ?? [], [fullData]);

	// Compute default "from": the last user message in the timeline
	const defaultFromId = useMemo(() => {
		for (let i = timeline.length - 1; i >= 0; i--) {
			if (timeline[i].role === "user") return timeline[i].messageId;
		}
		return null; // no user message found → show all
	}, [timeline]);

	// Range state: undefined means "use default", null means "all/current"
	const [fromIdOverride, setFromIdOverride] = useState<string | null | undefined>(undefined);
	const [toId, setToId] = useState<string | null>(null);

	const effectiveFromId = fromIdOverride === undefined ? defaultFromId : fromIdOverride;
	const isRangeFiltered = effectiveFromId !== null || toId !== null;

	// Fetch filtered data when range is active
	const { data: filteredData, isLoading: filteredLoading } = useFileModifications(
		narratorId,
		isRangeFiltered,
		toId,
		effectiveFromId,
	);

	const data = isRangeFiltered ? filteredData : fullData;
	const isLoading = isRangeFiltered ? filteredLoading : fullLoading;

	const revertFile = useRevertFile(narratorId);
	const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);

	const handleRangeChange = useCallback((newFrom: string | null, newTo: string | null) => {
		setFromIdOverride(newFrom);
		setToId(newTo);
		setExpandedFile(null);
		setConfirmRevert(null);
	}, []);

	if (fullLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" />
			</Center>
		);
	}

	const allFiles = fullData?.files ?? [];
	if (allFiles.length === 0) {
		return (
			<Center py="xl">
				<Text size="sm" c="dimmed">
					{t("fileMod_empty")}
				</Text>
			</Center>
		);
	}

	const files = data?.files ?? [];
	const displayedFiles = files.slice(0, MAX_FILE_SUMMARY_FILES);
	const hiddenFileCount = Math.max(0, files.length - displayedFiles.length);

	const handleRevert = async (deviceId: string, filePath: string) => {
		try {
			await revertFile.mutateAsync({ deviceId, filePath });
			notifications.show({ message: t("fileMod_reverted"), color: "green", autoClose: 3000 });
			setConfirmRevert(null);
		} catch {
			notifications.show({ message: t("fileMod_revertFailed"), color: "red", autoClose: 5000 });
		}
	};

	const toggleFile = (key: string) => {
		setExpandedFile((prev) => (prev === key ? null : key));
	};

	// Only show revert when viewing current state (toId is null)
	const canRevert = toId === null;

	return (
		<Box
			style={{
				overflow: "hidden",
				minWidth: 0,
				width: "100%",
				display: "flex",
				flexDirection: "column",
				height: "100%",
			}}
		>
			{/* Range boundary selector */}
			<RangeBoundarySelector
				timeline={timeline}
				fromId={effectiveFromId}
				toId={toId}
				onChange={handleRangeChange}
			/>

			{/* File count header */}
			<Group px="sm" py={6} justify="space-between" style={{ flexShrink: 0 }}>
				<Text size="xs" c="dimmed">
					{t("fileMod_fileCount", { count: files.length })}
				</Text>
			</Group>

			{/* File list */}
			{isLoading ? (
				<Center py="md">
					<Loader size="sm" />
				</Center>
			) : files.length === 0 ? (
				<Center py="md">
					<Text size="xs" c="dimmed">
						{t("fileMod_noChanges")}
					</Text>
				</Center>
			) : (
				<Box
					style={{
						flex: 1,
						overflowY: "auto",
						overflowX: "hidden",
						width: "100%",
						minHeight: 0,
					}}
				>
					<Stack gap={2} mx="xs">
						{displayedFiles.map((file) => {
							const key = fileKey(file.deviceId, file.filePath);
							const isExpanded = expandedFile === key;
							const displayPath = displayFilePath(file.deviceId, file.filePath, basePath);
							return (
								<Box
									key={key}
									style={{
										borderRadius: "var(--mantine-radius-sm)",
										border: "1px solid var(--mantine-color-default-border)",
										overflow: "hidden",
									}}
								>
									<UnstyledButton
										onClick={() => toggleFile(key)}
										w="100%"
										py={6}
										px="xs"
										style={{
											backgroundColor: isExpanded
												? "var(--mantine-color-default-hover)"
												: undefined,
										}}
									>
										<Group
											gap="xs"
											wrap="nowrap"
											justify="space-between"
											style={{ overflow: "hidden", minWidth: 0 }}
										>
											<Group
												gap="xs"
												wrap="nowrap"
												style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
											>
												{isExpanded ? (
													<IconChevronDown size={14} style={{ flexShrink: 0 }} />
												) : (
													<IconChevronRight size={14} style={{ flexShrink: 0 }} />
												)}
												{file.originalExists ? (
													<IconFile size={14} style={{ flexShrink: 0 }} />
												) : (
													<IconFilePlus size={14} style={{ flexShrink: 0 }} />
												)}
												<TruncatedPath path={displayPath} />
											</Group>
											<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
												<Badge
													size="xs"
													variant="light"
													color={file.originalExists ? "blue" : "green"}
												>
													{file.originalExists ? t("fileMod_modified") : t("fileMod_newFile")}
												</Badge>
												<Badge size="xs" variant="light" color="gray">
													{t("fileMod_editCount", { count: file.editCount })}
												</Badge>
											</Group>
										</Group>
									</UnstyledButton>

									{isExpanded && (
										<Box px="xs" pb="xs">
											<Stack gap="xs">
												<FileDiffContent
													narratorId={narratorId}
													snapshotId={file.snapshotId}
													filePath={file.filePath}
													upToMessageId={toId}
													fromMessageId={effectiveFromId}
												/>
												{canRevert && (
													<Group justify="flex-end">
														{confirmRevert === key ? (
															<Group gap="xs">
																<Text size="xs" c="dimmed">
																	{t("fileMod_revertConfirm")}
																</Text>
																<Button
																	size="compact-xs"
																	color="red"
																	loading={revertFile.isPending}
																	onClick={() => handleRevert(file.deviceId, file.filePath)}
																>
																	{t("fileMod_revertFile")}
																</Button>
																<Button
																	size="compact-xs"
																	variant="default"
																	onClick={() => setConfirmRevert(null)}
																>
																	{t("fileMod_cancelDelete")}
																</Button>
															</Group>
														) : (
															<Tooltip label={t("fileMod_revertFile")}>
																<Button
																	size="compact-xs"
																	variant="light"
																	color="orange"
																	leftSection={<IconArrowBackUp size={12} />}
																	onClick={(e) => {
																		e.stopPropagation();
																		setConfirmRevert(key);
																	}}
																>
																	{t("fileMod_revertFile")}
																</Button>
															</Tooltip>
														)}
													</Group>
												)}
											</Stack>
										</Box>
									)}
								</Box>
							);
						})}
						{hiddenFileCount > 0 && (
							<Text size="xs" c="dimmed" ta="center" py="xs">
								{t("fileMod_listTruncated", {
									shown: displayedFiles.length,
									hidden: hiddenFileCount,
								})}
							</Text>
						)}
					</Stack>
				</Box>
			)}
		</Box>
	);
}
