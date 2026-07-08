import { useConfirmDialog } from "@frontend/components/common/ConfirmDialogProvider";
import {
	ActionIcon,
	Anchor,
	Box,
	Center,
	Group,
	Loader,
	NumberInput,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useNarrator,
	useUpdateBehaviorFence,
	useUpdateReflectionOverrides,
} from "../../hooks/useNarrator";
import { useSpecFile, useSpecFiles, useSpecTasks, useUpdateSpecFile } from "../../hooks/useSpec";
import { api } from "../../lib/api";
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

	// Stable wrappers so the hoisted header-actions node (below) does not change
	// identity every render. `handleSave` depends on the react-query mutation
	// object, which is a fresh reference each render; calling through refs keeps
	// the reported node stable and avoids an infinite update loop in dock mode.
	const handleSaveRef = useRef(handleSave);
	handleSaveRef.current = handleSave;
	const handleReloadRef = useRef(handleReload);
	handleReloadRef.current = handleReload;
	const stableSave = useCallback(() => handleSaveRef.current(), []);
	const stableReload = useCallback(() => handleReloadRef.current(), []);

	useHotkeys([
		[
			"mod+s",
			(e) => {
				e.preventDefault();
				if (dirty && !isPreviewOnly) handleSave();
			},
		],
	]);

	// The save/reload controls hoisted into the dock's shared header. Memoized so
	// the node keeps a stable identity unless something that affects the buttons
	// actually changes — using the stable* wrappers (not handleSave/handleReload,
	// which change every render via the react-query mutation object).
	const headerActionsNode = useMemo<React.ReactNode>(() => {
		if (!chromeless || !(dirty && !isPreviewOnly)) return null;
		return (
			<>
				<Tooltip label={t("spec.reload")}>
					<ActionIcon size="sm" variant="subtle" color="gray" onClick={stableReload}>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("spec.save")}>
					<ActionIcon
						size="sm"
						variant="light"
						color="green"
						onClick={stableSave}
						loading={updateFile.isPending}
					>
						<IconDeviceFloppy size={14} />
					</ActionIcon>
				</Tooltip>
			</>
		);
	}, [chromeless, dirty, isPreviewOnly, updateFile.isPending, stableSave, stableReload, t]);

	// In chromeless (dock) mode, hoist the controls into the dock's shared header
	// via the reporting callback. Clears on unmount / when clean.
	useEffect(() => {
		if (!chromeless || !onHeaderActionsChange) return;
		onHeaderActionsChange(headerActionsNode);
		return () => onHeaderActionsChange(null);
	}, [chromeless, onHeaderActionsChange, headerActionsNode]);

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
						<AutoContinuationControl narratorId={narratorId} />
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
									borderBottom:
										"1px solid light-dark(var(--mantine-color-yellow-2), var(--mantine-color-dark-4))",
									background:
										"light-dark(var(--mantine-color-yellow-0), color-mix(in srgb, var(--mantine-color-yellow-9) 18%, var(--mantine-color-dark-6)))",
								}}
							>
								<IconLock
									size={13}
									color="var(--mantine-color-yellow-6)"
									style={{ marginTop: 2 }}
								/>
								<Text
									size="xs"
									style={{
										color:
											"light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-1))",
									}}
								>
									{t("spec.behaviorFenceEditHint")}
								</Text>
							</Group>
						)}
						{selectedMeta?.path === "behavior_fence" && (
							<BehaviorFenceControl narratorId={narratorId} />
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

// === Auto-continuation mode control (tasks tab header) ===

type AutoContinuationMode = "always" | "blockStop" | "protectedOnly" | "off";
type AutoContinuationOverride = "inherit" | AutoContinuationMode;

const AUTO_CONTINUATION_MODE_VALUES: AutoContinuationMode[] = [
	"always",
	"blockStop",
	"protectedOnly",
	"off",
];

function normalizeAutoContinuationOverride(value: unknown): AutoContinuationOverride {
	const valid = new Set(["inherit", "always", "blockStop", "protectedOnly", "off"]);
	return typeof value === "string" && valid.has(value)
		? (value as AutoContinuationOverride)
		: "inherit";
}

function resolveAutoContinuationMode(
	override: AutoContinuationOverride,
	globalMode: AutoContinuationMode,
): AutoContinuationMode {
	return override === "inherit" ? globalMode : override;
}

function AutoContinuationControl({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const { data: settingsData } = useQuery<Record<string, unknown>>({
		queryKey: ["settings"],
		queryFn: () => api.getSettings(),
	});
	const { data: narrator } = useNarrator(narratorId);

	const globalMode: AutoContinuationMode =
		((settingsData?.agent as Record<string, unknown> | undefined)
			?.autoContinuationMode as AutoContinuationMode) ?? "always";
	const override = normalizeAutoContinuationOverride(narrator?.autoContinuationOverride);
	const effectiveMode = resolveAutoContinuationMode(override, globalMode);

	const reflectionOverridesMutation = useUpdateReflectionOverrides();
	const updateSettingsMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
		},
	});

	const handleChange = useCallback(
		(value: string) => {
			const mode = value as AutoContinuationMode;
			// If user picks the same as global, store as "inherit"
			const overrideValue: AutoContinuationOverride = mode === globalMode ? "inherit" : mode;
			reflectionOverridesMutation.mutate({
				id: narratorId,
				autoContinuationOverride: overrideValue,
			});
		},
		[globalMode, narratorId, reflectionOverridesMutation],
	);

	const handleFollowDefault = useCallback(() => {
		reflectionOverridesMutation.mutate({ id: narratorId, autoContinuationOverride: "inherit" });
	}, [narratorId, reflectionOverridesMutation]);

	const handleSetAsDefault = useCallback(() => {
		updateSettingsMutation.mutate({ agent: { autoContinuationMode: effectiveMode } });
		reflectionOverridesMutation.mutate({ id: narratorId, autoContinuationOverride: "inherit" });
	}, [effectiveMode, narratorId, reflectionOverridesMutation, updateSettingsMutation]);

	const isPending = reflectionOverridesMutation.isPending || updateSettingsMutation.isPending;

	return (
		<Box px="sm" py={6} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
			<Group justify="space-between" align="center" wrap="nowrap" gap="xs" mb={4}>
				<Text size="xs" fw={600}>
					{t("autoContinuation")}
				</Text>
			</Group>
			<SegmentedControl
				size="xs"
				fullWidth
				value={effectiveMode}
				onChange={handleChange}
				disabled={isPending}
				data={AUTO_CONTINUATION_MODE_VALUES.map((mode) => ({
					value: mode,
					label: t(`autoContinuationMode_${mode}`),
				}))}
			/>
			{override !== "inherit" && (
				<Group justify="space-between" mt={4} wrap="nowrap" style={{ width: "100%" }}>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleFollowDefault}
					>
						{t("override_followDefault")}
					</Anchor>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleSetAsDefault}
					>
						{t("override_setAsDefault")}
					</Anchor>
				</Group>
			)}
		</Box>
	);
}

