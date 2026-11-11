/**
 * The task board (outline P2 PR 5): the built-in view of the process dimension, grouped by
 * executor, then status. One component for a session (its dock tab, `scope.kind === "session"`)
 * and a project (the project page); the server reads the right spaces for each.
 *
 *   - A person may add a task to the session ("Add", "Add and start": person-created and locked
 *     by default, owner Q5), finish, cancel or reopen a task ("Reopen and start" for a session's
 *     own), hand it to themselves or someone else, or back to the session.
 *   - A locked goal whose completion waits for its person (D26b) shows that, with the change and
 *     Confirm / Reject for the person who decides (PR 6's diff and decisions); finishing or
 *     cancelling it from the menu is not offered meanwhile, so no waiting change is left behind.
 *   - Cancelled tasks are folded under their count until opened.
 *   - Every task opens in the outline.
 *   - A task of the project's space that can be started has "Open a new session for this" (outline
 *     P2 PR 10c-1, D54; `OpenTaskSession.tsx`): a new session takes it and starts on it; the row
 *     then says which session is on it. Such tasks are grouped as "Ready to start".
 *   - A task the reader manages that an agent finished is marked 「新完成」 (D50 ④, outline P2
 *     PR 9b) until they have seen it: once its row has been on screen, the board tells the server
 *     (`useNewlyDoneMarks`); the mark stays for as long as this board is open, and is gone the
 *     next time the board is read.
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
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardAssignTarget,
	type OutlineBoardExecutor,
	type OutlineBoardSection,
	type OutlineBoardTask,
	type OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import {
	IconArrowBackUp,
	IconArrowsExchange,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconExternalLink,
	IconLock,
	IconPlayerPlay,
	IconUser,
	IconUserShare,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlinePendingDetail } from "../../../hooks/useOutline";
import {
	invalidateTaskBoards,
	taskBoardKeys,
	useAddBoardTask,
	useUpdateBoardTask,
} from "../../../hooks/useTaskBoard";
import { ApiError, api } from "../../../lib/api";
import { observePageLifecycle } from "../../../lib/page-lifecycle";
import { ensureTypographyCssVars, TYPE_ROLE_STYLE } from "../../../lib/typography-css-vars";
import { useEditorPanelVisible } from "../../narrator/narrator-panel-visibility";
import { DiffEntry } from "../OutlinePendingPanel";
import { OutlineStatusChip, OutlineStatusIcon } from "../OutlineStatusIcon";
import { OpenSessionForm, useOpenSessionControl } from "./OpenTaskSession";
import { TransferSessions } from "./TransferSessions";

// Task text paints with the reader's typography variables (TYPE_ROLE_STYLE).
ensureTypographyCssVars();

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
	scopeKind?: "session" | "project",
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
			// A project's unassigned tasks wait for someone to open a session for them (D54).
			return scopeKind === "project" ? t("board.readyToStart") : t("board.nobody");
	}
}

/** A status group's badge: the same one a task's checkbox is drawn as everywhere else. */
const STATUS_ICON: Record<StatusGroup, ReactNode> = {
	doing: <OutlineStatusIcon status="doing" />,
	waiting: <OutlineStatusIcon status="waiting" />,
	todo: <OutlineStatusIcon status="todo" />,
	done: <OutlineStatusIcon status="done" />,
	cancelled: <OutlineStatusIcon status="cancelled" />,
};

/** A 「新完成」 mark: the task at the version it was shown finished. */
const markKey = (task: Pick<OutlineBoardTask, "id" | "versionSeq">) =>
	`${task.id}:${task.versionSeq}`;

/** How long the board gathers marks seen before it tells the server, in one request. */
export const NEWLY_DONE_SEEN_FLUSH_MS = 600;

/** How often a mark in view but hidden by its host (nothing said so) is looked at again. */
const NEWLY_DONE_RECHECK_MS = 1000;

