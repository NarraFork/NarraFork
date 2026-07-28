/**
 * vlist-error-actions.tsx — live handlers for the exact vlist's error notice card.
 *
 * The render layer (`render/RenderSystemText.tsx`) repaints the error card from
 * its measured geometry and must stay free of app coupling (no REST client, no
 * i18n, no modal), so it only declares an `ErrorNoticeActions` slot. Without an
 * injected slot the two right-side controls paint correctly but do nothing —
 * exactly the regression this module closes: in Virtual-list mode "Mark as
 * retryable" and the dismiss button were inert, while the chunked path
 * (MessageBubble's ErrorNotice) has always driven the real flows.
 *
 * Behaviour parity with the chunked card:
 *   - retry  → open the shared RetryRuleModal prefilled with this error's text
 *              (POST /settings/retry-rules + settings query invalidation live
 *              inside that component)
 *   - close  → DELETE the error message, drop it from the messages cache; the
 *              server broadcasts `messages_deleted`, which the shell already
 *              turns into a structural document reload
 *
 * The modal is hosted ONCE for the whole list (rows are zero-DOM copies and
 * cannot own a modal), keyed by the clicked row's error text.
 *
 * Kept as its own module (like vlist-spec-carryover-actions) so the wiring is
 * unit-testable without pulling the whole shell into the test graph.
 */

import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { removeMessagesFromCache } from "../MessageBubble";
import { RetryRuleModal } from "../RetryRuleModal";
import type { ErrorNoticeActions } from "./render/RenderSystemText";
import type { VListItem } from "./vlist-pipeline";

/** Resolve the per-row action slot; undefined when the row is not an error card. */
export type ErrorNoticeActionsResolver = (
	messageId: string | undefined,
	errorText: string,
) => ErrorNoticeActions | undefined;

/**
 * True when this row is the system error notice. The card kind lives in the
 * layout spec's data (the same value `resolveRenderExtra` forwards as
 * `extra.kind`), so no measure-layer import is needed.
 */
export function isErrorNoticeItem(item: VListItem): boolean {
	if (item.spec.kind !== "system-text") return false;
	return (item.spec.data as { kind?: unknown } | null)?.kind === "error";
}

/** The measured body text of an error row (prefills the retry-rule keyword). */
export function errorNoticeText(item: VListItem): string {
	const text = (item.spec.data as { text?: unknown } | null)?.text;
	return typeof text === "string" ? text : "";
}

/**
 * Resolve a row's error-notice actions, or undefined when the row is not an error
 * card / has no owning message id. Pure helper so the shell's render loop stays
 * flat, mirroring `resolveSpecCarryoverActions`.
 *
 * System cards carry no `-b{n}` block suffix and therefore no RowInteraction, so
 * the owning message comes from the manifest source ids.
 */
export function resolveErrorNoticeActions(
	item: VListItem,
	sourceIds: readonly string[],
	resolve: ErrorNoticeActionsResolver,
): ErrorNoticeActions | undefined {
	if (!isErrorNoticeItem(item)) return undefined;
	return resolve(sourceIds[0], errorNoticeText(item));
}

export interface VListErrorNoticeActions {
	/** Per-row resolver handed to `resolveErrorNoticeActions`. */
	resolve: ErrorNoticeActionsResolver;
	/** The single retry-rule dialog for the whole list (mounted by the shell). */
	ruleModal: ReactNode;
}

/**
 * Build the error-notice action resolver for one narrator, plus the one rule
 * dialog its rows share.
 *
 * The resolver caches one object per message id and keeps that identity stable
 * until the in-flight dismissal changes, so unchanged rows keep referential props
 * and the ExactRow memo can keep skipping them during scroll.
 */
export function useVListErrorNoticeActions(narratorId: string): VListErrorNoticeActions {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	// The error text the rule dialog is currently open for (null → closed).
	const [ruleTarget, setRuleTarget] = useState<string | null>(null);
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
				const result = await api.dismissErrorMessage(narratorId, messageId);
				// Drop the row locally too: the server also broadcasts
				// `messages_deleted` (which the shell turns into a structural reload),
				// but pruning the cache keeps the paged messages query consistent —
				// exactly what the chunked ErrorNotice does.
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

	const markRetryableLabel = t("markRetryable");

	const resolve = useMemo<ErrorNoticeActionsResolver>(() => {
		const cache = new Map<string, ErrorNoticeActions>();
		return (messageId: string | undefined, errorText: string) => {
			if (!messageId) return undefined;
			const cached = cache.get(messageId);
			if (cached) return cached;
			const actions: ErrorNoticeActions = {
				onMarkRetryable: () => setRuleTarget(errorText),
				onDismiss: () => void dismiss(messageId),
				dismissing: dismissingId === messageId,
				markRetryableLabel,
			};
			cache.set(messageId, actions);
			return actions;
		};
	}, [dismiss, dismissingId, markRetryableLabel]);

	const closeRuleModal = useCallback(() => setRuleTarget(null), []);

	const ruleModal =
		ruleTarget === null ? null : (
			<RetryRuleModal opened onClose={closeRuleModal} errorMessage={ruleTarget} />
		);

	return { resolve, ruleModal };
}
