/**
 * The task board's 「转交给会话…」 (outline P2 PR 10a): the sessions a task may be handed to, each
 * with 「转交」 (the hand-over alone: the session is told, nothing is started) and 「转交并开始」 (the
 * session is started on the task when it would continue on it). Named sessions come first. Read
 * when the picker opens (`GET /outline/tasks/:id/transfer-sessions`, at most 50).
 */
import { Button, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import type { OutlineBoardTask } from "@shared/outline-task-board";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { TYPE_ROLE_STYLE } from "../../../lib/typography-css-vars";

export function TransferSessions({
	task,
	pending,
	onTransfer,
}: {
	task: OutlineBoardTask;
	pending: boolean;
	onTransfer: (narratorId: string, start: boolean) => void;
}) {
	const { t } = useTranslation("outline");
	const sessions = useQuery({
		queryKey: ["task-board", "transfer-sessions", task.id],
		queryFn: () => api.getTransferSessions(task.id),
		retry: false,
		staleTime: 5_000,
	});
	return (
		<Stack
			gap={6}
			data-testid="task-transfer"
			// Within a phone's width: the popover never grows past the viewport.
			style={{ width: "min(300px, calc(100vw - 48px))" }}
		>
			<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs} data-testid="task-transfer-note">
				{t("board.transfer.note")}
			</Text>
			{sessions.isPending && <Loader size="xs" />}
			{sessions.isError && (
				<Text size="xs" c="red" style={TYPE_ROLE_STYLE.xs}>
					{t("board.transfer.failed")}
				</Text>
			)}
			{sessions.data?.sessions.length === 0 && (
				<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs} data-testid="task-transfer-empty">
					{t("board.transfer.empty")}
				</Text>
			)}
			{sessions.data && sessions.data.sessions.length > 0 && (
				<ScrollArea.Autosize mah={260} type="auto">
					<Stack gap={8}>
						{sessions.data.sessions.map((session) => (
							<Stack
								key={session.narratorId}
								gap={2}
								data-testid="task-transfer-session"
								data-narrator-id={session.narratorId}
							>
								<Text size="sm" style={{ ...TYPE_ROLE_STYLE.body, wordBreak: "break-word" }}>
									{session.title || t("board.transfer.untitled")}
									{session.handle && (
										<Text span size="xs" c="dimmed" ml={6} style={TYPE_ROLE_STYLE.xs}>
											@{session.handle}
										</Text>
									)}
								</Text>
								<Group gap={6}>
									<Button
										size="compact-xs"
										variant="default"
										loading={pending}
										onClick={() => onTransfer(session.narratorId, false)}
										data-testid="task-transfer-only"
									>
										{t("board.transfer.only")}
									</Button>
									{/* Starting it runs a turn on the person's behalf: theirs to ask only where
									    they may write the session. */}
									{session.canStart && (
										<Button
											size="compact-xs"
											loading={pending}
											onClick={() => onTransfer(session.narratorId, true)}
											data-testid="task-transfer-start"
										>
											{t("board.transfer.andStart")}
										</Button>
									)}
								</Group>
							</Stack>
						))}
					</Stack>
				</ScrollArea.Autosize>
			)}
			{sessions.data?.truncated && (
				<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
					{t("board.transfer.more", { n: sessions.data.limit })}
				</Text>
			)}
		</Stack>
	);
}
