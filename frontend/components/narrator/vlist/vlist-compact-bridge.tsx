/**
 * vlist-compact-bridge.tsx — Compact-marker interactions for the exact vlist.
 *
 * The pretext vlist paints every row as a zero-DOM copy, so a compact marker has
 * no component of its own that could own state, a modal, or an API call. This
 * integration-layer hook rebuilds the two interactions the chunked
 * CompactIndicator / SegmentCompactIndicator provide and hands them to the
 * renderer as plain callbacks:
 *
 *   - open  → the SHELL-LEVEL CompactSummaryModal that NarratorPanel already
 *             mounts above the list (CompactSummaryModalCtx). Reusing it means
 *             the summary body, edit, delete and failed-compact retry flows are
 *             literally the same component as the chunked path, and a message
 *             append cannot unmount the modal mid-edit.
 *   - cancel → the same confirm dialog + `POST /compact/cancel` the chunked
 *             marker fires, hosted ONCE for the whole list.
 *
 * Both are keyed by `spec.key`, and neither can change a row's height: the marker
 * row is a constant 25px and the confirm dialog is a portal-mounted modal.
 *
 * Lives in vlist/ (so the isolation guard allows importing outer app modules) and
 * is only ever used by PretextExactMessageList.
 */

import { narratorsApi } from "@frontend/lib/api/narrators";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CompactSummaryModalCtx } from "../MessageBubble";
import { resolveVListCompactTarget, type VListCompactTarget } from "./vlist-compact-target";
import type { VListItem } from "./vlist-pipeline";

/** Per-row compact callbacks handed to the render layer through `extra`. */
export interface VListCompactRowActions {
	/** Open the summary modal for a finished / failed marker. */
	onOpenCompact?: () => void;
	/** Ask to abort a RUNNING context compaction. */
	onCancelCompact?: () => void;
}

export interface UseVListCompactActionsArgs {
	narratorId: string;
	renderItems: readonly VListItem[];
	/** `spec.key → manifest source message ids` (system cards carry no id in the key). */
	sourceIdsByKey: ReadonlyMap<string, readonly string[]>;
}

export interface VListCompactActions {
	/** `spec.key → the row's compact callbacks`; absent for non-marker rows. */
	byKey: ReadonlyMap<string, VListCompactRowActions>;
	/** Localized tooltip for the cancel affordance. */
	cancelTitle: string;
	/** The single confirm dialog for the whole list (null while nothing pending). */
	cancelDialog: ReactNode;
}

/**
 * Build the per-row compact callbacks for the currently rendered items, plus the
 * one confirm dialog they share.
 *
 * The map is rebuilt only when the rendered items / source ids change (never on
 * scroll), so each row's callbacks stay referentially stable inside one document
 * revision and the `ExactRow` memo keeps skipping unchanged rows.
 */
export function useVListCompactActions({
	narratorId,
	renderItems,
	sourceIdsByKey,
}: UseVListCompactActionsArgs): VListCompactActions {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const summaryModal = useContext(CompactSummaryModalCtx);
	// The marker whose cancellation is awaiting confirmation (null → dialog closed).
	const [pendingCancel, setPendingCancel] = useState<VListCompactTarget | null>(null);
	const [cancelling, setCancelling] = useState(false);

	// A deleted / edited summary invalidates the messages query, which is what the
	// chunked marker's `onDelete` does. The exact shell reloads its document from
	// the same WS/messages revision, so refreshing the query is enough here too.
	const invalidateMessages = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] });
	}, [queryClient, narratorId]);

	const openSummary = useCallback(
		(target: VListCompactTarget) => {
			// No provider (e.g. a harness render) → nothing to open; the row simply
			// stays inert rather than throwing.
			summaryModal?.open({
				kind: target.kind,
				narratorId,
				messageId: target.messageId,
				onDelete: invalidateMessages,
			});
		},
		[summaryModal, narratorId, invalidateMessages],
	);

	const byKey = useMemo(() => {
		const map = new Map<string, VListCompactRowActions>();
		for (const item of renderItems) {
			if (!item) continue;
			const target = resolveVListCompactTarget(
				item.spec.kind,
				item.spec.data,
				sourceIdsByKey.get(item.spec.key) ?? [],
			);
			if (!target) continue;
			const actions: VListCompactRowActions = {};
			// A running compact has no summary yet; a finished one cannot be cancelled.
			// Exactly one of the two is ever bound (parity with the chunked marker).
			if (target.canCancel) {
				actions.onCancelCompact = () => setPendingCancel(target);
			} else if (target.canOpen && summaryModal) {
				actions.onOpenCompact = () => openSummary(target);
			}
			if (actions.onCancelCompact || actions.onOpenCompact) map.set(item.spec.key, actions);
		}
		return map;
	}, [renderItems, sourceIdsByKey, summaryModal, openSummary]);

	const closeCancelDialog = useCallback(() => setPendingCancel(null), []);

	const confirmCancel = useCallback(async () => {
		setCancelling(true);
		try {
			const res = await narratorsApi.cancelCompact(narratorId);
			// The rollback + marker removal arrive over WS (messages_deleted /
			// compact_done), which the shell already turns into a document reload.
			if (!res.ok) {
				notifications.show({
					message: t("cancelCompactFailedDesc"),
					color: "yellow",
					autoClose: 4000,
				});
			}
			setPendingCancel(null);
		} catch {
			notifications.show({
				title: t("cancelCompactFailed"),
				message: t("cancelCompactFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setCancelling(false);
		}
	}, [narratorId, t]);

	const cancelDialog = pendingCancel ? (
		<Modal
			opened
			onClose={closeCancelDialog}
			title={
				<Group gap="xs">
					<IconX size={18} style={{ color: "var(--mantine-color-orange-6)" }} />
					<Text fw={600}>{t("cancelCompactTitle")}</Text>
				</Group>
			}
			centered
			size="sm"
		>
			<Stack gap="md">
				<Text size="sm">{t("cancelCompactConfirmDesc")}</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="subtle" size="xs" onClick={closeCancelDialog}>
						{t("cancelCompactKeep")}
					</Button>
					<Button color="orange" size="xs" loading={cancelling} onClick={confirmCancel}>
						{t("cancelCompactConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	) : null;

	return {
		byKey,
		cancelTitle: t("cancelCompactTitle"),
		cancelDialog,
	};
}
