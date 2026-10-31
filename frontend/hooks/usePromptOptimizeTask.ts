import {
	getNarratorComposerOptimizeTask,
	getNarratorRunningOptimizeCount,
	getPromptOptimizeTask,
	type PromptOptimizeTask,
	promptOptimizeTaskKey,
	subscribePromptOptimizeTasks,
} from "@frontend/lib/prompt-optimize-tasks";
import { useCallback, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * The task for one composer target, re-rendering when it changes.
 *
 * `useSyncExternalStore` rather than `useState` + effect on purpose: the task can
 * change while this component is unmounted (that is the entire point of the
 * registry), so it must be read from the store on mount rather than mirrored into
 * local state that starts empty.
 */
export function usePromptOptimizeTask(
	narratorId: string,
	messageId?: string,
): PromptOptimizeTask | undefined {
	const key = promptOptimizeTaskKey(narratorId, messageId);
	const subscribe = useCallback(
		(listener: () => void) => subscribePromptOptimizeTasks(listener),
		[],
	);
	const getSnapshot = useCallback(() => getPromptOptimizeTask(key), [key]);
	// Server snapshot: nothing is running before hydration, and the store is
	// client-only, so an empty snapshot is the honest answer.
	return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/**
 * Whether any optimization is running for a narrator — drives the status icon.
 *
 * Returns a boolean derived from a count, so the snapshot is stable by value and
 * the dozens of icons on the sidebar do not re-render on unrelated task changes.
 */
export function useNarratorIsOptimizingPrompt(narratorId: string | null | undefined): boolean {
	const subscribe = useCallback(
		(listener: () => void) =>
			narratorId ? subscribePromptOptimizeTasks(listener) : noopSubscribe(),
		[narratorId],
	);
	const getSnapshot = useCallback(
		() => (narratorId ? getNarratorRunningOptimizeCount(narratorId) > 0 : false),
		[narratorId],
	);
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * The running main-composer optimization for a narrator, if any.
 *
 * Lets a freshly mounted composer adopt work that was started by a previous
 * instance of itself — which is what a narrator switch produces. Without this the
 * component starts from `loading: false` even though the request is still running,
 * so its toolbar disagrees with the status badge.
 */
export function useNarratorComposerOptimizeTask(
	narratorId: string | null | undefined,
): PromptOptimizeTask | undefined {
	const subscribe = useCallback(
		(listener: () => void) =>
			narratorId ? subscribePromptOptimizeTasks(listener) : noopSubscribe(),
		[narratorId],
	);
	const getSnapshot = useCallback(
		() => (narratorId ? getNarratorComposerOptimizeTask(narratorId) : undefined),
		[narratorId],
	);
	return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
