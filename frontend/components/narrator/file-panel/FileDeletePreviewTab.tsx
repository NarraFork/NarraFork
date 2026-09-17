import { useDeletePreview } from "@frontend/hooks/useNarrator";
import { toRelativePath } from "@frontend/lib/format";
import { formatRevertWarning, formatRevertWarnings } from "@frontend/lib/revert-warnings";
import {
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFile, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../../common/TruncatedPath";
import { DiffView } from "../diff/DiffView";

const MAX_DELETE_PREVIEW_FILES = 1_000;

export function FileDeletePreviewTab({
	narratorId,
	basePath,
	messageId,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	basePath: string | null;
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
	const displayedAffectedFiles = affectedFiles.slice(0, MAX_DELETE_PREVIEW_FILES);
	const hiddenAffectedFileCount = Math.max(0, affectedFiles.length - displayedAffectedFiles.length);
	const toolCallCount = data?.toolCallCount ?? 0;
	// `affectedFiles` always mirrors the scope the server chose, so only the label and
	// the advisories depend on which scope that was.
	const scopeBadge =
		data?.scope === "workspace"
			? { color: "red", labelKey: "revertScopeWorkspace" }
			: data?.scope === "narrator"
				? { color: "blue", labelKey: "revertScopeNarrator" }
				: { color: "gray", labelKey: "revertScopeLegacy" };
	const workspaceWarningText =
		data?.scope === "workspace" ? formatRevertWarnings(t, data.workspaceScope?.warnings) : null;
	const subagentWarning =
		data?.scope === "narrator" ? data.narratorScope?.subagentWarning : undefined;
	const subagentWarningText = subagentWarning
		? formatRevertWarning(t, {
				code: "SUBAGENT_CHANGES_REVERTED",
				changeCount: subagentWarning.changeCount,
				sampleFilePaths: subagentWarning.sampleFiles,
			})
		: null;

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
		<Box
			style={{
				overflow: "hidden",
				minWidth: 0,
				width: "100%",
				display: "flex",
				flexDirection: "column",
				flex: 1,
			}}
		>
			<Group px="sm" py={4} justify="space-between">
				<Text size="xs" c="dimmed">
					{t("fileMod_affectedFiles", { count: affectedFiles.length })} (
					{t("fileMod_toolCallCount", { count: toolCallCount })})
				</Text>
				{/* Which scope produced this list — deleting reverts files, and in a shared
				    worktree the workspace scope also discards other actors' work. A response
				    without a scope came from the legacy replay preview, so it must not be
				    labelled as either tree-based scope. */}
				<Badge size="xs" variant="light" color={scopeBadge.color}>
					{t(scopeBadge.labelKey)}
				</Badge>
			</Group>

			{workspaceWarningText && (
				<Text size="xs" c="red" px="sm" pb={4}>
					{workspaceWarningText}
				</Text>
			)}
			{subagentWarningText && (
				<Text size="xs" c="yellow" px="sm" pb={4}>
					{subagentWarningText}
				</Text>
			)}

			<Box
				style={{
					flex: 1,
					maxHeight: "calc(100vh - 260px)",
					overflowY: "auto",
					overflowX: "hidden",
					width: "100%",
				}}
			>
				<Stack gap={2} mx="xs">
					{displayedAffectedFiles.map((file) => {
						const lang = file.filePath.split(".").pop() ?? "";
						const isExpanded = expandedFile === file.filePath;
						const displayPath = toRelativePath(file.filePath, basePath);
						return (
							<Box
								key={file.filePath}
								style={{
									borderRadius: "var(--mantine-radius-sm)",
									border: "1px solid var(--mantine-color-default-border)",
									overflow: "hidden",
								}}
							>
								<UnstyledButton
									onClick={() => toggleFile(file.filePath)}
									w="100%"
									py={6}
									px="xs"
									style={{
										backgroundColor: isExpanded ? "var(--mantine-color-default-hover)" : undefined,
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
											{file.willBeDeleted ? (
												<IconTrash size={14} style={{ flexShrink: 0 }} />
											) : (
												<IconFile size={14} style={{ flexShrink: 0 }} />
											)}
											<TruncatedPath path={displayPath} />
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
					{hiddenAffectedFileCount > 0 && (
						<Text size="xs" c="dimmed" ta="center" py="xs">
							{t("fileMod_listTruncated", {
								shown: displayedAffectedFiles.length,
								hidden: hiddenAffectedFileCount,
							})}
						</Text>
					)}
				</Stack>
			</Box>

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
		</Box>
	);
}
