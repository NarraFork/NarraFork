import type { AsyncQuestion } from "@frontend/types/narrator";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";

export const asyncQuestionsQueryKey = (narratorId: string) => ["async-questions", narratorId];
export const globalQuestionsQueryKey = ["async-questions", "all"];

/** Decisions from either surface must refresh both the inline form and global inbox. */
export function invalidateAsyncQuestionQueries(queryClient: QueryClient, narratorId: string) {
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: asyncQuestionsQueryKey(narratorId), exact: true }),
		queryClient.invalidateQueries({ queryKey: globalQuestionsQueryKey, exact: true }),
	]);
}

interface AsyncQuestionsPage {
	items: AsyncQuestion[];
	nextCursor: string | null;
	openCount: number;
}

/**
 * The open asynchronous-question inbox for one narrator.
 *
 * No polling: every transition is pushed as `async_question_changed`, and
 * `applyAsyncQuestionChange` writes it straight into this cache. The query itself is
 * the reconnect / first-load path.
 *
 * Scoped to `status: "open"` because that is the actionable set. Decided questions are
 * already visible in the conversation (their tool card renders the answers), so a
 * second place to read them would only go stale.
 */
export function useAsyncQuestions(narratorId: string, enabled = true) {
	return useQuery({
		queryKey: asyncQuestionsQueryKey(narratorId),
		queryFn: () => api.getAsyncQuestions(narratorId, { status: "open" }),
		enabled: !!narratorId && enabled,
	});
}

/** Changes that leave the question OPEN, so the inbox keeps (or refreshes) it. */
const UPSERT_CHANGES = new Set<AsyncQuestionChange>(["opened", "awaited", "await_ended"]);

/**
 * Fold one pushed change into a list of open questions.
 *
 * Exported and pure so it can be tested directly. The classification is the whole logic
 * and the easy mistake is treating a WAIT transition as a decision, which would drop a
 * question from the inbox at the exact moment an agent started waiting for it.
 *
 * Sort order is part of the contract: awaited questions first (an agent is blocked on
 * those), then newest — matching what the server returns, so a pushed update cannot
 * reorder the list differently from a refetch.
 */
export function applyAsyncQuestionChangeToList(
	items: readonly AsyncQuestion[],
	change: AsyncQuestionChange,
	question: AsyncQuestion,
): AsyncQuestion[] {
	const without = items.filter((item) => item.id !== question.id);
	if (!UPSERT_CHANGES.has(change)) return without;
	return [question, ...without].sort((a, b) => {
		if (!!a.awaited !== !!b.awaited) return a.awaited ? -1 : 1;
		return b.createdAt.localeCompare(a.createdAt);
	});
}

export type AsyncQuestionChange =
	| "opened"
	| "answered"
	| "dismissed"
	| "withdrawn"
	| "awaited"
	| "await_ended";

/**
 * Apply one pushed change to the cached inbox.
 *
 * Upsert for the changes that leave the question open, removal for the ones that decide
 * it. `awaited` / `await_ended` are upserts precisely because they are NOT decisions:
 * the question is still waiting for the user, but its urgency flipped (the agent is now
 * blocked on it, or stopped being), and the record carries the new `awaited` flag.
 *
 * Upsert rather than append: a reconnect can replay an `opened` event for a question the
 * refetched page already holds, and appending would show it twice.
 *
 * `openCount` is recomputed from the resulting array rather than incremented, so a
 * missed event cannot leave the badge permanently off by one.
 */
export function useApplyAsyncQuestionChange(narratorId?: string) {
	const queryClient = useQueryClient();
	return useCallback(
		(change: AsyncQuestionChange, question: AsyncQuestion) => {
			queryClient.setQueryData<AsyncQuestionsPage>(
				asyncQuestionsQueryKey(narratorId ?? question.narratorId),
				(previous) => {
					const next = applyAsyncQuestionChangeToList(previous?.items ?? [], change, question);
					return {
						items: next,
						nextCursor: previous?.nextCursor ?? null,
						openCount: next.length,
					};
				},
			);
			// The global page contains ACL-filtered session metadata absent from this frame.
			// Refetch it on EVERY change, even an unawaited open while its button is hidden.
			// Cache correctness must not depend on whether a notification is urgent.
			void queryClient.invalidateQueries({ queryKey: globalQuestionsQueryKey, exact: true });
		},
		[queryClient, narratorId],
	);
}

/** Shared list-stream consumer: reconcile all changes, notify only wait transitions. */
export function useAsyncQuestionListChange() {
	const applyChange = useApplyAsyncQuestionChange();
	return useCallback(
		(data: Record<string, unknown>) => {
			const change = data.change as AsyncQuestionChange;
			const question = data.question as AsyncQuestion | undefined;
			if (!question?.id || !question.narratorId) return null;
			if (
				!UPSERT_CHANGES.has(change) &&
				change !== "answered" &&
				change !== "dismissed" &&
				change !== "withdrawn"
			)
				return null;
			applyChange(change, question);
			if (change === "opened") return null;
			// A decision is the final wait notification: the server does NOT also emit
			// await_ended for decided questions. Always clear this question's own alert.
			return {
				type: "awaitedQuestion" as const,
				awaited: change === "awaited",
				questionId: question.id,
			};
		},
		[applyChange],
	);
}

/** Answer one open question. */
export function useAnswerAsyncQuestion(narratorId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			questionId,
			answers,
			annotations,
		}: {
			questionId: string;
			answers: Record<string, string>;
			annotations?: Record<string, { preview?: string; notes?: string }>;
		}) => api.answerAsyncQuestion(narratorId, questionId, { answers, annotations }),
		// The server also pushes `async_question_changed`, but a mutation that only waits
		// for the socket would leave the form looking unsubmitted if the frame is delayed.
		// Invalidating here is idempotent with the pushed update.
		onSettled: () => invalidateAsyncQuestionQueries(queryClient, narratorId),
	});
}

/** Dismiss one open question ("decide it yourself"). */
export function useDismissAsyncQuestion(narratorId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ questionId }: { questionId: string }) =>
			api.dismissAsyncQuestion(narratorId, questionId),
		onSettled: () => invalidateAsyncQuestionQueries(queryClient, narratorId),
	});
}