/**
 * A board read with 「新完成」 dropped from the tasks the reader saw, each at the version seen
 * (`markKey`): a version read since is left as the server marked it.
 */
export function withoutNewlyDone(
	board: OutlineTaskBoardResponse,
	seen: ReadonlySet<string>,
): OutlineTaskBoardResponse {
	const strip = (task: OutlineBoardTask): OutlineBoardTask => {
		if (!task.newlyDone || !seen.has(markKey(task))) return task;
		const { newlyDone: _seen, ...rest } = task;
		return rest;
	};
	return {
		...board,
		sections: board.sections.map((section) => ({
			...section,
			open: section.open.map(strip),
			finished: section.finished.map(strip),
		})),
	};
}

/**
 * The board's 「新完成」 marks: shown for the tasks the server marks, and kept for as long as the
 * board stays mounted (a read after the reader saw them no longer marks them); `seen` gathers the
 * marks that were on screen and tells the server in one request (again on unmount), then drops
 * them from the cached reads so a board opened again does not show them.
 */
function useNewlyDoneMarks(tasks: readonly OutlineBoardTask[]) {
	const queryClient = useQueryClient();
	// The board is on screen: its dock tab is the shown one and the page is in the foreground.
	const visible = useEditorPanelVisible();
	const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		const marked = tasks.filter((task) => task.newlyDone).map(markKey);
		if (marked.some((key) => !shown.has(key))) setShown((prev) => new Set([...prev, ...marked]));
	}, [tasks, shown]);
	const pending = useRef(new Map<string, number>());
	const told = useRef(new Set<string>());
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(
		(options: { keepalive?: boolean } = {}) => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			const all = [...pending.current].map(([id, versionSeq]) => ({ id, versionSeq }));
			pending.current.clear();
			// A request names at most so many; a board seldom shows more at once.
			const size = OUTLINE_TASK_BOARD_LIMITS.seenPerRequest;
			for (let start = 0; start < all.length; start += size) {
				const batch = all.slice(start, start + size);
				const keys = new Set(batch.map(markKey));
				api
					.markBoardTasksSeen({ tasks: batch }, options)
					.then(() =>
						queryClient.setQueriesData<OutlineTaskBoardResponse>(
							{ queryKey: taskBoardKeys.all },
							(board) => (board?.sections ? withoutNewlyDone(board, keys) : board),
						),
					)
					.catch(() => {
						// Not recorded: told again the next time they are seen.
						for (const task of batch) told.current.delete(markKey(task));
					});
			}
		},
		[queryClient],
	);
	const seen = useCallback(
		(task: OutlineBoardTask) => {
			const key = markKey(task);
			if (told.current.has(key)) return;
			told.current.add(key);
			pending.current.set(task.id, task.versionSeq);
			timer.current ??= setTimeout(() => flush(), NEWLY_DONE_SEEN_FLUSH_MS);
		},
		[flush],
	);
	useEffect(() => () => flush(), [flush]);
	// A page closed or sent to the background right after a mark was seen still records it.
	useEffect(() => observePageLifecycle({ onHidden: () => flush({ keepalive: true }) }), [flush]);
	const isNew = useCallback(
		(task: OutlineBoardTask) =>
			task.status === "done" && (task.newlyDone === true || shown.has(markKey(task))),
		[shown],
	);
	return { isNew, seen, visible };
}

type NewlyDoneMarks = ReturnType<typeof useNewlyDoneMarks>;

/**
 * 「新完成」 on a task's row: reported seen once it is on screen. That is: the board is shown (its
 * dock tab is the visible one, the page in the foreground: `visible`; a board in a tab behind
 * another stays mounted, hidden), the row intersects the viewport, and in the frame after that
 * the page is visible and nothing hides the row (`checkVisibility`; a host that hides it without
 * saying so is looked at again every second while the row stays in view). The board shown again
 * looks again at once. Without IntersectionObserver, once it is drawn while shown.
 */
