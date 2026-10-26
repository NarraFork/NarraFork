/**
 * The imperative handle and tail-metadata contract shared by the narrator
 * message-list implementations.
 *
 * Historically declared in ChunkedMessageList.tsx; extracted so the panel and
 * the list implementations agree on the contract without importing a concrete
 * list component.
 */

import type { BlockSourceMessage } from "@shared/narrator-blocks/message-blocks";
import type { NarratorMsg } from "../narrator-panel-types";

/** What the reader was looking for when they asked for the jump. */
export interface MessageJumpOptions {
	/**
	 * Text the target row should show (a quoted excerpt, a search query). One
	 * message renders as several rows; this picks the row that contains it.
	 */
	needle?: string;
}

/** A dock bridge that scrolls to and highlights a message in the chat panel. */
export type ScrollToMessageFn = (messageId: string, options?: MessageJumpOptions) => void;

export interface MessageListHandle {
	scrollToMessageTarget: (args: {
		domIds: string[];
		targetIds: string[];
		highlightId?: string;
		/** Text the target row should show; picks among the message's rows. */
		needle?: string;
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
	/**
	 * A loaded message's row, for the blocks an action names (§5.5); undefined when the
	 * message is not loaded.
	 */
	messageOf: (messageId: string) => BlockSourceMessage<unknown> | undefined;
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
	/** Tool-use id of the most recent spec://tasks.json op; drives SpecTasksDetail spinner. */
	latestSpecTasksToolUseId?: string | null;
}
