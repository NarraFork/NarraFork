/**
 * The async-question inbox: every open question the user can see, in one place.
 *
 * ## One inbox, not two
 *
 * There used to be a per-session drawer as well. It was redundant: the questions a
 * session is waiting on are a SUBSET of "everything waiting on me", so a second
 * component could only duplicate the first with a filter — and two components meant two
 * places for the answer/dismiss wiring to drift apart. This drawer instead puts the
 * current session's questions in their own group at the top, which is the only thing the
 * per-session version actually offered.
 *
 * ## Where the entry point lives
 *
 * Above the composer, not in a header. That is where the user is when they are about to
 * act, and a question waiting for them is an action. A message-area banner scrolls away
 * with the conversation; a header toolbar has a capacity budget that DROPS entries when
 * it overflows, and a question waiting on the user must never be what gets dropped.
 *
 * The dashboard hosts a second entry (`NeedsAttention`), for the case where the user is
 * not in a session at all.
 *
 * ## No polling
 *
 * The count refreshes when the drawer opens and whenever any subscribed narrator pushes
 * a wait transition. A periodic cross-session scan would put a per-row ACL walk on the
 * main thread for a number that changes a few times an hour.
 */

import type { AsyncQuestion } from "@frontend/types/narrator";
import { Badge, Button, Divider, Drawer, Group, Stack, Text } from "@mantine/core";
import { IconClockPause, IconInbox } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	globalQuestionsQueryKey,
	invalidateAsyncQuestionQueries,
} from "../../hooks/useAsyncQuestions";
import { api } from "../../lib/api";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { toBannerQuestions } from "./async-question-questions";

/** A global-inbox row: the question plus enough context to say which session it is. */
export interface GlobalQuestion extends AsyncQuestion {
	narratorTitle: string | null;
	chapterId: string | null;
}

export { globalQuestionsQueryKey } from "../../hooks/useAsyncQuestions";

export function useGlobalAsyncQuestions(enabled = true) {
	return useQuery({
		queryKey: globalQuestionsQueryKey,
		queryFn: () => api.getAllAsyncQuestions(),
		enabled,
	});
}

/**
 * Split the inbox into "this session" and "elsewhere".
 *
 * Exported for testing: the grouping is what replaced a whole component, so it is worth
 * pinning that a question is never dropped or double-counted by it.
 */
export function groupQuestionsByScope(
	items: readonly GlobalQuestion[],
	currentNarratorId?: string,
): { current: GlobalQuestion[]; others: GlobalQuestion[] } {
	if (!currentNarratorId) return { current: [], others: [...items] };
	const current: GlobalQuestion[] = [];
	const others: GlobalQuestion[] = [];
	for (const item of items) {
		if (item.narratorId === currentNarratorId) current.push(item);
		else others.push(item);
	}
	return { current, others };
}

interface InboxButtonProps {
	/**
	 * The session being viewed, when there is one. Drives the label ("3 questions" vs
	 * "this session 3 · elsewhere 2") and the drawer's grouping.
	 */
	currentNarratorId?: string;
	/** Composer-adjacent placement wants a full-width row; a header wants a compact chip. */
	variant?: "row" | "compact";
}

/**
 * The inbox entry point: a count, and whether anything is BLOCKING.
 *
 * Two visual states, because the two situations differ in what ignoring them costs. A
 * merely accumulating inbox is quiet; an agent stopped and waiting is yellow.
 */
export function AsyncQuestionInboxButton({ currentNarratorId, variant = "row" }: InboxButtonProps) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const { data } = useGlobalAsyncQuestions();
	const items = (data?.items ?? []) as GlobalQuestion[];
	const { current, others } = groupQuestionsByScope(items, currentNarratorId);
	const awaitedCount = items.filter((q) => q.awaited).length;

	// Nothing waiting → no control at all. A permanent "0" badge would be chrome that
	// never means anything, and this sits in the most crowded part of the layout.
	if (items.length === 0) return null;

	// With a session in view the split is the useful reading: "2 elsewhere" is what tells
	// the user the button is worth pressing even though this session looks quiet.
	const label = currentNarratorId
		? others.length > 0
			? t("inboxBadgeSplit", { current: current.length, others: others.length })
			: t("asyncQuestionInboxBadge", { count: current.length })
		: t("asyncQuestionInboxBadge", { count: items.length });

	return (
		<>
			<Button
				size={variant === "compact" ? "compact-xs" : "compact-sm"}
				fullWidth={variant === "row"}
				justify={variant === "row" ? "flex-start" : undefined}
				variant={awaitedCount > 0 ? "light" : "subtle"}
				color={awaitedCount > 0 ? "yellow" : "gray"}
				leftSection={awaitedCount > 0 ? <IconClockPause size={14} /> : <IconInbox size={14} />}
				onClick={() => setOpened(true)}
				aria-label={t("globalInboxOpen", { count: items.length })}
			>
				<Group gap={6} wrap="nowrap">
					<Text size="xs">{label}</Text>
					{awaitedCount > 0 && (
						<Text size="xs" fw={600}>
							{t("inboxBadgeAwaitedSuffix", { count: awaitedCount })}
						</Text>
					)}
				</Group>
			</Button>
			<AsyncQuestionInboxDrawer
				opened={opened}
				onClose={() => setOpened(false)}
				currentNarratorId={currentNarratorId}
			/>
		</>
	);
}

