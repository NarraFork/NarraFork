/**
 * VListRowInteraction.tsx — Per-row interaction layer for the pretext vlist.
 *
 * Wraps one rendered row body with the same interaction surface the chunked
 * path gives each block (ContentViewer / ReasoningBlock / ToolCallCard):
 *   - touch left-swipe reveal menu + desktop right-click context menu
 *     (both render the same menu items, via useSwipeMenu)
 *   - Ctrl/Cmd+Click toggle + Shift+Click range multi-select
 *   - selected-state outline (+ mobile selection offset)
 *   - the data-block-id / data-message-id / data-block-index DOM contract the
 *     selection toolbar & DOM fallbacks rely on
 *
 * Menu contents come in two tiers:
 *   1. shared message actions (copy / rollback / fork / ask-in-passing /
 *      compact / delete / edit), built by vlist-row-actions.buildRowCtxActions —
 *      plus "view original" for an edited message, which arrives as its own prop
 *      (the shell owns the single modal instance; this layer only calls back);
 *   2. card-specific command items for tool & subagent rows — open child
 *      session, detach to background, cancel background task, inspect tool
 *      call, copy file path, view file — gated by the row's tool metadata
 *      (vlist-tool-meta.ts) exactly like ToolCallCard / SubagentCard gate them.
 *
 * The inspector & file-preview modals are lazy AND only mounted while open, so
 * scrolling rows pay for neither.
 *
 * It is deliberately a self-contained child component: all swipe/menu state
 * lives inside this row, so interacting with one row never re-renders the
 * parent PretextExactMessageList (which would recompute virtualization). The
 * controller mounts once after admission; the menu itself is mounted lazily —
 * only while swiping or while the context menu is open. Cold history rows skip
 * control hooks without postponing gesture capture or remounting their bodies.
 *
 * This lives inside vlist/ (so it may import the outer hooks) and is only ever
 * rendered by PretextExactMessageList, preserving the module-isolation guard.
 */

import { useSwipeMenu } from "@frontend/hooks/useSwipeMenu";
import type { ToolCallDetailRef } from "@frontend/lib/api/narrators";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { type ReactNode, useCallback } from "react";
import { useRenderInteractive } from "../lod/RenderLodCtx";
import type { MessageContextMenuActions } from "../message/MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	BLOCK_INDICES_ATTR,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "../message/MessageSelectionCtx";
import { VListRowInteractionControls } from "./VListRowInteractionControls";
import { useDeferredInteractionMount } from "./vlist-interaction-admission-context";
import type { VListRowToolActions } from "./vlist-row-actions";
import type { VListToolMeta } from "./vlist-tool-meta";

const SWIPE_REVEAL_WIDTH = 180;

export interface VListRowInteractionProps {
	/** Selection-system blockId (msg-… | tc-… | sa-…). */
	blockId: string;
	/** Owning message id for the DOM contract. */
	messageId: string;
	/** Primary block index for the DOM contract. */
	blockIndex: number;
	/** All source block indices (reasoning runs); emitted as data-block-indices. */
	blockIndices?: readonly number[];
	/** Text copied by the "copy" menu item; omitted → no copy item. */
	copyText?: string;
	/** Closed-over per-row menu actions (already bound to messageId/blockIndex). */
	actions: MessageContextMenuActions;
	/**
	 * Owning panel narrator id — required by the tool-call inspector. Absent →
	 * the inspect item is hidden.
	 */
	narratorId?: string;
	/**
	 * Tool-call id behind this row (tc-/sa- rows only). Drives the inspect item.
	 */
	toolUseId?: string;
	/** Card-owned request identity; never derive refs from the selection messageId. */
	toolDetailRef?: ToolCallDetailRef & { toolUseId?: string };
	/** Row tool facts (file path, child narrator, background state). */
	toolMeta?: VListToolMeta;
	/** Card-specific actions already bound to this row's tool. */
	toolActions?: VListRowToolActions;
	/**
	 * Reveal the pre-edit text of an EDITED message. Passed straight from the
	 * shell (never through MessageContextMenuActions, which the chunked path
	 * shares) and present only when the row's message carries `editedAt`. This
	 * layer only invokes the callback — the modal itself is a single shell-level
	 * instance, so a scrolling list never mounts one per row.
	 */
	onViewOriginal?: () => void;
	/**
	 * Open this row's MAIN body in the shell's fullscreen viewer.
	 *
	 * A single item on purpose: a row can host several readable bodies (a tool card
	 * has command + output), and one menu entry cannot say which. The per-body
	 * controls — including wrap and source — live on each body's own hover action
	 * bar, where the target is unambiguous. Absent → the item is hidden (aggregate
	 * traces, system cards and anything with no readable text).
	 */
	onOpenFullscreen?: () => void;
	/**
	 * Verbatim model-facing content for the "what the model saw" inspector, for rows
	 * that speak FOR somebody (a system injection) rather than run a tool. Present →
	 * an inspect item opens the generic ContentInspector with this exact text; absent
	 * → the item is hidden. Independent of `toolUseId` (which drives the tool dump).
	 */
	inspectContent?: { title: string; text: string };
	/** Row body (the pure renderer's output). */
	children: ReactNode;
	/**
	 * Message-level selection (chat rooms), orthogonal to the block-selection
	 * system: outline when selected, modifier-click toggles. Absent → no chrome.
	 */
	selected?: boolean;
	onToggleSelect?: (opts: { shiftKey: boolean }) => void;
}

