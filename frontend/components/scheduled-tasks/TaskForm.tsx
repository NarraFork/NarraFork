import { DirectoryPicker } from "@frontend/components/common/DirectoryPicker";
import { useUnsavedChangesGuard } from "@frontend/components/knowledge/editor/useUnsavedChangesGuard";
import { useAllModels } from "@frontend/hooks/useModels";
import { useProjects } from "@frontend/hooks/useProjects";
import {
	useCreateScheduledTask,
	useSchedulePreview,
	useUpdateScheduledTask,
} from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { FOLLOW_DEFAULT_MODEL } from "@frontend/lib/constants";
import {
	Accordion,
	Alert,
	Button,
	Grid,
	Group,
	Modal,
	NumberInput,
	Paper,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { LOCALE_OPTIONS } from "@shared/i18n-locales";
import { parseSchedule } from "@shared/scheduled-task-schedule";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { ScheduleEditor } from "./ScheduleEditor";
import { SchedulePreviewPanel } from "./SchedulePreviewPanel";
import { scheduleSummary } from "./schedule-presentation";
import { TaskTargetPicker } from "./TaskTargetPicker";
import {
	createTaskDraft,
	scheduleWasChanged,
	type TaskDraft,
	taskDraftInput,
	taskPreviewSchedule,
	updateTaskDraft,
} from "./task-form-state";

export function TaskForm({
	task,
	copy = false,
	onSaved,
	onCancel,
}: {
	task?: ScheduledTask;
	copy?: boolean;
	onSaved: (task: ScheduledTask) => void;
	onCancel: () => void;
}) {
	const { t, i18n } = useTranslation("scheduledTasks");
	const [initial] = useState(() => createTaskDraft(task, copy, i18n.language));
	const [draft, setDraft] = useState(initial);
	const [saved, setSaved] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const { data: projects = [], isError: projectsError } = useProjects();
	const { groupedModels } = useAllModels();
	const create = useCreateScheduledTask();
	const update = useUpdateScheduledTask();
	const editing = !!task && !copy;
	const scheduleChanged = editing && scheduleWasChanged(draft, initial);
	const dirty = !saved && JSON.stringify(draft) !== JSON.stringify(initial);
	const guard = useUnsavedChangesGuard(dirty);
	const parsed = parseSchedule(draft.schedule);
	const issue = parsed.ok ? null : parsed.issue;
	const issueText = issue ? t(`validation.${issue.code}`) : undefined;
	const preview = useSchedulePreview(
		taskPreviewSchedule(draft, editing ? initial : undefined),
		draft.timezone || null,
		editing && !scheduleChanged ? task.firedCount : 0,
	);
	const pending = create.isPending || update.isPending;
	const patch = (values: Partial<TaskDraft>) => {
		setDraft((old) => updateTaskDraft(old, values));
		setSaveError(null);
	};
	const submit = async () => {
		if (
			pending ||
			saved ||
			((!editing || scheduleChanged) && (preview.isFetching || preview.debouncing))
		)
			return;
		setSubmitted(true);
		if (
			!draft.name.trim() ||
			!draft.prompt.trim() ||
			!parsed.ok ||
			(!draft.timezone && !(editing && task.timezone === null)) ||
			(draft.narratorMode === "existing"
				? !draft.targetNarratorId
				: draft.runContext === "project" && !draft.projectId) ||
			(draft.onBusy === "wait" &&
				(!Number.isInteger(draft.busyWaitMinutes) ||
					(draft.busyWaitMinutes ?? 0) < 1 ||
					(draft.busyWaitMinutes ?? 0) > 1440))
		)
			return;
		if (preview.error && (!editing || scheduleChanged)) return;
		try {
			const changes = taskDraftInput(draft, initial);
			const result = editing
				? Object.keys(changes).length > 0
					? await update.mutateAsync({ id: task.id, data: changes })
					: task
				: await create.mutateAsync(taskDraftInput(draft));
			flushSync(() => setSaved(true));
			onSaved(result);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : t("saveFailed"));
		}
	};
	const policy = draft.cleanupPolicy ?? { mode: "none" };
	return (
		<>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<Grid gap="lg">
					<Grid.Col span={{ base: 12, md: 8 }}>
						<Stack gap="lg">
							{copy && <Alert color="blue">{t("copyHint")}</Alert>}
							{saveError && (
								<Alert color="red" title={t("saveFailed")}>
									{saveError}
								</Alert>
							)}
							<Paper withBorder p="lg" radius="md">
								<Stack>
									<Title order={3}>{t("basicSection")}</Title>
									<TextInput
										required
										label={t("name")}
										placeholder={t("namePlaceholder")}
										maxLength={200}
										value={draft.name}
										onChange={(event) => patch({ name: event.currentTarget.value })}
										error={submitted && !draft.name.trim() ? t("required") : undefined}
									/>
									<Textarea
										required
										label={t("prompt")}
										description={t("promptDesc")}
										placeholder={t("promptPlaceholder")}
										minRows={5}
										autosize
										maxRows={18}
										maxLength={50_000}
										value={draft.prompt}
										onChange={(event) => patch({ prompt: event.currentTarget.value })}
										error={submitted && !draft.prompt.trim() ? t("required") : undefined}
									/>
									<Switch
										label={t("enableSchedule")}
										checked={draft.enabled ?? true}
										onChange={(event) => patch({ enabled: event.currentTarget.checked })}
									/>
								</Stack>
							</Paper>
							<Paper withBorder p="lg" radius="md">
								<Stack>
									<Title order={3}>{t("schedule")}</Title>
									<ScheduleEditor
										schedule={draft.schedule}
										timezone={draft.timezone}
										allowServerTimezone={editing && task.timezone === null}
										onChange={(schedule) => patch({ schedule })}
										onTimezoneChange={(timezone) => patch({ timezone })}
										errorPath={issue?.path}
										error={issueText}
									/>
									{scheduleChanged && (
										<Alert color="orange" icon={<IconAlertTriangle size={16} />}>
											{t("scheduleResetWarning")}
										</Alert>
									)}
									{editing && !scheduleChanged && (
										<Text size="xs" c="dimmed">
											{t("schedulePreserved")}
										</Text>
									)}
								</Stack>
							</Paper>
							<Paper withBorder p="lg" radius="md">
								<Stack>
									<Title order={3}>{t("executionTarget")}</Title>
									<Select
										label={t("narratorMode")}
										value={draft.narratorMode}
										allowDeselect={false}
										data={[
											{ value: "new", label: t("modeNew") },
											{ value: "reuse", label: t("modeReuse") },
											{ value: "existing", label: t("modeExisting") },
										]}
										onChange={(value) =>
											patch({ narratorMode: value as TaskDraft["narratorMode"] })
										}
									/>
									{draft.narratorMode === "existing" && (
										<>
											<TaskTargetPicker
												value={draft.targetNarratorId ?? null}
												onChange={(targetNarratorId) => patch({ targetNarratorId })}
												error={submitted && !draft.targetNarratorId ? t("required") : undefined}
											/>
											<Alert color="blue">{t("existingInherited")}</Alert>
										</>
									)}
									{draft.narratorMode !== "new" && (
										<>
											<Select
												label={t("contextPolicy")}
												value={draft.contextPolicy}
												allowDeselect={false}
												data={[
													{ value: "keep", label: t("context.keep") },
													{ value: "clear", label: t("context.clear") },
												]}
												onChange={(value) =>
													patch({ contextPolicy: value as TaskDraft["contextPolicy"] })
												}
											/>
											{draft.contextPolicy === "clear" && (
												<Alert color="orange">{t("contextClearWarning")}</Alert>
											)}
										</>
									)}
									{draft.narratorMode !== "existing" && (
										<>
											<Select
												label={t("runContext")}
												value={draft.runContext}
												data={[
													{ value: "standalone", label: t("ctxStandalone") },
													{ value: "project", label: t("ctxProject") },
												]}
												onChange={(value) =>
													patch({ runContext: value as TaskDraft["runContext"] })
												}
											/>
											{draft.runContext === "project" && (
												<Select
													required
													label={t("project")}
													description={
														projectsError
															? t("projectsLoadFailed")
															: projects.length === 0
																? t("noProjectsAvailable")
																: t("projectDesc")
													}
													data={projects.map((project) => ({
														value: project.id,
														label: project.name,
													}))}
													searchable
													value={draft.projectId || null}
													onChange={(value) => patch({ projectId: value ?? "" })}
													error={submitted && !draft.projectId ? t("required") : undefined}
												/>
											)}
											<DirectoryPicker
												label={t("cwd")}
												description={t(
													draft.runContext === "project" ? "cwdProjectDesc" : "cwdDesc",
												)}
												value={draft.cwd}
												onChange={(cwd) => patch({ cwd })}
											/>
										</>
									)}
									{draft.narratorMode !== "new" && (
										<Select
											label={t("modelPolicy")}
											description={t(
												draft.narratorMode === "existing"
													? "existingModelPolicyHint"
													: "modelPolicyHint",
											)}
											value={draft.modelPolicy}
											allowDeselect={false}
											data={["follow", "temporary", "sync"].map((value) => ({
												value,
												label: t(`policy.${value}`),
											}))}
											onChange={(value) =>
												patch({ modelPolicy: value as TaskDraft["modelPolicy"] })
											}
										/>
									)}
									{(draft.narratorMode !== "existing" || draft.modelPolicy !== "follow") && (
										<Select
											label={t("model")}
											description={t("modelDesc")}
											data={groupedModels}
											searchable
											limit={100}
											value={draft.model || FOLLOW_DEFAULT_MODEL}
											onChange={(value) =>
												patch({ model: value && value !== FOLLOW_DEFAULT_MODEL ? value : "" })
											}
										/>
									)}
									{draft.narratorMode !== "existing" && (
										<>
											<Select
												label={t("permissionMode")}
												description={t("permissionModeDesc")}
												value={draft.permissionMode}
												data={[
													{ value: "default", label: t("permDefault") },
													{ value: "acceptEdits", label: t("permAcceptEdits") },
													{ value: "readOnly", label: t("permReadOnly") },
													{ value: "dontAsk", label: t("permDontAsk") },
													{ value: "bypassPermissions", label: t("permBypass") },
												]}
												onChange={(value) => patch({ permissionMode: value ?? "default" })}
											/>
											{draft.permissionMode === "bypassPermissions" && (
												<Alert color="orange" icon={<IconAlertTriangle size={16} />}>
													{t("bypassWarning")}
												</Alert>
											)}
										</>
									)}
								</Stack>
							</Paper>
							<Paper withBorder p="lg" radius="md">
								<Stack>
									<Title order={3}>{t("unattendedSection")}</Title>
									<Select
										label={t("onBusy")}
										value={draft.onBusy}
										allowDeselect={false}
										data={["skip", "wait", "interrupt"].map((value) => ({
											value,
											label: t(`busyPolicy.${value}`),
										}))}
										onChange={(value) => patch({ onBusy: value as TaskDraft["onBusy"] })}
									/>
									{draft.onBusy === "wait" && (
										<NumberInput
											label={t("busyWaitMinutes")}
											description={t("busyWaitHint")}
											min={1}
											max={1440}
											allowDecimal={false}
											value={draft.busyWaitMinutes}
											onChange={(value) => patch({ busyWaitMinutes: Number(value) })}
											error={
												submitted &&
												((draft.busyWaitMinutes ?? 0) < 1 || (draft.busyWaitMinutes ?? 0) > 1440)
													? t("validation.invalid_interval")
													: undefined
											}
										/>
									)}
									{draft.onBusy === "interrupt" && (
										<Alert color="orange">{t("busyInterruptWarning")}</Alert>
									)}
									<Switch
										label={t("requireReport")}
										description={t("requireReportHint")}
										checked={draft.requireReport ?? true}
										onChange={(event) => patch({ requireReport: event.currentTarget.checked })}
									/>
									<Select
										label={t("onBlocked")}
										description={t("onBlockedHint")}
										value={draft.onBlocked}
										data={[
											{ value: "auto", label: t("blockedPolicy.auto") },
											{ value: "wait", label: t("blockedPolicy.wait") },
										]}
										onChange={(value) => patch({ onBlocked: value as TaskDraft["onBlocked"] })}
									/>
									{draft.onBlocked === "wait" && (
										<NumberInput
											label={t("blockedWaitMinutes")}
											min={1}
											max={1440}
											allowDecimal={false}
											value={draft.blockedWaitMinutes}
											onChange={(value) => patch({ blockedWaitMinutes: Number(value) })}
										/>
									)}
									<NumberInput
										label={t("maxRunMinutes")}
										min={5}
										max={1440}
										allowDecimal={false}
										value={draft.maxRunMinutes}
										onChange={(value) => patch({ maxRunMinutes: Number(value) })}
									/>
									<Switch
										label={t("notifyOnSuccess")}
										description={t("notificationHint")}
										checked={draft.notifyOnSuccess ?? false}
										onChange={(event) => patch({ notifyOnSuccess: event.currentTarget.checked })}
									/>
								</Stack>
							</Paper>
							{draft.narratorMode !== "existing" && (
								<Accordion variant="separated" radius="md">
									<Accordion.Item value="retention">
										<Accordion.Control>{t("cleanupPolicy")}</Accordion.Control>
										<Accordion.Panel>
											<Stack>
												<Select
													label={t("cleanupPolicy")}
													value={policy.mode}
													data={[
														{ value: "none", label: t("cleanupNone") },
														{ value: "keepLatestN", label: t("cleanupKeepLatestN") },
														{ value: "olderThanDays", label: t("cleanupOlderThanDays") },
													]}
													onChange={(value) =>
														patch({
															cleanupPolicy:
																value === "keepLatestN"
																	? { mode: value, keepLatestN: 20 }
																	: value === "olderThanDays"
																		? { mode: value, olderThanDays: 30 }
																		: { mode: "none" },
														})
													}
												/>
												{policy.mode !== "none" && (
													<NumberInput
														label={t(
															policy.mode === "keepLatestN" ? "cleanupKeepCount" : "cleanupDays",
														)}
														min={1}
														max={policy.mode === "keepLatestN" ? 1000 : 3650}
														allowDecimal={false}
														value={
															policy.mode === "keepLatestN"
																? policy.keepLatestN
																: policy.olderThanDays
														}
														onChange={(value) =>
															patch({
																cleanupPolicy:
																	policy.mode === "keepLatestN"
																		? { mode: policy.mode, keepLatestN: Number(value) }
																		: { mode: "olderThanDays", olderThanDays: Number(value) },
															})
														}
													/>
												)}
												<Text size="xs" c="dimmed">
													{t("cleanupWarning")}
												</Text>
											</Stack>
										</Accordion.Panel>
									</Accordion.Item>
									<Accordion.Item value="advanced">
										<Accordion.Control>{t("advancedSection")}</Accordion.Control>
										<Accordion.Panel>
											<Stack>
												<Textarea
													label={t("systemPrompt")}
													autosize
													minRows={3}
													maxRows={12}
													maxLength={10_000}
													value={draft.systemPrompt}
													onChange={(event) => patch({ systemPrompt: event.currentTarget.value })}
												/>
												<Select
													label={t("locale")}
													data={LOCALE_OPTIONS}
													value={draft.locale}
													onChange={(value) => patch({ locale: value as TaskDraft["locale"] })}
												/>
											</Stack>
										</Accordion.Panel>
									</Accordion.Item>
								</Accordion>
							)}
						</Stack>
					</Grid.Col>
					<Grid.Col span={{ base: 12, md: 4 }}>
						<Stack style={{ position: "sticky", top: 20 }}>
							<Text fw={500} size="sm">
								{scheduleSummary(draft.schedule, t)}
							</Text>
							<SchedulePreviewPanel
								timezone={draft.timezone || null}
								preview={preview.data}
								loading={preview.isFetching || preview.debouncing}
								error={issueText ?? (preview.error ? preview.error.message : null)}
							/>
							<Text size="xs" c="dimmed">
								{t("lifecycleHint")}
							</Text>
						</Stack>
					</Grid.Col>
				</Grid>
				<Group justify="flex-end" mt="lg">
					<Button variant="default" onClick={onCancel} disabled={pending}>
						{t("cancel")}
					</Button>
					<Button
						type="submit"
						loading={pending}
						disabled={
							saved || ((!editing || scheduleChanged) && (preview.isFetching || preview.debouncing))
						}
					>
						{t("save")}
					</Button>
				</Group>
			</form>
			<Modal
				opened={guard.status === "blocked"}
				onClose={() => guard.reset?.()}
				title={t("unsavedTitle")}
				centered
			>
				<Stack>
					<Text size="sm">{t("unsavedBody")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => guard.reset?.()}>
							{t("keepEditing")}
						</Button>
						<Button color="red" onClick={() => guard.proceed?.()}>
							{t("discardChanges")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
