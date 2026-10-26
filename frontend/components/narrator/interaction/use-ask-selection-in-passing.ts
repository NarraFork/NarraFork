import { publishAskInPassingEvent } from "@frontend/lib/ask-in-passing-events";
import { useCallback, useRef } from "react";
import { useAskInPassing } from "../../../hooks/useNarrator";
import { api } from "../../../lib/api";
import type { ComposerQuote } from "../composer/composer-quotes";
import { useOpenAskInPassingNarrator } from "../question/AskInPassingCard";

export interface AskSelectionInput {
	/** The message the selection starts in: the fork point. */
	sourceMessageId: string;
	quote: ComposerQuote;
	question: string;
}

/**
 * 顺便提问 straight from a text selection: create the pending card at the source
 * message and resolve it in one go, so the fork receives the excerpt as a quote
 * ahead of the question and opens beside this conversation. A failed resolve
 * removes the pending card it created instead of leaving an orphan without the
 * quote behind. Rejects with the server error for the caller to show.
 */
export function useAskSelectionInPassing(narratorId: string) {
	const resolve = useAskInPassing();
	const resolveRef = useRef(resolve);
	resolveRef.current = resolve;
	const openAnswer = useOpenAskInPassingNarrator();
	const openAnswerRef = useRef(openAnswer);
	openAnswerRef.current = openAnswer;

	return useCallback(
		async ({ sourceMessageId, quote, question }: AskSelectionInput) => {
			const started = await api.startAskInPassing(narratorId, { sourceMessageId });
			let answer: { id: string };
			try {
				answer = await resolveRef.current.mutateAsync({
					narratorId,
					question,
					pendingMessageId: started.messageId,
					quote,
				});
			} catch (error) {
				await api
					.cancelAskInPassing(narratorId, started.messageId)
					.then(() =>
						publishAskInPassingEvent({
							kind: "deleted",
							narratorId,
							messageId: started.messageId,
						}),
					)
					.catch(() => {});
				throw error;
			}
			openAnswerRef.current(answer.id);
		},
		[narratorId],
	);
}
