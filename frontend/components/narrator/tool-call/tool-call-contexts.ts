/**
 * Cross-cutting React contexts for the narrator message surface.
 *
 * These historically lived in ToolCallCard.tsx. They were extracted into this
 * neutral module so that non-card consumers (NarratorPanel providers, the file
 * approval surface, the vlist permission bridge) do not depend on the tool card
 * module — and so a future renderer swap does not have to carry the card just
 * to keep the contexts alive.
 */

import { createContext } from "react";

/**
 * Context carrying whether the narrator is currently thinking, plus the
 * tool-use id of the latest spec://tasks.json write. SpecTasksDetail uses these
 * to decide whether a doing task should animate — spinning only makes sense
 * while the narrator is actively working AND this card is the most recent tasks
 * snapshot (so historical task cards stay static rather than showing a false
 * "active" spinner). A null latest id means "unknown" → fall back to isThinking
 * alone so the live/streaming case still animates.
 */
export const LatestTodosToolUseIdCtx = createContext<{
	isThinking: boolean;
	latestSpecTasksToolUseId?: string | null;
}>({ isThinking: false, latestSpecTasksToolUseId: null });

/**
 * Context that lets a denied tool call in the latest assistant turn offer an
 * "allow and execute" action. Only enabled when the narrator is idle/interrupted
 * (no live loop running) so re-execution does not race the agent loop.
 */
export const AllowRetryCtx = createContext<{
	/** True when the narrator is idle/interrupted and re-execution is permitted. */
	enabled: boolean;
	/** The latest top-level assistant message ID — only its tool calls may retry. */
	latestAssistantMessageId: string | null;
	/** Trigger re-execution of a denied tool call by its toolUseId. */
	onAllowRetry: (toolUseId: string) => void;
}>({
	enabled: false,
	latestAssistantMessageId: null,
	onAllowRetry: () => {},
});

/**
 * Context for keyboard-driven permission button navigation.
 * `focusIndex` is the 0-based index of the currently focused button (null = inactive).
 * `setFocusIndex` lets the parent shift focus via arrow keys.
 *
 * `setButtonCount` lets the child report how many navigable buttons it has.
 * `setHasFeedback` lets the child report whether feedback text is present.
 * `registerActions` lets the child register onClick handlers so the parent can invoke them.
 */
export const PermEnterHintCtx = createContext<{
	focusIndex: number | null;
	setFocusIndex: (i: number | null) => void;
	setButtonCount: (n: number) => void;
	setHasFeedback: (has: boolean) => void;
	registerActions: (actions: (() => void)[]) => void;
	/** The permission ID that Enter key should bind to (earliest pending). */
	activePermissionId: string | null;
}>({
	focusIndex: null,
	setFocusIndex: () => {},
	setButtonCount: () => {},
	setHasFeedback: () => {},
	registerActions: () => {},
	activePermissionId: null,
});
