import { invalidateAsyncQuestionQueries } from "@frontend/hooks/useAsyncQuestions";
import { api } from "@frontend/lib/api";
import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";
import type { AsyncQuestion } from "@frontend/types/narrator";
import { Alert, Badge, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import type { SideCarBody } from "@shared/sidecar-body";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { toBannerQuestions } from "./async-question-questions";

export type AsyncQuestionAnswerSnapshot = Extract<SideCarBody, { kind: "asyncQuestionAnswers" }>;

/** A message's frozen receipt is readable after fork/delete/ACL loss, never mutable. */
export function AsyncQuestionHistoricalSnapshot({
	snapshot,
}: {
	snapshot: AsyncQuestionAnswerSnapshot;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Stack gap="sm" data-question-historical-snapshot={snapshot.questionId}>
			<Badge color="gray">{t("asyncQuestionHistoricalSnapshot")}</Badge>
			<Text size="xs" c="dimmed">
				{t("asyncQuestionHistoricalFallback")}
			</Text>
			<Text size="xs" c="dimmed">
				{snapshot.questionId} · {snapshot.createdAt}
			</Text>
			<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{snapshot.context || t("asyncQuestionContextUnknown")}
			</Text>
			{snapshot.items.map((item) => (
				<Stack key={item.questionId ?? item.header} gap="xs">
					<Text fw={600}>{item.header}</Text>
					{item.options?.map((option) => (
						<Text
							key={option.header}
							size="sm"
							style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
						>
							{option.header}
							{option.description ? ` — ${option.description}` : ""}
						</Text>
					))}
					<Text size="xs" c="dimmed">
						{t("asyncQuestionHistoricalAnswer")}
					</Text>
					<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.answer}</Text>
					{item.notes && (
						<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.notes}</Text>
					)}
				</Stack>
			))}
			{snapshot.outcome === "dismissed" && <Text>{t("asyncQuestionState_dismissed")}</Text>}
			{snapshot.supplement && (
				<Stack gap="xs">
					<Text size="xs" c="dimmed">
						{t("asyncQuestionSupplement")}
					</Text>
					<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{snapshot.supplement}
					</Text>
				</Stack>
			)}
		</Stack>
	);
}

export function questionStateKey(question: AsyncQuestion) {
	return question.status === "answered"
		? question.resolution
			? "asyncQuestionResolved"
			: "asyncQuestionPending"
		: `asyncQuestionState_${question.status}`;
}

