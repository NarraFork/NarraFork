/**
 * Notification center data hooks.
 *
 * WS contract (spec §6.1): event `notification_center_changed` is data-free.
 * The client marks queries stale once per coalesced frame — never a full
 * list storm — and only refetches unread-count (and the open drawer's page).
 */

import type {
	NotificationKind,
	NotificationListItem,
	NotificationListPage,
	NotificationUnreadCounts,
} from "@shared/notification-center";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	filterItemsForDisplay,
	listQueryParams,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	type NotificationCenterFilter,
	type NotificationNavigateTarget,
	notificationNavigateTarget,
	notificationQueryKeys,
} from "./types";

const SUMMARY_STALE_TIME_MS = 30_000;
const LIST_STALE_TIME_MS = 10_000;

export type {
	NotificationCenterFilter,
	NotificationKind,
	NotificationListItem,
	NotificationListPage,
	NotificationNavigateTarget,
};
export {
	filterItemsForDisplay,
	listQueryParams,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	notificationNavigateTarget,
	notificationQueryKeys,
};

/** Flatten infinite pages for rendering. */
export function flattenNotificationPages(
	pages: NotificationListPage[] | undefined,
): NotificationListItem[] {
	if (!pages) return [];
	return pages.flatMap((page) => page.items);
}

/**
 * Coalesced invalidation of the notification-center query family.
 * One microtask flush per burst, regardless of how many frames arrived.
 */
export function markNotificationCenterStale(client: QueryClient): void {
	void client.invalidateQueries({ queryKey: notificationQueryKeys.root });
}

/**
 * Subscribe to `notification_center_changed`.
 *
 * Mounted from the Header bell so the badge stays live without the drawer
 * being open. Reconnect also invalidates once (dropped frames are invisible).
 */
export function useNotificationCenterLive(enabled = true): void {
	const qc = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let queued = false;
		const flush = () => {
			if (queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				markNotificationCenterStale(qc);
			});
		};
		const listener = narratorWSManager.addListener(
			{ types: [NOTIFICATION_CENTER_CHANGED_WS_TYPE] },
			flush,
		);
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) flush();
		});
		return () => {
			offConnection();
			narratorWSManager.removeListener(listener);
		};
	}, [enabled, qc]);
}

/** Aggregated unread badge source. */
export function useNotificationUnreadCounts(enabled = true) {
	useNotificationCenterLive(enabled);
	return useQuery({
		queryKey: notificationQueryKeys.unreadCount(),
		queryFn: () => api.getNotificationUnreadCounts(),
		enabled,
		staleTime: SUMMARY_STALE_TIME_MS,
		// Badge is updated by WS + mutation paths; focus remount is not a reason
		// to re-hit SQLite every Alt-Tab (same reasoning as chat unread).
		refetchOnWindowFocus: false,
	});
}

/** Infinite list for the drawer. Cursor pagination; no unbounded COUNT. */
export function useNotificationList(filter: NotificationCenterFilter, enabled = true) {
	const params = listQueryParams(filter);
	const query = useInfiniteQuery({
		queryKey: notificationQueryKeys.list(params),
		queryFn: ({ pageParam }) =>
			api.listNotifications({
				...params,
				cursor: pageParam ?? null,
				limit: 30,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (last: NotificationListPage) => last.nextCursor ?? undefined,
		enabled,
		staleTime: LIST_STALE_TIME_MS,
		refetchOnWindowFocus: false,
	});
	const items = filterItemsForDisplay(filter, flattenNotificationPages(query.data?.pages));
	return { ...query, items };
}

function patchUnreadAfterRead(
	client: QueryClient,
	kind: NotificationKind | undefined,
	ids: string[] | undefined,
): void {
	client.setQueryData(
		notificationQueryKeys.unreadCount(),
		(prev: NotificationUnreadCounts | undefined) => {
			if (!prev) return prev;
			const n = ids?.length ?? 0;
			if (n === 0 && !kind) {
				return {
					total: 0,
					chat_message: 0,
					permission_request: 0,
					lowerBound: false,
				};
			}
			// Without per-row kind in the optimistic path, clamp totals and let the
			// next unread-count fetch reconcile exact per-kind numbers.
			const total = Math.max(0, prev.total - n);
			let chat = prev.chat_message;
			let perm = prev.permission_request;
			if (kind === "chat_message") chat = Math.max(0, chat - n);
			else if (kind === "permission_request") perm = Math.max(0, perm - n);
			return {
				...prev,
				total,
				chat_message: chat,
				permission_request: perm,
				lowerBound: prev.lowerBound && total > 0 ? prev.lowerBound : false,
			};
		},
	);
}

/** Mark selected notifications read (row click or bulk). */
export function useMarkNotificationsRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { ids?: string[]; before?: number; kind?: NotificationKind }) =>
			api.markNotificationsRead(body),
		onSuccess: (_data, body) => {
			if (body.ids?.length) {
				patchUnreadAfterRead(qc, body.kind, body.ids);
			} else {
				patchUnreadAfterRead(qc, body.kind, undefined);
			}
			// Refresh lists so display status settles without waiting for a WS round-trip.
			void qc.invalidateQueries({ queryKey: notificationQueryKeys.root });
		},
	});
}

/** Delete one notification row (API present; UI chrome may come later). */
export function useDeleteNotification() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteNotification(id),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: notificationQueryKeys.root });
		},
	});
}

export interface NotificationActivateResult {
	navigated: boolean;
	markedRead: boolean;
	target: NotificationNavigateTarget | null;
}

/**
 * Row click: mark read + navigate (unless gone).
 * Navigation is the caller's job (router); this returns the target.
 *
 * `resolved` permission rows still mark read and still navigate when the
 * narrator/link target exists — only true `gone` is inert (review M1).
 */
export function useActivateNotification() {
	const markRead = useMarkNotificationsRead();
	return useCallback(
		(item: NotificationListItem): NotificationActivateResult => {
			const target = notificationNavigateTarget(item);
			const alreadyRead = item.status === "read";
			// gone is inert: no navigation, no read mutation (spec §6.2.4).
			const gone = item.displayStatus === "gone";
			if (!alreadyRead && !gone) {
				void markRead.mutateAsync({ ids: [item.id], kind: item.kind }).catch(() => {
					// Read failure must not block navigation; WS/invalidate will reconcile.
				});
			}
			return {
				navigated: target != null,
				markedRead: !alreadyRead && !gone,
				target,
			};
		},
		[markRead],
	);
}

/** Pure helper for tests / drawer header label. */
export function notificationFilterFromValue(value: string): NotificationCenterFilter {
	switch (value) {
		case "actionable":
		case "messages":
		case "permissions":
		case "all":
			return value;
		default:
			return "all";
	}
}
