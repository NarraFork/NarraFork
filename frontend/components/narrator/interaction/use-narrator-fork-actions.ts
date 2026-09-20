import { notifications } from "@mantine/notifications";
import { useCallback, useMemo, useRef } from "react";
import { useForkNarrator, useStartAskInPassing } from "../../../hooks/useNarrator";

export interface UseNarratorForkActionsOptions {
	narratorId: string;
	/** The narrator's chapter id (null/undefined for standalone narrators). */
	chapterId: string | null | undefined;
	/** Chapter-bound fork handler supplied by the host (git-aware auto-naming). */
	onForkFromMessage: ((messageId: string) => void) | undefined;
	/** Navigate to a narrator route (used after a standalone fork). */
	navigateToNarrator: (narratorId: string) => void;
}

export interface UseNarratorForkActionsResult {
	/** Fork from a message: chapter-bound via host handler, else a direct narrator fork. */
	forkHandler: ((messageId: string) => void) | undefined;
	/** Start an "ask in passing" child probe from a source message. */
	handleAskInPassing: (messageUuid: string | null, messageId: string) => void;
}

/**
 * Fork + "ask in passing" actions extracted from NarratorPanel. A chapter-bound
 * narrator forks through the host's `onForkFromMessage` (auto-named, git-aware);
 * a standalone narrator forks its session directly and navigates to the new one.
 *
 * Kept lifted (called from the panel): the resolved handlers feed the panel's
 * trace-row action context memo, consumed by descendants.
 */
export function useNarratorForkActions(
	options: UseNarratorForkActionsOptions,
): UseNarratorForkActionsResult {
	const { narratorId, chapterId, onForkFromMessage, navigateToNarrator } = options;

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
	// Chapter-bound: use onForkFromMessage (direct fork with auto-generated name)
	// Standalone: use handleStandaloneFork (direct narrator fork)
	const forkHandler = useMemo(
		() => (chapterId ? onForkFromMessage : handleStandaloneFork),
		[chapterId, onForkFromMessage, handleStandaloneFork],
	);

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