/** Durable summary stays on the originating tool; details are loaded on demand. */
export function AsyncQuestionSummary({
	question,
	readOnly = false,
}: {
	question: AsyncQuestion;
	readOnly?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	return (
		<Stack gap="xs">
			<Group gap="xs">
				<Badge color={question.status === "open" ? "blue" : "gray"}>
					{t(questionStateKey(question))}
				</Badge>
				{question.awaited && question.status === "open" && (
					<Text size="xs">{t("asyncQuestionAwaitedNotice")}</Text>
				)}
			</Group>
			<Text size="sm">{question.questions.map((item) => item.header).join(" · ")}</Text>
			<Text size="xs" c="dimmed">
				{question.context || t("asyncQuestionContextUnknown")}
			</Text>
			{question.resolution && <Text size="sm">{question.resolution.note}</Text>}
			{question.withdrawReason && <Text size="sm">{question.withdrawReason}</Text>}
			<Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>
				{t("asyncQuestionDetails")}
			</Button>
			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={t("asyncQuestionDetails")}
				size="lg"
			>
				{opened && (
					<AsyncQuestionDetail
						narratorId={question.narratorId}
						questionId={question.id}
						readOnly={readOnly}
					/>
				)}
			</Modal>
		</Stack>
	);
}

type AsyncQuestionDetailProps = {
	narratorId: string;
	questionId: string;
	readOnly?: boolean;
	snapshot?: AsyncQuestionAnswerSnapshot;
	/** Inherited events are historical even when the original actor's API is authorized. */
	historicalOnly?: boolean;
};

export function AsyncQuestionDetail(props: AsyncQuestionDetailProps) {
	const { t } = useTranslation("narrator");
	if (props.historicalOnly) {
		return props.snapshot ? (
			<AsyncQuestionHistoricalSnapshot snapshot={props.snapshot} />
		) : (
			<Text>{t("asyncQuestionContextUnknown")}</Text>
		);
	}
	// Keep live hooks unmounted for inherited history: readOnly alone still reads future state.
	return <AsyncQuestionLiveDetail {...props} />;
}

function AsyncQuestionLiveDetail({
	narratorId,
	questionId,
	readOnly = false,
	snapshot,
}: AsyncQuestionDetailProps) {
	const { t } = useTranslation("narrator");
	const client = useQueryClient();
	const query = useInfiniteQuery({
		queryKey: ["async-question-detail", narratorId, questionId],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => api.getAsyncQuestionDetail(narratorId, questionId, pageParam),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		// A frozen receipt needs no retries or cross-subject lookup after fork/ACL loss.
		retry: snapshot ? false : undefined,
	});
	const question = query.data?.pages[0]?.question;
	const canAct =
		!readOnly &&
		!query.isError &&
		query.data?.pages[0]?.canAct !== false &&
		!query.data?.pages[0]?.tooLarge;
	const draftKey = `supplement:${questionId}`;
	const [text, setText] = useState(() => readSession("ask-draft", draftKey) ?? "");
	useEffect(() => {
		if (!question || !canAct) return;
		if (text && text.length <= 24000) writeSession("ask-draft", draftKey, text);
		else if (!text) removeSession("ask-draft", draftKey);
	}, [text, draftKey, question, canAct]);
	const answer = useMutation({
		mutationFn: (answers: Record<string, string>) =>
			api.answerAsyncQuestion(narratorId, questionId, { answers }),
		onSuccess: () => invalidateAsyncQuestionQueries(client, narratorId),
	});
	const dismiss = useMutation({
		mutationFn: () => api.dismissAsyncQuestion(narratorId, questionId),
		onSuccess: () => invalidateAsyncQuestionQueries(client, narratorId),
	});
	const ignore = useMutation({
		mutationFn: () => api.ignoreAsyncQuestion(narratorId, questionId),
		onSuccess: () => invalidateAsyncQuestionQueries(client, narratorId),
	});
	const supplement = useMutation({
		onError: () =>
			client.invalidateQueries({ queryKey: ["async-question-detail", narratorId, questionId] }),
		mutationFn: () =>
			api.supplementAsyncQuestion(narratorId, questionId, {
				text,
				...(question?.answerMessageId ? { answerMessageId: question.answerMessageId } : {}),
			}),
		onSuccess: async () => {
			setText("");
			removeSession("ask-draft", draftKey);
			await invalidateAsyncQuestionQueries(client, narratorId);
			await client.invalidateQueries({
				queryKey: ["async-question-detail", narratorId, questionId],
			});
		},
	});
	if (query.isError && snapshot) return <AsyncQuestionHistoricalSnapshot snapshot={snapshot} />;
	if (query.isError)
		return (
			<Alert color="red">
				<Text>{query.error.message}</Text>
				<Button onClick={() => void query.refetch()}>{t("humanAttentionRetry")}</Button>
			</Alert>
		);
	if (!question) return <Text>{t("humanAttentionLoading")}</Text>;
	return (
		<Stack gap="sm" data-question-detail={questionId}>
			{query.data?.pages[0]?.tooLarge && (
				<Alert color="yellow">{t("humanAttentionTooLarge")}</Alert>
			)}
			<Badge>{t(questionStateKey(question))}</Badge>
			{question.status === "open" && (
				<Text size="xs" c={question.awaited ? "yellow" : "dimmed"}>
					{t(question.awaited ? "asyncQuestionAwaitedNotice" : "asyncQuestionLater")}
				</Text>
			)}
			<Text size="xs" c="dimmed">
				{question.id} · {question.createdAt}
			</Text>
			<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{question.context || t("asyncQuestionContextUnknown")}
			</Text>
			<AskUserQuestionBanner
				requestId={question.id}
				draftId={question.toolCallId}
				answerKey="id"
				questions={toBannerQuestions(question.questions)}
				answers={question.answers ?? undefined}
				readOnly={!canAct || question.status !== "open"}
				busy={answer.isPending || dismiss.isPending || ignore.isPending}
				onSubmit={(_id, answers) => answer.mutateAsync(answers)}
				onDeny={() => dismiss.mutate()}
				denyLabel={t("asyncQuestionDismiss")}
				onIgnore={() => ignore.mutate()}
				ignoreLabel={t("asyncQuestionIgnore")}
			/>
			{question.resolution && (
				<Alert color="gray">
					<Text size="xs">
						{t("asyncQuestionResolved")} · {question.resolution.resolvedAt}
					</Text>
					<Text>{question.resolution.note}</Text>
				</Alert>
			)}
			{question.withdrawReason && <Text>{question.withdrawReason}</Text>}
			{query.data?.pages
				.flatMap((page) => page.supplements)
				.map((item) => (
					<Alert key={item.messageId} color="gray">
						<Text size="xs">{item.createdAt}</Text>
						<Text style={{ whiteSpace: "pre-wrap" }}>{item.text}</Text>
					</Alert>
				))}
			{query.hasNextPage && (
				<Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
					{t("humanAttentionLoadMore")}
				</Button>
			)}
			{question.status === "answered" && canAct && (
				<Stack gap="xs">
					<Text size="xs">{t("asyncQuestionSupplementReference", { id: question.id })}</Text>
					<Textarea
						label={t("asyncQuestionSupplement")}
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						autosize
						minRows={3}
						maxRows={10}
						maxLength={24000}
					/>
					<Button
						disabled={!text.trim()}
						loading={supplement.isPending}
						onClick={() => supplement.mutate()}
					>
						{t("asyncQuestionSendSupplement")}
					</Button>
				</Stack>
			)}
			{(supplement.error || dismiss.error || ignore.error) && (
				<Alert color="red">{(supplement.error || dismiss.error || ignore.error)?.message}</Alert>
			)}
		</Stack>
	);
}
