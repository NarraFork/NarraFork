import {
	useAnswerAsyncQuestion,
	useAsyncQuestions,
	useDismissAsyncQuestion,
} from "@frontend/hooks/useAsyncQuestions";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EMPTY_ASYNC_QUESTIONS } from "./narrator-panel-overrides";
import type { AsyncQuestionSlot } from "./narrator-panel-types";
import { toBannerQuestions } from "./question/async-question-questions";

/** Inline question forms, stable across unrelated panel renders. */
export function useNarratorAsyncQuestionSlots(
	narratorId: string,
	enabled = true,
): ReadonlyMap<string, AsyncQuestionSlot> {
	const { t } = useTranslation("narrator");
	const { data } = useAsyncQuestions(narratorId, enabled);
	// Mutation result objects change on every render; only mutate is stable.
	const { mutate: answerAsyncQuestion } = useAnswerAsyncQuestion(narratorId);
	const { mutate: dismissAsyncQuestion } = useDismissAsyncQuestion(narratorId);
	const [busyAsyncQuestionId, setBusyAsyncQuestionId] = useState<string | null>(null);
	const openAsyncQuestions = data?.items ?? EMPTY_ASYNC_QUESTIONS;

	return useMemo(() => {
		const map = new Map<string, AsyncQuestionSlot>();
		for (const question of openAsyncQuestions) {
			if (!question.toolUseId) continue;
			map.set(question.toolUseId, {
				id: question.id,
				draftId: question.toolCallId,
				questions: toBannerQuestions(question.questions),
				busy: busyAsyncQuestionId === question.id,
				denyLabel: t("asyncQuestionDismiss"),
				awaited: question.awaited,
				awaitedLabel: t("asyncQuestionAwaitedNotice"),
				onSubmit: (questionId, answers) => {
					setBusyAsyncQuestionId(questionId);
					answerAsyncQuestion(
						{ questionId, answers },
						{ onSettled: () => setBusyAsyncQuestionId(null) },
					);
				},
				onDismiss: (questionId) => {
					setBusyAsyncQuestionId(questionId);
					dismissAsyncQuestion({ questionId }, { onSettled: () => setBusyAsyncQuestionId(null) });
				},
			});
		}
		return map;
	}, [openAsyncQuestions, busyAsyncQuestionId, answerAsyncQuestion, dismissAsyncQuestion, t]);
}
