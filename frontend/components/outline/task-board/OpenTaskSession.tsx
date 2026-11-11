/**
 * "Open a new session for this" on the project's task board (outline P2 PR 10c-1, owner decision
 * D54): a task of the project's space that can be started gets a button; a click opens a new
 * session of the project that takes the task and starts on it (the server puts its brief
 * together from the outline). The arrow beside it opens a small form for the three things a
 * person may set: the model, the working directory, a note added to the brief. Nothing navigates:
 * the row then says which session is on it, and that opens the session.
 *
 * `useOpenSessionControl` holds one row's state; the row draws the button, the form and the
 * result with the parts below.
 */
import { Button, Loader, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	OUTLINE_TASK_BOARD_LIMITS,
	type OutlineBoardOpenSessionRefusal,
	type OutlineBoardTask,
} from "@shared/outline-task-board";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import type { useTranslation } from "react-i18next";
import { invalidateTaskBoards, useOpenTaskSession } from "../../../hooks/useTaskBoard";
import { ApiError } from "../../../lib/api";
import { TYPE_ROLE_STYLE } from "../../../lib/typography-css-vars";

const OpenSessionModelSelect = lazy(() => import("./OpenSessionModelSelect"));

type Translate = ReturnType<typeof useTranslation>["t"];

const REFUSALS: ReadonlySet<string> = new Set<OutlineBoardOpenSessionRefusal>([
	"finished",
	"planning",
	"prerequisites",
	"people",
	"confirmation",
	"assigned_to_person",
	"unavailable",
	"not_project_task",
	"no_directory",
	"in_progress",
	"claimed",
	"unreadable",
	"changed",
	"start_failed",
]);

/** Why a session was not opened, in the reader's language (the server's words as a last resort). */
export function openSessionErrorText(t: Translate, error: unknown): string {
	if (error instanceof ApiError) {
		const details = error.data?.details as
			| { reason?: string; holder?: { name?: string | null } }
			| undefined;
		const reason = details?.reason;
		if (reason === "claimed" && details?.holder?.name)
			return t("board.openSession.error.claimedBy", { name: details.holder.name });
		if (reason && REFUSALS.has(reason)) return t(`board.openSession.error.${reason}`);
		if (error.status === 403) return t("board.openSession.error.forbidden");
		// The task is gone or was edited since the board was read.
		if (error.status === 404 || error.status === 409) return t("board.openSession.error.changed");
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export interface OpenSessionOptions {
	model?: string;
	cwd?: string;
	note?: string;
}

/** One row's "open a new session" state: the request, its result, its error. */
export function useOpenSessionControl(task: OutlineBoardTask, t: Translate) {
	const queryClient = useQueryClient();
	const open = useOpenTaskSession();
	const [formOpen, setFormOpen] = useState(false);
	/** The session this row's click opened, until the board is read again. */
	const [opened, setOpened] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const submit = (options: OpenSessionOptions = {}) => {
		if (open.isPending || opened) return;
		setError(null);
		open.mutate(
			{
				blockId: task.id,
				body: {
					baseVersionSeq: task.versionSeq,
					...(options.model ? { model: options.model } : {}),
					...(options.cwd?.trim() ? { cwd: options.cwd.trim() } : {}),
					...(options.note?.trim() ? { note: options.note } : {}),
				},
			},
			{
				onSuccess: (result) => {
					setOpened(result.narratorId);
					setFormOpen(false);
				},
				onError: (failure) => {
					const message = openSessionErrorText(t, failure);
					const refused = failure instanceof ApiError && failure.status < 500;
					setError(message);
					// Said twice on purpose: a refusal re-reads the board, and the task may then move
					// to another group (someone took it), taking this row and its message with it.
					notifications.show({
						color: refused ? "yellow" : "red",
						title: t("board.openSession.failed"),
						message,
					});
					if (refused) invalidateTaskBoards(queryClient);
				},
			},
		);
	};
	return {
		/** The server offers it for this task, and this row has not opened one yet. */
		offered: task.openSession === true && !opened,
		pending: open.isPending,
		opened,
		error,
		formOpen,
		setFormOpen,
		submit,
	};
}

export type OpenSessionControl = ReturnType<typeof useOpenSessionControl>;

/** The form behind "Open a new session for this…": model, working directory, a note. */
export function OpenSessionForm({ control, t }: { control: OpenSessionControl; t: Translate }) {
	const [model, setModel] = useState("");
	const [cwd, setCwd] = useState("");
	const [note, setNote] = useState("");
	return (
		<Stack gap={8} w={280} maw="calc(100vw - 48px)" data-testid="task-open-session-form">
			<Text size="xs" c="dimmed" style={TYPE_ROLE_STYLE.xs}>
				{t("board.openSession.hint")}
			</Text>
			<Suspense fallback={<Loader size="xs" />}>
				<OpenSessionModelSelect
					label={t("board.openSession.model")}
					value={model}
					onChange={setModel}
				/>
			</Suspense>
			<TextInput
				size="xs"
				label={t("board.openSession.cwd")}
				placeholder={t("board.openSession.cwdPlaceholder")}
				value={cwd}
				onChange={(e) => setCwd(e.currentTarget.value)}
				data-testid="task-open-session-cwd"
			/>
			<Textarea
				size="xs"
				autosize
				minRows={2}
				maxRows={6}
				label={t("board.openSession.note")}
				placeholder={t("board.openSession.notePlaceholder")}
				maxLength={OUTLINE_TASK_BOARD_LIMITS.maxOpenNoteChars}
				value={note}
				onChange={(e) => setNote(e.currentTarget.value)}
				data-testid="task-open-session-note"
			/>
			{control.error && (
				<Text
					size="xs"
					c="red"
					style={TYPE_ROLE_STYLE.xs}
					data-testid="task-open-session-form-error"
				>
					{control.error}
				</Text>
			)}
			<Button
				size="compact-sm"
				loading={control.pending}
				onClick={() => control.submit({ model, cwd, note })}
				data-testid="task-open-session-submit"
			>
				{t("board.openSession.submit")}
			</Button>
		</Stack>
	);
}
