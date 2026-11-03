/**
 * The task board (outline P2 PR 5): the built-in view of the process dimension, grouped by
 * executor, then status. One component for a session (its dock tab, `scope.kind === "session"`)
 * and a project (the project page); the server reads the right spaces for each.
 *
 *   - A person may add a task to the session ("Add", "Add and start": person-created and locked
 *     by default, owner Q5), finish, cancel or reopen a task ("Reopen and start" for a session's
 *     own), hand it to themselves or someone else, or back to the session.
 *   - A locked goal whose completion waits for its person (D26b) shows that, with the change and
 *     Confirm / Reject for the person who decides (PR 6's diff and decisions).
 *   - Every task opens in the outline.
 *
 * Changes are the person's writes; the board re-reads after each, and when the session's tasks
 * change (`outline_tasks_changed`).
 */
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Menu,
	Paper,
	Popover,
	Stack,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	OutlineBoardAssignTarget,
	OutlineBoardExecutor,
	OutlineBoardSection,
	OutlineBoardTask,
	OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import {
	IconArrowBackUp,
	IconCheck,
	IconCircle,
	IconCircleDot,
	IconCircleX,
	IconDots,
	IconExternalLink,
	IconHourglass,
	IconLock,
	IconPlayerPlay,
	IconUser,
	IconUserShare,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlinePendingDetail } from "../../../hooks/useOutline";
import {
	invalidateTaskBoards,
	useAddBoardTask,
	useUpdateBoardTask,
} from "../../../hooks/useTaskBoard";
import { ApiError, api } from "../../../lib/api";
import { DiffEntry } from "../OutlinePendingPanel";

type Translate = ReturnType<typeof useTranslation>["t"];

type StatusGroup = "doing" | "waiting" | "todo" | "done" | "cancelled";
const STATUS_ORDER: StatusGroup[] = ["doing", "waiting", "todo", "done", "cancelled"];

function statusGroupOf(task: OutlineBoardTask): StatusGroup {
	if ((task.status === "todo" || task.status === "doing") && task.waiting) return "waiting";
	return task.status;
}

function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

function executorKey(executor: OutlineBoardExecutor): string {
	switch (executor.kind) {
		case "session":
			return `session:${executor.narratorId}`;
		case "human":
			return `human:${executor.name}`;
		case "agent":
			return `agent:${executor.name}`;
		default:
			return "none";
	}
}

interface ExecutorGroup {
	key: string;
	executor: OutlineBoardExecutor;
	tasks: OutlineBoardTask[];
}

