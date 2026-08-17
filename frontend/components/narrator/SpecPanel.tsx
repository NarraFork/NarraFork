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
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconChecklist, IconFileText, IconLock, IconX } from "@tabler/icons-react";
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
import { registerSpecFileSelector } from "./spec-file-reveal";

const SpecMarkdownEditor = lazy(() =>
	import("./SpecMarkdownEditor").then((m) => ({ default: m.SpecMarkdownEditor })),
);

interface SpecPanelProps {
	narratorId: string;
	onClose: () => void;
	/**
	 * When true (dock surface), suppress this panel's own title bar — the dock's
	 * ToolPanelShell provides the single header. The file-tabs row stays as the content top row.
	 */
	chromeless?: boolean;
}

const TASKS_URI = "spec://tasks.json";

export function SpecPanel({ narratorId, onClose, chromeless = false }: SpecPanelProps) {
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
	// Monotonic edit counter. A save captures the version it is persisting; if the
	// user edits again while the request is in flight the version advances, so on
	// success we only clear `dirty` when nothing changed meanwhile — otherwise the
	// newer edits would be silently treated as saved and lost on reload.
	const editVersionRef = useRef(0);
	// Bumped whenever we accept fresh server content, so the editor resets.
	const [docRevisionKey, setDocRevisionKey] = useState<string>("");

	// UI editability comes from the file metadata (available from the list even
	// before the detail query resolves), falling back to the loaded file.
	const uiEditable = fileData?.uiEditable ?? selectedMeta?.uiEditable ?? true;
	// Agent-readonly: the assistant's tools can't write it (e.g. behavior_fence).
	const isAgentReadonly = fileData?.readonly ?? selectedMeta?.readonly ?? false;
	// Preview-only in the UI: not a task file and not UI-editable.
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

	/**
	 * Publish the selector so a chat row can reveal one file (see `spec-file-reveal`).
	 *
	 * Deliberately `handleSelectFile` and not a raw `setSelectedUri`: the unsaved-edits
	 * confirmation lives in that handler, and bypassing it would let an external jump
	 * silently discard whatever the reader was typing.
	 */
	useEffect(
		() => registerSpecFileSelector(narratorId, (uri: string) => void handleSelectFile(uri)),
		[narratorId, handleSelectFile],
	);

	const handleSave = useCallback(async () => {
		if (isPreviewOnly) return;
		const content = isTasksFile
			? `${JSON.stringify({ tasks: editTasks }, null, "\t")}\n`
			: editContent;
		const savedVersion = editVersionRef.current;
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
			// Only clear dirty if no edit landed after this save started. If the user
			// changed something meanwhile, keep dirty so the newer state can be saved.
			if (editVersionRef.current === savedVersion) {
				setDirty(false);
			}
			// A working narrator gets the edit as a cut-in message right after its
			// current tool call, so say so rather than implying it landed silently.
			notifications.show({
				message: result.interjected ? t("spec.savedInterjected") : t("spec.saved"),
				color: "green",
				autoClose: result.interjected ? 2500 : 1500,
			});
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

	const handleTasksChange = useCallback((next: SpecTaskItem[]) => {
		editVersionRef.current += 1;
		setEditTasks(next);
		setDirty(true);
	}, []);

	const handleContentChange = useCallback((next: string) => {
		editVersionRef.current += 1;
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
					style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
				>
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						<IconChecklist size={15} color="var(--mantine-color-indigo-4)" />
						<Text size="xs" fw={600}>
							{t("spec.title")}
						</Text>
					</Group>
					<Box style={{ flex: 1 }} />
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
							originalTasks={tasksData?.document.tasks ?? []}
							dirty={dirty}
							compiled={tasksData?.compiled ?? null}
							onChange={handleTasksChange}
							onSave={handleSave}
							onReload={handleReload}
							isSaving={updateFile.isPending}
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
										"1px solid light-dark(var(--mantine-color-yellow-2), var(--mantine-color-default-border))",
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
									dirty={dirty}
									onSave={handleSave}
									onReload={handleReload}
									isSaving={updateFile.isPending}
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

	const agentSettings = settingsData?.agent as Record<string, unknown> | undefined;
	const globalMode: AutoContinuationMode =
		(agentSettings?.autoContinuationMode as AutoContinuationMode) ?? "protectedOnly";
	const override = normalizeAutoContinuationOverride(narrator?.autoContinuationOverride);
	const effectiveMode = resolveAutoContinuationMode(override, globalMode);

	const globalInterval =
		typeof agentSettings?.tasksReminderInterval === "number"
			? (agentSettings.tasksReminderInterval as number)
			: 15;
	const intervalOverrideRaw = narrator?.tasksReminderIntervalOverride;
	const intervalOverride =
		typeof intervalOverrideRaw === "number" ? (intervalOverrideRaw as number) : null;
	const effectiveInterval = intervalOverride ?? globalInterval;

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

	const handleIntervalChange = useCallback(
		async (value: number) => {
			const next = Number.isFinite(value) ? Math.trunc(value) : -1;
			let clamped = Math.max(-1, Math.min(1000, next));
			if (clamped >= 0 && clamped <= 4) {
				if (effectiveInterval < clamped) {
					clamped = 5;
				} else {
					clamped = -1;
				}
			}
			if (clamped === effectiveInterval) return;
			reflectionOverridesMutation.mutate({
				id: narratorId,
				tasksReminderIntervalOverride: clamped === globalInterval ? null : clamped,
			});
		},
		[effectiveInterval, narratorId, globalInterval, reflectionOverridesMutation],
	);

	const handleFollowDefaultInterval = useCallback(() => {
		reflectionOverridesMutation.mutate({ id: narratorId, tasksReminderIntervalOverride: null });
	}, [narratorId, reflectionOverridesMutation]);

	const handleSetIntervalAsDefault = useCallback(() => {
		updateSettingsMutation.mutate({ agent: { tasksReminderInterval: effectiveInterval } });
		reflectionOverridesMutation.mutate({ id: narratorId, tasksReminderIntervalOverride: null });
	}, [effectiveInterval, narratorId, reflectionOverridesMutation, updateSettingsMutation]);

	const isPending = reflectionOverridesMutation.isPending || updateSettingsMutation.isPending;
	const intervalDiffers = intervalOverride !== null;

	return (
		<Box px="sm" py={6} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
			{/* Auto-continuation control */}
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
				mb={intervalDiffers || override !== "inherit" ? 4 : 8}
			/>
			{override !== "inherit" && (
				<Group justify="space-between" mt={4} mb={8} wrap="nowrap" style={{ width: "100%" }}>
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

			{/* Periodic tasks reminder injection interval */}
			<Group justify="space-between" align="center" wrap="nowrap" gap="xs" mt={8} mb={4}>
				<Text size="xs" fw={600}>
					{t("spec.tasksReminderIntervalLabel")}
				</Text>
				<IntervalNumberInput value={effectiveInterval} onCommit={handleIntervalChange} />
			</Group>
			<Text size="xs" c="dimmed" mb={intervalDiffers ? 2 : 4}>
				{effectiveInterval > 0
					? t("spec.tasksReminderIntervalOn", { count: effectiveInterval })
					: t("spec.tasksReminderIntervalOff")}
			</Text>
			{intervalDiffers && (
				<Group justify="space-between" mt={4} mb={4} wrap="nowrap" style={{ width: "100%" }}>
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
		</Box>
	);
}

/**
 * Interval NumberInput that keeps the typed value as local draft state and only
 * commits on blur or Enter. Committing per keystroke would fire a save on every
 * character and the accompanying `disabled` toggle would strip keyboard focus
 * mid-typing. Intentionally never disabled for the same reason: the value is
 * re-synced from props whenever the field is not being edited.
 */
function IntervalNumberInput({
	value,
	onCommit,
}: {
	value: number;
	onCommit: (next: number) => void;
}) {
	const [draft, setDraft] = useState<number | string>(value);
	// Live-typing flag as a ref: it never affects the render output, it only gates
	// the prop-sync effect below.
	const editingRef = useRef(false);

	useEffect(() => {
		if (editingRef.current) return;
		setDraft(value);
	}, [value]);

	const commit = useCallback(() => {
		editingRef.current = false;
		const parsed = typeof draft === "number" ? draft : Number.parseInt(String(draft).trim(), 10);
		if (!Number.isFinite(parsed)) {
			setDraft(value);
			return;
		}
		onCommit(parsed);
	}, [draft, onCommit, value]);

	return (
		<NumberInput
			size="xs"
			w={110}
			min={-1}
			max={1000}
			step={1}
			allowDecimal={false}
			value={draft}
			onChange={(v) => {
				editingRef.current = true;
				setDraft(v);
			}}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				}
			}}
		/>
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

	const handleIntervalChange = useCallback(
		async (value: number) => {
			const next = Number.isFinite(value) ? Math.trunc(value) : -1;
			let clamped = Math.max(-1, Math.min(1000, next));
			if (clamped >= 0 && clamped <= 4) {
				if (effectiveInterval < clamped) {
					clamped = 5;
				} else {
					clamped = -1;
				}
			}
			if (clamped === effectiveInterval) return;
			// Store as override; if it equals the global default, fall back to "follow default".
			fenceMutation.mutate({
				id: narratorId,
				behaviorFenceIntervalOverride: clamped === globalInterval ? null : clamped,
			});
		},
		[effectiveInterval, fenceMutation, narratorId, globalInterval],
	);

	const handleAttachChange = useCallback(
		async (value: string) => {
			const nextAttach = value === "on";
			// If user picks the same as global default, store as "inherit"
			const override: FenceAttachOverride =
				nextAttach === globalAttach ? "inherit" : (value as "on" | "off");
			fenceMutation.mutate({ id: narratorId, behaviorFenceAttachOverride: override });
		},
		[globalAttach, fenceMutation, narratorId],
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
		<Box px="sm" py={8} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
			{/* Periodic injection interval */}
			<Group justify="space-between" align="center" wrap="nowrap" gap="xs" mb={4}>
				<Text size="xs" fw={600}>
					{t("spec.fenceIntervalLabel")}
				</Text>
				<IntervalNumberInput value={effectiveInterval} onCommit={handleIntervalChange} />
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
					value={effectiveAttach ? "on" : "off"}
					onChange={handleAttachChange}
					disabled={isPending}
					data={[
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
