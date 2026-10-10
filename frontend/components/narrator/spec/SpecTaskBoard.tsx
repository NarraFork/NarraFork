import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@frontend/lib/dnd-modifiers";
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Menu,
	Paper,
	Progress,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import {
	IconArrowRight,
	IconCheck,
	IconCircle,
	IconCircleDot,
	IconDeviceFloppy,
	IconExclamationCircle,
	IconGripVertical,
	IconLock,
	IconLockOpen,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpecCompiledTasks, SpecTaskItem } from "../../../lib/api/spec";
import { useConfirmDialog } from "../../common/confirm-dialog-context";

export type SpecTaskStatus = SpecTaskItem["status"];

interface SpecTaskBoardProps {
	tasks: SpecTaskItem[];
	originalTasks: SpecTaskItem[];
	dirty: boolean;
	compiled: SpecCompiledTasks | null;
	onChange: (tasks: SpecTaskItem[]) => void;
	onSave: () => void;
	onReload: () => void;
	isSaving: boolean;
}

const STATUS_ORDER: SpecTaskStatus[] = ["doing", "todo", "blocked", "done"];

const STATUS_META: Record<SpecTaskStatus, { color: string; icon: typeof IconCircle }> = {
	doing: { color: "indigo", icon: IconCircleDot },
	todo: { color: "gray", icon: IconCircle },
	blocked: { color: "orange", icon: IconExclamationCircle },
	done: { color: "green", icon: IconCheck },
};

/** A single editable, sortable task card. */
function TaskCard({
	task,
	index,
	onUpdate,
	onRemove,
	onLock,
	onUnlock,
	isModified,
	onSave,
	isSaving,
}: {
	task: SpecTaskItem;
	index: number;
	onUpdate: (index: number, patch: Partial<SpecTaskItem>) => void;
	onRemove: (index: number) => void;
	onLock: (index: number) => void;
	onUnlock: (index: number) => void;
	isModified: boolean;
	onSave: () => void;
	isSaving: boolean;
}) {
	const { t } = useTranslation("narrator");
	const meta = STATUS_META[task.status];
	const StatusIcon = meta.icon;
	// Expand the text area to multiple rows while it holds edit focus so long
	// task descriptions are fully visible; collapse back to a single line on blur.
	const [focused, setFocused] = useState(false);

	// Freeze all mutations while a save is in flight: any edit made between the
	// request and its response would be silently discarded when SpecPanel clears
	// `dirty` on success, so drag/status/text/lock/delete are all disabled here.
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: String(index),
		disabled: isSaving,
	});

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div ref={setNodeRef} style={style}>
			<Paper withBorder radius="sm" p={6} bg="var(--mantine-color-body)">
				<Group gap={6} wrap="nowrap" align="flex-start">
					{/* Drag handle — no Tooltip to avoid flicker during drag */}
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						mt={2}
						disabled={isSaving}
						style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
						aria-label={t("spec.reorderHint")}
						{...attributes}
						{...listeners}
					>
						<IconGripVertical size={14} />
					</ActionIcon>

					{/* Status toggle via menu */}
					<Menu shadow="md" position="bottom-start" withinPortal disabled={isSaving}>
						<Menu.Target>
							<Tooltip label={t("spec.changeStatus")} openDelay={400}>
								<ActionIcon
									size="sm"
									variant="subtle"
									color={meta.color}
									mt={2}
									disabled={isSaving}
								>
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

					{/* Editable task text — expands to multiple rows while focused */}
					<Textarea
						variant="unstyled"
						size="xs"
						autosize
						minRows={1}
						maxRows={focused ? 10 : 1}
						style={{ flex: 1 }}
						value={task.text}
						readOnly={isSaving}
						onChange={(e) => onUpdate(index, { text: e.currentTarget.value })}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
						placeholder={t("spec.taskPlaceholder")}
						title={t("spec.editTaskHint")}
						styles={{
							input: {
								minHeight: 22,
								cursor: "text",
								paddingInline: 6,
								paddingBlock: 2,
								borderRadius: "var(--mantine-radius-sm)",
								border: "1px solid transparent",
								transition: "background-color 100ms ease, border-color 100ms ease",
								textDecoration: task.status === "done" ? "line-through" : undefined,
								opacity: task.status === "done" ? 0.6 : 1,
								"&:hover": {
									backgroundColor: "var(--mantine-color-default-hover)",
								},
								"&:focus": {
									backgroundColor: "var(--mantine-color-body)",
									borderColor: "var(--mantine-color-indigo-5)",
								},
							},
						}}
					/>

					{/* Save button if single task is modified */}
					{isModified && (
						<Tooltip label={t("spec.save")} openDelay={200}>
							<ActionIcon
								size="sm"
								variant="filled"
								color="green"
								mt={2}
								onClick={onSave}
								loading={isSaving}
								aria-label={t("spec.save")}
							>
								<IconDeviceFloppy size={14} />
							</ActionIcon>
						</Tooltip>
					)}

					{/* Protected toggle: locked tasks unlock (with confirm); ordinary tasks lock instantly */}
					{task.protected ? (
						<Tooltip label={t("spec.unlockProtected")} openDelay={200} multiline w={240}>
							<ActionIcon
								size="sm"
								variant="subtle"
								color="yellow"
								mt={2}
								disabled={isSaving}
								onClick={() => onUnlock(index)}
								aria-label={t("spec.unlockProtected")}
							>
								<IconLock size={14} />
							</ActionIcon>
						</Tooltip>
					) : (
						<Tooltip label={t("spec.lockProtected")} openDelay={200} multiline w={240}>
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								mt={2}
								disabled={isSaving}
								onClick={() => onLock(index)}
								aria-label={t("spec.lockProtected")}
							>
								<IconLockOpen size={14} />
							</ActionIcon>
						</Tooltip>
					)}

					{/* Delete (protected tasks must be unlocked before removal) */}
					{!task.protected && (
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							mt={2}
							disabled={isSaving}
							onClick={() => onRemove(index)}
							aria-label={t("spec.deleteTask")}
						>
							<IconTrash size={14} />
						</ActionIcon>
					)}
				</Group>
			</Paper>
		</div>
	);
}

