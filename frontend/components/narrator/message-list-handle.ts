/**
 * The imperative handle and tail-metadata contract shared by the narrator
 * message-list implementations.
 *
 * Historically declared in ChunkedMessageList.tsx; extracted so the panel and
 * the list implementations agree on the contract without importing a concrete
 * list component.
 */

import type { NarratorMsg } from "./narrator-panel-types";

export interface MessageListHandle {
	scrollToMessageTarget: (args: {
		domIds: string[];
		targetIds: string[];
		highlightId?: string;
	}) => Promise<boolean>;
	scrollToBottom: (instant?: boolean) => void;
	refreshStructure: (mode?: "diff" | "full") => void;
	detachFromBottom: () => void;
	/**
	 * Announce an imminent LOD change centered on a viewport point, so the list can
	 * keep that point visually fixed across the rebuild. The wheel/pinch handlers
	 * capture this themselves; UI-driven changes (the indicator's notches and
	 * steppers) have no gesture to capture from and call this instead.
	 */
	prepareLodChange: (clientY: number) => void;
}

export interface MessageListTailMeta {
	statusReady?: boolean;
	lastRealMessage: {
		id: string;
		role: NarratorMsg["role"];
	} | null;
	lastUserMessageId?: string;
	contextPercent?: number | null;
	turnUsageJson?: NarratorMsg["turnUsageJson"] | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
	/** Tool-use id of the most recent spec://tasks.json op; drives SpecTasksDetail spinner. */
	latestSpecTasksToolUseId?: string | null;
}
