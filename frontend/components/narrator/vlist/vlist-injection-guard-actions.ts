/**
 * vlist-injection-guard-actions.ts — live dismiss handler for the interrupt
 * task-guard reminder card.
 *
 * The reminder (server source `interrupt_task_guard`) is rendered as an
 * origin_notice system-text card. The render layer (`RenderSystemText`'s
 * OriginNoticeCard) only declares an `InjectionGuardActions` slot; this module
 * wires the real DELETE + cache prune, mirroring vlist-error-actions.
 *
 * Matching is by `data.kind === "origin_notice"` AND `data.originLabel ===
 * "interrupt_task_guard"` — originLabel is the raw injection source the
 * adapter already carries, so no other origin notice grows a close button.
 */

import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { removeMessagesFromCache } from "../message/messages-query-cache";
import type { InjectionGuardActions } from "./render/RenderSystemText";
import type { VListItem } from "./vlist-pipeline";

/** The server-side injection source this dismiss slot serves. */
export const INTERRUPT_TASK_GUARD_SOURCE = "interrupt_task_guard";

/** Resolve the per-row action slot; undefined when the row is not a guard card. */
export type InjectionGuardActionsResolver = (
	messageId: string | undefined,
) => InjectionGuardActions | undefined;

/** True when this row is the interrupt task-guard reminder card. */
export function isInterruptGuardItem(item: VListItem): boolean {
	if (item.spec.kind !== "system-text") return false;
	const data = item.spec.data as { kind?: unknown; originLabel?: unknown } | null;
	return data?.kind === "origin_notice" && data?.originLabel === INTERRUPT_TASK_GUARD_SOURCE;
}

/**
 * Resolve a row's guard actions, or undefined when the row is not the reminder
 * card / has no owning message id. Pure helper so the shell's render loop stays
 * flat, mirroring `resolveErrorNoticeActions`.
 */
export function resolveInterruptGuardActions(
	item: VListItem,
	sourceIds: readonly string[],
	resolve: InjectionGuardActionsResolver,
): InjectionGuardActions | undefined {
	if (!isInterruptGuardItem(item)) return undefined;
	return resolve(sourceIds[0]);
}

/**
 * Build the dismiss resolver for one narrator. The resolver caches one object
 * per message id and keeps that identity stable until the in-flight dismissal
 * changes, so unchanged rows keep referential props and the row memo can keep
 * skipping them during scroll.
 */
export function useInterruptGuardActions(narratorId: string): InjectionGuardActionsResolver {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const [dismissingId, setDismissingId] = useState<string | null>(null);
	// Read at click time so a second click is rejected without making the handler
	// depend on the in-flight state.
	const dismissingRef = useRef(dismissingId);
	dismissingRef.current = dismissingId;

	const dismiss = useCallback(
		async (messageId: string) => {
			if (!narratorId || dismissingRef.current) return;
			setDismissingId(messageId);
			try {
				const result = await api.dismissInterruptTaskGuardMessage(narratorId, messageId);
				// Drop the row locally too: the server also broadcasts
				// `messages_deleted` (which the shell turns into a structural reload),
				// but pruning the cache keeps the paged messages query consistent.
				removeMessagesFromCache(qc, narratorId, result.deletedMessageIds ?? [messageId]);
			} catch {
				notifications.show({
					title: t("deleteMessageFailed"),
					message: t("deleteMessageFailedDesc"),
					color: "red",
					autoClose: 5000,
				});
			} finally {
				setDismissingId(null);
			}
		},
		[narratorId, qc, t],
	);

	const dismissLabel = t("interruptGuard.dismiss");

	return useMemo<InjectionGuardActionsResolver>(() => {
		const cache = new Map<string, InjectionGuardActions>();
		return (messageId: string | undefined) => {
			if (!messageId) return undefined;
			const cached = cache.get(messageId);
			if (cached) return cached;
			const actions: InjectionGuardActions = {
				onDismiss: () => void dismiss(messageId),
				dismissing: dismissingId === messageId,
				dismissLabel,
			};
			cache.set(messageId, actions);
			return actions;
		};
		// The resolver is rebuilt (dropping its cache) when the in-flight id or the
		// label changes, so no row keeps serving a stale loading flag — same reason
		// `dismissingId` is a dependency in vlist-error-actions.
	}, [dismiss, dismissingId, dismissLabel]);
}
