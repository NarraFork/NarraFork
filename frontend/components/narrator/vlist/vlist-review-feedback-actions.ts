/**
 * vlist-review-feedback-actions.ts — the live handler behind the review card's button.
 *
 * The render layer (`render/RenderReviewCard.tsx`) draws the card from its measured
 * geometry and imports no REST client or i18n, so it only declares a `ReviewCardActions`
 * slot. This module fills it.
 *
 * What the button does is START A TURN, not send anything: the conclusion row IS the
 * narrator's user message and has been in its history since the review concluded. Being
 * informed therefore needs no click; only spending a model request on it does, which is
 * why a concluded review does not wake an idle narrator by itself.
 *
 * Kept as its own module (like `vlist-spec-carryover-actions`) so the wiring is
 * unit-testable without pulling the shell into the test graph.
 *
 * No local cache patch on success: the server flips `applied` on the block and
 * broadcasts `message_updated`, which the shell's WS subscription already applies.
 */

import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewCardActions } from "./render/RenderReviewCard";
import type { VListItem } from "./vlist-pipeline";

/** Resolve the per-message action slot; undefined when the row owns no message. */
export type ReviewFeedbackActionsResolver = (
	messageId: string | undefined,
) => ReviewCardActions | undefined;

/**
 * True when this row is the review card.
 *
 * One element kind, so one check: the conclusion is its own `review-card` element rather
 * than a card nested in something else. (It was briefly a `system-text` card inside an
 * `injection-bubble`, which is why the earlier version of this predicate had to know two
 * shapes — and why matching only one of them would have left the button inert on every
 * real row.)
 */
export function isReviewFeedbackItem(item: VListItem): boolean {
	return item.spec.kind === "review-card";
}

/**
 * Resolve a row's review actions, or undefined when the row is not a review card / has
 * no owning message id. Pure helper so the shell's render loop stays flat, mirroring
 * `resolveSpecCarryoverActions`.
 *
 * System cards carry no `-b{n}` block suffix and therefore no RowInteraction, so the
 * owning message comes from the manifest source ids.
 */
export function resolveReviewFeedbackActions(
	item: VListItem,
	sourceIds: readonly string[],
	resolve: ReviewFeedbackActionsResolver,
): ReviewCardActions | undefined {
	if (!isReviewFeedbackItem(item)) return undefined;
	return resolve(sourceIds[0]);
}

/**
 * Build the review-card action resolver for one narrator.
 *
 * The resolver caches one object per message id and keeps that identity stable until the
 * in-flight request changes, so unchanged rows keep referential props and the ExactRow
 * memo can keep skipping them during scroll.
 */
export function useReviewFeedbackActions(narratorId: string): ReviewFeedbackActionsResolver {
	const { t } = useTranslation("narrator");
	const [applyingId, setApplyingId] = useState<string | null>(null);
	// Read at click time so a second click is rejected without making the handler depend
	// on the in-flight state. The server claims the row transactionally as well — this
	// only spares the round trip.
	const applyingRef = useRef(applyingId);
	applyingRef.current = applyingId;

	const apply = useCallback(
		async (messageId: string) => {
			if (!narratorId || applyingRef.current) return;
			setApplyingId(messageId);
			try {
				await api.applyReviewFeedback(narratorId, messageId);
			} catch (err) {
				notifications.show({
					title: t("reviewFeedbackApplyFailed"),
					message: err instanceof Error ? err.message : String(err),
					color: "red",
				});
			} finally {
				setApplyingId(null);
			}
		},
		[narratorId, t],
	);

	return useMemo(() => {
		const cache = new Map<string, ReviewCardActions>();
		return (messageId: string | undefined) => {
			if (!messageId) return undefined;
			const cached = cache.get(messageId);
			if (cached) return cached;
			const actions: ReviewCardActions = {
				onApply: () => void apply(messageId),
				applying: applyingId === messageId,
			};
			cache.set(messageId, actions);
			return actions;
		};
	}, [apply, applyingId]);
}
