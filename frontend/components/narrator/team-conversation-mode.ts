/**
 * Team mode of the coordinator conversation (the team page's left column): an opt-in context
 * the team route provides around its `NarratorPanel`. The message list reads it and, only when
 * it is present, folds the coordinator's `Team` calls into one-line chips and shows team events
 * as dividers at their time (`vlist/team-conversation-transform.ts`). The session page provides
 * nothing, so its list builds exactly as before.
 *
 * Zero-dependency on purpose: the team components import this, never the lazily loaded vlist.
 */
import { createContext, useContext } from "react";

/** One divider, already worded by the provider (time and text). */
export interface TeamConversationEvent {
	id: string;
	/** Epoch ms of the event. */
	at: number;
	/** The whole line: 「10:31 · 「修复导出 CSV 时区错误」评审通过」. */
	text: string;
	tone: "ok" | "warn" | "neutral";
}

/** Localized chip text: a label per action key (see `teamChipActionKey`), plus the counts. */
export interface TeamChipLabels {
	actions: Readonly<Record<string, string>>;
	/** Label of an action without its own wording. */
	other: string;
	/** 「×{count}」 */
	count: (count: number) => string;
	/** 「{count} 次失败」 */
	failed: (count: number) => string;
}

/** What the list reports about its loaded window, so events page together with messages. */
export interface TeamConversationWindow {
	/** `createdAt` of the oldest loaded message, null while nothing is loaded. */
	oldestAt: string | null;
	/** More (older) messages exist above the loaded window. */
	hasPrev: boolean;
}

export interface TeamConversationMode {
	/** Dividers, ascending by `(at, id)`. */
	events: readonly TeamConversationEvent[];
	chipLabels: TeamChipLabels;
	/** Changes whenever `events` or the labels do (the layout's rebuild + cache identity). */
	revision: string;
	onWindowChange?: (window: TeamConversationWindow) => void;
}

export const TeamConversationModeContext = createContext<TeamConversationMode | null>(null);

export function useTeamConversationMode(): TeamConversationMode | null {
	return useContext(TeamConversationModeContext);
}
