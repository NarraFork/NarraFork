/**
 * Team mode of the coordinator conversation (the team page's left column): the rules that turn
 * team events into divider lines, and the hook that reads them for the loaded window and builds
 * the `TeamConversationModeContext` value the route provides around the narrator panel.
 *
 * Bounded: the events read is the ordinary `/events` with the fixed divider kinds and `since` =
 * the oldest loaded message while older history exists, newest first, at most
 * {@link TEAM_CONVERSATION_EVENT_PAGES} pages of 50. Scrolling up moves `since` and fetches
 * the older dividers; live ones arrive through the summary's `lastEventId` invalidation of the
 * activity key prefix (`useTeamSummary`).
 */
import type {
	TeamChipLabels,
	TeamConversationEvent,
	TeamConversationMode,
	TeamConversationWindow,
} from "@frontend/components/narrator/team-conversation-mode";
import type { TeamActivityEvent, TeamActivityPage } from "@shared/project-teams";
import { type InfiniteData, keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { teamKeys } from "../../hooks/useTeams";
import { api } from "../../lib/api";

/** Most event pages (of 50) one window reads; older dividers are then simply not shown. */
export const TEAM_CONVERSATION_EVENT_PAGES = 4;

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** Epoch ms of a server time (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS` in UTC); NaN if none. */
export function serverTimeMs(value: string | null | undefined): number {
	if (!value) return Number.NaN;
	const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
	return Date.parse(sqlite ? `${value.replace(" ", "T")}Z` : value);
}

/** The `since` bound of the events read: the oldest loaded message, only while older exist. */
export function conversationSince(window: TeamConversationWindow | null): string | undefined {
	if (!window?.hasPrev || !window.oldestAt) return undefined;
	const ms = serverTimeMs(window.oldestAt);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 「10:31」 today, 「11-26 10:31」 another day (local time). */
export function dividerTime(ms: number, now: number): string {
	const date = new Date(ms);
	const today = new Date(now);
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One event as a divider: its i18n key (under `teams.conversation.event.`), values and tone, or
 * null for a kind (or a detail) that makes no divider.
 */
export function dividerOf(event: Pick<TeamActivityEvent, "kind" | "detail" | "workItemTitle">): {
	key: string;
	values: Record<string, string | number>;
	tone: TeamConversationEvent["tone"];
} | null {
	const detail = event.detail ?? {};
	const pr = num(detail.pr);
	switch (event.kind) {
		case "work.review":
			if (detail.verdict === "clear") return { key: "reviewClear", values: {}, tone: "ok" };
			if (detail.verdict === "blocker") return { key: "reviewBlocker", values: {}, tone: "warn" };
			return null;
		case "work.returned":
			return { key: "returned", values: {}, tone: "warn" };
		case "work.merged":
			return detail.detectedBy === "pull_request" && pr !== null
				? { key: "mergedPr", values: { pr }, tone: "ok" }
				: { key: "merged", values: {}, tone: "ok" };
		case "work.pr_opened":
			return pr !== null ? { key: "prOpened", values: { pr }, tone: "neutral" } : null;
		case "work.merge_failed":
			return { key: "mergeFailed", values: {}, tone: "warn" };
		default:
			return null;
	}
}

/** The events of the pages as dividers, ascending by `(at, id)`, each worded once. */
export function conversationEvents(
	events: readonly TeamActivityEvent[],
	t: Translate,
	now: number,
): TeamConversationEvent[] {
	const out: TeamConversationEvent[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		const at = serverTimeMs(event.createdAt);
		const divider = dividerOf(event);
		if (!divider || !Number.isFinite(at)) continue;
		const title = event.workItemTitle?.trim() || t("teams.conversation.event.untitled");
		const text = t(`teams.conversation.event.${divider.key}`, { ...divider.values, title });
		out.push({
			id: event.id,
			at,
			text: t("teams.conversation.eventLine", { time: dividerTime(at, now), text }),
			tone: divider.tone,
		});
	}
	return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Chip wording; action keys are the transform's (`work.create`, `brief.read`, …). */
export function chipLabels(t: Translate): TeamChipLabels {
	const actions: Record<string, string> = {};
	for (const action of [
		"work.create",
		"work.update",
		"work.review",
		"work.ready",
		"work.sync",
		"work.cancel",
		"work.list",
		"brief.read",
		"brief.write",
		"checkin",
		"decision",
		"cleanup",
	])
		actions[action] = t(`teams.conversation.chip.${action.replace(".", "_")}`);
	return {
		actions,
		other: t("teams.conversation.chip.other"),
		count: (count) => t("teams.conversation.chipCount", { count }),
		failed: (count) => t("teams.conversation.chipFailed", { count }),
	};
}

/** A short, stable signature of the dividers (joins the layout's revision). */
export function eventsRevision(events: readonly TeamConversationEvent[], language: string): string {
	let hash = 5381;
	for (const event of events) {
		const text = `${event.id}|${event.text}|${event.tone};`;
		for (let index = 0; index < text.length; index++)
			hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
	}
	return `${language}:${events.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * The team mode value for the coordinator's panel. Reads nothing until the list has reported
 * its loaded window.
 */
export function useTeamConversationModeValue(
	projectId: string,
	teamId: string,
): TeamConversationMode {
	const { t, i18n } = useTranslation("projects");
	const [window, setWindow] = useState<TeamConversationWindow | null>(null);
	const onWindowChange = useCallback((next: TeamConversationWindow) => {
		setWindow((previous) =>
			previous && previous.oldestAt === next.oldestAt && previous.hasPrev === next.hasPrev
				? previous
				: next,
		);
	}, []);
	const since = conversationSince(window);
	const query = useInfiniteQuery<
		TeamActivityPage,
		Error,
		InfiniteData<TeamActivityPage>,
		readonly unknown[],
		string | undefined
	>({
		queryKey: [...teamKeys.activity(teamId), "conversation", since ?? "all"],
		queryFn: ({ pageParam }) =>
			api.getTeamConversationEvents(projectId, teamId, { since, cursor: pageParam }),
		initialPageParam: undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: !!projectId && !!teamId && window !== null,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: false,
		gcTime: 60_000,
	});
	const pages = query.data?.pages.length ?? 0;
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage && pages < TEAM_CONVERSATION_EVENT_PAGES)
			void fetchNextPage();
	}, [hasNextPage, isFetchingNextPage, pages, fetchNextPage]);
	const raw = query.data?.pages;
	const events = useMemo(
		() => conversationEvents(raw?.flatMap((page) => page.events) ?? [], t, Date.now()),
		[raw, t],
	);
	const labels = useMemo(() => chipLabels(t), [t]);
	const language = i18n.language;
	return useMemo(
		() => ({
			events,
			chipLabels: labels,
			revision: eventsRevision(events, language),
			onWindowChange,
		}),
		[events, labels, language, onWindowChange],
	);
}
