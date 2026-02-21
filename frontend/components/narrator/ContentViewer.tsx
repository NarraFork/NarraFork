import { ActionIcon, Box, Code, CopyButton, Group, Menu, Modal, Tooltip } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowsMaximize,
	IconCode,
	IconCopy,
	IconDeviceMobileRotated,
	IconGitBranch,
	IconGitFork,
	IconMarkdown,
	IconTextWrap,
	IconTextWrapDisabled,
	IconTrash,
} from "@tabler/icons-react";
import {
	type CSSProperties,
	forwardRef,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { DiffView } from "./DiffView";
import { MarkdownContent } from "./MarkdownContent";
import { useMessageContextMenu } from "./MessageContextMenuCtx";

export type CodeContentType = "markdown" | "code" | "diff";

interface ContentViewerProps {
	/** Text content to display and copy */
	content: string;
	/** Style applied to the Code block */
	style?: CSSProperties;
	/** Modal title when fullscreen */
	title?: string;
	/** If provided, renders DiffView instead of Code in fullscreen */
	diff?: { oldStr: string; newStr: string };
	/** If true, render content as markdown instead of a code block */
	markdown?: boolean;
	/** Content type for word-wrap default preference. Defaults to "code". */
	contentType?: CodeContentType;
	/** Extra children rendered inside the wrapper (e.g. existing Code block) */
	children?: ReactNode;
	/** Render function receiving wordWrap state, used instead of children when wrap control is needed */
	renderContent?: (wordWrap: boolean) => ReactNode;
}

/** Sticky wrapper: zero-height, sticks to the top of the nearest scroll
 *  ancestor so buttons remain visible during vertical scroll.
 *  Width is constrained to the container (not the overflowing content)
 *  because sticky elements size relative to their containing block. */
const actionStickyWrapper: CSSProperties = {
	position: "sticky",
	top: 0,
	height: 0,
	zIndex: 2,
	pointerEvents: "none",
	overflow: "visible",
};

const actionBarPos: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	padding: 4,
	pointerEvents: "none",
};

const actionBarHidden: CSSProperties = {
	...actionBarPos,
	opacity: 0,
	transition: "opacity 150ms ease",
};

const actionBarVisible: CSSProperties = {
	...actionBarPos,
	opacity: 1,
	transition: "opacity 150ms ease",
};

/** Fullscreen modal toolbar */
const modalToolbarStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: 8,
	paddingBottom: 8,
};

let nextInstanceId = 0;

/** Global: close any currently open swipe menu. Each ContentViewer registers
 *  its closeSwipe; only the latest one matters. */
let globalCloseSwipe: (() => void) | null = null;

/** Global registry: instanceId → handle, so parent components can look up
 *  a ContentViewer by its data-cv-id DOM attribute without passing refs. */
const handleRegistry = new Map<number, ContentViewerHandle>();

/** Look up a ContentViewerHandle from a DOM event target.
 *  Walks up to the nearest `[data-cv-id]` element and returns the handle. */
export function resolveContentViewerHandle(target: EventTarget | null): ContentViewerHandle | null {
	if (!(target instanceof HTMLElement)) return null;
	const el = target.closest("[data-cv-id]");
	if (!el) return null;
	const id = Number(el.getAttribute("data-cv-id"));
	return handleRegistry.get(id) ?? null;
}

export interface ContentViewerHandle {
	openFullscreen: () => void;
	toggleWrap: () => void;
	getContent: () => string;
}

