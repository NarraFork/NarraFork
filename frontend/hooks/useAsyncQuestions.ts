import type { AsyncQuestion } from "@frontend/types/narrator";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";

export const asyncQuestionsQueryKey = (narratorId: string) => ["async-questions", narratorId];
export const globalQuestionsQueryKey = ["async-questions", "all"];

/** Decisions from either surface must refresh both the inline form and global inbox. */
export function invalidateAsyncQuestionQueries(queryClient: QueryClient, narratorId: string) {
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: asyncQuestionsQueryKey(narratorId), exact: false }),
		queryClient.invalidateQueries({ queryKey: globalQuestionsQueryKey, exact: false }),
		queryClient.invalidateQueries({ queryKey: ["human-attention"] }),
		queryClient.invalidateQueries({ queryKey: ["async-question-detail", narratorId] }),
	]);
}

interface AsyncQuestionsPage {
	items: AsyncQuestion[];
	nextCursor: string | null;
	openCount: number;
}

/** Bounded all-state summaries for durable tool cards; full answers load via detail. */
export function useAsyncQuestions(narratorId: string, enabled = true) {
	return useQuery({
		queryKey: asyncQuestionsQueryKey(narratorId),
		queryFn: () => api.getAsyncQuestions(narratorId, { filter: "all", limit: 32 }),
		enabled: !!narratorId && enabled,
	});
}

/** Older summary pages are fetched separately, keeping the first-page cache compatible. */
export function useOlderAsyncQuestions(
	narratorId: string,
	cursor: string | null | undefined,
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: [...asyncQuestionsQueryKey(narratorId), "older", cursor ?? "none"],
		initialPageParam: cursor ?? undefined,
		queryFn: ({ pageParam }) =>
			api.getAsyncQuestions(narratorId, { filter: "all", cursor: pageParam, limit: 32 }),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: !!narratorId && !!cursor && enabled,
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

export type AsyncQuestionPush = Pick<AsyncQuestion, "id" | "narratorId"> & Partial<AsyncQuestion>;

export function readAsyncQuestionPush(data: Record<string, unknown>): AsyncQuestionPush | null {
	const nested = data.question as AsyncQuestionPush | undefined;
	if (nested?.id && nested.narratorId) return nested;
	const id =
		typeof data.questionId === "string"
			? data.questionId
			: typeof data.id === "string"
				? data.id
				: null;
	if (!id || typeof data.narratorId !== "string") return null;
	return {
		id,
		narratorId: data.narratorId,
		status: data.status as AsyncQuestion["status"] | undefined,
	};
}

export type AsyncQuestionChange =
	| "opened"
	| "answered"
	| "dismissed"
	| "withdrawn"
	| "awaited"
	| "await_ended"
	| "resolved"
	| "supplemented";

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
		(change: AsyncQuestionChange, question: AsyncQuestionPush) => {
			queryClient.setQueryData<AsyncQuestionsPage>(
				asyncQuestionsQueryKey(narratorId ?? question.narratorId),
				(previous) => {
					// Preserve terminal summaries at their original card. Never insert into an
					// unloaded page: refetch supplies ordering and the authoritative cursor.
					if (!previous || !question.questions) return previous;
					const record = question as AsyncQuestion;
					const exists = previous.items.some((item) => item.id === question.id);
					const next = exists
						? previous.items.map((item) => (item.id === question.id ? record : item))
						: change === "opened" && !previous.nextCursor
							? [record, ...previous.items].slice(0, 32)
							: previous.items;
					return {
						...previous,
						items: next,
						openCount: next.filter((item) => item.status === "open").length,
					};
				},
			);
			void queryClient.invalidateQueries({
				queryKey: asyncQuestionsQueryKey(narratorId ?? question.narratorId),
			});
			void queryClient.invalidateQueries({
				queryKey: ["async-question-detail", question.narratorId, question.id],
			});
			// The global page contains ACL-filtered session metadata absent from this frame.
			// Refetch it on EVERY change, even an unawaited open while its button is hidden.
			// Cache correctness must not depend on whether a notification is urgent.
			void queryClient.invalidateQueries({ queryKey: globalQuestionsQueryKey, exact: false });
			void queryClient.invalidateQueries({ queryKey: ["human-attention"] });
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
			const question = readAsyncQuestionPush(data);
			if (!question?.id || !question.narratorId) return null;
			if (
				!UPSERT_CHANGES.has(change) &&
				change !== "answered" &&
				change !== "dismissed" &&
				change !== "withdrawn" &&
				change !== "resolved" &&
				change !== "supplemented"
			)
				return null;
			applyChange(change, question);
			if (change === "opened") return null;
			// A decision is the final wait notification: the server does NOT also emit
			// await_ended for decided questions. Always clear this question's own alert.
			return {
				type: "awaitedQuestion" as const,
				awaited: change === "awaited" && question.status === "open",
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
