import { notifications } from "@mantine/notifications";
import { useCallback, useRef } from "react";
import { useForkNarrator, useStartAskInPassing } from "../../../hooks/useNarrator";

/** Ordinary promotion never routes back to a resource canvas, including legacy sources. */
export function ordinaryPromoteDestination(narratorId: string) {
	if (!narratorId) throw new Error("Promoted conversation ID is missing");
	return { to: "/narrators/$narratorId" as const, params: { narratorId } };
}

export interface UseNarratorForkActionsOptions {
	narratorId: string;
	/** The narrator's chapter id (null/undefined for standalone narrators). */
	chapterId: string | null | undefined;
	/** Legacy resource callback retained for host compatibility; ordinary forks do not invoke it. */
	onForkFromMessage: ((messageId: string) => void) | undefined;
	/** Navigate to a narrator route (used after a standalone fork). */
	navigateToNarrator: (narratorId: string) => void;
}

export interface UseNarratorForkActionsResult {
	/** Fork any ordinary source into an independent conversation. */
	forkHandler: ((messageId: string) => void) | undefined;
	/** Start an "ask in passing" child probe from a source message. */
	handleAskInPassing: (messageUuid: string | null, messageId: string) => void;
}

/**
 * Fork + "ask in passing" actions extracted from NarratorPanel. Ordinary forks
 * always create an independent conversation and navigate to its narrator route.
 * A chapter-bound source does not allocate another resource.
 *
 * Kept lifted (called from the panel): the resolved handlers feed the panel's
 * trace-row action context memo, consumed by descendants.
 */
export function useNarratorForkActions(
	options: UseNarratorForkActionsOptions,
): UseNarratorForkActionsResult {
	const { narratorId, navigateToNarrator } = options;

	const forkNarratorMutation = useForkNarrator();
	const forkNarratorMutationRef = useRef(forkNarratorMutation);
	forkNarratorMutationRef.current = forkNarratorMutation;
	const navigateToNarratorRef = useRef(navigateToNarrator);
	navigateToNarratorRef.current = navigateToNarrator;

	// Keep row actions stable across inline navigation callbacks, but use the
	// latest mutation at click time and latest navigation when the fork completes.
	// Standalone narrators: fork narrator directly (no git involved)
	const handleStandaloneFork = useCallback(
		(messageId: string) => {
			forkNarratorMutationRef.current.mutate(
				{ narratorId, forkMessageId: messageId },
				{
					onSuccess: (newNarrator: { id: string }) => {
						navigateToNarratorRef.current(newNarrator.id);
					},
				},
			);
		},
		[narratorId],
	);
	// Legacy hosts keep their resource callbacks, but ordinary message forks never
	// call them: even a chapter-bound source produces an independent conversation.
	const forkHandler = handleStandaloneFork;

	const startAskInPassingMutation = useStartAskInPassing();
	const startAskInPassingMutationRef = useRef(startAskInPassingMutation);
	startAskInPassingMutationRef.current = startAskInPassingMutation;
	const handleAskInPassing = useCallback(
		(messageUuid: string | null, messageId: string) => {
			startAskInPassingMutationRef.current.mutate(
				{
					narratorId,
					sourceMessageId: messageId,
					sourceMessageUuid: messageUuid ?? undefined,
				},
				{
					onError: (error: Error) => {
						notifications.show({
							message: error.message,
							color: "red",
							autoClose: 5000,
						});
					},
				},
			);
		},
		[narratorId],
	);

	return { forkHandler, handleAskInPassing };
}
