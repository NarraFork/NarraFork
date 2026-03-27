import { useFileDiff, useFileModifications, useRevertFile } from "@frontend/hooks/useNarrator";
import {
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "./DiffView";

function FileDiffContent({
	narratorId,
	snapshotId,
	filePath,
}: {
	narratorId: string;
	snapshotId: string;
	filePath: string;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useFileDiff(narratorId, snapshotId, true);

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

export function FileSummaryTab({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useFileModifications(narratorId);
	const revertFile = useRevertFile(narratorId);
	const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);

	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" />
			</Center>
		);
	}

	const files = data?.files ?? [];

	if (files.length === 0) {
		return (
			<Center py="xl">
				<Text size="sm" c="dimmed">
					{t("fileMod_empty")}
				</Text>
			</Center>
		);
	}

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

	return (
		<Stack gap={0}>
			<Group px="sm" py={6} justify="space-between">
				<Text size="xs" c="dimmed">
					{t("fileMod_fileCount", { count: files.length })}
				</Text>
			</Group>
			<ScrollArea.Autosize mah="calc(100vh - 200px)">
				<Stack gap={2} mx="xs">
					{files.map((file) => {
						const isExpanded = expandedFile === file.filePath;
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
									<Group gap="xs" wrap="nowrap" justify="space-between">
										<Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
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
											<Text
												size="xs"
												ff="monospace"
												style={{
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{file.filePath}
											</Text>
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
											/>
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
										</Stack>
									</Box>
								)}
							</Box>
						);
					})}
				</Stack>
			</ScrollArea.Autosize>
		</Stack>
	);
}