type FenceAttachOverride = "inherit" | "on" | "off";

function normalizeFenceAttachOverride(value: unknown): FenceAttachOverride {
	return value === "on" || value === "off" ? value : "inherit";
}

function resolveFenceAttach(override: FenceAttachOverride, globalDefault: boolean): boolean {
	if (override === "inherit") return globalDefault;
	return override === "on";
}

/**
 * Behavior-fence injection settings for the current narrator: periodic-injection
 * interval (completed tool calls, -1 = off) and whether the fence rides along with
 * the tasks.json reminder. Both support follow-default / set-as-default against the
 * global settings, mirroring AutoContinuationControl. When a change would enable both
 * the periodic interval and the tasks-attach at once, the user is asked to confirm.
 */
function BehaviorFenceControl({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const confirm = useConfirmDialog();
	const { data: settingsData } = useQuery<Record<string, unknown>>({
		queryKey: ["settings"],
		queryFn: () => api.getSettings(),
	});
	const { data: narrator } = useNarrator(narratorId);

	const agentSettings = settingsData?.agent as Record<string, unknown> | undefined;
	const globalInterval =
		typeof agentSettings?.behaviorFenceInterval === "number"
			? (agentSettings.behaviorFenceInterval as number)
			: -1;
	const globalAttach = agentSettings?.behaviorFenceAttachTasks !== false;

	const intervalOverrideRaw = narrator?.behaviorFenceIntervalOverride;
	const intervalOverride =
		typeof intervalOverrideRaw === "number" ? (intervalOverrideRaw as number) : null;
	const attachOverride = normalizeFenceAttachOverride(narrator?.behaviorFenceAttachOverride);

	const effectiveInterval = intervalOverride ?? globalInterval;
	const effectiveAttach = resolveFenceAttach(attachOverride, globalAttach);

	const fenceMutation = useUpdateBehaviorFence();
	const updateSettingsMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
		},
	});
	const isPending = fenceMutation.isPending || updateSettingsMutation.isPending;

	// Ask for confirmation when a change turns on BOTH the periodic interval and the
	// tasks-attach at the same time (they stack, so the fence would inject on two cadences).
	const confirmIfBothEnabled = useCallback(
		async (nextInterval: number, nextAttach: boolean): Promise<boolean> => {
			if (nextInterval > 0 && nextAttach) {
				return confirm({
					title: t("spec.fenceBothTitle"),
					message: t("spec.fenceBothMessage"),
					confirmLabel: t("spec.fenceBothConfirm"),
					cancelLabel: t("cancel"),
				});
			}
			return true;
		},
		[confirm, t],
	);

	const handleIntervalChange = useCallback(
		async (value: number) => {
			const next = Number.isFinite(value) ? Math.trunc(value) : -1;
			const clamped = Math.max(-1, Math.min(1000, next));
			if (clamped === effectiveInterval) return;
			const ok = await confirmIfBothEnabled(clamped, effectiveAttach);
			if (!ok) return;
			// Store as override; if it equals the global default, fall back to "follow default".
			fenceMutation.mutate({
				id: narratorId,
				behaviorFenceIntervalOverride: clamped === globalInterval ? null : clamped,
			});
		},
		[
			effectiveInterval,
			effectiveAttach,
			confirmIfBothEnabled,
			fenceMutation,
			narratorId,
			globalInterval,
		],
	);

	const handleAttachChange = useCallback(
		async (value: string) => {
			const override = normalizeFenceAttachOverride(value);
			const nextAttach = resolveFenceAttach(override, globalAttach);
			const ok = await confirmIfBothEnabled(effectiveInterval, nextAttach);
			if (!ok) return;
			fenceMutation.mutate({ id: narratorId, behaviorFenceAttachOverride: override });
		},
		[globalAttach, effectiveInterval, confirmIfBothEnabled, fenceMutation, narratorId],
	);

	const handleFollowDefaultInterval = useCallback(() => {
		fenceMutation.mutate({ id: narratorId, behaviorFenceIntervalOverride: null });
	}, [fenceMutation, narratorId]);

	const handleSetIntervalAsDefault = useCallback(() => {
		updateSettingsMutation.mutate({ agent: { behaviorFenceInterval: effectiveInterval } });
		fenceMutation.mutate({ id: narratorId, behaviorFenceIntervalOverride: null });
	}, [effectiveInterval, fenceMutation, narratorId, updateSettingsMutation]);

	const handleFollowDefaultAttach = useCallback(() => {
		fenceMutation.mutate({ id: narratorId, behaviorFenceAttachOverride: "inherit" });
	}, [fenceMutation, narratorId]);

	const handleSetAttachAsDefault = useCallback(() => {
		updateSettingsMutation.mutate({ agent: { behaviorFenceAttachTasks: effectiveAttach } });
		fenceMutation.mutate({ id: narratorId, behaviorFenceAttachOverride: "inherit" });
	}, [effectiveAttach, fenceMutation, narratorId, updateSettingsMutation]);

	const intervalDiffers = intervalOverride !== null;
	const attachDiffers = attachOverride !== "inherit";

	return (
		<Box px="sm" py={8} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
			{/* Periodic injection interval */}
			<Group justify="space-between" align="center" wrap="nowrap" gap="xs" mb={4}>
				<Text size="xs" fw={600}>
					{t("spec.fenceIntervalLabel")}
				</Text>
				<NumberInput
					size="xs"
					w={110}
					min={-1}
					max={1000}
					step={1}
					allowDecimal={false}
					value={effectiveInterval}
					onChange={(v) => handleIntervalChange(typeof v === "number" ? v : -1)}
					disabled={isPending}
				/>
			</Group>
			<Text size="xs" c="dimmed" mb={intervalDiffers ? 2 : 6}>
				{effectiveInterval > 0
					? t("spec.fenceIntervalOn", { count: effectiveInterval })
					: t("spec.fenceIntervalOff")}
			</Text>
			{intervalDiffers && (
				<Group justify="space-between" mb={6} wrap="nowrap" style={{ width: "100%" }}>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleFollowDefaultInterval}
					>
						{t("override_followDefault")}
					</Anchor>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleSetIntervalAsDefault}
					>
						{t("override_setAsDefault")}
					</Anchor>
				</Group>
			)}

			{/* Attach-to-tasks toggle */}
			<Group justify="space-between" align="center" wrap="nowrap" gap="xs" mb={4}>
				<Text size="xs" fw={600}>
					{t("spec.fenceAttachLabel")}
				</Text>
				<SegmentedControl
					size="xs"
					value={attachOverride}
					onChange={handleAttachChange}
					disabled={isPending}
					data={[
						{ value: "inherit", label: t("override_inherit") },
						{ value: "on", label: t("override_on") },
						{ value: "off", label: t("override_off") },
					]}
				/>
			</Group>
			<Text size="xs" c="dimmed" mb={attachDiffers ? 2 : 0}>
				{effectiveAttach ? t("spec.fenceAttachOn") : t("spec.fenceAttachOff")}
			</Text>
			{attachDiffers && (
				<Group justify="space-between" mt={2} wrap="nowrap" style={{ width: "100%" }}>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleFollowDefaultAttach}
					>
						{t("override_followDefault")}
					</Anchor>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", opacity: isPending ? 0.45 : 1 }}
						onClick={handleSetAttachAsDefault}
					>
						{t("override_setAsDefault")}
					</Anchor>
				</Group>
			)}
		</Box>
	);
}
