/**
 * The task board's two readers (outline P2 PR 5), router-free: a session's board (the session
 * dock's task tab) and a project's board (the project page). The host passes how a task opens in
 * the outline.
 */
import { Alert, Center, Loader } from "@mantine/core";
import type { OutlineBoardTask } from "@shared/outline-task-board";
import { useTranslation } from "react-i18next";
import { useProjectTaskBoard, useSessionTaskBoard } from "../../../hooks/useTaskBoard";
import { TaskBoard } from "./TaskBoard";

export function SessionTaskBoard({
	narratorId,
	onOpenTask,
}: {
	narratorId: string;
	onOpenTask?: (task: OutlineBoardTask) => void;
}) {
	const { t } = useTranslation("outline");
	const board = useSessionTaskBoard(narratorId);
	if (board.isLoading)
		return (
			<Center py="md">
				<Loader size="sm" />
			</Center>
		);
	if (board.error || !board.data)
		return (
			<Alert color="red" variant="light">
				{t("board.loadFailed")}
			</Alert>
		);
	return <TaskBoard pages={[board.data]} onOpenTask={onOpenTask} />;
}

export function ProjectTaskBoard({
	projectId,
	onOpenTask,
}: {
	projectId: string;
	onOpenTask?: (task: OutlineBoardTask) => void;
}) {
	const { t } = useTranslation("outline");
	const board = useProjectTaskBoard(projectId);
	if (board.isLoading)
		return (
			<Center py="md">
				<Loader size="sm" />
			</Center>
		);
	if (board.error || !board.data)
		return (
			<Alert color="red" variant="light">
				{t("board.loadFailed")}
			</Alert>
		);
	return (
		<TaskBoard
			pages={board.data.pages}
			onOpenTask={onOpenTask}
			hasMoreSpaces={board.hasNextPage}
			loadingMoreSpaces={board.isFetchingNextPage}
			onLoadMoreSpaces={() => void board.fetchNextPage()}
		/>
	);
}
