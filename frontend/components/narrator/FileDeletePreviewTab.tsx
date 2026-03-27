import { useDeletePreview } from "@frontend/hooks/useNarrator";
import {
	Accordion,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import { IconFile, IconTrash } from "@tabler/icons-react";
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

	return (
		<Stack gap="xs" h="100%">
			<Group px="sm" py={4} justify="space-between">
				<Text size="xs" c="dimmed">
					{t("fileMod_affectedFiles", { count: affectedFiles.length })} (
					{t("fileMod_toolCallCount", { count: toolCallCount })})
				</Text>
			</Group>

			<ScrollArea.Autosize mah="calc(100vh - 260px)" style={{ flex: 1 }}>
				<Accordion variant="separated" chevronPosition="left" mx="xs">
					{affectedFiles.map((file) => {
						const lang = file.filePath.split(".").pop() ?? "";
						return (
							<Accordion.Item key={file.filePath} value={file.filePath}>
								<Accordion.Control>
									<Group gap="xs" wrap="nowrap" justify="space-between">
										<Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
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
								</Accordion.Control>
								<Accordion.Panel>
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
								</Accordion.Panel>
							</Accordion.Item>
						);
					})}
				</Accordion>
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
