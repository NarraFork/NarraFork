import {
	useAnswerAsyncQuestion,
	useAsyncQuestions,
	useDismissAsyncQuestion,
	useIgnoreAsyncQuestion,
	useOlderAsyncQuestions,
} from "@frontend/hooks/useAsyncQuestions";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EMPTY_ASYNC_QUESTIONS } from "./narrator-panel-overrides";
import type { AsyncQuestionSlot } from "./narrator-panel-types";
import { toBannerQuestions } from "./question/async-question-questions";

/** Inline question forms, stable across unrelated panel renders. */
export function useNarratorAsyncQuestionSlots(
	narratorId: string,
	enabled = true,
	readOnly = false,
): ReadonlyMap<string, AsyncQuestionSlot> {
	const { t } = useTranslation("narrator");
	const { data } = useAsyncQuestions(narratorId, enabled);
	// Mutation result objects change on every render; only mutate is stable.
	const { mutateAsync: answerAsyncQuestion } = useAnswerAsyncQuestion(narratorId);
	const { mutate: dismissAsyncQuestion } = useDismissAsyncQuestion(narratorId);
	const { mutate: ignoreAsyncQuestion } = useIgnoreAsyncQuestion(narratorId);
	const [busyAsyncQuestionId, setBusyAsyncQuestionId] = useState<string | null>(null);
	const older = useOlderAsyncQuestions(narratorId, data?.nextCursor, enabled);
	const { fetchNextPage, hasNextPage, isFetching, isError } = older;
	useEffect(() => {
		// Recover originating cards beyond the first page, one bounded request at a time.
		if (enabled && hasNextPage && !isFetching && !isError) void fetchNextPage();
	}, [enabled, fetchNextPage, hasNextPage, isFetching, isError]);
	const openAsyncQuestions = useMemo(() => {
		if (!older.data?.pages.length) return data?.items ?? EMPTY_ASYNC_QUESTIONS;
		const items = [...(data?.items ?? []), ...older.data.pages.flatMap((page) => page.items)];
		return [...new Map(items.map((question) => [question.id, question])).values()];
	}, [data?.items, older.data]);

	return useMemo(() => {
		const map = new Map<string, AsyncQuestionSlot>();
		for (const question of openAsyncQuestions) {
			if (!question.toolUseId) continue;
			map.set(question.toolUseId, {
				id: question.id,
				question,
				readOnly,
				draftId: question.toolCallId,
				questions: toBannerQuestions(question.questions),
				busy: busyAsyncQuestionId === question.id,
				denyLabel: t("asyncQuestionDismiss"),
				awaited: question.awaited,
				awaitedLabel: t("asyncQuestionAwaitedNotice"),
				onSubmit: (questionId, answers) => {
					setBusyAsyncQuestionId(questionId);
					return answerAsyncQuestion(
						{ questionId, answers },
						{ onSettled: () => setBusyAsyncQuestionId(null) },
					);
				},
				onDismiss: (questionId) => {
					setBusyAsyncQuestionId(questionId);
					dismissAsyncQuestion({ questionId }, { onSettled: () => setBusyAsyncQuestionId(null) });
				},
				onIgnore: (questionId) => {
					setBusyAsyncQuestionId(questionId);
					ignoreAsyncQuestion({ questionId }, { onSettled: () => setBusyAsyncQuestionId(null) });
				},
			});
		}
		return map;
	}, [
		openAsyncQuestions,
		busyAsyncQuestionId,
		answerAsyncQuestion,
		dismissAsyncQuestion,
		ignoreAsyncQuestion,
		t,
		readOnly,
	]);
}