/** Lightweight, always-listening row shell; admission never moves its body. */
export function VListRowInteraction({
	blockId,
	messageId,
	blockIndex,
	blockIndices,
	copyText,
	actions: msgCtx,
	narratorId,
	toolUseId,
	toolDetailRef,
	toolMeta,
	toolActions,
	onViewOriginal,
	onOpenFullscreen,
	inspectContent,
	selected,
	onToggleSelect,
	children,
}: VListRowInteractionProps) {
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const selection = useMessageSelection();
	const isSelected = selection.selectedBlockIds.has(blockId);

	const handleDeselectBlock = useCallback(() => {
		selection.deselectBlock(blockId);
	}, [selection.deselectBlock, blockId]);

	const swipe = useSwipeMenu({
		enabled: interactive,
		touchEnabled: interactive,
		excludeSelectors: [".mantine-Menu-dropdown"],
		blockId,
		onSwipeRight: isSelected ? handleDeselectBlock : undefined,
	});

	// Admit only this row; the original gesture hooks remain mounted even when cold.
	const showSwipeMenu = interactive && (swipe.swipeOffset > 0 || swipe.swipeClosing);
	const { ready, ensure } = useDeferredInteractionMount({
		enabled: interactive,
		immediate: swipe.ctxMenuOpened || showSwipeMenu || isSelected || selected === true,
	});

	// Desktop: right-click opens the context menu (gated on !isMobile like the
	// chunked path; suppressed when a native text selection is active).
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (!interactive || isMobile) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			ensure();
			swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
			swipe.setCtxMenuOpened(true);
		},
		[interactive, isMobile, ensure, swipe.setCtxMenuPos, swipe.setCtxMenuOpened],
	);

	// Desktop: Ctrl/Cmd+Click toggles the block, Shift+Click range-selects.
	const handleBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (!interactive || isMobile) return;
			const isModKey = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;
			if (!isModKey && !isShift) return;
			if (shouldIgnoreMessageBlockSelection(e.target)) return;
			// Message-level selection (chat): the host owns the set; the block
			// selection system stays the default when no message toggle is wired.
			if (onToggleSelect) {
				e.preventDefault();
				onToggleSelect({ shiftKey: isShift });
				return;
			}
			if (!selection.selectionMode) {
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			}
			e.preventDefault();
			if (isShift) {
				window.getSelection()?.removeAllRanges();
				selection.rangeSelectTo(blockId);
			} else {
				selection.toggleBlock(blockId);
			}
		},
		[
			interactive,
			isMobile,
			onToggleSelect,
			selection.selectionMode,
			selection.rangeSelectTo,
			selection.toggleBlock,
			blockId,
		],
	);

	// Selected visual offset (mobile only) so a selected row matches the anchor's
	// swipe, mirroring ContentViewer's selectionOffset behaviour.
	const showSelectedVisual = isSelected;
	const selectionOffset =
		isMobile && showSelectedVisual && !swipe.swipeRevealed ? SWIPE_REVEAL_WIDTH : 0;
	const effectiveOffset = swipe.swipeOffset > 0 ? swipe.swipeOffset : selectionOffset;
	// The chat selection outline reuses the block-selection visual (same tint,
	// same offset) so the two read as one language.
	const showMessageSelected = selected === true;
	const showOutline = showSelectedVisual || showMessageSelected;

	if (!interactive) return <>{children}</>;

	return (
		<>
			<Box
				ref={swipe.swipeBoxRef as React.RefObject<HTMLDivElement>}
				data-content-block
				{...{ [BLOCK_ID_ATTR]: blockId }}
				data-message-id={messageId}
				data-block-index={String(blockIndex)}
				{...(blockIndices && blockIndices.length > 1
					? { [BLOCK_INDICES_ATTR]: blockIndices.join(",") }
					: {})}
				onContextMenu={handleContextMenu}
				onClick={handleBlockClick}
				style={{
					height: "100%",
					transform: effectiveOffset > 0 ? `translateX(-${effectiveOffset}px)` : undefined,
					transition: swipe.swipeTransition,
					outline: showOutline ? "2px solid var(--mantine-color-indigo-6)" : undefined,
					outlineOffset: showOutline ? -2 : undefined,
					borderRadius: showOutline ? 4 : undefined,
				}}
			>
				{children}
			</Box>

			{ready && (
				<VListRowInteractionControls
					blockIndex={blockIndex}
					blockIndices={blockIndices}
					copyText={copyText}
					actions={msgCtx}
					narratorId={narratorId}
					toolUseId={toolUseId}
					toolDetailRef={toolDetailRef}
					toolMeta={toolMeta}
					toolActions={toolActions}
					onViewOriginal={onViewOriginal}
					onOpenFullscreen={onOpenFullscreen}
					inspectContent={inspectContent}
					swipe={swipe}
				/>
			)}
		</>
	);
}
