/**
 * ChatMessageList.tsx — Virtualized chat history.
 *
 * A thin shell over the pure pieces:
 *   - heights          → `measureChatMessageCached` (zero DOM, deterministic)
 *   - virtualization   → `@shared/pretext-layout/vlist-virtualization`
 *   - grouping/anchors → `chat-list-layout`
 *
 * The shell reads the scroll container's `clientHeight` / `scrollTop`. That is the
 * one measurement allowed by the height contract (viewport size, not content
 * size); nothing inside a measure function touches the DOM.
 *
 * Three behaviours are load-bearing:
 *
 *  1. **Bottom pin.** A new message follows the view only when the reader is
 *     already at the bottom; otherwise it raises an unread affordance instead of
 *     yanking them out of history.
 *  2. **Anchored prepend.** Loading older history inserts content ABOVE the
 *     viewport, so `scrollTop` is compensated by the inserted height. Without
 *     this the view jumps backwards on every page.
 *  3. **Selection by index.** Range selection uses array indices, NOT DOM order —
 *     only the mounted window exists in the DOM, so a DOM-order range would
 *     silently miss everything scrolled out of view.
 *
 * The list assumes the parent REMOUNTS it per room (the surfaces key
 * `ChatRoomView` on `roomId`); the refs below — last seq, boot latch, scroll
 * position — are deliberately not reset on a room change, because a remount
 * already gives every room a clean instance.
 */

import { ActionIcon, Box, Button, Group, Loader, Text, Tooltip } from "@mantine/core";
import {
	findVisibleRange,
	layoutItems,
	spacerHeights,
} from "@shared/pretext-layout/vlist-virtualization";
import { IconArrowDown, IconCheck, IconCornerUpLeft, IconTrash } from "@tabler/icons-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessage } from "../../lib/api/chat";
import { formatLocaleTime } from "../../lib/intl-format";
import { UserAvatar } from "../UserAvatar";
import { ChatAttachmentBlock } from "./ChatAttachmentBlock";
import {
	anchoredScrollTop,
	buildChatRows,
	CHAT_OVERSCAN_PX,
	type ChatReplyInfo,
	isPinnedToBottom,
	toMeasureIdentity,
} from "./chat-list-layout";
import { measureChatMessageCached } from "./chat-measure-cache";
import {
	CHAT_BUBBLE_PADDING_X,
	CHAT_BUBBLE_PADDING_Y,
	CHAT_HEADER_GAP,
	CHAT_HEADER_HEIGHT,
	CHAT_MESSAGE_GAP,
	CHAT_REPLY_GAP,
	chatReplyLineHeight,
} from "./measure-chat-message";
import { RenderChatMessageBody } from "./RenderChatMessageBody";

/** Fallback width before the container has been observed. */
const FALLBACK_WIDTH = 640;
/** Vertical padding of the scroll canvas. */
const CANVAS_PADDING = 12;
/**
 * Height of the "load older / start of history" slot.
 *
 * Fixed and always mounted (once the room has content) so it cannot change the
 * canvas height in the same commit the anchor compensation writes `scrollTop`.
 */
const OLDER_SLOT_HEIGHT = 32;

/**
 * How many unseen messages a tail advance from `previousSeq` to `nextSeq` adds.
 *
 * Extracted as a pure function because the interesting cases are arithmetic, not
 * rendering: `seq` is contiguous per room (one claimed per write, and a soft
 * delete keeps its row), so the GAP is the number of messages that arrived. A
 * flat +1 under-reports every burst that lands in a single commit — the normal
 * case, since a WS append and a refetch coalesce into one render.
 *
 * `previousSeq === 0` is a room's first page rather than new traffic (the boot
 * scroll owns that), and a shrinking tail is a prepend or a cache replacement,
 * neither of which is an arrival.
 */
export function unseenArrivals(previousSeq: number, nextSeq: number): number {
	if (previousSeq <= 0 || nextSeq <= previousSeq) return 0;
	return nextSeq - previousSeq;
}

