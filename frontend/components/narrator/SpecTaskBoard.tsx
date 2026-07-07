import {
	ActionIcon,
	Badge,
	Group,
	Menu,
	Paper,
	Progress,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	IconArrowRight,
	IconCheck,
	IconCircle,
	IconCircleDot,
	IconExclamationCircle,
	IconLock,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { SpecCompiledTasks, SpecTaskItem } from "../../lib/api/spec";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";

export type SpecTaskStatus = SpecTaskItem["status"];

interface SpecTaskBoardProps {
	tasks: SpecTaskItem[];
	compiled: SpecCompiledTasks | null;
	onChange: (tasks: SpecTaskItem[]) => void;
}

const STATUS_ORDER: SpecTaskStatus[] = ["doing", "todo", "blocked", "done"];

const STATUS_META: Record<SpecTaskStatus, { color: string; icon: typeof IconCircle }> = {
	doing: { color: "indigo", icon: IconCircleDot },
	todo: { color: "gray", icon: IconCircle },
	blocked: { color: "orange", icon: IconExclamationCircle },
	done: { color: "green", icon: IconCheck },
};

/** A single editable task card. */
function TaskCard({
	task,
	index,
	onUpdate,
	onRemove,
	onUnlock,
}: {
	task: SpecTaskItem;
	index: number;
	onUpdate: (index: number, patch: Partial<SpecTaskItem>) => void;
	onRemove: (index: number) => void;
	onUnlock: (index: number) => void;
}) {
	const { t } = useTranslation("narrator");
	const meta = STATUS_META[task.status];
	const StatusIcon = meta.icon;

	return (
		<Paper withBorder radius="sm" p={6} bg="var(--mantine-color-body)">
			<Group gap={6} wrap="nowrap" align="flex-start">
				{/* Status toggle via menu */}
				<Menu shadow="md" position="bottom-start" withinPortal>
					<Menu.Target>
						<Tooltip label={t("spec.changeStatus")} openDelay={400}>
							<ActionIcon size="sm" variant="subtle" color={meta.color} mt={2}>
								<StatusIcon size={16} />
							</ActionIcon>
						</Tooltip>
					</Menu.Target>
					<Menu.Dropdown>
						{STATUS_ORDER.map((status) => {
							const m = STATUS_META[status];
							const Icon = m.icon;
							return (
								<Menu.Item
									key={status}
									leftSection={<Icon size={14} color={`var(--mantine-color-${m.color}-6)`} />}
									onClick={() => onUpdate(index, { status })}
									disabled={status === task.status}
								>
									{t(`spec.status.${status}`)}
								</Menu.Item>
							);
						})}
					</Menu.Dropdown>
				</Menu>

				{/* Editable task text */}
				<TextInput
					variant="unstyled"
					size="xs"
					style={{ flex: 1 }}
					value={task.text}
					onChange={(e) => onUpdate(index, { text: e.currentTarget.value })}
					placeholder={t("spec.taskPlaceholder")}
					styles={{
						input: {
							minHeight: 22,
							height: "auto",
							textDecoration: task.status === "done" ? "line-through" : undefined,
							opacity: task.status === "done" ? 0.6 : 1,
						},
					}}
				/>

				{/* Protected: click the lock to unlock; otherwise delete */}
				{task.protected ? (
					<Tooltip label={t("spec.unlockProtected")} openDelay={200} multiline w={240}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="yellow"
							mt={2}
							onClick={() => onUnlock(index)}
							aria-label={t("spec.unlockProtected")}
						>
							<IconLock size={14} />
						</ActionIcon>
					</Tooltip>
				) : (
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						mt={2}
						onClick={() => onRemove(index)}
						aria-label={t("spec.deleteTask")}
					>
						<IconTrash size={14} />
					</ActionIcon>
				)}
			</Group>
		</Paper>
	);
}

/** A status column grouping tasks. */
function StatusColumn({
	status,
	tasks,
	onUpdate,
	onRemove,
	onUnlock,
}: {
	status: SpecTaskStatus;
	tasks: { task: SpecTaskItem; index: number }[];
	onUpdate: (index: number, patch: Partial<SpecTaskItem>) => void;
	onRemove: (index: number) => void;
	onUnlock: (index: number) => void;
}) {
	const { t } = useTranslation("narrator");
	const meta = STATUS_META[status];
	if (tasks.length === 0) return null;

	return (
		<Stack gap={4}>
			<Group gap={6} align="center">
				<Text size="xs" fw={700} c={meta.color} tt="uppercase">
					{t(`spec.group.${status}`)}
				</Text>
				<Badge size="xs" variant="light" color={meta.color} radius="sm">
					{tasks.length}
				</Badge>
			</Group>
			<Stack gap={4}>
				{tasks.map(({ task, index }) => (
					<TaskCard
						key={index}
						task={task}
						index={index}
						onUpdate={onUpdate}
						onRemove={onRemove}
						onUnlock={onUnlock}
					/>
				))}
			</Stack>
		</Stack>
	);
}

export function SpecTaskBoard({ tasks, compiled, onChange }: SpecTaskBoardProps) {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();

	const updateTask = useCallback(
		(index: number, patch: Partial<SpecTaskItem>) => {
			onChange(tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)));
		},
		[tasks, onChange],
	);

	const unlockTask = useCallback(
		async (index: number) => {
			const ok = await confirm({
				title: t("spec.unlockConfirmTitle"),
				message: t("spec.unlockConfirmMessage"),
				confirmLabel: t("spec.unlockConfirmLabel"),
				confirmColor: "yellow",
			});
			if (!ok) return;
			// Drop the protected flag so the task becomes an ordinary editable/removable task.
			onChange(
				tasks.map((task, i) => {
					if (i !== index) return task;
					const { protected: _protected, ...rest } = task;
					return rest;
				}),
			);
		},
		[tasks, onChange, confirm, t],
	);

	const removeTask = useCallback(
		(index: number) => {
			onChange(tasks.filter((_, i) => i !== index));
		},
		[tasks, onChange],
	);

	const addTask = useCallback(() => {
		onChange([...tasks, { text: "", status: "todo" }]);
	}, [tasks, onChange]);

	// Group tasks by status while preserving their original index (for edits)
	const grouped: Record<SpecTaskStatus, { task: SpecTaskItem; index: number }[]> = {
		doing: [],
		todo: [],
		blocked: [],
		done: [],
	};
	tasks.forEach((task, index) => {
		grouped[task.status].push({ task, index });
	});

	const total = tasks.length;
	const doneCount = grouped.done.length;
	const protectedOpen = compiled?.protectedOpenCount ?? 0;
	const progressPct = total > 0 ? (doneCount / total) * 100 : 0;

	return (
		<Stack gap="sm" p="xs">
			{/* Progress overview */}
			<Paper withBorder radius="sm" p="sm">
				<Stack gap={6}>
					<Group justify="space-between" align="center">
						<Text size="xs" fw={600}>
							{compiled?.complete && total > 0
								? t("spec.allDone")
								: t("spec.progressLabel", { done: doneCount, total })}
						</Text>
						<Group gap={6}>
							{protectedOpen > 0 && (
								<Badge
									size="xs"
									variant="light"
									color="yellow"
									leftSection={<IconLock size={10} />}
								>
									{t("spec.protectedCount", { count: protectedOpen })}
								</Badge>
							)}
							{compiled?.blocked && (
								<Badge size="xs" variant="light" color="orange">
									{t("spec.hasBlocked")}
								</Badge>
							)}
						</Group>
					</Group>
					<Progress
						value={progressPct}
						color={compiled?.complete ? "green" : "indigo"}
						size="sm"
						radius="xl"
					/>
					{compiled?.currentTask && (
						<Group gap={4} wrap="nowrap">
							<IconArrowRight size={12} color="var(--mantine-color-indigo-5)" />
							<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
								{compiled.currentTask.text}
							</Text>
						</Group>
					)}
				</Stack>
			</Paper>

			{/* Empty state */}
			{total === 0 ? (
				<Stack align="center" gap="xs" py="xl">
					<Text size="sm" c="dimmed">
						{t("spec.noTasks")}
					</Text>
				</Stack>
			) : (
				STATUS_ORDER.map((status) => (
					<StatusColumn
						key={status}
						status={status}
						tasks={grouped[status]}
						onUpdate={updateTask}
						onRemove={removeTask}
						onUnlock={unlockTask}
					/>
				))
			)}

			{/* Add task */}
			<ActionIcon
				variant="light"
				color="indigo"
				size="md"
				radius="sm"
				onClick={addTask}
				aria-label={t("spec.addTask")}
				style={{ alignSelf: "flex-start" }}
			>
				<IconPlus size={16} />
			</ActionIcon>
		</Stack>
	);
}