/** A status column grouping tasks, sortable within the group. */
function StatusColumn({
	status,
	tasks,
	onUpdate,
	onRemove,
	onLock,
	onUnlock,
	onReorder,
	isTaskModified,
	onSave,
	isSaving,
}: {
	status: SpecTaskStatus;
	tasks: { task: SpecTaskItem; index: number }[];
	onUpdate: (index: number, patch: Partial<SpecTaskItem>) => void;
	onRemove: (index: number) => void;
	onLock: (index: number) => void;
	onUnlock: (index: number) => void;
	onReorder: (activeIndex: number, overIndex: number) => void;
	isTaskModified: (index: number) => boolean;
	onSave: () => void;
	isSaving: boolean;
}) {
	const { t } = useTranslation("narrator");
	const meta = STATUS_META[status];
	// PointerSensor covers mouse/touch; KeyboardSensor makes reordering operable
	// for keyboard users (focus the grip, then Space to pick up and arrows to move).
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			onReorder(Number(active.id), Number(over.id));
		},
		[onReorder],
	);

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
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis]}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={tasks.map(({ index }) => String(index))}
					strategy={verticalListSortingStrategy}
				>
					<Stack gap={4}>
						{tasks.map(({ task, index }) => (
							<TaskCard
								key={index}
								task={task}
								index={index}
								onUpdate={onUpdate}
								onRemove={onRemove}
								onLock={onLock}
								onUnlock={onUnlock}
								isModified={isTaskModified(index)}
								onSave={onSave}
								isSaving={isSaving}
							/>
						))}
					</Stack>
				</SortableContext>
			</DndContext>
		</Stack>
	);
}

export function SpecTaskBoard({
	tasks,
	originalTasks,
	dirty,
	compiled,
	onChange,
	onSave,
	onReload,
	isSaving,
}: SpecTaskBoardProps) {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();

	const isTaskModified = useCallback(
		(index: number) => {
			const original = originalTasks[index];
			if (!original) return true; // new task
			const current = tasks[index];
			if (!current) return false;
			return (
				current.text !== original.text ||
				current.status !== original.status ||
				Boolean(current.protected) !== Boolean(original.protected)
			);
		},
		[originalTasks, tasks],
	);

	const updateTask = useCallback(
		(index: number, patch: Partial<SpecTaskItem>) => {
			onChange(tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)));
		},
		[tasks, onChange],
	);

	const lockTask = useCallback(
		(index: number) => {
			// Marking a task protected is a tightening commitment — apply immediately.
			onChange(tasks.map((task, i) => (i === index ? { ...task, protected: true } : task)));
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

	// Reorder two tasks that share the same status, by their flat-array indices.
	// Only the slots occupied by that status are permuted; every other task keeps
	// its position, so the flat array order (which the agent reads) stays coherent.
	const reorderWithinStatus = useCallback(
		(activeIndex: number, overIndex: number) => {
			const active = tasks[activeIndex];
			const over = tasks[overIndex];
			if (!active || !over || active.status !== over.status) return;

			// Flat slots this status currently occupies, in order.
			const slots: number[] = [];
			tasks.forEach((task, i) => {
				if (task.status === active.status) slots.push(i);
			});

			const from = slots.indexOf(activeIndex);
			const to = slots.indexOf(overIndex);
			if (from < 0 || to < 0) return;

			// Reorder the tasks belonging to this status, then write them back into
			// the same slot positions.
			const groupTasks = slots.map((slot) => tasks[slot]);
			const [moved] = groupTasks.splice(from, 1);
			groupTasks.splice(to, 0, moved);

			const next = [...tasks];
			slots.forEach((slot, i) => {
				next[slot] = groupTasks[i];
			});
			onChange(next);
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
						onLock={lockTask}
						onUnlock={unlockTask}
						onReorder={reorderWithinStatus}
						isTaskModified={isTaskModified}
						onSave={onSave}
						isSaving={isSaving}
					/>
				))
			)}

			{/* Add task and general Save/Discard controls */}
			<Group gap="xs" style={{ alignSelf: "flex-start" }}>
				<ActionIcon
					variant="light"
					color="indigo"
					size="md"
					radius="sm"
					onClick={addTask}
					aria-label={t("spec.addTask")}
				>
					<IconPlus size={16} />
				</ActionIcon>

				{dirty && (
					<>
						<Button
							size="xs"
							variant="filled"
							color="green"
							onClick={onSave}
							loading={isSaving}
							leftSection={<IconDeviceFloppy size={14} />}
						>
							{t("spec.save")}
						</Button>
						<Button size="xs" variant="subtle" color="gray" onClick={onReload} disabled={isSaving}>
							{t("spec.reload")}
						</Button>
					</>
				)}
			</Group>
		</Stack>
	);
}