export function AsyncQuestionInboxDrawer({
	opened,
	onClose,
	currentNarratorId,
}: {
	opened: boolean;
	onClose: () => void;
	currentNarratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const { data, isLoading } = useGlobalAsyncQuestions(opened);
	const [busyId, setBusyId] = useState<string | null>(null);

	const invalidate = (_data: unknown, _error: unknown, { narratorId }: { narratorId: string }) =>
		invalidateAsyncQuestionQueries(queryClient, narratorId);

	const answerMutation = useMutation({
		mutationFn: ({
			narratorId,
			questionId,
			answers,
		}: {
			narratorId: string;
			questionId: string;
			answers: Record<string, string>;
		}) => api.answerAsyncQuestion(narratorId, questionId, { answers }),
		onSettled: invalidate,
	});
	const dismissMutation = useMutation({
		mutationFn: ({ narratorId, questionId }: { narratorId: string; questionId: string }) =>
			api.dismissAsyncQuestion(narratorId, questionId),
		onSettled: invalidate,
	});

	const items = (data?.items ?? []) as GlobalQuestion[];
	const { current, others } = groupQuestionsByScope(items, currentNarratorId);

	const renderQuestion = (question: GlobalQuestion, showSession: boolean) => (
		<Stack key={question.id} gap={4}>
			<Group gap={6} wrap="nowrap">
				{/* Which session asked. Omitted inside the current-session group, where it
				    would repeat the group heading on every row. */}
				{showSession && (
					<Text
						size="xs"
						c="dimmed"
						truncate
						component={Link}
						to="/narrators/$narratorId"
						// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
						params={{ narratorId: question.narratorId } as any}
						style={{ textDecoration: "none" }}
					>
						{question.narratorTitle || question.narratorId}
					</Text>
				)}
				{question.awaited && (
					<>
						<IconClockPause size={12} color="var(--mantine-color-yellow-6)" />
						<Text size="xs" c="yellow.6" fw={500}>
							{t("asyncQuestionAwaitedNotice")}
						</Text>
					</>
				)}
			</Group>
			<AskUserQuestionBanner
				requestId={question.id}
				draftId={question.toolCallId}
				questions={toBannerQuestions(question.questions)}
				busy={busyId === question.id}
				denyLabel={t("asyncQuestionDismiss")}
				onSubmit={(_id, answers) => {
					setBusyId(question.id);
					answerMutation.mutate(
						{ narratorId: question.narratorId, questionId: question.id, answers },
						{ onSettled: () => setBusyId(null) },
					);
				}}
				onDeny={() => {
					setBusyId(question.id);
					dismissMutation.mutate(
						{ narratorId: question.narratorId, questionId: question.id },
						{ onSettled: () => setBusyId(null) },
					);
				}}
			/>
		</Stack>
	);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="lg"
			title={
				<Group gap="xs">
					<IconInbox size={18} />
					<Text fw={500}>{t("globalInboxTitle")}</Text>
					{items.length > 0 && (
						<Badge size="sm" variant="light">
							{items.length}
						</Badge>
					)}
				</Group>
			}
		>
			<Stack gap="lg">
				<Text size="xs" c="dimmed">
					{t("globalInboxDesc")}
				</Text>
				{isLoading && (
					<Text size="sm" c="dimmed">
						{t("asyncQuestionInboxLoading")}
					</Text>
				)}
				{!isLoading && items.length === 0 && (
					<Text size="sm" c="dimmed">
						{t("asyncQuestionInboxEmpty")}
					</Text>
				)}
				{current.length > 0 && (
					<>
						<Text size="xs" fw={600} tt="uppercase" c="dimmed">
							{t("inboxGroupCurrentSession")}
						</Text>
						{current.map((question) => renderQuestion(question, false))}
					</>
				)}
				{current.length > 0 && others.length > 0 && <Divider />}
				{others.length > 0 && (
					<>
						{current.length > 0 && (
							<Text size="xs" fw={600} tt="uppercase" c="dimmed">
								{t("inboxGroupOtherSessions")}
							</Text>
						)}
						{others.map((question) => renderQuestion(question, true))}
					</>
				)}
			</Stack>
		</Drawer>
	);
}
