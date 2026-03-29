import { useFileDiff, useFileModifications, useRevertFile } from "@frontend/hooks/useNarrator";
import { toRelativePath } from "@frontend/lib/format";
import {
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
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
	IconCircleFilled,
	IconFile,
	IconFilePlus,
} from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../common/TruncatedPath";
import { DiffView } from "./DiffView";

function FileDiffContent({
	narratorId,
	snapshotId,
	filePath,
	upToMessageId,
}: {
	narratorId: string;
	snapshotId: string;
	filePath: string;
	upToMessageId?: string | null;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useFileDiff(narratorId, snapshotId, true, upToMessageId);

	if (isLoading) {
		return (
			<Center py="md">
				<Loader size="sm" />
			</Center>
		);
	}
	if (!data) return null;

	const original = data.original ?? "";
	const current = data.current ?? "";

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

/** Horizontal scrollable timeline of edit messages */
function EditTimeline({
	timeline,
	selectedId,
	onSelect,
}: {
	timeline: Array<{ messageId: string; createdAt: string; seq: number }>;
	selectedId: string | null; // null = latest
	onSelect: (messageId: string | null) => void;
}) {
	const { t } = useTranslation("narrator");
	const scrollRef = useRef<HTMLDivElement>(null);

	// Callback ref: scroll active node into view when it mounts
	const activeNodeRef = useCallback((node: HTMLButtonElement | null) => {
		if (node && scrollRef.current) {
			node.scrollIntoView({ inline: "center", block: "nearest" });
		}
	}, []);

	if (timeline.length <= 1) return null;

	const lastId = timeline[timeline.length - 1]?.messageId ?? null;
	const effectiveId = selectedId ?? lastId;

	const formatTime = (iso: string) => {
		const d = new Date(iso);
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	};

	return (
		<Box
			ref={scrollRef}
			px="sm"
			py={6}
			style={{
				overflowX: "auto",
				overflowY: "hidden",
				flexShrink: 0,
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
		>
			<Group gap={0} wrap="nowrap" style={{ minWidth: "max-content" }}>
				{timeline.map((entry, idx) => {
					const isActive = entry.messageId === effectiveId;
					const isLast = idx === timeline.length - 1;
					return (
						<Group key={entry.messageId} gap={0} wrap="nowrap" align="center">
							{idx > 0 && (
								<Box
									style={{
										width: 20,
										height: 2,
										backgroundColor: "var(--mantine-color-dark-3)",
										flexShrink: 0,
									}}
								/>
							)}
							<Tooltip
								label={
									isLast
										? t("fileMod_timelineCurrent")
										: t("fileMod_timelineMessage", { n: idx + 1 })
								}
							>
								<UnstyledButton
									ref={isActive ? activeNodeRef : undefined}
									onClick={() => onSelect(isLast ? null : entry.messageId)}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "center",
										gap: 2,
										padding: "2px 6px",
										borderRadius: "var(--mantine-radius-sm)",
										backgroundColor: isActive ? "var(--mantine-color-indigo-light)" : undefined,
										flexShrink: 0,
									}}
								>
									<IconCircleFilled
										size={isActive ? 10 : 7}
										color={
											isActive
												? "var(--mantine-color-indigo-filled)"
												: "var(--mantine-color-dark-3)"
										}
									/>
									<Text
										size="10px"
										c={isActive ? "indigo" : "dimmed"}
										fw={isActive ? 600 : 400}
										style={{ lineHeight: 1.2 }}
									>
										{isLast ? t("fileMod_timelineCurrent") : `#${idx + 1}`}
									</Text>
									<Text size="9px" c="dimmed" style={{ lineHeight: 1 }}>
										{formatTime(entry.createdAt)}
									</Text>
								</UnstyledButton>
							</Tooltip>
						</Group>
					);
				})}
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
	const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

	// Always fetch full data first to get timeline
	const { data: fullData, isLoading: fullLoading } = useFileModifications(narratorId);
	const timeline = useMemo(() => fullData?.timeline ?? [], [fullData]);

	// Fetch filtered data when a non-latest message is selected
	const { data: filteredData, isLoading: filteredLoading } = useFileModifications(
		narratorId,
		!!selectedMessageId,
		selectedMessageId,
	);

	const data = selectedMessageId ? filteredData : fullData;
	const isLoading = selectedMessageId ? filteredLoading : fullLoading;

	const revertFile = useRevertFile(narratorId);
	const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);

	// Reset expanded file when switching timeline point
	const handleTimelineSelect = useCallback((messageId: string | null) => {
		setSelectedMessageId(messageId);
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

	const handleRevert = async (filePath: string) => {
		try {
			await revertFile.mutateAsync(filePath);
			notifications.show({ message: t("fileMod_reverted"), color: "green", autoClose: 3000 });
			setConfirmRevert(null);
		} catch {
			notifications.show({ message: t("fileMod_revertFailed"), color: "red", autoClose: 5000 });
		}
	};

	const toggleFile = (filePath: string) => {
		setExpandedFile((prev) => (prev === filePath ? null : filePath));
	};

	const isViewingHistory = selectedMessageId !== null;

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
			{/* Timeline */}
			<EditTimeline
				timeline={timeline}
				selectedId={selectedMessageId}
				onSelect={handleTimelineSelect}
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
						{files.map((file) => {
							const isExpanded = expandedFile === file.filePath;
							const displayPath = toRelativePath(file.filePath, basePath);
							return (
								<Box
									key={file.filePath}
									style={{
										borderRadius: "var(--mantine-radius-sm)",
										border: "1px solid var(--mantine-color-dark-4)",
										overflow: "hidden",
									}}
								>
									<UnstyledButton
										onClick={() => toggleFile(file.filePath)}
										w="100%"
										py={6}
										px="xs"
										style={{
											backgroundColor: isExpanded ? "var(--mantine-color-dark-5)" : undefined,
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
													upToMessageId={selectedMessageId}
												/>
												{!isViewingHistory && (
													<Group justify="flex-end">
														{confirmRevert === file.filePath ? (
															<Group gap="xs">
																<Text size="xs" c="dimmed">
																	{t("fileMod_revertConfirm")}
																</Text>
																<Button
																	size="compact-xs"
																	color="red"
																	loading={revertFile.isPending}
																	onClick={() => handleRevert(file.filePath)}
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
																		setConfirmRevert(file.filePath);
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
					</Stack>
				</Box>
			)}
		</Box>
	);
}