export const ContentViewer = memo(
	forwardRef<ContentViewerHandle, ContentViewerProps>(function ContentViewer(
		{ content, style, title, diff, markdown, contentType = "code", children, renderContent },
		ref,
	) {
		const { t } = useTranslation("common");
		const { t: tNarrator } = useTranslation("narrator");
		const msgCtx = useMessageContextMenu();
		const { data: userPrefs } = useUserPreferences();
		const defaultWrap =
			contentType === "markdown"
				? (userPrefs?.wordWrapMarkdown ?? true)
				: contentType === "diff"
					? (userPrefs?.wordWrapDiff ?? true)
					: (userPrefs?.wordWrapCode ?? true);
		const [fullscreen, { open, close }] = useDisclosure(false);
		const [hovered, setHovered] = useState(false);
		const [wordWrap, setWordWrap] = useState(defaultWrap);
		const userToggled = useRef(false);
		const [showSource, setShowSource] = useState(false);
		const boxRef = useRef<HTMLDivElement>(null);
		const actionBarRef = useRef<HTMLDivElement>(null);
		const modalBodyRef = useRef<HTMLDivElement>(null);
		const instanceId = useRef(nextInstanceId++);

		const handle: ContentViewerHandle = {
			openFullscreen: () => open(),
			toggleWrap: () => {
				userToggled.current = true;
				setWordWrap((v) => !v);
			},
			getContent: () => content,
		};

		useImperativeHandle(ref, () => handle);

		// Register in global registry so parents can resolve via DOM lookup
		useEffect(() => {
			const id = instanceId.current;
			handleRegistry.set(id, handle);
			return () => {
				handleRegistry.delete(id);
			};
		});

		// Sync with user preferences once they load (unless user already toggled manually)
		useEffect(() => {
			if (!userToggled.current) {
				setWordWrap(defaultWrap);
			}
		}, [defaultWrap]);
		const isMobile = useMediaQuery("(max-width: 768px)");

		// Browser-native landscape: request fullscreen + lock orientation
		const toggleLandscape = useCallback(async () => {
			try {
				const el = modalBodyRef.current?.closest(".mantine-Modal-content") as HTMLElement | null;
				if (!el) return;
				if (document.fullscreenElement) {
					await document.exitFullscreen();
					screen.orientation?.unlock?.();
				} else {
					await el.requestFullscreen();
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					await (screen.orientation as any)?.lock?.("landscape").catch(() => {});
				}
			} catch {
				// Fullscreen API not supported or denied — silently ignore
			}
		}, []);

		// Clean up orientation lock when modal closes
		useEffect(() => {
			if (!fullscreen && document.fullscreenElement) {
				document.exitFullscreen().catch(() => {});
				screen.orientation?.unlock?.();
			}
		}, [fullscreen]);

		// Intercept browser back button to close fullscreen modal instead of navigating
		const closedByPopState = useRef(false);
		useEffect(() => {
			if (!fullscreen) return;
			closedByPopState.current = false;
			history.pushState({ contentViewerFullscreen: true }, "");
			const onPopState = () => {
				closedByPopState.current = true;
				close();
			};
			window.addEventListener("popstate", onPopState);
			return () => {
				window.removeEventListener("popstate", onPopState);
				// If closed by X button or other means, pop the extra history entry
				if (!closedByPopState.current) {
					history.back();
				}
			};
		}, [fullscreen, close]);

		// When fullscreen modal is open, suppress layout/paint on the chat scroll
		// container behind it.  We walk up from our inline box to find the nearest
		// Mantine ScrollArea viewport and toggle `content-visibility: hidden`.
		useEffect(() => {
			if (!fullscreen) return;
			const viewport = boxRef.current?.closest(
				"[data-radix-scroll-area-viewport], .mantine-ScrollArea-viewport",
			);
			if (!(viewport instanceof HTMLElement)) return;
			const prev = viewport.style.contentVisibility;
			viewport.style.contentVisibility = "hidden";
			return () => {
				viewport.style.contentVisibility = prev;
				// Nudge autosize textareas to recalculate after layout is restored
				requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
			};
		}, [fullscreen]);

		// Context menu state (desktop: Mantine Menu, mobile: swipe reveal)
		const [ctxMenuOpened, setCtxMenuOpened] = useState(false);
		const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0, flipY: false });

		// Mobile swipe state
		const [swipeOffset, setSwipeOffset] = useState(0);
		const swipeOffsetRef = useRef(0);
		const [swipeRevealed, setSwipeRevealed] = useState(false);
		const [swipeClosing, setSwipeClosing] = useState(false);
		const [swipeY, setSwipeY] = useState(0);
		const [swipeInitialRight, setSwipeInitialRight] = useState(0);
		const swipeRef = useRef<{
			startX: number;
			startY: number;
			locked: boolean;
			dir: "h" | "v" | null;
		} | null>(null);
		const SWIPE_THRESHOLD = 60;
		const SWIPE_REVEAL_WIDTH = 180;
		const swipeMenuRef = useRef<HTMLDivElement>(null);

		const closeSwipe = useCallback(() => {
			setSwipeClosing(true);
			swipeOffsetRef.current = 0;
			setSwipeOffset(0);
			setSwipeRevealed(false);
			globalCloseSwipe = null;
			// Remove menu DOM after transition completes
			setTimeout(() => setSwipeClosing(false), 220);
		}, []);

		// Register as the global open swipe menu when revealed
		useEffect(() => {
			if (swipeRevealed) {
				globalCloseSwipe = closeSwipe;
			}
			return () => {
				if (globalCloseSwipe === closeSwipe) {
					globalCloseSwipe = null;
				}
			};
		}, [swipeRevealed, closeSwipe]);

		// Desktop: right-click opens context menu
		const handleContextMenu = useCallback(
			(e: React.MouseEvent) => {
				if (isMobile) return;
				const selection = window.getSelection();
				if (selection && selection.toString().trim().length > 0) return;
				e.preventDefault();
				e.stopPropagation();
				const x = Math.min(e.clientX, window.innerWidth - 200);
				const flipY = e.clientY > window.innerHeight - 300;
				setCtxMenuPos({ x, y: e.clientY, flipY });
				setCtxMenuOpened(true);
			},
			[isMobile],
		);

		// Mobile: swipe-left to reveal action buttons
		useEffect(() => {
			if (!isMobile) return;
			const node = boxRef.current;
			if (!node) return;

			const onTouchStart = (e: TouchEvent) => {
				// Close any other ContentViewer's open swipe menu
				if (globalCloseSwipe && globalCloseSwipe !== closeSwipe) {
					globalCloseSwipe();
					swipeRef.current = null;
					return;
				}
				// If this menu is already revealed, close it and don't start a new swipe
				if (swipeRevealed) {
					closeSwipe();
					swipeRef.current = null;
					return;
				}
				const touch = e.touches[0];
				swipeRef.current = {
					startX: touch.clientX,
					startY: touch.clientY,
					locked: false,
					dir: null,
				};
				setSwipeY(touch.clientY);
				if (node) {
					setSwipeInitialRight(node.getBoundingClientRect().right);
				}
			};

			const onTouchMove = (e: TouchEvent) => {
				const s = swipeRef.current;
				if (!s || swipeRevealed) return;
				const touch = e.touches[0];
				const dx = s.startX - touch.clientX;
				const dy = Math.abs(touch.clientY - s.startY);

				// Determine direction lock
				if (!s.dir) {
					if (Math.abs(dx) > 10 || dy > 10) {
						s.dir = Math.abs(dx) > dy ? "h" : "v";
					}
					return;
				}
				if (s.dir === "v") return; // vertical scroll, ignore

				// Horizontal swipe — clamp between 0 and reveal width
				const offset = Math.max(0, Math.min(dx, SWIPE_REVEAL_WIDTH));
				swipeOffsetRef.current = offset;
				setSwipeOffset(offset);
			};

			const onTouchEnd = () => {
				const s = swipeRef.current;
				swipeRef.current = null;
				if (!s || s.dir !== "h") {
					return;
				}
				// Snap: if past threshold, reveal; otherwise close
				if (swipeOffsetRef.current >= SWIPE_THRESHOLD) {
					swipeOffsetRef.current = SWIPE_REVEAL_WIDTH;
					setSwipeOffset(SWIPE_REVEAL_WIDTH);
					setSwipeRevealed(true);
				} else {
					swipeOffsetRef.current = 0;
					setSwipeOffset(0);
					setSwipeRevealed(false);
				}
			};

			node.addEventListener("touchstart", onTouchStart, { passive: true });
			node.addEventListener("touchmove", onTouchMove, { passive: true });
			node.addEventListener("touchend", onTouchEnd, { passive: true });
			return () => {
				node.removeEventListener("touchstart", onTouchStart);
				node.removeEventListener("touchmove", onTouchMove);
				node.removeEventListener("touchend", onTouchEnd);
			};
		}, [isMobile, swipeRevealed, closeSwipe]);

		// Close swipe when tapping outside (but not on the swipe menu itself)
		useEffect(() => {
			if (!swipeRevealed) return;
			const onTouch = (e: TouchEvent) => {
				const target = e.target as Node;
				const node = boxRef.current;
				const menu = swipeMenuRef.current;
				if (node?.contains(target) || menu?.contains(target)) return;
				closeSwipe();
			};
			document.addEventListener("touchstart", onTouch, { passive: true });
			return () => document.removeEventListener("touchstart", onTouch);
		}, [swipeRevealed, closeSwipe]);

		const iconSize = isMobile ? 18 : 12;
		const btnSize: "lg" | "xs" = isMobile ? "lg" : "xs";

		const copyBtn = (
			<CopyButton value={content}>
				{({ copied, copy }) => (
					<Tooltip label={copied ? t("copied") : t("copy")} withArrow position="top">
						<ActionIcon
							size={btnSize}
							variant="filled"
							color={copied ? "teal" : "gray"}
							onClick={copy}
							aria-label={copied ? t("copied") : t("copy")}
							style={{ pointerEvents: "auto" }}
						>
							<IconCopy size={iconSize} />
						</ActionIcon>
					</Tooltip>
				)}
			</CopyButton>
		);

		const fullscreenBtn = (
			<Tooltip label={t("fullscreen")} withArrow position="top">
				<ActionIcon
					size={btnSize}
					variant="filled"
					color="gray"
					onClick={open}
					aria-label={t("fullscreen")}
					style={{ pointerEvents: "auto" }}
				>
					<IconArrowsMaximize size={iconSize} />
				</ActionIcon>
			</Tooltip>
		);

		const wrapToggle = (
			<Tooltip label={wordWrap ? t("noWrap") : t("wordWrap")} withArrow position="top">
				<ActionIcon
					size={btnSize}
					variant="filled"
					color={wordWrap ? "indigo" : "gray"}
					onClick={() => {
						userToggled.current = true;
						setWordWrap((v) => !v);
					}}
					aria-label={wordWrap ? t("noWrap") : t("wordWrap")}
					style={{ pointerEvents: "auto" }}
				>
					{wordWrap ? <IconTextWrap size={iconSize} /> : <IconTextWrapDisabled size={iconSize} />}
				</ActionIcon>
			</Tooltip>
		);

		const wrapStyle: CSSProperties = wordWrap
			? { whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "hidden" }
			: { whiteSpace: "pre", overflowX: "auto" };

		const sourceToggle = markdown ? (
			<Tooltip label={showSource ? t("rendered") : t("source")} withArrow position="top">
				<ActionIcon
					size={btnSize}
					variant="filled"
					color={showSource ? "indigo" : "gray"}
					onClick={() => setShowSource((v) => !v)}
					aria-label={showSource ? t("rendered") : t("source")}
					style={{ pointerEvents: "auto" }}
				>
					{showSource ? <IconMarkdown size={iconSize} /> : <IconCode size={iconSize} />}
				</ActionIcon>
			</Tooltip>
		) : null;

		/** Render markdown or raw source depending on toggle */
		const renderMarkdown = (extraStyle?: CSSProperties) =>
			showSource ? (
				<Code block style={{ ...style, ...wrapStyle, ...extraStyle }}>
					{content}
				</Code>
			) : (
				<Box px="xs" py={4} style={{ minWidth: 0, ...extraStyle }}>
					<MarkdownContent text={content} wordWrap={wordWrap} />
				</Box>
			);

		// Mobile: double-tap to fullscreen
		const lastTapRef = useRef(0);
		const handleDoubleTap = useCallback(() => {
			if (!isMobile) return;
			const now = Date.now();
			if (now - lastTapRef.current < 300) {
				open();
				lastTapRef.current = 0;
			} else {
				lastTapRef.current = now;
			}
		}, [isMobile, open]);

		const swipeTransition = swipeRef.current ? "none" : "transform 200ms ease";
		const swipeMenuTransition = swipeRef.current ? "none" : "left 200ms ease, transform 200ms ease";

		return (
			<>
				<Box
					ref={boxRef}
					pos="relative"
					data-content-block
					data-cv-id={instanceId.current}
					style={{
						maxWidth: "100%",
						minWidth: 0,
						transform: isMobile && swipeOffset > 0 ? `translateX(-${swipeOffset}px)` : undefined,
						transition: isMobile ? swipeTransition : undefined,
					}}
					onMouseEnter={isMobile ? undefined : () => setHovered(true)}
					onMouseLeave={isMobile ? undefined : () => setHovered(false)}
					onContextMenu={handleContextMenu}
					onClick={isMobile ? handleDoubleTap : undefined}
				>
					{/* Sticky bar: desktop hover only */}
					{!isMobile && (
						<div style={actionStickyWrapper} ref={actionBarRef}>
							<Group gap={2} style={hovered ? actionBarVisible : actionBarHidden} wrap="nowrap">
								{sourceToggle}
								{wrapToggle}
								{copyBtn}
								{fullscreenBtn}
							</Group>
						</div>
					)}

					{/* Inline content */}
					{renderContent
						? renderContent(wordWrap)
						: (children ??
							(markdown ? (
								renderMarkdown({
									maxHeight: style?.maxHeight,
									overflowY: style?.maxHeight ? "auto" : undefined,
								})
							) : (
								<Code block style={{ ...style, ...wrapStyle, maxWidth: "100%" }}>
									{content}
								</Code>
							)))}
				</Box>

				{/* Mobile swipe-reveal action menu — fixed, hugging the message's right edge */}
				{isMobile &&
					(swipeOffset > 0 || swipeClosing) &&
					(() => {
						const menuLeft = swipeInitialRight - swipeOffset;
						const boxRect = boxRef.current?.getBoundingClientRect();
						const menuRef = swipeMenuRef.current;
						const menuH = menuRef?.offsetHeight ?? 200;
						let menuTop = swipeY;
						if (boxRect && boxRect.height > menuH) {
							// Clamp so menu stays within the content block bounds
							const minTop = boxRect.top + menuH / 2;
							const maxTop = boxRect.bottom - menuH / 2;
							menuTop = Math.max(minTop, Math.min(swipeY, maxTop));
						}
						return (
							<Box
								ref={swipeMenuRef}
								style={{
									position: "fixed",
									left: menuLeft,
									top: menuTop,
									transform: "translateY(-50%)",
									zIndex: 1000,
									transition: swipeMenuTransition,
									pointerEvents: swipeClosing ? "none" : "auto",
								}}
							>
								<Menu opened withinPortal={false} position="bottom-start">
									<Menu.Dropdown
										style={{
											position: "relative",
											width: SWIPE_REVEAL_WIDTH,
										}}
									>
										<Menu.Item
											leftSection={<IconArrowsMaximize size={14} />}
											onClick={() => {
												open();
												closeSwipe();
											}}
										>
											{t("fullscreen")}
										</Menu.Item>
										<Menu.Item
											leftSection={
												wordWrap ? <IconTextWrap size={14} /> : <IconTextWrapDisabled size={14} />
											}
											onClick={() => {
												userToggled.current = true;
												setWordWrap((v) => !v);
												closeSwipe();
											}}
										>
											{wordWrap ? t("noWrap") : t("wordWrap")}
										</Menu.Item>
										<Menu.Item
											leftSection={<IconCopy size={14} />}
											onClick={() => {
												navigator.clipboard.writeText(content);
												closeSwipe();
											}}
										>
											{t("copy")}
										</Menu.Item>
										{(msgCtx.onBranchFromMessage ||
											msgCtx.onForkFromMessage ||
											msgCtx.onDeleteMessage) && <Menu.Divider />}
										{msgCtx.onBranchFromMessage && (
											<Menu.Item
												leftSection={<IconGitBranch size={14} />}
												onClick={() => {
													msgCtx.onBranchFromMessage?.();
													closeSwipe();
												}}
											>
												{tNarrator("contextMenu_branch")}
											</Menu.Item>
										)}
										{msgCtx.onForkFromMessage && (
											<Menu.Item
												leftSection={<IconGitFork size={14} />}
												onClick={() => {
													msgCtx.onForkFromMessage?.();
													closeSwipe();
												}}
											>
												{tNarrator("contextMenu_fork")}
											</Menu.Item>
										)}
										{msgCtx.onDeleteMessage && (
											<Menu.Item
												color="red"
												leftSection={<IconTrash size={14} />}
												onClick={() => {
													msgCtx.onDeleteMessage?.();
													closeSwipe();
												}}
											>
												{tNarrator("contextMenu_delete")}
											</Menu.Item>
										)}
									</Menu.Dropdown>
								</Menu>
							</Box>
						);
					})()}

				{/* Fullscreen modal */}
				<Modal
					opened={fullscreen}
					onClose={close}
					title={title}
					fullScreen
					styles={{
						body: {
							height: "calc(100vh - 60px)",
							overflow: "auto",
							padding: isMobile ? 8 : undefined,
							display: "flex",
							flexDirection: "column",
						},
					}}
				>
					<div ref={modalBodyRef} style={modalToolbarStyle}>
						{sourceToggle}
						{wrapToggle}
						{copyBtn}
						{isMobile && (
							<Tooltip label={t("landscape")} withArrow position="top">
								<ActionIcon
									size="lg"
									variant="filled"
									color="gray"
									onClick={toggleLandscape}
									aria-label={t("landscape")}
								>
									<IconDeviceMobileRotated size={18} />
								</ActionIcon>
							</Tooltip>
						)}
					</div>

					{diff ? (
						<Box
							style={{
								flex: 1,
								minHeight: 0,
								overflow: "hidden",
								display: "flex",
								flexDirection: "column",
							}}
						>
							<DiffView
								oldStr={diff.oldStr}
								newStr={diff.newStr}
								maxHeight={undefined}
								wordWrap={wordWrap}
							/>
						</Box>
					) : markdown ? (
						renderMarkdown({ flex: 1, minHeight: 0, overflow: "auto" })
					) : (
						<Code
							block
							style={{
								...style,
								...wrapStyle,
								maxHeight: undefined,
								overflow: "auto",
								fontSize: isMobile ? 11 : 12,
								flex: 1,
								minHeight: 0,
							}}
						>
							{content}
						</Code>
					)}
				</Modal>

				{/* Context menu */}
				<Menu
					opened={ctxMenuOpened}
					onChange={setCtxMenuOpened}
					position="bottom-start"
					withinPortal
					styles={{
						dropdown: {
							position: "fixed",
							left: ctxMenuPos.x,
							...(ctxMenuPos.flipY
								? { bottom: window.innerHeight - ctxMenuPos.y, top: "auto" }
								: { top: ctxMenuPos.y }),
						},
					}}
				>
					<Menu.Target>
						<div
							style={{
								position: "fixed",
								left: ctxMenuPos.x,
								top: ctxMenuPos.y,
								pointerEvents: "none",
							}}
						/>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item leftSection={<IconArrowsMaximize size={14} />} onClick={open}>
							{t("fullscreen")}
						</Menu.Item>
						<Menu.Item
							leftSection={
								wordWrap ? <IconTextWrap size={14} /> : <IconTextWrapDisabled size={14} />
							}
							onClick={() => {
								userToggled.current = true;
								setWordWrap((v) => !v);
							}}
						>
							{wordWrap ? t("noWrap") : t("wordWrap")}
						</Menu.Item>
						<Menu.Item
							leftSection={<IconCopy size={14} />}
							onClick={() => navigator.clipboard.writeText(content)}
						>
							{t("copy")}
						</Menu.Item>
						{(msgCtx.onBranchFromMessage || msgCtx.onForkFromMessage || msgCtx.onDeleteMessage) && (
							<Menu.Divider />
						)}
						{msgCtx.onBranchFromMessage && (
							<Menu.Item
								leftSection={<IconGitBranch size={14} />}
								onClick={msgCtx.onBranchFromMessage}
							>
								{tNarrator("contextMenu_branch")}
							</Menu.Item>
						)}
						{msgCtx.onForkFromMessage && (
							<Menu.Item leftSection={<IconGitFork size={14} />} onClick={msgCtx.onForkFromMessage}>
								{tNarrator("contextMenu_fork")}
							</Menu.Item>
						)}
						{msgCtx.onDeleteMessage && (
							<Menu.Item
								color="red"
								leftSection={<IconTrash size={14} />}
								onClick={msgCtx.onDeleteMessage}
							>
								{tNarrator("contextMenu_delete")}
							</Menu.Item>
						)}
					</Menu.Dropdown>
				</Menu>
			</>
		);
	}),
);
