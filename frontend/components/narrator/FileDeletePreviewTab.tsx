import { useDeletePreview } from "@frontend/hooks/useNarrator";
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
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFile, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "./DiffView";

export function FileDeletePreviewTab({
	narratorId,
	messageId,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	messageId: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useDeletePreview(narratorId, messageId, true);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);

	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" />
			</Center>
		);
	}

	const affectedFiles = data?.affectedFiles ?? [];
	const toolCallCount = data?.toolCallCount ?? 0;

	if (affectedFiles.length === 0) {
		return (
			<Stack gap="md" align="center" py="xl">
				<Text size="sm" c="dimmed">
					{t("fileMod_noFileChanges")}
				</Text>
				<Group gap="sm">
					<Button size="sm" color="red" onClick={onConfirm}>
						{t("fileMod_confirmDelete")}
					</Button>
					<Button size="sm" variant="default" onClick={onCancel}>
						{t("fileMod_cancelDelete")}
					</Button>
				</Group>
			</Stack>
		);
	}

	const toggleFile = (filePath: string) => {
		setExpandedFile((prev) => (prev === filePath ? null : filePath));
	};

	return (
		<Stack gap="xs" h="100%">
			<Group px="sm" py={4} justify="space-between">
				<Text size="xs" c="dimmed">
					{t("fileMod_affectedFiles", { count: affectedFiles.length })} (
					{t("fileMod_toolCallCount", { count: toolCallCount })})
				</Text>
			</Group>

			<ScrollArea.Autosize mah="calc(100vh - 260px)" style={{ flex: 1 }}>
				<Stack gap={2} mx="xs">
					{affectedFiles.map((file) => {
						const lang = file.filePath.split(".").pop() ?? "";
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
											{file.willBeDeleted ? (
												<IconTrash size={14} style={{ flexShrink: 0 }} />
											) : (
												<IconFile size={14} style={{ flexShrink: 0 }} />
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
										<Badge size="xs" variant="light" color={file.willBeDeleted ? "red" : "orange"}>
											{file.willBeDeleted
												? t("fileMod_willBeDeleted")
												: t("fileMod_willBeReverted")}
										</Badge>
									</Group>
								</UnstyledButton>

								{isExpanded && (
									<Box px="xs" pb="xs">
										{file.willBeDeleted ? (
											<Text size="xs" c="dimmed" py="xs">
												{t("fileMod_willBeDeleted")}
											</Text>
										) : (
											<DiffView
												oldStr={file.currentContent ?? ""}
												newStr={file.revertedContent ?? ""}
												maxHeight={400}
												language={lang}
											/>
										)}
									</Box>
								)}
							</Box>
						);
					})}
				</Stack>
			</ScrollArea.Autosize>

			<Box px="sm" pb="sm">
				<Group gap="sm" justify="flex-end">
					<Button size="sm" variant="default" onClick={onCancel}>
						{t("fileMod_cancelDelete")}
					</Button>
					<Button size="sm" color="red" leftSection={<IconTrash size={14} />} onClick={onConfirm}>
						{t("fileMod_confirmDelete")}
					</Button>
				</Group>
			</Box>
		</Stack>
	);
}
