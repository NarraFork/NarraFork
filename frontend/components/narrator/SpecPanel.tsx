import { useConfirmDialog } from "@frontend/components/common/ConfirmDialogProvider";
import {
	ActionIcon,
	Box,
	Center,
	Group,
	Loader,
	ScrollArea,
	SegmentedControl,
	Text,
	Tooltip,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconChecklist,
	IconDeviceFloppy,
	IconFileText,
	IconLock,
	IconRefresh,
	IconX,
} from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSpecFile, useSpecFiles, useSpecTasks, useUpdateSpecFile } from "../../hooks/useSpec";
import type { SpecTaskItem } from "../../lib/api/spec";
import { MarkdownContent } from "./MarkdownContent";
import { SpecTaskBoard } from "./SpecTaskBoard";

const SpecMarkdownEditor = lazy(() =>
	import("./SpecMarkdownEditor").then((m) => ({ default: m.SpecMarkdownEditor })),
);

interface SpecPanelProps {
	narratorId: string;
	onClose: () => void;
	/**
	 * When true (dock surface), suppress this panel's own title bar — the dock's
	 * ToolPanelShell provides the single header. The save/reload controls are
	 * reported up via `onHeaderActionsChange` so they render in that shared
	 * header; the file-tabs row stays as the content top row.
	 */
	chromeless?: boolean;
	/** Report the header action controls (save/reload) to the dock shell. */
	onHeaderActionsChange?: (node: React.ReactNode | null) => void;
}

const TASKS_URI = "spec://tasks.json";