function NewlyDoneBadge({
	task,
	visible,
	onSeen,
}: {
	task: OutlineBoardTask;
	visible: boolean;
	onSeen: (task: OutlineBoardTask) => void;
}) {
	const { t } = useTranslation("outline");
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element || !visible) return;
		const shown = () =>
			document.visibilityState === "visible" &&
			element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false;
		if (typeof IntersectionObserver === "undefined") {
			if (shown()) onSeen(task);
			return;
		}
		let intersecting = false;
		let frame = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			cancelAnimationFrame(frame);
			clearTimeout(retry);
			if (!intersecting) return;
			// A frame runs only while the page is shown: a board opened in a hidden tab waits for it.
			frame = requestAnimationFrame(() => {
				if (!intersecting) return;
				if (shown()) onSeen(task);
				// Hidden by a host that does not say so (its `visibility: hidden`): look again later.
				else retry = setTimeout(check, NEWLY_DONE_RECHECK_MS);
			});
		};
		const observer = new IntersectionObserver((entries) => {
			intersecting = entries.some((entry) => entry.isIntersecting);
			check();
		});
		observer.observe(element);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(retry);
			observer.disconnect();
		};
	}, [task, visible, onSeen]);
	return (
		<Tooltip label={t("board.newlyDoneHint")} withinPortal openDelay={300} multiline maw={260}>
			<OutlineStatusChip ref={ref} status="newly_done" data-testid="task-badge-newly-done">
				{t("board.newlyDone")}
			</OutlineStatusChip>
		</Tooltip>
	);
}

export interface TaskBoardProps {
	/** One board response, or the pages of a project board. */
	pages: readonly OutlineTaskBoardResponse[];
	/** Open a task in the outline (the host decides where: a dock panel, the outline page). */
	onOpenTask?: (task: OutlineBoardTask) => void;
	/** Open a session (the one doing a task); without it the row links to the session's page. */
	onOpenSession?: (narratorId: string) => void;
	/** A project board's next page of spaces. */
	onLoadMoreSpaces?: () => void;
	hasMoreSpaces?: boolean;
	loadingMoreSpaces?: boolean;
}

