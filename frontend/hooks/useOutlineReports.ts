/**
 * The outline's reports (汇报, P2 PR 11): the list of a person's reports (heads only, newest day
 * first, a page at a time by cursor), one report's detail (read only when it is opened), marking
 * reports read, asking for "today so far", and taking back a decision made in the person's name.
 *
 * A report changes only when the background job writes it, it is marked read, or a decision in it
 * is undone; each of these sends `human_attention_changed` to its person, which re-reads the list.
 * A detail is keyed by its head's `createdAt`: "today so far" is made again under the same id, and
 * the new head in the list is what makes the page read it again.
 */

import { HUMAN_ATTENTION_CHANGED_WS_TYPE } from "@shared/human-attention";
import type { OutlineDigestHead } from "@shared/outline-digest";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { humanAttentionQueryKey } from "./useHumanAttention";
import { invalidateOutlineSpace, outlineKeys } from "./useOutline";

export const outlineReportKeys = {
	all: ["outline", "reports"] as const,
	list: () => ["outline", "reports", "list"] as const,
	details: () => ["outline", "reports", "detail"] as const,
	detail: (id: string, createdAt: string) =>
		["outline", "reports", "detail", id, createdAt] as const,
};

/** Days per page of the list. */
export const OUTLINE_REPORT_PAGE = 14;
/** How often the list is read again while "today so far" is being made. */
export const OUTLINE_REPORT_POLL_MS = 1500;

/**
 * Commits undone from a report in this browser session. A delegate's confirmation keeps reading
 * as standing on the server once undone (its pending row does not record the revert), so the
 * client remembers what it took back.
 */
const undoneHere = new Set<string>();

export function wasUndoneHere(commitId: string | null): boolean {
	return commitId !== null && undoneHere.has(commitId);
}

/** The person's reports, newest day first; `poll` while a "today so far" is awaited. */
export function useOutlineReportList(options: { enabled?: boolean; poll?: boolean } = {}) {
	const enabled = options.enabled ?? true;
	const client = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		const handle = narratorWSManager.addListener(
			{ types: [HUMAN_ATTENTION_CHANGED_WS_TYPE] },
			() => {
				void client.invalidateQueries({ queryKey: outlineReportKeys.list() });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [client, enabled]);
	return useInfiniteQuery({
		queryKey: outlineReportKeys.list(),
		queryFn: ({ pageParam }) =>
			api.listOutlineReports({ before: pageParam, limit: OUTLINE_REPORT_PAGE }),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		retry: false,
		staleTime: 30_000,
		refetchInterval: options.poll ? OUTLINE_REPORT_POLL_MS : false,
	});
}

/** One report, read when it is opened; null `head` reads nothing. */
export function useOutlineReport(head: Pick<OutlineDigestHead, "id" | "createdAt"> | null) {
	return useQuery({
		queryKey: outlineReportKeys.detail(head?.id ?? "", head?.createdAt ?? ""),
		queryFn: () => api.getOutlineReport(head?.id as string),
		enabled: head !== null,
		retry: false,
		staleTime: 60_000,
	});
}

/** Mark reports read (opening one does). */
export function useMarkOutlineReportRead() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (ids: string[]) => api.markOutlineReportRead(ids),
		onSettled: () => {
			void client.invalidateQueries({ queryKey: outlineReportKeys.list() });
			void client.invalidateQueries({ queryKey: humanAttentionQueryKey });
		},
	});
}

/** Ask for "today so far". */
export function useRequestOutlineReportNow() {
	return useMutation({ mutationFn: () => api.requestOutlineReportNow() });
}

/**
 * Take back a decision made in the person's name. Afterwards the reports read again (whether it
 * still stands), and so do the space, the inbox and the confirmations it may have been among.
 */
export function useUndoOutlineDecision() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: { commitId: string; spaceId: string }) =>
			api.undoOutlineDecision(input.commitId),
		onSuccess: (_result, input) => {
			undoneHere.add(input.commitId);
		},
		onSettled: (_result, _error, input) => {
			void client.invalidateQueries({ queryKey: outlineReportKeys.details() });
			void client.invalidateQueries({ queryKey: outlineKeys.digest() });
			void client.invalidateQueries({ queryKey: humanAttentionQueryKey });
			invalidateOutlineSpace(client, input.spaceId);
		},
	});
}
