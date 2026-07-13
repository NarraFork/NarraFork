import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Chip,
	Container,
	Group,
	Modal,
	NumberInput,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { LOCALE_OPTIONS, type Locale } from "@shared/i18n-locales";
import {
	IconAlertTriangle,
	IconChevronRight,
	IconClock,
	IconFolder,
	IconHistory,
	IconMessage,
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "../../components/common/DirectoryPicker";
import { useChapters } from "../../hooks/useChapters";
import { useAllModels } from "../../hooks/useModels";
import { useProjects } from "../../hooks/useProjects";
import {
	useCreateScheduledTask,
	useDeleteScheduledTask,
	useRunScheduledTask,
	useScheduledTasks,
	useToggleScheduledTask,
	useUpdateScheduledTask,
} from "../../hooks/useScheduledTasks";
import type { ScheduledTask, ScheduledTaskInput } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import {
	type CronPresetState,
	cronToPreset,
	DEFAULT_CRON_PRESET,
	presetToCron,
} from "../../lib/cron-presets";
import { formatRelativeTime } from "../../lib/format";
import { formatLocaleDateTime } from "../../lib/intl-format";

const MODEL_SELECT_OPTION_LIMIT = 100;

export const Route = createFileRoute("/scheduled-tasks/")({
	component: ScheduledTasksPage,
});

interface TaskDraft {
	name: string;
	prompt: string;
	systemPrompt: string;
	model: string;
	permissionMode: string;
	locale: Locale;
	runContext: "standalone" | "chapter";
	cwd: string;
	projectId: string;
	chapterId: string;
	narratorMode: "new" | "reuse";
	enabled: boolean;
	timezone: string;
}

const EMPTY_DRAFT: TaskDraft = {
	name: "",
	prompt: "",
	systemPrompt: "",
	model: "",
	permissionMode: "bypassPermissions",
	locale: "zh-CN",
	runContext: "standalone",
	cwd: "",
	projectId: "",
	chapterId: "",
	narratorMode: "new",
	enabled: true,
	timezone: "",
};

function draftFromTask(task: ScheduledTask): TaskDraft {
	return {
		name: task.name,
		prompt: task.prompt,
		systemPrompt: task.systemPrompt ?? "",
		model: task.model ?? "",
		permissionMode: task.permissionMode,
		locale: task.locale,
		runContext: task.runContext,
		cwd: task.cwd ?? "",
		projectId: task.projectId ?? "",
		chapterId: task.chapterId ?? "",
		narratorMode: task.narratorMode,
		enabled: task.enabled,
		timezone: task.timezone ?? "",
	};
}

function ScheduledTasksPage() {
	const { t } = useTranslation("scheduledTasks");
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	const { data: tasks = [], isLoading } = useScheduledTasks();

	const createMutation = useCreateScheduledTask();
	const updateMutation = useUpdateScheduledTask();
	const toggleMutation = useToggleScheduledTask();
	const runMutation = useRunScheduledTask();
	const deleteMutation = useDeleteScheduledTask();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null);
	const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
	const [preset, setPreset] = useState<CronPresetState>(DEFAULT_CRON_PRESET);

	const cronExpr = useMemo(() => presetToCron(preset), [preset]);

	const startCreate = useCallback(() => {
		setEditingId(null);
		setDraft(EMPTY_DRAFT);
		setPreset(DEFAULT_CRON_PRESET);
		openEdit();
	}, [openEdit]);

	const startEdit = useCallback(
		(task: ScheduledTask) => {
			setEditingId(task.id);
			setDraft(draftFromTask(task));
			setPreset(cronToPreset(task.cronExpr));
			openEdit();
		},
		[openEdit],
	);

	const buildInput = useCallback((): ScheduledTaskInput => {
		const isChapter = draft.runContext === "chapter";
		return {
			name: draft.name.trim(),
			cronExpr,
			timezone: draft.timezone.trim() || null,
			prompt: draft.prompt,
			systemPrompt: draft.systemPrompt.trim() || null,
			model: draft.model.trim() || null,
			permissionMode: draft.permissionMode,
			locale: draft.locale,
			runContext: draft.runContext,
			cwd: isChapter ? null : draft.cwd.trim() || null,
			projectId: isChapter ? draft.projectId || null : null,
			chapterId: isChapter ? draft.chapterId || null : null,
			narratorMode: draft.narratorMode,
			enabled: draft.enabled,
		};
	}, [draft, cronExpr]);

	const handleSave = useCallback(() => {
		const input = buildInput();
		if (editingId) {
			updateMutation.mutate({ id: editingId, data: input }, { onSuccess: closeEdit });
		} else {
			createMutation.mutate(input, { onSuccess: closeEdit });
		}
	}, [buildInput, editingId, updateMutation, createMutation, closeEdit]);

	const confirmDelete = useCallback(() => {
		if (!deletingTask) return;
		deleteMutation.mutate(deletingTask.id, { onSuccess: closeDelete });
	}, [deletingTask, deleteMutation, closeDelete]);

	const chapterModeValid =
		draft.runContext !== "chapter" || (!!draft.projectId && !!draft.chapterId);
	const saveDisabled = !draft.name.trim() || !draft.prompt.trim() || !cronExpr || !chapterModeValid;

	return (
		<Container size="md" py="lg">
			<style>
				{`.scheduled-task-row-open{padding:6px 8px;margin:-6px -8px;transition:background-color 120ms ease;}
				.scheduled-task-row-open:hover{background-color:var(--mantine-color-default-hover);}`}
			</style>
			<Group justify="space-between" mb="md" align="flex-start">
				<Stack gap={4}>
					<Group gap="xs">
						<IconClock size={22} />
						<Title order={2}>{t("title")}</Title>
					</Group>
					<Text size="sm" c="dimmed">
						{t("subtitle")}
					</Text>
				</Stack>
				<Button leftSection={<IconPlus size={16} />} onClick={startCreate}>
					{t("createTask")}
				</Button>
			</Group>

			{isLoading ? (
				<Text c="dimmed">{t("loading")}</Text>
			) : tasks.length === 0 ? (
				<Paper withBorder p="xl" ta="center">
					<Text c="dimmed">{t("empty")}</Text>
				</Paper>
			) : (
				<Stack gap="sm">
					{tasks.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							onEdit={() => startEdit(task)}
							onDelete={() => {
								setDeletingTask(task);
								openDelete();
							}}
							onToggle={(enabled) => toggleMutation.mutate({ id: task.id, enabled })}
							onRun={() => runMutation.mutate(task.id)}
							onDetails={() =>
								navigate({ to: "/scheduled-tasks/$taskId", params: { taskId: task.id } })
							}
							onOpenNarrator={(narratorId) =>
								navigate({ to: "/narrators/$narratorId", params: { narratorId } })
							}
							running={runMutation.isPending && runMutation.variables === task.id}
						/>
					))}
				</Stack>
			)}

			<TaskFormModal
				opened={editOpened}
				onClose={closeEdit}
				isEditing={!!editingId}
				draft={draft}
				setDraft={setDraft}
				preset={preset}
				setPreset={setPreset}
				cronExpr={cronExpr}
				onSave={handleSave}
				saveDisabled={saveDisabled}
				saving={createMutation.isPending || updateMutation.isPending}
			/>

			<Modal
				opened={deleteOpened}
				onClose={closeDelete}
				title={t("deleteTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("deleteConfirm", { name: deletingTask?.name ?? "" })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{tc("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{tc("delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Container>
	);
}

function TaskRow({
	task,
	onEdit,
	onDelete,
	onToggle,
	onRun,
	onDetails,
	onOpenNarrator,
	running,
}: {
	task: ScheduledTask;
	onEdit: () => void;
	onDelete: () => void;
	onToggle: (enabled: boolean) => void;
	onRun: () => void;
	onDetails: () => void;
	onOpenNarrator: (narratorId: string) => void;
	running: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const nextRun = task.nextRunAt ? formatLocaleDateTime(task.nextRunAt) : "—";
	const lastRunAbs = task.lastRunAt ? formatLocaleDateTime(task.lastRunAt) : null;
	const lastRunRel = task.lastRunAt ? formatRelativeTime(task.lastRunAt) : null;
	const lastStatusColor = task.lastStatus
		? task.lastStatus === "success"
			? "teal"
			: task.lastStatus === "skipped"
				? "yellow"
				: "red"
		: "gray";

	return (
		<Paper withBorder p="md">
			<Group justify="space-between" wrap="nowrap" align="flex-start">
				{/* Whole info area is a single large click target into the detail page. */}
				<UnstyledButton
					onClick={onDetails}
					title={t("viewDetails")}
					style={{ minWidth: 0, flex: 1, borderRadius: 8 }}
					className="scheduled-task-row-open"
				>
					<Group gap="sm" wrap="nowrap" align="flex-start">
						<Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
							<Group gap="xs">
								<Text fw={600} truncate>
									{task.name}
								</Text>
								<Badge size="sm" variant="light" color={task.enabled ? "teal" : "gray"}>
									{task.enabled ? t("statusEnabled") : t("statusDisabled")}
								</Badge>
								<Badge size="sm" variant="outline" color="indigo">
									{task.runContext === "chapter" ? t("ctxChapter") : t("ctxStandalone")}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" ff="monospace">
								{task.cronExpr}
								{task.timezone ? ` (${task.timezone})` : ""}
							</Text>
							<Text size="xs" c="dimmed">
								{t("nextRun")}: {nextRun}
							</Text>

							{/* Last-run summary: status + when + error, with a direct link to its narrator. */}
							<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
								<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
									{t("lastRun")}:
								</Text>
								{task.lastStatus ? (
									<>
										<Badge
											size="sm"
											variant="light"
											color={lastStatusColor}
											style={{ flexShrink: 0 }}
										>
											{t(`last_${task.lastStatus}`)}
										</Badge>
										{lastRunRel && (
											<Text
												size="xs"
												c="dimmed"
												style={{ flexShrink: 0 }}
												title={lastRunAbs ?? undefined}
											>
												{lastRunRel}
											</Text>
										)}
										{task.lastError && (
											<Text size="xs" c="red" truncate title={task.lastError}>
												{task.lastError}
											</Text>
										)}
									</>
								) : (
									<Text size="xs" c="dimmed">
										{t("neverRun")}
									</Text>
								)}
							</Group>

							<Group gap={4} wrap="nowrap" c="indigo">
								<IconHistory size={14} />
								<Text size="xs" fw={500}>
									{t("viewRunHistory")}
								</Text>
								<IconChevronRight size={14} />
							</Group>
						</Stack>
					</Group>
				</UnstyledButton>
				<Group gap="xs" wrap="nowrap">
					<Switch
						checked={task.enabled}
						onChange={(e) => onToggle(e.currentTarget.checked)}
						size="sm"
					/>
					{task.lastNarratorId && (
						<Tooltip label={t("openLastNarrator")}>
							<ActionIcon
								variant="subtle"
								onClick={() => onOpenNarrator(task.lastNarratorId as string)}
								aria-label={t("openLastNarrator")}
							>
								<IconMessage size={16} />
							</ActionIcon>
						</Tooltip>
					)}
					<Tooltip label={t("runNow")}>
						<ActionIcon variant="subtle" onClick={onRun} loading={running} aria-label={t("runNow")}>
							<IconPlayerPlay size={16} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("edit")}>
						<ActionIcon variant="subtle" onClick={onEdit} aria-label={t("edit")}>
							<IconPencil size={16} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("delete")}>
						<ActionIcon variant="subtle" color="red" onClick={onDelete} aria-label={t("delete")}>
							<IconTrash size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>
		</Paper>
	);
}

function TaskFormModal({
	opened,
	onClose,
	isEditing,
	draft,
	setDraft,
	preset,
	setPreset,
	cronExpr,
	onSave,
	saveDisabled,
	saving,
}: {
	opened: boolean;
	onClose: () => void;
	isEditing: boolean;
	draft: TaskDraft;
	setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
	preset: CronPresetState;
	setPreset: React.Dispatch<React.SetStateAction<CronPresetState>>;
	cronExpr: string;
	onSave: () => void;
	saveDisabled: boolean;
	saving: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const { t: tc } = useTranslation("common");
	const { data: projects = [] } = useProjects();
	const { data: chapters = [] } = useChapters(
		draft.runContext === "chapter" ? draft.projectId : "",
	);
	const { groupedModels } = useAllModels();

	const patch = useCallback(
		(p: Partial<TaskDraft>) => setDraft((d) => ({ ...d, ...p })),
		[setDraft],
	);
	const patchPreset = useCallback(
		(p: Partial<CronPresetState>) => setPreset((s) => ({ ...s, ...p })),
		[setPreset],
	);

	const weekdayOptions = [
		{ value: "1", label: t("mon") },
		{ value: "2", label: t("tue") },
		{ value: "3", label: t("wed") },
		{ value: "4", label: t("thu") },
		{ value: "5", label: t("fri") },
		{ value: "6", label: t("sat") },
		{ value: "0", label: t("sun") },
	];

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={isEditing ? t("editTask") : t("createTask")}
			size="lg"
		>
			<Stack>
				<TextInput
					label={t("name")}
					placeholder={t("namePlaceholder")}
					required
					value={draft.name}
					onChange={(e) => {
						const v = e.currentTarget.value;
						patch({ name: v });
					}}
				/>

				<Textarea
					label={t("prompt")}
					description={t("promptDesc")}
					placeholder={t("promptPlaceholder")}
					required
					autosize
					minRows={3}
					maxRows={10}
					value={draft.prompt}
					onChange={(e) => {
						const v = e.currentTarget.value;
						patch({ prompt: v });
					}}
				/>

				{/* Schedule */}
				<Stack gap="xs">
					<Text size="sm" fw={500}>
						{t("schedule")}
					</Text>
					<SegmentedControl
						fullWidth
						size="xs"
						value={preset.kind}
						onChange={(v) => patchPreset({ kind: v as CronPresetState["kind"] })}
						data={[
							{ value: "everyNMinutes", label: t("presetEveryN") },
							{ value: "hourly", label: t("presetHourly") },
							{ value: "daily", label: t("presetDaily") },
							{ value: "weekly", label: t("presetWeekly") },
							{ value: "custom", label: t("presetCustom") },
						]}
					/>

					{preset.kind === "everyNMinutes" && (
						<NumberInput
							label={t("everyNLabel")}
							min={1}
							max={59}
							value={preset.minutes}
							onChange={(v) => patchPreset({ minutes: Number(v) || 1 })}
						/>
					)}
					{preset.kind === "hourly" && (
						<NumberInput
							label={t("hourlyMinuteLabel")}
							min={0}
							max={59}
							value={preset.hourlyMinute}
							onChange={(v) => patchPreset({ hourlyMinute: Number(v) || 0 })}
						/>
					)}
					{preset.kind === "weekly" && (
						<Stack gap={4}>
							<Text size="sm">{t("weekday")}</Text>
							<Chip.Group
								multiple
								value={preset.weekdays.map(String)}
								onChange={(vals) => {
									const days = vals.map(Number);
									patchPreset({ weekdays: days.length > 0 ? days : [1] });
								}}
							>
								<Group gap="xs">
									{weekdayOptions.map((opt) => (
										<Chip key={opt.value} value={opt.value} size="xs">
											{opt.label}
										</Chip>
									))}
								</Group>
							</Chip.Group>
						</Stack>
					)}
					{(preset.kind === "daily" || preset.kind === "weekly") && (
						<Group grow>
							<NumberInput
								label={t("hour")}
								min={0}
								max={23}
								value={preset.hour}
								onChange={(v) => patchPreset({ hour: Number(v) || 0 })}
							/>
							<NumberInput
								label={t("minute")}
								min={0}
								max={59}
								value={preset.minute}
								onChange={(v) => patchPreset({ minute: Number(v) || 0 })}
							/>
						</Group>
					)}
					{preset.kind === "custom" && (
						<TextInput
							label={t("cronExpr")}
							description={t("cronExprDesc")}
							placeholder="0 9 * * 1"
							value={preset.custom}
							onChange={(e) => {
								const v = e.currentTarget.value;
								patchPreset({ custom: v });
							}}
						/>
					)}
					<Text size="xs" c="dimmed">
						{t("compiledCron")}: <span style={{ fontFamily: "monospace" }}>{cronExpr || "—"}</span>
					</Text>
					<TextInput
						label={t("timezone")}
						description={t("timezoneDesc")}
						placeholder="Asia/Shanghai"
						value={draft.timezone}
						onChange={(e) => {
							const v = e.currentTarget.value;
							patch({ timezone: v });
						}}
					/>
				</Stack>

				{/* Run context */}
				<Stack gap="xs">
					<Text size="sm" fw={500}>
						{t("runContext")}
					</Text>
					<SegmentedControl
						fullWidth
						size="xs"
						value={draft.runContext}
						onChange={(v) => patch({ runContext: v as TaskDraft["runContext"] })}
						data={[
							{ value: "standalone", label: t("ctxStandalone") },
							{ value: "chapter", label: t("ctxChapter") },
						]}
					/>
					{draft.runContext === "standalone" ? (
						<DirectoryPicker
							label={t("cwd")}
							description={t("cwdDesc")}
							placeholder="/home/user/project"
							leftSection={<IconFolder size={16} />}
							value={draft.cwd}
							onChange={(v) => patch({ cwd: v })}
						/>
					) : (
						<Group grow align="flex-start">
							<Select
								label={t("project")}
								placeholder={t("selectProject")}
								data={projects.map((p) => ({ value: p.id, label: p.name }))}
								value={draft.projectId || null}
								onChange={(v) => patch({ projectId: v ?? "", chapterId: "" })}
								searchable
							/>
							<Select
								label={t("chapter")}
								placeholder={t("selectChapter")}
								data={chapters.map((c) => ({ value: c.id, label: c.title || c.branch }))}
								value={draft.chapterId || null}
								onChange={(v) => patch({ chapterId: v ?? "" })}
								disabled={!draft.projectId}
								searchable
							/>
						</Group>
					)}
				</Stack>

				{/* Narrator options */}
				<Group grow align="flex-start">
					<Select
						label={t("narratorMode")}
						description={t("narratorModeDesc")}
						data={[
							{ value: "new", label: t("modeNew") },
							{ value: "reuse", label: t("modeReuse") },
						]}
						value={draft.narratorMode}
						onChange={(v) => patch({ narratorMode: (v as TaskDraft["narratorMode"]) ?? "new" })}
						disabled={draft.runContext === "chapter"}
					/>
					<Select
						label={t("locale")}
						data={LOCALE_OPTIONS}
						value={draft.locale}
						onChange={(v) => patch({ locale: (v as TaskDraft["locale"]) ?? "en" })}
					/>
				</Group>

				<Select
					label={t("model")}
					description={t("modelDesc")}
					data={groupedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					value={draft.model || FOLLOW_DEFAULT_MODEL}
					onChange={(v) => patch({ model: v && v !== FOLLOW_DEFAULT_MODEL ? v : "" })}
					maxDropdownHeight={320}
					comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
				/>

				<Select
					label={t("permissionMode")}
					description={t("permissionModeDesc")}
					data={[
						{ value: "bypassPermissions", label: t("permBypass") },
						{ value: "acceptEdits", label: t("permAcceptEdits") },
						{ value: "default", label: t("permDefault") },
						{ value: "readOnly", label: t("permReadOnly") },
						{ value: "dontAsk", label: t("permDontAsk") },
					]}
					value={draft.permissionMode}
					onChange={(v) => patch({ permissionMode: v ?? "bypassPermissions" })}
				/>

				{draft.permissionMode === "bypassPermissions" && (
					<Alert color="orange" icon={<IconAlertTriangle size={16} />} p="xs">
						<Text size="xs">{t("bypassWarning")}</Text>
					</Alert>
				)}

				<Switch
					label={t("enabled")}
					checked={draft.enabled}
					onChange={(e) => {
						const v = e.currentTarget.checked;
						patch({ enabled: v });
					}}
				/>

				<Group justify="flex-end" gap="xs" mt="xs">
					<Button variant="subtle" onClick={onClose}>
						{tc("cancel")}
					</Button>
					<Button onClick={onSave} disabled={saveDisabled} loading={saving}>
						{tc("save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
