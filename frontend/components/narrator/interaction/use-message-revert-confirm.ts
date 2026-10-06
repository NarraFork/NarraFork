import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useState } from "react";
import { useRevertHistoryAction } from "../../../hooks/useNarrator";
import type { RevertActionConfirmOptions } from "../../../lib/api/narrators";
import type { MessageListHandle } from "../message/message-list-handle";

interface RevertTarget {
	messageId: string;
	blockIndex: number;
}

export interface UseMessageRevertConfirmOptions {
	narratorId: string;
	/** Ref to the message list, used to refresh structure after a revert. */
	chunkListRef: React.RefObject<MessageListHandle | null>;
	rollbackEditRegenerateSupported: boolean;
	rollbackEditRegenerateUnsupportedReason: string | undefined;
	t: (key: string) => string;
}

export interface UseMessageRevertConfirmResult {
	revertHistorySubmitting: boolean;
	pendingBlockDelete: RevertTarget | null;
	setPendingBlockDelete: React.Dispatch<React.SetStateAction<RevertTarget | null>>;
	handleDeleteBlock: (messageId: string, blockIndex: number) => void;
	confirmBlockDelete: (opts: RevertActionConfirmOptions) => Promise<void>;
	pendingRollback: RevertTarget | null;
	setPendingRollback: React.Dispatch<React.SetStateAction<RevertTarget | null>>;
	handleRollback: (messageId: string, blockIndex: number) => void;
	confirmRollback: (opts: RevertActionConfirmOptions) => Promise<void>;
}

/**
 * Confirm-then-apply flow for the two destructive history actions offered from a
 * message's context menu: deleting a tool block (rolls its file changes back) and
 * rolling the whole session back to a block. Both stage a pending target that the
 * RevertActionConfirmModal renders, then apply it through the revert mutation and
 * refresh the message list structure.
 *
 * Kept lifted (called from the panel): the context-menu triggers and the two
 * confirm modals live across the panel's JSX, and it reads the shared
 * `chunkListRef`, so it cannot be sunk into a single child.
 */
export function useMessageRevertConfirm(
	options: UseMessageRevertConfirmOptions,
): UseMessageRevertConfirmResult {
	const {
		narratorId,
		chunkListRef,
		rollbackEditRegenerateSupported,
		rollbackEditRegenerateUnsupportedReason,
		t,
	} = options;

	const { mutateAsync: applyHistoryAction, isPending: revertHistorySubmitting } =
		useRevertHistoryAction(narratorId);

	// Deleting a block rolls its file changes back, so it asks first rather than
	// firing straight from the context menu.
	const [pendingBlockDelete, setPendingBlockDelete] = useState<RevertTarget | null>(null);

	const handleDeleteBlock = useCallback(
		(messageId: string, blockIndex: number) => {
			if (!revertHistorySubmitting) setPendingBlockDelete({ messageId, blockIndex });
		},
		[revertHistorySubmitting],
	);

	const confirmBlockDelete = useCallback(
		async (opts: RevertActionConfirmOptions) => {
			if (!pendingBlockDelete || revertHistorySubmitting) return;
			try {
				await applyHistoryAction({ action: "delete_tool_block", target: pendingBlockDelete, opts });
				setPendingBlockDelete(null);
			} catch {
				// The mutation explains the journal outcome. Keep the revoked preview open
				// for an explicit reload or a history-only choice; never retry automatically.
			} finally {
				chunkListRef.current?.refreshStructure("full");
			}
		},
		[applyHistoryAction, pendingBlockDelete, revertHistorySubmitting, chunkListRef],
	);

	const [pendingRollback, setPendingRollback] = useState<RevertTarget | null>(null);

	const handleRollback = useCallback(
		(messageId: string, blockIndex: number) => {
			if (!rollbackEditRegenerateSupported) {
				notifications.show({
					title: t("rollbackEditRegenerateUnsupportedTitle"),
					message: rollbackEditRegenerateUnsupportedReason,
					color: "yellow",
				});
				return;
			}
			if (!revertHistorySubmitting) setPendingRollback({ messageId, blockIndex });
		},
		[
			rollbackEditRegenerateSupported,
			rollbackEditRegenerateUnsupportedReason,
			revertHistorySubmitting,
			t,
		],
	);

	const confirmRollback = useCallback(
		async (opts: RevertActionConfirmOptions) => {
			if (!pendingRollback || revertHistorySubmitting) return;
			if (!rollbackEditRegenerateSupported) {
				notifications.show({
					title: t("rollbackEditRegenerateUnsupportedTitle"),
					message: rollbackEditRegenerateUnsupportedReason,
					color: "yellow",
				});
				setPendingRollback(null);
				return;
			}
			try {
				await applyHistoryAction({ action: "rollback_to_block", target: pendingRollback, opts });
				setPendingRollback(null);
			} catch {
				// No second history mutation, and no re-plan/retry after an uncertain apply.
			} finally {
				chunkListRef.current?.refreshStructure("full");
			}
		},
		[
			applyHistoryAction,
			pendingRollback,
			revertHistorySubmitting,
			rollbackEditRegenerateSupported,
			rollbackEditRegenerateUnsupportedReason,
			t,
			chunkListRef,
		],
	);

	return {
		revertHistorySubmitting,
		pendingBlockDelete,
		setPendingBlockDelete,
		handleDeleteBlock,
		confirmBlockDelete,
		pendingRollback,
		setPendingRollback,
		handleRollback,
		confirmRollback,
	};
}
