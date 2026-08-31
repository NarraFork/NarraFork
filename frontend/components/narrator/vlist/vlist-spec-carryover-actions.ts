/**
 * vlist-spec-carryover-actions.ts — live button handlers for the vlist's Dynamic
 * Spec notice cards (spec_fork_carryover / spec_context_cleared / spec_goal_added).
 *
 * The render layer (`render/RenderSystemText.tsx`) draws these cards from their
 * measured geometry and must stay free of app coupling (no REST client, no
 * confirm dialog, no i18n), so it only declares a `SpecCarryoverActions` slot.
 * Without an injected slot the three buttons paint correctly but do nothing —
 * exactly the regression this module closes: in Virtual-list mode "View tasks" /
 * "Clear" / "Reset Spec" were inert, while the chunked path (MessageBubble's
 * SpecForkCarryoverCard) has always driven the real mutations.
 *
 * Behaviour parity with the chunked card:
 *   - clear  → POST spec/tasks/clear, then dismiss the notice
 *   - reset  → confirm dialog, POST spec/reset, then dismiss the notice
 *   - both invalidate the narrator's spec queries and toast the result
 *   - dismissal is a server delete that broadcasts `messages_deleted`, which the
 *     shell already turns into a structural document reload
 *
 * Kept as its own module (like vlist-user-bubble-header) so the wiring is
 * unit-testable without pulling the whole shell into the test graph.
 */

import { useConfirmDialog } from "@frontend/components/common/confirm-dialog-context";
import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpecCarryoverActions } from "./render/RenderSystemText";
import type { VListItem } from "./vlist-pipeline";

/** The system-text card kinds that carry Dynamic Spec buttons. */
const SPEC_ACTION_KINDS = new Set([
	"spec_fork_carryover",
	"spec_context_cleared",
	"spec_goal_added",
]);

/** Resolve the per-message action slot; undefined when the row owns no message. */
export type SpecCarryoverActionsResolver = (
	messageId: string | undefined,
) => SpecCarryoverActions | undefined;

/**
 * True when this row is one of the Dynamic Spec notice cards. The card kind lives
 * in the layout spec's data (the same value `resolveRenderExtra` forwards as
 * `extra.kind`), so no measure-layer import is needed.
 */
export function isSpecCarryoverItem(item: VListItem): boolean {
	if (item.spec.kind !== "system-text") return false;
	const kind = (item.spec.data as { kind?: unknown } | null)?.kind;
	return typeof kind === "string" && SPEC_ACTION_KINDS.has(kind);
}

/**
 * Resolve a row's spec-notice actions, or undefined when the row is not a spec
 * notice / has no owning message id. Pure helper so the shell's render loop stays
 * flat, mirroring `resolveReflectionTakeOver`.
 *
 * System cards carry no `-b{n}` block suffix and therefore no RowInteraction, so
 * the owning message comes from the manifest source ids (same as the
 * subagent-recovery card's submit wiring).
 */
export function resolveSpecCarryoverActions(
	item: VListItem,
	sourceIds: readonly string[],
	resolve: SpecCarryoverActionsResolver,
): SpecCarryoverActions | undefined {
	if (!isSpecCarryoverItem(item)) return undefined;
	return resolve(sourceIds[0]);
}

/**
 * Build the spec-notice action resolver for one narrator.
 *
 * `onViewTasks` opens the Spec task board and is owned by the shell (the chunked
 * card bubbles a `spec-open-tasks` DOM event to the NarratorPanel viewport; the
 * shell does the same from its scroll node).
 *
 * The returned resolver caches one object per message id and keeps that identity
 * stable until the in-flight action changes, so unchanged rows keep referential
 * props and the ExactRow memo can keep skipping them during scroll.
 */
export function useSpecCarryoverActions(
	narratorId: string,
	onViewTasks: () => void,
): SpecCarryoverActionsResolver {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();
	const [busy, setBusy] = useState<{ messageId: string; action: "clear" | "reset" } | null>(null);
	// Read at click time so a second click (or another card's button) is rejected
	// without making the handlers depend on the busy state.
	const busyRef = useRef(busy);
	busyRef.current = busy;

	const runAction = useCallback(
		async (messageId: string, action: "clear" | "reset") => {
			if (!narratorId || busyRef.current) return;
			if (action === "reset") {
				const ok = await confirm({
					title: t("specForkResetConfirmTitle"),
					message: t("specForkResetConfirmMessage"),
					confirmLabel: t("specForkResetSpec"),
					confirmColor: "red",
				});
				if (!ok) return;
			}
			setBusy({ messageId, action });
			try {
				if (action === "clear") await api.clearSpecTasks(narratorId);
				else await api.resetSpec(narratorId);
				// Dismissing the notice deletes the display message server-side and
				// broadcasts `messages_deleted`; the shell's WS subscription turns that
				// into a structural reload, so the card disappears without a local
				// cache patch.
				await api.dismissSpecCarryoverMessage(narratorId, messageId);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId, "spec"] });
				notifications.show({
					message: t(action === "clear" ? "specForkClearedToast" : "specForkResetToast"),
					color: "green",
					autoClose: 2000,
				});
			} catch (err) {
				notifications.show({
					message: err instanceof Error ? err.message : String(err),
					color: "red",
				});
			} finally {
				setBusy(null);
			}
		},
		[confirm, narratorId, qc, t],
	);

	return useMemo(() => {
		const cache = new Map<string, SpecCarryoverActions>();
		return (messageId: string | undefined) => {
			if (!messageId) return undefined;
			const cached = cache.get(messageId);
			if (cached) return cached;
			const actions: SpecCarryoverActions = {
				onViewTasks,
				onClearTasks: () => void runAction(messageId, "clear"),
				onResetSpec: () => void runAction(messageId, "reset"),
				busy: busy?.messageId === messageId ? busy.action : null,
			};
			cache.set(messageId, actions);
			return actions;
		};
	}, [busy, onViewTasks, runAction]);
}