export interface ChatMessageListProps {
	messages: ChatMessage[];
	currentUserId: string | null;
	/** Fetch one more (older) page. */
	onLoadOlder?: () => void;
	hasOlder?: boolean;
	isLoadingOlder?: boolean;
	/** Highest seq currently visible — drives the read watermark. */
	onVisibleSeq?: (seq: number) => void;
	/** Selection is owned by the parent so the toolbar can act on it. */
	selectedIds?: ReadonlySet<string>;
	onToggleSelect?: (messageId: string, index: number, shiftKey: boolean) => void;
	onReply?: (message: ChatMessage) => void;
	onDelete?: (message: ChatMessage) => void;
	/** Quote strip clicked — the parent owns the "load until reachable" policy. */
	onJumpToReply?: (reply: ChatReplyInfo) => void;
	/** Message id to flash after a jump landed. */
	highlightedId?: string | null;
}

/** Imperative surface the parent drives a jump through. */
export interface ChatMessageListHandle {
	/**
	 * Scroll a loaded message into view. Returns false when it is not in the
	 * currently loaded window, which is the parent's signal to fetch older pages
	 * and try again.
	 */
	scrollToMessage: (messageId: string) => boolean;
}

export const ChatMessageList = forwardRef<ChatMessageListHandle, ChatMessageListProps>(
	function ChatMessageList(
		{
			messages,
			currentUserId,
			onLoadOlder,
			hasOlder = false,
			isLoadingOlder = false,
			onVisibleSeq,
			selectedIds,
			onToggleSelect,
			onReply,
			onDelete,
			onJumpToReply,
			highlightedId,
		},
		ref,
	) {
		const { t } = useTranslation("chat");
		const scrollRef = useRef<HTMLDivElement | null>(null);
		const [width, setWidth] = useState(FALLBACK_WIDTH);
		const [viewportHeight, setViewportHeight] = useState(0);
		const [scrollTop, setScrollTop] = useState(0);
		const scrollTopRef = useRef(0);
		const pinnedRef = useRef(true);
		const [pinned, setPinned] = useState(true);
		const [unseenCount, setUnseenCount] = useState(0);

		const rows = useMemo(() => buildChatRows(messages), [messages]);

		// Bubbles never span the full width: a long line is harder to read than a
		// wrapped one, and the shrink-wrap in the measure layer needs a ceiling.
		const bubbleWidth = Math.max(200, Math.min(width - 24, Math.round(width * 0.82)));

		const measured = useMemo(
			() => rows.map((row) => measureChatMessageCached(toMeasureIdentity(row), bubbleWidth)),
			[rows, bubbleWidth],
		);

		const layout = useMemo(
			() =>
				layoutItems(
					measured.map((m) => m.height),
					CHAT_MESSAGE_GAP,
					CANVAS_PADDING,
					CANVAS_PADDING,
				),
			[measured],
		);

		// ── Viewport observation ────────────────────────────────────────────────
		// Reading the container's own box is the contract's allowed exception; no
		// CONTENT is measured here.
		useEffect(() => {
			const node = scrollRef.current;
			if (!node || typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(() => {
				setWidth(node.clientWidth || FALLBACK_WIDTH);
				setViewportHeight(node.clientHeight);
			});
			observer.observe(node);
			setWidth(node.clientWidth || FALLBACK_WIDTH);
			setViewportHeight(node.clientHeight);
			return () => observer.disconnect();
		}, []);

		// ── Anchored rebuild ────────────────────────────────────────────────────
		// A prepended page shifts every existing row down. The anchor is the FIRST
		// message that existed before the rebuild; comparing its old and new `top`
		// gives the exact compensation.
		const anchorRef = useRef<{ id: string; top: number } | null>(null);
		const previousFirstIdRef = useRef<string | null>(null);

		useLayoutEffect(() => {
			const node = scrollRef.current;
			if (!node) return;
			const firstId = messages[0]?.id ?? null;
			const anchor = anchorRef.current;
			// Only compensate when the head of the list actually changed (a prepend).
			// A tail append does not move anything already on screen.
			if (anchor && firstId !== previousFirstIdRef.current) {
				const index = messages.findIndex((message) => message.id === anchor.id);
				const nextTop = index >= 0 ? layout.items[index]?.top : undefined;
				if (nextTop !== undefined) {
					const target = anchoredScrollTop(scrollTopRef.current, anchor.top, nextTop);
					node.scrollTop = target;
					scrollTopRef.current = node.scrollTop;
					setScrollTop(node.scrollTop);
				}
			}
			previousFirstIdRef.current = firstId;
			anchorRef.current = null;
		}, [messages, layout]);

		/** Capture the anchor BEFORE asking for more history. */
		const requestOlder = useCallback(() => {
			if (!hasOlder || isLoadingOlder || !onLoadOlder) return;
			const firstVisible = messages[0];
			if (firstVisible) {
				anchorRef.current = { id: firstVisible.id, top: layout.items[0]?.top ?? 0 };
			}
			onLoadOlder();
		}, [hasOlder, isLoadingOlder, layout, messages, onLoadOlder]);

		// ── Bottom pin ──────────────────────────────────────────────────────────
		const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;
		const lastSeqRef = useRef(lastSeq);

		const scrollToBottom = useCallback(() => {
			const node = scrollRef.current;
			if (!node) return;
			node.scrollTop = node.scrollHeight;
			scrollTopRef.current = node.scrollTop;
			setScrollTop(node.scrollTop);
			pinnedRef.current = true;
			setPinned(true);
			setUnseenCount(0);
		}, []);

		useLayoutEffect(() => {
			if (lastSeq === lastSeqRef.current) return;
			const previousSeq = lastSeqRef.current;
			lastSeqRef.current = lastSeq;
			if (lastSeq < previousSeq) return;
			if (pinnedRef.current) {
				scrollToBottom();
				return;
			}
			const arrived = unseenArrivals(previousSeq, lastSeq);
			if (arrived > 0) setUnseenCount((count) => count + arrived);
		}, [lastSeq, scrollToBottom]);

		// Land at the bottom on first paint of a room.
		const bootRef = useRef(false);
		useLayoutEffect(() => {
			if (bootRef.current || messages.length === 0 || viewportHeight === 0) return;
			bootRef.current = true;
			scrollToBottom();
		}, [messages.length, viewportHeight, scrollToBottom]);

		const handleScroll = useCallback(() => {
			const node = scrollRef.current;
			if (!node) return;
			scrollTopRef.current = node.scrollTop;
			setScrollTop(node.scrollTop);
			const atBottom = isPinnedToBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
			pinnedRef.current = atBottom;
			setPinned(atBottom);
			if (atBottom) setUnseenCount(0);
			// Reaching the top edge pulls one more page.
			if (node.scrollTop <= CHAT_OVERSCAN_PX / 2) requestOlder();
		}, [requestOlder]);

		// ── Visible window ──────────────────────────────────────────────────────
		const range = useMemo(
			() => findVisibleRange(layout.items, scrollTop, viewportHeight || 600, CHAT_OVERSCAN_PX),
			[layout.items, scrollTop, viewportHeight],
		);
		const spacers = useMemo(
			() => spacerHeights(layout.items, range.start, range.end, layout.totalHeight),
			[layout, range.start, range.end],
		);

		/**
		 * The strictly-visible window, computed WITHOUT overscan.
		 *
		 * `range` deliberately mounts CHAT_OVERSCAN_PX beyond the viewport so scrolling
		 * has rows ready, but that padding is below the fold: rows the reader has not
		 * seen. Reporting it would mark a screenful of messages read on arrival, and
		 * the watermark only moves forward, so the mistake is unrecoverable.
		 */
		const seenRange = useMemo(
			() => findVisibleRange(layout.items, scrollTop, viewportHeight || 600, 0),
			[layout.items, scrollTop, viewportHeight],
		);

		// Report the highest seq the reader has actually seen, for the watermark.
		useEffect(() => {
			if (!onVisibleSeq || seenRange.end === 0) return;
			const lastVisible = messages[Math.min(seenRange.end, messages.length) - 1];
			if (lastVisible) onVisibleSeq(lastVisible.seq);
		}, [messages, onVisibleSeq, seenRange.end]);

		// ── Jump to a message ───────────────────────────────────────────────────
		//
		// Positioned from the LAYOUT, not from the DOM. `scrollIntoView` on a
		// `[data-chat-message-id]` node only works for the mounted window: a virtual
		// list has nothing in the DOM for a message 200 rows up, which is exactly the
		// case a reply jump exists for. `layout.items[index].top` is defined for every
		// loaded message regardless of what is painted.
		useImperativeHandle(
			ref,
			() => ({
				scrollToMessage: (messageId: string) => {
					const node = scrollRef.current;
					if (!node) return false;
					const index = messages.findIndex((message) => message.id === messageId);
					if (index < 0) return false;
					const item = layout.items[index];
					if (!item) return false;
					// Centre it when there is room, so the reader sees the surrounding
					// exchange rather than the quoted line pinned to the top edge.
					const viewport = node.clientHeight || 0;
					const target = Math.max(0, item.top - Math.max(0, (viewport - item.height) / 2));
					node.scrollTop = target;
					scrollTopRef.current = node.scrollTop;
					setScrollTop(node.scrollTop);
					const atBottom = isPinnedToBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
					pinnedRef.current = atBottom;
					setPinned(atBottom);
					return true;
				},
			}),
			[messages, layout],
		);

		return (
			<Box style={{ position: "relative", height: "100%", minHeight: 0 }}>
				<Box
					ref={scrollRef}
					onScroll={handleScroll}
					style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}
				>
					{/*
					 * Fixed-height slot, mounted whenever the room has any content — NOT
					 * conditional on `hasOlder`. A slot that disappears when the last page
					 * lands would shift the whole canvas by its own height in the same
					 * commit the anchor compensation runs, so the compensation would be off
					 * by exactly that amount.
					 */}
					{messages.length > 0 ? (
						<Group justify="center" style={{ height: OLDER_SLOT_HEIGHT }} align="center">
							{isLoadingOlder ? (
								<Loader size="xs" />
							) : hasOlder ? (
								<Button size="compact-xs" variant="subtle" onClick={requestOlder}>
									{t("loadOlder")}
								</Button>
							) : (
								<Text size="xs" c="dimmed">
									{t("historyStart")}
								</Text>
							)}
						</Group>
					) : null}
					<div style={{ height: spacers.top }} />
					{rows.slice(range.start, range.end).map((row, offset) => {
						const index = range.start + offset;
						const item = layout.items[index];
						const measuredRow = measured[index];
						if (!item || !measuredRow) return null;
						return (
							<ChatMessageRow
								key={row.message.id}
								row={row}
								index={index}
								measured={measuredRow}
								bubbleWidth={bubbleWidth}
								isOwn={row.message.sender?.id === currentUserId}
								selected={selectedIds?.has(row.message.id) ?? false}
								highlighted={highlightedId === row.message.id}
								// The layout model puts the gap BETWEEN items, so the last
								// mounted row must not add one — otherwise the mounted block is
								// one gap taller than the span the spacers were computed for.
								gapAfter={index < range.end - 1}
								onToggleSelect={onToggleSelect}
								onReply={onReply}
								onDelete={onDelete}
								onJumpToReply={onJumpToReply}
							/>
						);
					})}
					<div style={{ height: spacers.bottom }} />
				</Box>
				{!pinned ? (
					<Tooltip
						label={unseenCount > 0 ? t("newMessages", { count: unseenCount }) : t("toBottom")}
					>
						<ActionIcon
							variant="filled"
							color={unseenCount > 0 ? "indigo" : "gray"}
							radius="xl"
							size="lg"
							onClick={scrollToBottom}
							style={{ position: "absolute", right: 16, bottom: 16 }}
						>
							<IconArrowDown size={18} />
						</ActionIcon>
					</Tooltip>
				) : null}
			</Box>
		);
	},
);

