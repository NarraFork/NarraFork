import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useState } from "react";
import { useRevertHistoryAction } from "../../../hooks/useNarrator";
import type { BlockTarget, RevertActionConfirmOptions } from "../../../lib/api/narrators";
import { blockTargetOf } from "../message/block-target";
import type { MessageListHandle } from "../message/message-list-handle";

export interface UseMessageRevertConfirmOptions {
	narratorId: string;
	/**
	 * Ref to the message list: its rows name the block an action targets, and its
	 * structure is refreshed after a revert.
	 */
	chunkListRef: React.RefObject<MessageListHandle | null>;
	rollbackEditRegenerateSupported: boolean;
	rollbackEditRegenerateUnsupportedReason: string | undefined;
	t: (key: string) => string;
}

export interface UseMessageRevertConfirmResult {
	revertHistorySubmitting: boolean;
	pendingBlockDelete: BlockTarget | null;
	setPendingBlockDelete: React.Dispatch<React.SetStateAction<BlockTarget | null>>;
	handleDeleteBlock: (messageId: string, blockIndex: number) => void;
	confirmBlockDelete: (opts: RevertActionConfirmOptions) => Promise<void>;
	pendingRollback: BlockTarget | null;
	setPendingRollback: React.Dispatch<React.SetStateAction<BlockTarget | null>>;
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

	const { mutateAsync: applyHistoryAction, isPending } = useRevertHistoryAction(narratorId);
	// Set in the same event as the confirm click. The mutation only reports pending a
	// tick later, and the dialog revokes its plan at once, so without this it would
	// briefly render the spent plan as "unavailable".
	const [applying, setApplying] = useState(false);
	const revertHistorySubmitting = isPending || applying;

	// Deleting a block rolls its file changes back, so it asks first rather than
	// firing straight from the context menu.
	const [pendingBlockDelete, setPendingBlockDelete] = useState<BlockTarget | null>(null);

	const handleDeleteBlock = useCallback(
		(messageId: string, blockIndex: number) => {
			if (!revertHistorySubmitting)
				setPendingBlockDelete(blockTargetOf(chunkListRef.current, messageId, blockIndex));
		},
		[revertHistorySubmitting, chunkListRef],
	);

	const confirmBlockDelete = useCallback(
		async (opts: RevertActionConfirmOptions) => {
			if (!pendingBlockDelete || revertHistorySubmitting) return;
			setApplying(true);
			try {
				await applyHistoryAction({ action: "delete_tool_block", target: pendingBlockDelete, opts });
			} catch {
				// The mutation's notification explains the outcome. The plan is spent, so
				// close instead of leaving a revoked review open; never retry automatically.
			} finally {
				setPendingBlockDelete(null);
				setApplying(false);
				chunkListRef.current?.refreshStructure("full");
			}
		},
		[applyHistoryAction, pendingBlockDelete, revertHistorySubmitting, chunkListRef],
	);

	const [pendingRollback, setPendingRollback] = useState<BlockTarget | null>(null);

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
			if (!revertHistorySubmitting)
				setPendingRollback(blockTargetOf(chunkListRef.current, messageId, blockIndex));
		},
		[
			rollbackEditRegenerateSupported,
			rollbackEditRegenerateUnsupportedReason,
			revertHistorySubmitting,
			t,
			chunkListRef,
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
			setApplying(true);
			try {
				await applyHistoryAction({ action: "rollback_to_block", target: pendingRollback, opts });
			} catch {
				// The notification explains the outcome. No second history mutation, and no
				// re-plan/retry after an uncertain apply; reopening creates a fresh plan.
			} finally {
				setPendingRollback(null);
				setApplying(false);
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