/** Groups by executor, in a stable order: the board's own session, sessions, people, agents. */
function groupTasks(
	tasks: readonly OutlineBoardTask[],
	ownSession: string | null,
	me: string,
): ExecutorGroup[] {
	const groups = new Map<string, ExecutorGroup>();
	for (const task of tasks) {
		const key = executorKey(task.executor);
		const group = groups.get(key) ?? { key, executor: task.executor, tasks: [] };
		group.tasks.push(task);
		groups.set(key, group);
	}
	const rank = (group: ExecutorGroup): number => {
		const e = group.executor;
		if (e.kind === "session" && e.narratorId === ownSession) return 0;
		if (e.kind === "human" && e.name === me) return 1;
		if (e.kind === "session") return 2;
		if (e.kind === "human") return 3;
		if (e.kind === "agent") return 4;
		return 5;
	};
	return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

function executorLabel(
	t: Translate,
	executor: OutlineBoardExecutor,
	ownSession: string | null,
	me: string,
): string {
	switch (executor.kind) {
		case "session":
			return executor.narratorId === ownSession
				? t("board.thisSession")
				: executor.title || t("board.untitledSession");
		case "human":
			return executor.name === me ? t("board.you", { name: executor.name }) : executor.name;
		case "agent":
			return t("board.agent", { name: executor.name });
		default:
			return t("board.nobody");
	}
}

const STATUS_ICON: Record<StatusGroup, ReactNode> = {
	doing: <IconCircleDot size={14} color="var(--mantine-color-indigo-5)" />,
	waiting: <IconHourglass size={14} color="var(--mantine-color-orange-5)" />,
	todo: <IconCircle size={14} color="var(--mantine-color-gray-5)" />,
	done: <IconCheck size={14} color="var(--mantine-color-green-5)" />,
	cancelled: <IconCircleX size={14} color="var(--mantine-color-gray-6)" />,
};

export interface TaskBoardProps {
	/** One board response, or the pages of a project board. */
	pages: readonly OutlineTaskBoardResponse[];
	/** Open a task in the outline (the host decides where: a dock panel, the outline page). */
	onOpenTask?: (task: OutlineBoardTask) => void;
	/** A project board's next page of spaces. */
	onLoadMoreSpaces?: () => void;
	hasMoreSpaces?: boolean;
	loadingMoreSpaces?: boolean;
}

export function TaskBoard({
	pages,
	onOpenTask,
	onLoadMoreSpaces,
	hasMoreSpaces,
	loadingMoreSpaces,
}: TaskBoardProps) {
	const { t } = useTranslation("outline");
	const first = pages[0];
	const scope = first?.scope;
	const ownSession = scope?.kind === "session" ? scope.narratorId : null;
	const me = first?.me.name ?? "";
	const sections = useMemo(() => pages.flatMap((page) => page.sections), [pages]);
	// Finished tasks loaded past the board's first ones, by space.
	const [extra, setExtra] = useState<
		Record<string, { tasks: OutlineBoardTask[]; cursor: string | null }>
	>({});
	const sectionKey = sections.map((s) => `${s.space.id}:${s.finishedCursor ?? ""}`).join("|");
	// The board was read again: what was loaded past it starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the first pages change
	useEffect(() => setExtra({}), [sectionKey]);
	const sectionOf = useMemo(() => {
		const map = new Map<string, OutlineBoardSection>();
		for (const section of sections) map.set(section.space.id, section);
		return map;
	}, [sections]);
	const tasks = useMemo(() => {
		const out: OutlineBoardTask[] = [];
		for (const section of sections) out.push(...section.open, ...section.finished);
		// What was loaded past the board's first page, unless the board shows it now (changed since).
		const shown = new Set(out.map((task) => task.id));
		for (const section of sections)
			for (const task of extra[section.space.id]?.tasks ?? [])
				if (!shown.has(task.id)) out.push(task);
		return out;
	}, [sections, extra]);
	const groups = useMemo(() => groupTasks(tasks, ownSession, me), [tasks, ownSession, me]);

	const loadFinished = useMutation({
		mutationFn: async (spaceId: string) => {
			const cursor = extra[spaceId]?.cursor ?? sectionOf.get(spaceId)?.finishedCursor;
			if (!cursor) return null;
			return { spaceId, page: await api.getFinishedTasks(spaceId, cursor) };
		},
		onSuccess: (result) => {
			if (!result) return;
			setExtra((current) => ({
				...current,
				[result.spaceId]: {
					tasks: [...(current[result.spaceId]?.tasks ?? []), ...result.page.tasks],
					cursor: result.page.nextCursor,
				},
			}));
		},
	});
	const moreFinished = sections.filter((section) => {
		const loaded = extra[section.space.id];
		return loaded ? loaded.cursor !== null : section.finishedCursor !== null;
	});

	if (!first) return null;
	const truncated = sections.some((section) => section.openTruncated);
	return (
		<Stack gap="sm" data-testid="task-board" data-scope={scope?.kind}>
			{scope?.kind === "session" && first.canAdd && <AddTaskForm narratorId={scope.narratorId} />}
			{groups.length === 0 && (
				<Text size="sm" c="dimmed" data-testid="task-board-empty">
					{scope?.kind === "project" ? t("board.emptyProject") : t("board.empty")}
				</Text>
			)}
			{groups.map((group) => (
				<ExecutorGroupView
					key={group.key}
					group={group}
					label={executorLabel(t, group.executor, ownSession, me)}
					sectionOf={sectionOf}
					scopeKind={scope?.kind ?? "session"}
					me={me}
					onOpenTask={onOpenTask}
				/>
			))}
			{truncated && (
				<Text size="xs" c="dimmed">
					{t("board.openTruncated")}
				</Text>
			)}
			{moreFinished.map((section) => (
				<Button
					key={section.space.id}
					size="compact-xs"
					variant="subtle"
					color="gray"
					loading={loadFinished.isPending && loadFinished.variables === section.space.id}
					onClick={() => loadFinished.mutate(section.space.id)}
					data-testid="task-board-more-finished"
				>
					{scope?.kind === "project"
						? `${t("board.moreFinished")} · ${section.space.label ?? section.space.key}`
						: t("board.moreFinished")}
				</Button>
			))}
			{hasMoreSpaces && (
				<Button
					size="compact-sm"
					variant="light"
					loading={loadingMoreSpaces}
					onClick={onLoadMoreSpaces}
					data-testid="task-board-more-spaces"
				>
					{t("board.moreSpaces")}
				</Button>
			)}
		</Stack>
	);
}

function ExecutorGroupView({
	group,
	label,
	sectionOf,
	scopeKind,
	me,
	onOpenTask,
}: {
	group: ExecutorGroup;
	label: string;
	sectionOf: Map<string, OutlineBoardSection>;
	scopeKind: "session" | "project";
	me: string;
	onOpenTask?: (task: OutlineBoardTask) => void;
}) {
	const { t } = useTranslation("outline");
	const byStatus = new Map<StatusGroup, OutlineBoardTask[]>();
	for (const task of group.tasks) {
		const status = statusGroupOf(task);
		byStatus.set(status, [...(byStatus.get(status) ?? []), task]);
	}
	const open = group.tasks.filter((task) => task.status === "todo" || task.status === "doing");
	return (
		<Paper withBorder p="xs" radius="sm" data-testid="task-board-group" data-executor={group.key}>
			<Group gap={6} mb={4} justify="space-between" wrap="nowrap">
				<Group gap={6} wrap="nowrap">
					<IconUser size={14} color="var(--mantine-color-dimmed)" />
					<Text size="sm" fw={600} truncate>
						{label}
					</Text>
				</Group>
				{open.length > 0 && (
					<Text size="xs" c="dimmed">
						{t("board.count", { count: open.length })}
					</Text>
				)}
			</Group>
			<Stack gap={6}>
				{STATUS_ORDER.map((status) => {
					const tasks = byStatus.get(status);
					if (!tasks?.length) return null;
					return (
						<Stack key={status} gap={2} data-testid="task-board-status" data-status={status}>
							<Group gap={4}>
								{STATUS_ICON[status]}
								<Text size="xs" c="dimmed" fw={500}>
									{t(`board.status.${status}`)} · {tasks.length}
								</Text>
							</Group>
							{tasks.map((task) => (
								<TaskRow
									key={task.id}
									task={task}
									section={sectionOf.get(task.spaceId)}
									scopeKind={scopeKind}
									me={me}
									onOpenTask={onOpenTask}
								/>
							))}
						</Stack>
					);
				})}
			</Stack>
		</Paper>
	);
}

function TaskRow({
	task,
	section,
	scopeKind,
	me,
	onOpenTask,
}: {
	task: OutlineBoardTask;
	section: OutlineBoardSection | undefined;
	scopeKind: "session" | "project";
	me: string;
	onOpenTask?: (task: OutlineBoardTask) => void;
}) {
	const { t } = useTranslation("outline");
	const queryClient = useQueryClient();
	const update = useUpdateBoardTask();
	const [assigning, setAssigning] = useState(false);
	const [username, setUsername] = useState("");
	const canWrite = section?.canWrite ?? false;
	const sessionSpace = section?.space.kind === "session";
	const open = task.status === "todo" || task.status === "doing";
	const assignedToMe = task.assignee === `human:${me}`;

	const change = (body: {
		status?: "todo" | "done" | "cancelled";
		assign?: OutlineBoardAssignTarget;
		start?: boolean;
	}) =>
		update.mutate(
			{ blockId: task.id, body: { baseVersionSeq: task.versionSeq, ...body } },
			{
				onSuccess: () => {
					setAssigning(false);
					setUsername("");
				},
				onError: (error) => {
					const conflict = error instanceof ApiError && error.status === 409;
					if (conflict) invalidateTaskBoards(queryClient);
					notifications.show({
						color: conflict ? "yellow" : "red",
						title: conflict ? undefined : t("board.action.failed"),
						message: conflict ? t("board.action.conflict") : errorText(error),
					});
				},
			},
		);

	return (
		<Paper
			p={6}
			radius="sm"
			bg="var(--mantine-color-default)"
			data-testid="task-row"
			data-task-id={task.id}
			data-status={task.status}
			data-title={task.title}
		>
			<Group gap={6} wrap="nowrap" align="flex-start">
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Text
						size="sm"
						style={{ wordBreak: "break-word" }}
						td={task.status === "cancelled" ? "line-through" : undefined}
					>
						{task.title}
					</Text>
					<Group gap={4}>
						{task.humanCreated && (
							<Badge size="xs" variant="light" color="indigo" data-testid="task-badge-human">
								{t("board.humanCreated")}
							</Badge>
						)}
						{task.lock && (
							<Badge
								size="xs"
								variant="light"
								color="grape"
								leftSection={<IconLock size={10} />}
								data-testid="task-badge-locked"
							>
								{task.lock.by.name
									? t("board.locked", { name: task.lock.by.name })
									: t("board.lockedSomeone")}
							</Badge>
						)}
						{task.waiting && task.waiting.prerequisites > 0 && (
							<Badge size="xs" variant="light" color="orange">
								{t("board.waitPrerequisites", { count: task.waiting.prerequisites })}
							</Badge>
						)}
						{task.waiting?.people && (
							<Badge size="xs" variant="light" color="orange">
								{t("board.waitPeople")}
							</Badge>
						)}
						{task.waiting?.confirmation && (
							<Badge size="xs" variant="light" color="orange" data-testid="task-badge-confirmation">
								{t("board.waitConfirmation")}
							</Badge>
						)}
						{task.assignee && (
							<Text size="xs" c="dimmed">
								@{task.assignee}
							</Text>
						)}
						<Text size="xs" c="dimmed" ff="monospace">
							{task.address}
						</Text>
						{scopeKind === "project" && section && (
							<Text size="xs" c="dimmed">
								{t("board.space", { label: section.space.label ?? section.space.key })}
							</Text>
						)}
						{scopeKind === "session" && section?.role === "claimed" && (
							<Text size="xs" c="dimmed">
								{t("board.claimedElsewhere", { label: section.space.label ?? section.space.key })}
							</Text>
						)}
					</Group>
				</Stack>
				<Popover opened={assigning} onChange={setAssigning} withinPortal position="bottom-end">
					<Popover.Target>
						<div>
							<Menu shadow="md" position="bottom-end" withinPortal>
								<Menu.Target>
									<ActionIcon
										size="sm"
										variant="subtle"
										color="gray"
										aria-label={t("board.action.menu")}
										loading={update.isPending}
										data-testid="task-row-menu"
									>
										<IconDots size={14} />
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown>
									{canWrite && open && (
										<>
											<Menu.Item
												leftSection={<IconCheck size={14} />}
												onClick={() => change({ status: "done" })}
												data-testid="task-action-done"
											>
												{t("board.action.done")}
											</Menu.Item>
											{task.status === "doing" && (
												<Menu.Item
													leftSection={<IconArrowBackUp size={14} />}
													onClick={() => change({ status: "todo" })}
													data-testid="task-action-stop"
												>
													{t("board.action.stop")}
												</Menu.Item>
											)}
											<Menu.Item
												leftSection={<IconCircleX size={14} />}
												onClick={() => change({ status: "cancelled" })}
												data-testid="task-action-cancel"
											>
												{t("board.action.cancel")}
											</Menu.Item>
										</>
									)}
									{canWrite && !open && (
										<>
											<Menu.Item
												leftSection={<IconArrowBackUp size={14} />}
												onClick={() => change({ status: "todo" })}
												data-testid="task-action-reopen"
											>
												{t("board.action.reopen")}
											</Menu.Item>
											{sessionSpace && (
												<Menu.Item
													leftSection={<IconPlayerPlay size={14} />}
													onClick={() => change({ status: "todo", start: true })}
													data-testid="task-action-reopen-start"
												>
													{t("board.action.reopenAndStart")}
												</Menu.Item>
											)}
										</>
									)}
									{canWrite && open && (
										<>
											<Menu.Divider />
											{!assignedToMe && (
												<Menu.Item
													leftSection={<IconUser size={14} />}
													onClick={() => change({ assign: { kind: "me" } })}
													data-testid="task-action-me"
												>
													{t("board.action.assignMe")}
												</Menu.Item>
											)}
											<Menu.Item
												leftSection={<IconUserShare size={14} />}
												onClick={() => setAssigning(true)}
												data-testid="task-action-user"
											>
												{t("board.action.assignUser")}
											</Menu.Item>
											{task.assignee && (
												<Menu.Item
													leftSection={<IconArrowBackUp size={14} />}
													onClick={() => change({ assign: { kind: "session" } })}
													data-testid="task-action-session"
												>
													{t("board.action.assignSession")}
												</Menu.Item>
											)}
										</>
									)}
									{canWrite && onOpenTask && <Menu.Divider />}
									{onOpenTask && (
										<Menu.Item
											leftSection={<IconExternalLink size={14} />}
											onClick={() => onOpenTask(task)}
											data-testid="task-action-open"
										>
											{t("board.action.open")}
										</Menu.Item>
									)}
								</Menu.Dropdown>
							</Menu>
						</div>
					</Popover.Target>
					<Popover.Dropdown>
						<Group gap={4} wrap="nowrap">
							<TextInput
								size="xs"
								placeholder={t("board.action.usernamePlaceholder")}
								value={username}
								onChange={(e) => setUsername(e.currentTarget.value)}
								data-testid="task-assign-username"
								onKeyDown={(e) => {
									if (e.key === "Enter" && username.trim())
										change({ assign: { kind: "user", username: username.trim() } });
								}}
							/>
							<Button
								size="compact-xs"
								disabled={!username.trim()}
								loading={update.isPending}
								onClick={() => change({ assign: { kind: "user", username: username.trim() } })}
								data-testid="task-assign-submit"
							>
								{t("board.action.assign")}
							</Button>
						</Group>
					</Popover.Dropdown>
				</Popover>
			</Group>
			{task.completion && <CompletionBox task={task} />}
		</Paper>
	);
}

/** A locked goal whose completion waits for its person: the change, and Confirm / Reject. */
function CompletionBox({ task }: { task: OutlineBoardTask }) {
	const { t } = useTranslation("outline");
	const queryClient = useQueryClient();
	const completion = task.completion;
	const [showChange, setShowChange] = useState(false);
	const [reason, setReason] = useState("");
	const detail = useOutlinePendingDetail(showChange && completion ? completion.pendingId : null);
	const decide = useMutation({
		mutationFn: (decision: "confirm" | "reject") =>
			decision === "confirm"
				? api.confirmOutlinePending(completion?.pendingId as string)
				: api.rejectOutlinePending(completion?.pendingId as string, reason.trim() || null),
		onSuccess: (_, decision) =>
			notifications.show({
				color: decision === "confirm" ? "green" : "gray",
				message: t(
					decision === "confirm" ? "board.completion.confirmed" : "board.completion.rejected",
				),
			}),
		onError: (error) =>
			notifications.show({
				color: "red",
				title: t("board.completion.failed"),
				message: errorText(error),
			}),
		onSettled: () => {
			invalidateTaskBoards(queryClient);
			void queryClient.invalidateQueries({ queryKey: ["outline"] });
		},
	});
	if (!completion) return null;
	const status = t(`board.status.${completion.status}`);
	return (
		<Alert variant="light" color="orange" p={6} mt={4} data-testid="task-completion">
			<Stack gap={4}>
				<Text size="xs">
					{completion.canDecide
						? t("board.completion.asks", { status })
						: t("board.completion.asksOther", {
								status,
								name: task.lock?.by.name ?? t("board.lockedSomeone"),
							})}
				</Text>
				<Group gap={6}>
					<Button
						size="compact-xs"
						variant="subtle"
						color="gray"
						onClick={() => setShowChange((v) => !v)}
						data-testid="task-completion-show"
					>
						{showChange ? t("board.completion.hideChange") : t("board.completion.showChange")}
					</Button>
				</Group>
				{showChange && detail.isLoading && <Loader size="xs" />}
				{showChange &&
					detail.data?.entries.map((entry) => (
						<DiffEntry key={`${entry.kind}:${entry.blockId}`} entry={entry} />
					))}
				{completion.canDecide && (
					<>
						<Textarea
							size="xs"
							autosize
							minRows={1}
							maxRows={3}
							placeholder={t("board.completion.reasonPlaceholder")}
							value={reason}
							onChange={(e) => setReason(e.currentTarget.value)}
							data-testid="task-completion-reason"
						/>
						<Group gap="xs">
							<Button
								size="compact-xs"
								color="green"
								loading={decide.isPending && decide.variables === "confirm"}
								onClick={() => decide.mutate("confirm")}
								data-testid="task-completion-confirm"
							>
								{t("board.completion.confirm")}
							</Button>
							<Button
								size="compact-xs"
								variant="light"
								color="red"
								loading={decide.isPending && decide.variables === "reject"}
								onClick={() => decide.mutate("reject")}
								data-testid="task-completion-reject"
							>
								{t("board.completion.reject")}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Alert>
	);
}

/** Add a person-created task to the session: "Add" or "Add and start" (owner Q5). */
function AddTaskForm({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("outline");
	const add = useAddBoardTask(narratorId);
	const [text, setText] = useState("");
	const [lock, setLock] = useState(true);
	const submit = (start: boolean) => {
		const value = text.trim();
		if (!value) return;
		add.mutate(
			{ text: value, lock, start },
			{
				onSuccess: (result) => {
					setText("");
					notifications.show({
						color: result.added ? "green" : "yellow",
						message: [
							t(result.added ? "board.add.added" : "board.add.exists"),
							result.started ? t("board.add.started") : null,
						]
							.filter(Boolean)
							.join(" · "),
					});
				},
				onError: (error) =>
					notifications.show({
						color: "red",
						title: t("board.add.failed"),
						message: errorText(error),
					}),
			},
		);
	};
	return (
		<Paper withBorder p="xs" radius="sm" data-testid="task-board-add-form">
			<Stack gap={6}>
				<Textarea
					size="sm"
					autosize
					minRows={1}
					maxRows={6}
					placeholder={t("board.add.placeholder")}
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							submit(false);
						}
					}}
					data-testid="task-board-add-input"
				/>
				<Group gap="xs" justify="space-between" wrap="wrap">
					<Tooltip label={t("board.add.lock")} withinPortal openDelay={400}>
						<Checkbox
							size="xs"
							label={<IconLock size={12} />}
							checked={lock}
							onChange={(e) => setLock(e.currentTarget.checked)}
							aria-label={t("board.add.lock")}
							data-testid="task-board-add-lock"
						/>
					</Tooltip>
					<Group gap={6}>
						<Button
							size="compact-sm"
							variant="light"
							disabled={!text.trim()}
							loading={add.isPending && add.variables?.start === false}
							onClick={() => submit(false)}
							data-testid="task-board-add"
						>
							{t("board.add.add")}
						</Button>
						<Button
							size="compact-sm"
							leftSection={<IconPlayerPlay size={12} />}
							disabled={!text.trim()}
							loading={add.isPending && add.variables?.start === true}
							onClick={() => submit(true)}
							data-testid="task-board-add-start"
						>
							{t("board.add.addAndStart")}
						</Button>
					</Group>
				</Group>
			</Stack>
		</Paper>
	);
}