function ChatMessageRow({
	row,
	index,
	measured,
	bubbleWidth,
	isOwn,
	selected,
	highlighted,
	gapAfter,
	onToggleSelect,
	onReply,
	onDelete,
	onJumpToReply,
}: {
	row: ReturnType<typeof buildChatRows>[number];
	index: number;
	measured: ReturnType<typeof measureChatMessageCached>;
	bubbleWidth: number;
	isOwn: boolean;
	selected: boolean;
	/** Flash after a jump landed on this row. */
	highlighted: boolean;
	/** Draw the inter-item gap below this row (false for the last mounted row). */
	gapAfter: boolean;
	onToggleSelect?: (messageId: string, index: number, shiftKey: boolean) => void;
	onReply?: (message: ChatMessage) => void;
	onDelete?: (message: ChatMessage) => void;
	onJumpToReply?: (reply: ChatReplyInfo) => void;
}) {
	const { t } = useTranslation("chat");
	const [hovered, setHovered] = useState(false);
	const { message } = row;
	const sender = message.sender;

	const timestamp = useMemo(() => {
		// Via intl-format so the clock follows the app's language rather than the
		// browser's: a zh-CN reader on an en-US system should not get 12-hour times.
		return formatLocaleTime(message.createdAt, { hour: "2-digit", minute: "2-digit" });
	}, [message.createdAt]);

	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			if (!onToggleSelect) return;
			// Only an explicit modifier selects, so ordinary clicks (and text
			// selection drags) keep working.
			if (!event.shiftKey && !event.metaKey && !event.ctrlKey) return;
			event.preventDefault();
			onToggleSelect(message.id, index, event.shiftKey);
		},
		[index, message.id, onToggleSelect],
	);

	return (
		<Box
			// The row's height is EXACTLY what the measure layer reserved; the content
			// inside never decides it.
			style={{
				height: measured.height,
				marginBottom: gapAfter ? CHAT_MESSAGE_GAP : 0,
				display: "flex",
				justifyContent: isOwn ? "flex-end" : "flex-start",
				paddingInline: 12,
				boxSizing: "border-box",
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onClick={handleClick}
			data-chat-message-id={message.id}
		>
			<Box
				style={{
					position: "relative",
					width: measured.usedWidth,
					maxWidth: bubbleWidth,
					height: measured.height,
					padding: `${CHAT_BUBBLE_PADDING_Y}px ${CHAT_BUBBLE_PADDING_X}px`,
					boxSizing: "border-box",
					borderRadius: 8,
					background: selected
						? "var(--mantine-primary-color-light)"
						: isOwn
							? "var(--mantine-color-default-hover)"
							: "var(--mantine-color-default)",
					// `outline`, never `border`: a border participates in the box model, so
					// adding one would make the drawn bubble taller than the height the
					// measure layer reserved. The highlight wins over the selection ring so
					// a jump is visible even onto an already-selected row.
					outline: highlighted
						? "2px solid var(--mantine-primary-color-filled)"
						: selected
							? "1px solid var(--mantine-primary-color-filled)"
							: undefined,
					transition: "outline-color 150ms ease",
					overflow: "hidden",
				}}
			>
				{measured.hasHeader ? (
					<Group
						gap={6}
						wrap="nowrap"
						style={{ height: CHAT_HEADER_HEIGHT, marginBottom: CHAT_HEADER_GAP }}
					>
						<UserAvatar
							userId={sender?.id ?? ""}
							username={sender?.username ?? "?"}
							avatarColor={sender?.avatarColor ?? null}
							avatarImageId={sender?.avatarImageId ?? null}
							size={20}
						/>
						<Text size="xs" fw={600} truncate>
							{sender?.username ?? t("unknownSender")}
						</Text>
						<Text size="xs" c="dimmed">
							{timestamp}
						</Text>
					</Group>
				) : null}
				{measured.hasReply && row.reply ? (
					<ChatReplyStrip reply={row.reply} onJump={onJumpToReply} />
				) : null}
				{measured.attachments.length > 0 ? (
					<ChatAttachmentBlock
						attachments={row.message.attachments}
						measured={measured.attachments}
						height={measured.attachmentsHeight}
					/>
				) : null}
				<RenderChatMessageBody measured={measured} deletedLabel={t("messageDeleted")} />
				{hovered && !message.deletedAt ? (
					<Group
						gap={2}
						style={{
							position: "absolute",
							top: 2,
							right: 2,
							background: "var(--mantine-color-body)",
							borderRadius: 4,
						}}
					>
						{onToggleSelect ? (
							<Tooltip label={t("select")}>
								<ActionIcon
									size="xs"
									variant={selected ? "light" : "subtle"}
									color={selected ? "indigo" : "gray"}
									onClick={(event) => {
										event.stopPropagation();
										onToggleSelect(message.id, index, event.shiftKey);
									}}
								>
									<IconCheck size={12} />
								</ActionIcon>
							</Tooltip>
						) : null}
						{onReply ? (
							<Tooltip label={t("reply")}>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="gray"
									onClick={(event) => {
										event.stopPropagation();
										onReply(message);
									}}
								>
									<IconCornerUpLeft size={12} />
								</ActionIcon>
							</Tooltip>
						) : null}
						{onDelete && isOwn ? (
							<Tooltip label={t("delete")}>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red"
									onClick={(event) => {
										event.stopPropagation();
										onDelete(message);
									}}
								>
									<IconTrash size={12} />
								</ActionIcon>
							</Tooltip>
						) : null}
					</Group>
				) : null}
			</Box>
		</Box>
	);
}

/**
 * The quote strip above a reply: who was quoted, what they said, click to jump.
 *
 * One clamped line, exactly `CHAT_REPLY_LINE_HEIGHT` tall — the height the measure
 * layer reserved. Everything inside truncates rather than wrapping, so no amount of
 * quoted text or length of username can push the row past its reserved box.
 *
 * The three reply states get three different labels. Collapsing them (as the
 * previous single "this message was deleted" did) is actively misleading: the common
 * case is quoting something that is simply not in the loaded window, which the
 * snapshot now renders correctly, and only a real delete should say so.
 */
function ChatReplyStrip({
	reply,
	onJump,
}: {
	reply: ChatReplyInfo;
	onJump?: (reply: ChatReplyInfo) => void;
}) {
	const { t } = useTranslation("chat");
	// Nothing to navigate to when the content is unknowable: a legacy row whose
	// target is not loaded has no seq to page toward, so the click would be a no-op
	// and a clickable affordance would be a lie.
	const jumpable = !!onJump && (reply.state !== "unavailable" || reply.targetSeq !== null);

	const label =
		reply.state === "quoted"
			? reply.preview
			: reply.state === "deleted"
				? t("replyToDeleted")
				: t("replyUnavailable");

	const activate = () => {
		if (jumpable) onJump?.(reply);
	};

	return (
		<Box
			role={jumpable ? "button" : undefined}
			tabIndex={jumpable ? 0 : undefined}
			aria-label={
				reply.authorName ? t("jumpToReplyOf", { name: reply.authorName }) : t("jumpToReply")
			}
			onClick={(event) => {
				// The row itself treats modifier-clicks as selection; a quote click is its
				// own action and must not also toggle the selection.
				event.stopPropagation();
				activate();
			}}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				event.stopPropagation();
				activate();
			}}
			style={{
				height: chatReplyLineHeight(),
				marginBottom: CHAT_REPLY_GAP,
				paddingLeft: 8,
				borderLeft: "3px solid var(--mantine-primary-color-filled)",
				overflow: "hidden",
				display: "flex",
				alignItems: "center",
				gap: 4,
				cursor: jumpable ? "pointer" : "default",
			}}
		>
			{reply.authorName ? (
				<Text size="xs" fw={600} c="dimmed" style={{ flexShrink: 0, maxWidth: "45%" }} truncate>
					{reply.authorName}
				</Text>
			) : null}
			<Text
				size="xs"
				c="dimmed"
				fs={reply.state === "quoted" ? undefined : "italic"}
				truncate
				style={{ minWidth: 0 }}
			>
				{label}
			</Text>
		</Box>
	);
}
