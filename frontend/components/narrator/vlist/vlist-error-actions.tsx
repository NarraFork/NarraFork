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
 *   - fix    → (conditional) turn off the provider's native image_generation tool
 *              and retry, for the one failure where that is the actual cause
 *   - probe  → (conditional, admin only) open ModelTestDialog against the model the
 *              failed turn dispatched to. Restored here after the chunked card was
 *              deleted took its only entry point with it
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
import { ModelTestDialog } from "../../providers/ModelTestDialog";
import { removeMessagesFromCache } from "../message/messages-query-cache";
import { RetryRuleModal } from "../RetryRuleModal";
import { useCodexImageGenerationFix } from "../useCodexImageGenerationFix";
import { useNarratorModelTest } from "../useNarratorModelTest";
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
	/**
	 * The dialogs the whole list shares, mounted once by the shell: the retry-rule
	 * editor and the model probe. Rows are zero-DOM copies and cannot own a modal.
	 */
	ruleModal: ReactNode;
	/**
	 * Whether an error card with this text may offer the provider fix. Handed to
	 * the document build as `canOfferProviderFix`: the fix is a labelled button on
	 * its own row, so its presence changes the card's measured height and must be
	 * known during adaptation, not at paint time.
	 */
	canOfferProviderFix: (errorText: string) => boolean;
	/**
	 * Whether an error card with this text may offer the model probe. Same measured-
	 * row contract as `canOfferProviderFix` — it shares that button row.
	 */
	canOfferModelTest: (errorText: string) => boolean;
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
	// The provider-settings fix is per-narrator (it disables the tool for the
	// provider this narrator resolved to and retries its last turn), but whether a
	// given ROW may offer it depends on that row's error text, hence `canFix`.
	const imageGenFix = useCodexImageGenerationFix(narratorId);
	// The model probe, restored from the deleted chunked card. Same per-narrator /
	// per-row-text split as the fix above: eligibility depends on the user's role and
	// the narrator's resolved model, the error text decides which rows offer it.
	const modelTest = useNarratorModelTest(narratorId);
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
			// Whether the fix BUTTON exists was already decided during adaptation (it
			// occupies a measured row), so this only makes the painted button live for
			// the rows that carry it.
			const offerImageGenFix = imageGenFix.canFix(errorText);
			const offerModelTest = modelTest.canTest(errorText);
			const actions: ErrorNoticeActions = {
				onMarkRetryable: () => setRuleTarget(errorText),
				onDismiss: () => void dismiss(messageId),
				dismissing: dismissingId === messageId,
				markRetryableLabel,
				...(offerImageGenFix
					? { onDisableImageGen: imageGenFix.run, disablingImageGen: imageGenFix.busy }
					: {}),
				// The dialog opens for THIS row's text, so the probe reports against the
				// error the reader clicked rather than whichever card rendered last.
				...(offerModelTest ? { onTestModel: () => modelTest.open(errorText) } : {}),
			};
			cache.set(messageId, actions);
			return actions;
		};
		// The whole resolver is rebuilt (dropping its cache) whenever the fix's
		// applicability or busy state changes, so a row cannot keep serving a stale
		// loading flag — same reason `dismissingId` is a dependency.
	}, [
		dismiss,
		dismissingId,
		markRetryableLabel,
		imageGenFix.canFix,
		imageGenFix.run,
		imageGenFix.busy,
		modelTest.canTest,
		modelTest.open,
	]);

	const closeRuleModal = useCallback(() => setRuleTarget(null), []);

	const ruleModal = (
		<>
			{ruleTarget === null ? null : (
				<RetryRuleModal opened onClose={closeRuleModal} errorMessage={ruleTarget} />
			)}
			{modelTest.target === null ? null : (
				<ModelTestDialog
					opened
					onClose={modelTest.close}
					modelValue={modelTest.modelValue}
					selectedModelValue={modelTest.selectedModelValue}
					sourceError={modelTest.target}
				/>
			)}
		</>
	);

	return {
		resolve,
		ruleModal,
		canOfferProviderFix: imageGenFix.canFix,
		canOfferModelTest: modelTest.canTest,
	};
}