export function TaskBoard({
	pages,
	onOpenTask,
	onOpenSession,
	onLoadMoreSpaces,
	hasMoreSpaces,
	loadingMoreSpaces,
}: TaskBoardProps) {
	const { t } = useTranslation("outline");
	const first = pages[0];
	const scope = first?.scope;
	const ownSession = scope?.kind === "session" ? scope.narratorId : null;
	const me = first?.me.name ?? "";
	// Each space once: a project board's pages are read at different times, and a space can move
	// from one page to the next in between.
	const sections = useMemo(() => {
		const seen = new Set<string>();
		return pages
			.flatMap((page) => page.sections)
			.filter((section) => !seen.has(section.space.id) && !!seen.add(section.space.id));
	}, [pages]);
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
	const newly = useNewlyDoneMarks(tasks);

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
	const truncated = sections.filter((section) => section.openTruncated);
	return (
		<Stack gap="sm" data-testid="task-board" data-scope={scope?.kind}>
			{scope?.kind === "session" && first.canAdd && <AddTaskForm narratorId={scope.narratorId} />}
			{groups.length === 0 && (
				<Text size="sm" c="dimmed" style={TYPE_ROLE_STYLE.body} data-testid="task-board-empty">
					{scope?.kind === "project" ? t("board.emptyProject") : t("board.empty")}
				</Text>
			)}
			{groups.map((group) => (
				<ExecutorGroupView
					key={group.key}
					group={group}
					label={executorLabel(t, group.executor, ownSession, me, scope?.kind)}
					sectionOf={sectionOf}
					scopeKind={scope?.kind ?? "session"}
					me={me}
					newly={newly}
					onOpenTask={onOpenTask}
					onOpenSession={onOpenSession}
				/>
			))}
			{truncated.map((section) => (
				<Text
					key={section.space.id}
					size="xs"
					c="dimmed"
					style={TYPE_ROLE_STYLE.xs}
					data-testid="task-board-open-truncated"
					data-space-id={section.space.id}
				>
					{t("board.openTruncatedIn", { label: section.space.label ?? section.space.key })}
				</Text>
			))}
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
	newly,
	onOpenTask,
	onOpenSession,
}: {
	group: ExecutorGroup;
	label: string;
	sectionOf: Map<string, OutlineBoardSection>;
	scopeKind: "session" | "project";
	me: string;
	newly: NewlyDoneMarks;
	onOpenTask?: (task: OutlineBoardTask) => void;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("outline");
	const [showCancelled, setShowCancelled] = useState(false);
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
					<Text size="sm" fw={600} truncate style={TYPE_ROLE_STYLE.body}>
						{label}
					</Text>
				</Group>
				{open.length > 0 && (
					<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
						{t("board.count", { count: open.length })}
					</Text>
				)}
			</Group>
			<Stack gap={6}>
				{STATUS_ORDER.map((status) => {
					const tasks = byStatus.get(status);
					if (!tasks?.length) return null;
					// Cancelled tasks are folded until opened.
					const folded = status === "cancelled" && !showCancelled;
					const heading = (
						<Group gap={4}>
							{status === "cancelled" &&
								(folded ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />)}
							{STATUS_ICON[status]}
							<Text size="xs" c="dimmed" fw={500} style={TYPE_ROLE_STYLE.xs}>
								{t(`board.status.${status}`)} · {tasks.length}
							</Text>
						</Group>
					);
					return (
						<Stack
							key={status}
							gap={2}
							data-testid="task-board-status"
							data-status={status}
							data-folded={folded ? "true" : undefined}
						>
							{status === "cancelled" ? (
								<UnstyledButton
									onClick={() => setShowCancelled((shown) => !shown)}
									aria-expanded={!folded}
									data-testid="task-board-cancelled-toggle"
								>
									{heading}
								</UnstyledButton>
							) : (
								heading
							)}
							{!folded &&
								tasks.map((task) => (
									<TaskRow
										key={task.id}
										task={task}
										section={sectionOf.get(task.spaceId)}
										scopeKind={scopeKind}
										me={me}
										newly={newly}
										onOpenTask={onOpenTask}
										onOpenSession={onOpenSession}
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
	newly,
	onOpenTask,
	onOpenSession,
}: {
	task: OutlineBoardTask;
	section: OutlineBoardSection | undefined;
	scopeKind: "session" | "project";
	me: string;
	newly: NewlyDoneMarks;
	onOpenTask?: (task: OutlineBoardTask) => void;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("outline");
	const queryClient = useQueryClient();
	const update = useUpdateBoardTask();
	const session = useOpenSessionControl(task, t);
	// The session doing a project task: the one this row just opened, or the one the board names.
	const doingSession =
		session.opened ??
		(scopeKind === "project" &&
		section?.space.kind === "project" &&
		task.status === "doing" &&
		task.executor.kind === "session"
			? task.executor.narratorId
			: null);
	const doingTitle =
		session.opened !== null
			? task.title
			: task.executor.kind === "session"
				? task.executor.title
				: null;
	// The popover under the menu: a username to hand to, or the sessions to hand to.
	const [assigning, setAssigning] = useState<false | "user" | "session">(false);
	const [username, setUsername] = useState("");
	const canWrite = section?.canWrite ?? false;
	const sessionSpace = section?.space.kind === "session";
	const open = task.status === "todo" || task.status === "doing";
	// Its completion waits for a person: Confirm / Reject decide it, not the menu.
	const ending = !task.completion;
	const assignedToMe = task.assignee === `human:${me}`;

	const change = (body: {
		status?: "todo" | "done" | "cancelled";
		assign?: OutlineBoardAssignTarget;
		start?: boolean;
	}) =>
		update.mutate(
			{ blockId: task.id, body: { baseVersionSeq: task.versionSeq, ...body } },
			{
				onSuccess: (result) => {
					setAssigning(false);
					setUsername("");
					// 「转交并开始」: whether the session was started, and why not.
					if (body.start && body.assign?.kind === "narrator")
						notifications.show({
							color: result.started ? "green" : "yellow",
							message: result.started
								? t("board.transfer.started")
								: t(`board.transfer.notStarted.${result.notStarted ?? "not_started"}`),
						});
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
			data-newly-done={newly.isNew(task) ? "true" : undefined}
		>
			<Group gap={6} wrap="nowrap" align="flex-start">
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Text
						size="sm"
						style={{ ...TYPE_ROLE_STYLE.body, wordBreak: "break-word" }}
						td={task.status === "cancelled" ? "line-through" : undefined}
					>
						{task.title}
					</Text>
					<Group gap={4}>
						{newly.isNew(task) && (
							<NewlyDoneBadge task={task} visible={newly.visible} onSeen={newly.seen} />
						)}
						{task.humanCreated && (
							<Badge size="xs" variant="light" color="indigo" data-testid="task-badge-human">
								{t("board.humanCreated")}
							</Badge>
						)}
						{task.plan?.state === "planning" && (
							<Badge size="xs" variant="light" color="yellow" data-testid="task-badge-planning">
								{t("board.planning")}
							</Badge>
						)}
						{task.lock && (
							<OutlineStatusChip status="locked" data-testid="task-badge-locked">
								{task.lock.by.name
									? t("board.locked", { name: task.lock.by.name })
									: t("board.lockedSomeone")}
							</OutlineStatusChip>
						)}
						{task.waiting && task.waiting.prerequisites > 0 && (
							<OutlineStatusChip status="waiting">
								{t("board.waitPrerequisites", { count: task.waiting.prerequisites })}
							</OutlineStatusChip>
						)}
						{task.waiting?.people && (
							<OutlineStatusChip status="waiting">{t("board.waitPeople")}</OutlineStatusChip>
						)}
						{task.waiting?.confirmation && (
							<OutlineStatusChip status="waiting" data-testid="task-badge-confirmation">
								{t("board.waitConfirmation")}
							</OutlineStatusChip>
						)}
						{/* Handed to a session by its id: the group it is under names that session. */}
						{task.assignee &&
							!(
								task.executor.kind === "session" &&
								task.assignee === `agent:${task.executor.narratorId}`
							) && (
								<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
									@{task.assignee}
								</Text>
							)}
						<Text size="xs" c="dimmed" ff="monospace" style={TYPE_ROLE_STYLE.code}>
							{task.address}
						</Text>
						{scopeKind === "project" && section && (
							<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
								{t("board.space", { label: section.space.label ?? section.space.key })}
							</Text>
						)}
						{scopeKind === "session" && section?.role === "claimed" && (
							<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
								{t("board.claimedElsewhere", { label: section.space.label ?? section.space.key })}
							</Text>
						)}
					</Group>
					{(session.offered || doingSession) && (
						<Group gap={4} justify="flex-end" wrap="wrap" data-testid="task-open-session-row">
							{session.offered && (
								<Popover
									opened={session.formOpen}
									onChange={session.setFormOpen}
									withinPortal
									position="bottom-end"
									shadow="md"
								>
									<Popover.Target>
										<Button.Group>
											<Button
												size="compact-xs"
												leftSection={<IconPlayerPlay size={12} />}
												loading={session.pending}
												onClick={() => session.submit()}
												data-testid="task-open-session"
											>
												{t("board.openSession.button")}
											</Button>
											<Button
												size="compact-xs"
												px={4}
												disabled={session.pending}
												aria-label={t("board.openSession.options")}
												aria-expanded={session.formOpen}
												onClick={() => session.setFormOpen(!session.formOpen)}
												data-testid="task-open-session-options"
											>
												<IconChevronDown size={12} />
											</Button>
										</Button.Group>
									</Popover.Target>
									<Popover.Dropdown>
										<OpenSessionForm control={session} t={t} />
									</Popover.Dropdown>
								</Popover>
							)}
							{doingSession && (
								<Button
									component="a"
									href={`/narrators/${encodeURIComponent(doingSession)}`}
									size="compact-xs"
									variant="light"
									leftSection={<IconExternalLink size={12} />}
									onClick={(event) => {
										if (!onOpenSession) return;
										event.preventDefault();
										onOpenSession(doingSession);
									}}
									styles={{ label: { whiteSpace: "normal", textAlign: "left" } }}
									h="auto"
									mih={22}
									data-testid="task-open-session-doing"
									data-narrator-id={doingSession}
								>
									{doingTitle
										? t("board.openSession.doing", { title: doingTitle })
										: t("board.openSession.doingUntitled")}
								</Button>
							)}
						</Group>
					)}
					{session.error && !session.formOpen && (
						<Text
							size="xs"
							c="red"
							role="alert"
							style={TYPE_ROLE_STYLE.xs}
							data-testid="task-open-session-error"
						>
							{session.error}
						</Text>
					)}
				</Stack>
				<Popover
					opened={assigning !== false}
					onChange={(opened) => {
						if (!opened) setAssigning(false);
					}}
					withinPortal
					position="bottom-end"
				>
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
									{session.offered && (
										<>
											<Menu.Item
												leftSection={<IconPlayerPlay size={14} />}
												disabled={session.pending}
												onClick={() => session.submit()}
												data-testid="task-action-open-session"
											>
												{t("board.openSession.button")}
											</Menu.Item>
											<Menu.Item
												leftSection={<IconChevronDown size={14} />}
												disabled={session.pending}
												onClick={() => session.setFormOpen(true)}
												data-testid="task-action-open-session-options"
											>
												{t("board.openSession.options")}
											</Menu.Item>
											<Menu.Divider />
										</>
									)}
									{canWrite && open && (
										<>
											{ending && (
												<Menu.Item
													leftSection={<OutlineStatusIcon status="done" />}
													onClick={() => change({ status: "done" })}
													data-testid="task-action-done"
												>
													{t("board.action.done")}
												</Menu.Item>
											)}
											{task.status === "doing" && (
												<Menu.Item
													leftSection={<IconArrowBackUp size={14} />}
													onClick={() => change({ status: "todo" })}
													data-testid="task-action-stop"
												>
													{t("board.action.stop")}
												</Menu.Item>
											)}
											{ending && (
												<Menu.Item
													leftSection={<OutlineStatusIcon status="cancelled" />}
													onClick={() => change({ status: "cancelled" })}
													data-testid="task-action-cancel"
												>
													{t("board.action.cancel")}
												</Menu.Item>
											)}
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
												onClick={() => setAssigning("user")}
												data-testid="task-action-user"
											>
												{t("board.action.assignUser")}
											</Menu.Item>
											{/* A session space's task goes to others by handing it out (a later PR). */}
											{!sessionSpace && (
												<Menu.Item
													leftSection={<IconArrowsExchange size={14} />}
													onClick={() => setAssigning("session")}
													data-testid="task-action-transfer"
												>
													{t("board.action.transferSession")}
												</Menu.Item>
											)}
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
											onClick={() => {
												// Opening it is seeing it.
												if (newly.isNew(task)) newly.seen(task);
												onOpenTask(task);
											}}
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
						{assigning === "session" && (
							<TransferSessions
								task={task}
								pending={update.isPending}
								onTransfer={(narratorId, start) =>
									change({ assign: { kind: "narrator", narratorId }, ...(start ? { start } : {}) })
								}
							/>
						)}
						<Group gap={4} wrap="nowrap" display={assigning === "session" ? "none" : undefined}>
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
