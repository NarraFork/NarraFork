import { notifications } from "@mantine/notifications";
import type { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../../lib/api";
import { handleRegistry } from "../ContentViewer";
import {
	BLOCK_ID_ATTR,
	collectSelectedText,
	type MessageSelectionResolver,
	type MessageSelectionState,
	resolveBlockRange,
	resolveSelectedBlockMeta,
	resolveSelectedMessageIds,
} from "../MessageSelectionCtx";
import {
	getGlobalCloseSwipe,
	setGlobalOnSelectionRange,
	setGlobalSwipeAnchor,
	setGlobalToggleBlock,
} from "../swipeState";

interface ChunkListLike {
	detachFromBottom: () => void;
	refreshStructure: (mode?: "diff" | "full") => void;
}

export interface UseMessageSelectionOptions {
	narratorId: string;
	contentRef: React.RefObject<HTMLDivElement | null>;
	viewportRef: React.RefObject<HTMLElement | null>;
	chunkListRef: React.RefObject<ChunkListLike | null>;
	navigate: ReturnType<typeof useNavigate>;
	t: (key: string, opts?: Record<string, unknown>) => string;
	/** Async confirm dialog (Mantine modals.openConfirmModal wrapper). */
	confirm: (opts: { message: string }) => Promise<boolean>;
	compactSupported: boolean;
	compactUnsupportedReason: string;
	compactUsesFallbackSummary: boolean;
	compactFallbackSummaryReason: string;
}

/**
 * Message multi-select machinery extracted from NarratorPanel: selection state
 * (mode / selected block ids / anchor / chunk resolver), the desktop toggle &
 * shift-range handlers, the swipe-menu global-registry bridges, the floating
 * toolbar position clamp, and the batch copy/delete/fork/segment-compact actions.
 *
 * The off-screen anchor OVERLAY state (swipe / compacting / selection anchors)
 * intentionally stays in NarratorPanel: those are driven by swipe/compacting
 * trackers that span well beyond selection. This hook only registers the
 * selection-range/toggle callbacks the overlay system calls into.
 *
 * Injected deps are the DOM/layout refs and panel-level values; module-level
 * globals and resolver helpers are imported directly.
 */
export function useMessageSelection(options: UseMessageSelectionOptions) {
	const {
		narratorId,
		contentRef,
		viewportRef,
		chunkListRef,
		navigate,
		t,
		confirm,
		compactSupported,
		compactUnsupportedReason,
		compactUsesFallbackSummary,
		compactFallbackSummaryReason,
	} = options;

	const [selectionMode, setSelectionMode] = useState(false);
	const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
	const [anchorBlockId, setAnchorBlockId] = useState<string | null>(null);
	const [chunkSelectionResolver, setChunkSelectionResolver] =
		useState<MessageSelectionResolver | null>(null);

	const exitSelection = useCallback(() => {
		setSelectionMode(false);
		setSelectedBlockIds(new Set());
		setAnchorBlockId(null);
		setGlobalSwipeAnchor(null);
		// Close any open swipe
		const closeFn = getGlobalCloseSwipe();
		if (closeFn) closeFn();
	}, []);

	const deselectBlock = useCallback((blockId: string) => {
		setSelectedBlockIds((prev) => {
			const next = new Set(prev);
			next.delete(blockId);
			if (next.size === 0) {
				setSelectionMode(false);
				setAnchorBlockId(null);
				setGlobalSwipeAnchor(null);
			}
			return next;
		});
	}, []);

	// Desktop: Ctrl/Cmd+Click toggles a single block
	const toggleBlock = useCallback(
		(blockId: string) => {
			setSelectedBlockIds((prev) => {
				const next = new Set(prev);
				if (next.has(blockId)) {
					next.delete(blockId);
					if (next.size === 0) {
						setSelectionMode(false);
						setAnchorBlockId(null);
						return next;
					}
				} else {
					chunkListRef.current?.detachFromBottom();
					next.add(blockId);
					setSelectionMode(true);
					setAnchorBlockId(blockId);
				}
				return next;
			});
		},
		[chunkListRef],
	);

	const applyRangeSelection = useCallback(
		(anchor: string, target: string, updateAnchor = false) => {
			const applyDomFallback = () => {
				const container = contentRef.current;
				if (!container) return;
				const range = resolveBlockRange(container, anchor, target);
				if (!range) return;
				chunkListRef.current?.detachFromBottom();
				setSelectionMode(true);
				setSelectedBlockIds(range);
				if (updateAnchor) setAnchorBlockId(anchor);
			};

			const resolver = chunkSelectionResolver;
			const resolved = resolver?.resolveRange?.(anchor, target);
			if (!resolved) {
				applyDomFallback();
				return;
			}
			Promise.resolve(resolved)
				.then((range) => {
					if (!range) {
						applyDomFallback();
						return;
					}
					chunkListRef.current?.detachFromBottom();
					setSelectionMode(true);
					setSelectedBlockIds(range);
					if (updateAnchor) setAnchorBlockId(anchor);
				})
				.catch(applyDomFallback);
		},
		[chunkSelectionResolver, contentRef, chunkListRef],
	);

	// Desktop: Shift+Click range-selects from anchor to target
	const rangeSelectTo = useCallback(
		(blockId: string) => {
			const anchor = anchorBlockId;
			if (!anchor) {
				// No anchor yet — treat as single toggle
				chunkListRef.current?.detachFromBottom();
				setSelectionMode(true);
				setSelectedBlockIds(new Set([blockId]));
				setAnchorBlockId(blockId);
				return;
			}
			applyRangeSelection(anchor, blockId);
		},
		[anchorBlockId, applyRangeSelection, chunkListRef],
	);

	// Register the global range-selection callback so useSwipeMenu instances
	// can trigger multi-select without prop drilling.
	useEffect(() => {
		const handler = (anchor: string, target: string) => applyRangeSelection(anchor, target, true);
		setGlobalOnSelectionRange(handler);
		return () => setGlobalOnSelectionRange(null);
	}, [applyRangeSelection]);

	// Register toggle callback so useSwipeMenu can add/remove blocks
	// from the selection when multi-select mode is already active.
	useEffect(() => {
		if (selectionMode) {
			setGlobalToggleBlock(toggleBlock);
			return () => setGlobalToggleBlock(null);
		}
		setGlobalToggleBlock(null);
	}, [selectionMode, toggleBlock]);

	// Clear selection when narrator changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId is intentionally a dependency to reset selection on narrator switch
	useEffect(() => {
		exitSelection();
	}, [narratorId, exitSelection]);

	// Escape key exits multi-select mode
	useEffect(() => {
		if (!selectionMode) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				exitSelection();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectionMode, exitSelection]);

	// --- Floating toolbar position — clamp to selected blocks' bounding box ---
	const selectionToolbarRef = useRef<HTMLDivElement>(null);
	const selectionToolbarParentRef = useRef<HTMLDivElement>(null);
	const [selectionToolbarTop, setSelectionToolbarTop] = useState<number | null>(null);

	useEffect(() => {
		if (!selectionMode || selectedBlockIds.size === 0) {
			setSelectionToolbarTop(null);
			return;
		}
		const container = contentRef.current;
		const scrollEl = viewportRef.current;
		const parentEl = selectionToolbarParentRef.current;
		if (!container || !scrollEl) return;

		const reposition = () => {
			const els = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
			let minTop = Number.POSITIVE_INFINITY;
			let maxBottom = Number.NEGATIVE_INFINITY;
			for (const el of els) {
				const bid = el.getAttribute(BLOCK_ID_ATTR);
				if (!bid || !selectedBlockIds.has(bid)) continue;
				const r = el.getBoundingClientRect();
				if (r.top < minTop) minTop = r.top;
				if (r.bottom > maxBottom) maxBottom = r.bottom;
			}
			if (!Number.isFinite(minTop)) return;
			const menuH = selectionToolbarRef.current?.offsetHeight ?? 160;
			const half = menuH / 2;
			// Clamp against the message-area container (not the viewport) so the
			// toolbar never slides under the composer / status bar below it. The
			// toolbar is absolutely positioned inside this container, so the final
			// `top` must be expressed in the container's local coordinate space.
			const parentRect = parentEl?.getBoundingClientRect();
			const boundTop = parentRect?.top ?? 0;
			const boundBottom = parentRect?.bottom ?? scrollEl.getBoundingClientRect().bottom;
			const boundCenter = (boundTop + boundBottom) / 2;
			// Prefer the container's vertical center, but stay within the selected
			// blocks' bounds so the toolbar visually tracks the selection.
			let top = Math.max(minTop + half, Math.min(boundCenter, maxBottom - half));
			// Clamp so the whole menu stays inside the container (above the composer).
			top = Math.max(boundTop + half, Math.min(top, boundBottom - half));
			// Convert from viewport coordinates to the container's local space.
			setSelectionToolbarTop(top - boundTop);
		};

		reposition();
		scrollEl.addEventListener("scroll", reposition, { passive: true });
		window.addEventListener("resize", reposition, { passive: true });
		return () => {
			scrollEl.removeEventListener("scroll", reposition);
			window.removeEventListener("resize", reposition);
		};
	}, [selectionMode, selectedBlockIds, contentRef, viewportRef]);

	// --- Batch copy ---
	const handleBatchCopy = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let selectedText = chunkSelectionResolver?.collectSelectedText
			? chunkSelectionResolver.collectSelectedText(selectedBlockIds)
			: contentRef.current
				? collectSelectedText(contentRef.current, selectedBlockIds, handleRegistry)
				: { text: "", truncated: false };
		if (!selectedText.text && contentRef.current) {
			selectedText = collectSelectedText(contentRef.current, selectedBlockIds, handleRegistry);
		}
		if (!selectedText.text) return;
		try {
			await navigator.clipboard.writeText(selectedText.text);
			notifications.show({
				message: selectedText.truncated
					? t("batchCopyTruncated", { count: selectedBlockIds.size })
					: t("batchCopySuccess", { count: selectedBlockIds.size }),
				color: "teal",
			});
		} catch {
			notifications.show({ message: t("batchCopyFailed"), color: "red" });
		}
		exitSelection();
	}, [selectedBlockIds, chunkSelectionResolver, exitSelection, contentRef, t]);

	// --- Batch delete ---
	const handleBatchDelete = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let metas = chunkSelectionResolver?.resolveSelectedMeta
			? chunkSelectionResolver.resolveSelectedMeta(selectedBlockIds)
			: contentRef.current
				? resolveSelectedBlockMeta(contentRef.current, selectedBlockIds)
				: [];
		if (metas.length === 0 && contentRef.current) {
			metas = resolveSelectedBlockMeta(contentRef.current, selectedBlockIds);
		}
		if (metas.length === 0) return;
		// Confirm
		const ok = await confirm({ message: t("batchDeleteConfirm", { count: metas.length }) });
		if (!ok) return;
		exitSelection();
		try {
			const res = await api.deleteMessageBlocks(
				narratorId,
				metas.map((m) => ({ messageId: m.messageId, blockIndex: m.blockIndex })),
			);
			// Always re-fetch from server to ensure consistency
			chunkListRef.current?.refreshStructure("full");
			if (res.failed > 0) {
				notifications.show({ message: t("batchDeleteFailed"), color: "orange" });
			}
		} catch {
			// Network / unexpected error — re-fetch to reflect whatever actually happened
			chunkListRef.current?.refreshStructure("full");
			notifications.show({ message: t("batchDeleteFailed"), color: "red" });
		}
	}, [
		selectedBlockIds,
		chunkSelectionResolver,
		exitSelection,
		narratorId,
		t,
		confirm,
		contentRef,
		chunkListRef,
	]);

	// --- Batch fork ---
	const handleBatchFork = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let messageIds = chunkSelectionResolver?.resolveSelectedMessageIds
			? chunkSelectionResolver.resolveSelectedMessageIds(selectedBlockIds)
			: contentRef.current
				? resolveSelectedMessageIds(contentRef.current, selectedBlockIds)
				: [];
		if (messageIds.length === 0 && contentRef.current) {
			messageIds = resolveSelectedMessageIds(contentRef.current, selectedBlockIds);
		}
		if (messageIds.length === 0) return;
		exitSelection();
		try {
			const newNarrator = await api.forkFromMessages(narratorId, messageIds);
			notifications.show({
				message: t("batchForkSuccess", { count: messageIds.length }),
				color: "teal",
			});
			navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
		} catch {
			notifications.show({ message: t("batchForkFailed"), color: "red" });
		}
	}, [
		selectedBlockIds,
		chunkSelectionResolver,
		exitSelection,
		narratorId,
		navigate,
		t,
		contentRef,
	]);

	// --- Segment compact ---
	const handleSegmentCompact = useCallback(async () => {
		if (!compactSupported) {
			notifications.show({
				title: t("compactUnsupportedTitle"),
				message: compactUnsupportedReason,
				color: "yellow",
			});
			return;
		}
		if (selectedBlockIds.size === 0) return;
		let messageIds = chunkSelectionResolver?.resolveSelectedMessageIds
			? chunkSelectionResolver.resolveSelectedMessageIds(selectedBlockIds)
			: contentRef.current
				? resolveSelectedMessageIds(contentRef.current, selectedBlockIds)
				: [];
		if (messageIds.length === 0 && contentRef.current) {
			messageIds = resolveSelectedMessageIds(contentRef.current, selectedBlockIds);
		}
		if (messageIds.length === 0) return;
		const segmentCompactConfirmMessage = compactUsesFallbackSummary
			? `${t("segmentCompactConfirm", { count: messageIds.length })}\n\n${compactFallbackSummaryReason}`
			: t("segmentCompactConfirm", { count: messageIds.length });
		if (!(await confirm({ message: segmentCompactConfirmMessage }))) return;
		exitSelection();
		try {
			// Compacting state will arrive via substatus_change WS event
			await api.triggerSegmentCompact(narratorId, messageIds);
		} catch (err) {
			const isInProgress = err instanceof ApiError && err.status === 409;
			notifications.show({
				title: isInProgress ? t("compactInProgress") : t("segmentCompactFailed"),
				message: isInProgress ? t("compactInProgressDesc") : t("segmentCompactFailedDesc"),
				color: isInProgress ? "yellow" : "red",
				autoClose: 5000,
			});
		}
	}, [
		selectedBlockIds,
		exitSelection,
		chunkSelectionResolver,
		narratorId,
		t,
		confirm,
		compactSupported,
		compactUnsupportedReason,
		compactUsesFallbackSummary,
		compactFallbackSummaryReason,
		contentRef,
	]);

	const selectionCtxValue = useMemo<MessageSelectionState>(
		() => ({
			selectionMode,
			selectedBlockIds,
			anchorBlockId,
			exitSelection,
			deselectBlock,
			toggleBlock,
			rangeSelectTo,
		}),
		[
			selectionMode,
			selectedBlockIds,
			anchorBlockId,
			exitSelection,
			deselectBlock,
			toggleBlock,
			rangeSelectTo,
		],
	);

	return {
		selectionMode,
		selectedBlockIds,
		setChunkSelectionResolver,
		exitSelection,
		handleBatchCopy,
		handleBatchDelete,
		handleBatchFork,
		handleSegmentCompact,
		selectionToolbarRef,
		selectionToolbarParentRef,
		selectionToolbarTop,
		selectionCtxValue,
	};
}