export function SpecPanel({
	narratorId,
	onClose,
	chromeless = false,
	onHeaderActionsChange,
}: SpecPanelProps) {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const { data: files } = useSpecFiles(narratorId);
	const [selectedUri, setSelectedUri] = useState<string>(TASKS_URI);
	const isTasksFile = selectedUri === TASKS_URI;

	const { data: fileData, isLoading: fileLoading } = useSpecFile(
		narratorId,
		isTasksFile ? "" : selectedUri,
	);
	const { data: tasksData, isLoading: tasksLoading } = useSpecTasks(narratorId);
	const updateFile = useUpdateSpecFile(narratorId);

	// Look up UI-editability from the file list metadata so it is known even
	// before the file content query resolves.
	const selectedMeta = useMemo(
		() => files?.find((f) => f.uri === selectedUri),
		[files, selectedUri],
	);

	// Local editing state
	const [editContent, setEditContent] = useState<string>("");
	const [editTasks, setEditTasks] = useState<SpecTaskItem[]>([]);
	const [dirty, setDirty] = useState(false);
	const baseRevisionRef = useRef<string | null>(null);
	// Bumped whenever we accept fresh server content, so the editor resets.
	const [docRevisionKey, setDocRevisionKey] = useState<string>("");

	// UI editability comes from the file metadata (available from the list even
	// before the detail query resolves), falling back to the loaded file.
	const uiEditable = fileData?.uiEditable ?? selectedMeta?.uiEditable ?? true;
	// Agent-readonly: the assistant's tools can't write it (e.g. behavior_fence).
	const isAgentReadonly = fileData?.readonly ?? selectedMeta?.readonly ?? false;
	// Preview-only in the UI: not a task file and not UI-editable (e.g. HOW_TO_USE_SPEC.md).
	const isPreviewOnly = !isTasksFile && !uiEditable;
	// Show the behavior-fence hint: agent-readonly but the user may still edit it.
	const showFenceEditHint = !isTasksFile && isAgentReadonly && uiEditable;

	// Sync tasks from server (only when not dirty, to avoid clobbering local edits)
	useEffect(() => {
		if (isTasksFile && tasksData && !dirty) {
			setEditTasks(tasksData.document.tasks);
			baseRevisionRef.current = tasksData.revisionId;
		}
	}, [isTasksFile, tasksData, dirty]);

	// Sync file content from server
	useEffect(() => {
		if (!isTasksFile && fileData && !dirty) {
			setEditContent(fileData.content);
			baseRevisionRef.current = fileData.revisionId;
			setDocRevisionKey(`${fileData.uri}:${fileData.revisionId ?? "builtin"}`);
		}
	}, [isTasksFile, fileData, dirty]);

	// File tabs: tasks first, then editable/readonly docs
	const docFiles = useMemo(() => {
		if (!files) return [];
		return files.filter((f) => f.uri !== TASKS_URI);
	}, [files]);

	const handleSelectFile = useCallback(
		async (uri: string) => {
			if (uri === selectedUri) return;
			if (dirty) {
				const ok = await confirm({
					title: t("spec.unsavedTitle"),
					message: t("spec.unsavedMessage"),
					confirmLabel: t("spec.discardConfirm"),
					cancelLabel: t("spec.keepEditing"),
					confirmColor: "red",
				});
				if (!ok) return;
			}
			setDirty(false);
			setSelectedUri(uri);
		},
		[selectedUri, dirty, confirm, t],
	);

	const handleSave = useCallback(async () => {
		if (isPreviewOnly) return;
		const content = isTasksFile
			? `${JSON.stringify({ tasks: editTasks }, null, "\t")}\n`
			: editContent;
		try {
			const result = await updateFile.mutateAsync({
				uri: selectedUri,
				content,
				baseRevisionId: baseRevisionRef.current,
				// Behavior-fence and other agent-readonly edits should always ping the
				// agent via the sidecar so it re-aligns its plan.
				notifyAgent: true,
			});
			baseRevisionRef.current = result.revisionId;
			setDirty(false);
			notifications.show({ message: t("spec.saved"), color: "green", autoClose: 1500 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("conflict") || msg.includes("409")) {
				notifications.show({
					title: t("spec.conflictTitle"),
					message: t("spec.conflictMessage"),
					color: "orange",
					autoClose: 5000,
				});
			} else {
				notifications.show({ title: t("spec.saveError"), message: msg, color: "red" });
			}
		}
	}, [isPreviewOnly, isTasksFile, editTasks, editContent, selectedUri, updateFile, t]);

	const handleReload = useCallback(() => {
		setDirty(false);
		// Force re-sync from server data on next effect run
		if (isTasksFile) {
			if (tasksData) {
				setEditTasks(tasksData.document.tasks);
				baseRevisionRef.current = tasksData.revisionId;
			}
		} else if (fileData) {
			setEditContent(fileData.content);
			baseRevisionRef.current = fileData.revisionId;
			setDocRevisionKey(`${fileData.uri}:${fileData.revisionId ?? "builtin"}:reload:${Date.now()}`);
		}
	}, [isTasksFile, tasksData, fileData]);

	useHotkeys([
		[
			"mod+s",
			(e) => {
				e.preventDefault();
				if (dirty && !isPreviewOnly) handleSave();
			},
		],
	]);

	// In chromeless (dock) mode, hoist the save/reload controls into the dock's
	// shared header via the reporting callback. Non-null only while there are
	// unsaved edits on an editable file. Clears on unmount / when clean.
	useEffect(() => {
		if (!chromeless || !onHeaderActionsChange) return;
		const node =
			dirty && !isPreviewOnly ? (
				<>
					<Tooltip label={t("spec.reload")}>
						<ActionIcon size="sm" variant="subtle" color="gray" onClick={handleReload}>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("spec.save")}>
						<ActionIcon
							size="sm"
							variant="light"
							color="green"
							onClick={handleSave}
							loading={updateFile.isPending}
						>
							<IconDeviceFloppy size={14} />
						</ActionIcon>
					</Tooltip>
				</>
			) : null;
		onHeaderActionsChange(node);
		return () => onHeaderActionsChange(null);
	}, [
		chromeless,
		onHeaderActionsChange,
		dirty,
		isPreviewOnly,
		updateFile.isPending,
		handleSave,
		handleReload,
		t,
	]);

	const handleTasksChange = useCallback((next: SpecTaskItem[]) => {
		setEditTasks(next);
		setDirty(true);
	}, []);

	const handleContentChange = useCallback((next: string) => {
		setEditContent(next);
		setDirty(true);
	}, []);

	const loading = isTasksFile ? tasksLoading : fileLoading;

	// Build segmented control data (Tasks + docs). Keep labels short.
	const fileTabs = useMemo(() => {
		const items: { value: string; label: React.ReactNode }[] = [
			{
				value: TASKS_URI,
				label: (
					<Group gap={4} wrap="nowrap">
						<IconChecklist size={13} />
						<span>{t("spec.tabTasks")}</span>
					</Group>
				),
			},
		];
		for (const f of docFiles) {
			const label =
				f.path === "behavior_fence" ? t("spec.tabBehaviorFence") : f.path.replace(/\.md$/, "");
			items.push({
				value: f.uri,
				label: (
					<Group gap={4} wrap="nowrap">
						{f.readonly ? <IconLock size={12} /> : <IconFileText size={13} />}
						<span>{label}</span>
					</Group>
				),
			});
		}
		return items;
	}, [docFiles, t]);

	return (
		<Box h="100%" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
			{/* Header — hidden in the dock (ToolPanelShell provides it); save/reload
			    are hoisted to the shell via onHeaderActionsChange instead. */}
			{!chromeless && (
				<Group
					gap={6}
					px="xs"
					py={4}
					wrap="nowrap"
					style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
				>
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						<IconChecklist size={15} color="var(--mantine-color-indigo-4)" />
						<Text size="xs" fw={600}>
							{t("spec.title")}
						</Text>
					</Group>
					<Box style={{ flex: 1 }} />
					{dirty && !isPreviewOnly && (
						<>
							<Tooltip label={t("spec.reload")}>
								<ActionIcon size="sm" variant="subtle" color="gray" onClick={handleReload}>
									<IconRefresh size={14} />
								</ActionIcon>
							</Tooltip>
							<Tooltip label={t("spec.save")}>
								<ActionIcon
									size="sm"
									variant="light"
									color="green"
									onClick={handleSave}
									loading={updateFile.isPending}
								>
									<IconDeviceFloppy size={14} />
								</ActionIcon>
							</Tooltip>
						</>
					)}
					<ActionIcon size="sm" variant="subtle" color="gray" onClick={onClose}>
						<IconX size={14} />
					</ActionIcon>
				</Group>
			)}

			{/* File tabs */}
			<Box px="xs" py={6} style={{ flexShrink: 0 }}>
				<ScrollArea type="never" scrollbars="x">
					<SegmentedControl
						size="xs"
						data={fileTabs}
						value={selectedUri}
						onChange={handleSelectFile}
						styles={{ root: { flexWrap: "nowrap" } }}
					/>
				</ScrollArea>
			</Box>

			{/* Content */}
			<Box style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
				{loading ? (
					<Center style={{ flex: 1 }}>
						<Loader size="sm" />
					</Center>
				) : isPreviewOnly ? (
					<ScrollArea style={{ flex: 1 }} p="sm">
						<MarkdownContent text={fileData?.content ?? ""} />
					</ScrollArea>
				) : isTasksFile ? (
					<ScrollArea style={{ flex: 1 }}>
						<SpecTaskBoard
							tasks={editTasks}
							compiled={tasksData?.compiled ?? null}
							onChange={handleTasksChange}
						/>
					</ScrollArea>
				) : (
					<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
						{showFenceEditHint && (
							<Group
								gap={6}
								px="sm"
								py={6}
								wrap="nowrap"
								align="flex-start"
								style={{
									flexShrink: 0,
									borderBottom: "1px solid var(--mantine-color-dark-4)",
									background: "var(--mantine-color-dark-6)",
								}}
							>
								<IconLock
									size={13}
									color="var(--mantine-color-yellow-5)"
									style={{ marginTop: 2 }}
								/>
								<Text size="xs" c="dimmed">
									{t("spec.behaviorFenceEditHint")}
								</Text>
							</Group>
						)}
						<Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
							<Suspense
								fallback={
									<Center style={{ flex: 1 }}>
										<Loader size="sm" />
									</Center>
								}
							>
								<SpecMarkdownEditor
									value={editContent}
									revisionKey={docRevisionKey}
									onChange={handleContentChange}
								/>
							</Suspense>
						</Box>
					</Box>
				)}
			</Box>
		</Box>
	);
}
