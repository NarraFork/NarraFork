import { ActionIcon, Box, Code, CopyButton, Group, Menu, Modal, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowsMaximize,
	IconArrowsMinimize,
	IconCode,
	IconCopy,
	IconDeviceMobileRotated,
	IconEdit,
	IconExternalLink,
	IconGitFork,
	IconMarkdown,
	IconRefresh,
	IconTextWrap,
	IconTextWrapDisabled,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import {
	type CSSProperties,
	createContext,
	forwardRef,
	memo,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { DiffView } from "./DiffView";
import { HighlightedCode } from "./HighlightedCode";
import { MarkdownContent } from "./MarkdownContent";
import { useMessageContextMenu } from "./MessageContextMenuCtx";
import { BLOCK_ID_ATTR, NestedBlockCtx, useMessageSelection } from "./MessageSelectionCtx";

export type CodeContentType = "markdown" | "code" | "diff";

interface ContentViewerEnvironment {
	isMobile: boolean;
	defaultWraps: Record<CodeContentType, boolean>;
}

const DEFAULT_CONTENT_VIEWER_ENV: ContentViewerEnvironment = {
	isMobile: false,
	defaultWraps: {
		markdown: true,
		code: true,
		diff: true,
	},
};

const ContentViewerEnvironmentContext = createContext<ContentViewerEnvironment>(
	DEFAULT_CONTENT_VIEWER_ENV,
);

export function ContentViewerEnvironmentProvider({
	value,
	children,
}: {
	value: ContentViewerEnvironment;
	children: ReactNode;
}) {
	return (
		<ContentViewerEnvironmentContext.Provider value={value}>
			{children}
		</ContentViewerEnvironmentContext.Provider>
	);
}

interface ContentViewerProps {
	/** Text content to display and copy */
	content: string;
	/** Full (untruncated) content shown only in fullscreen modal. Falls back to `content`. */
	fullContent?: string;
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
	/** Shiki language id for syntax highlighting (e.g. "typescript"). */
	language?: string;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
	/** Whether this content is currently being streamed (enables per-char animation) */
	streaming?: boolean;
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

/** Global registry: instanceId → handle, so parent components can look up
 *  a ContentViewer by its data-cv-id DOM attribute without passing refs. */
export const handleRegistry = new Map<number, ContentViewerHandle>();

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
		{
			content,
			fullContent,
			style,
			title,
			diff,
			markdown,
			contentType = "code",
			children,
			renderContent,
			language,
			blockIndex,
			streaming,
		},
		ref,
	) {
		const { t } = useTranslation("common");
		const { t: tNarrator } = useTranslation("narrator");
		const msgCtx = useMessageContextMenu();
		const contentViewerEnv = useContext(ContentViewerEnvironmentContext);
		const defaultWrap = contentViewerEnv.defaultWraps[contentType] ?? true;
		const [fullscreen, { open, close }] = useDisclosure(false);
		const [hovered, setHovered] = useState(false);
		const [wordWrap, setWordWrap] = useState(defaultWrap);
		const userToggled = useRef(false);
		const [showSource, setShowSource] = useState(false);
		const boxRef = useRef<HTMLDivElement>(null);
		const actionBarRef = useRef<HTMLDivElement>(null);
		const modalBodyRef = useRef<HTMLDivElement>(null);
		const instanceId = useRef(nextInstanceId++);
		const isMobile = contentViewerEnv.isMobile;
		const nested = useContext(NestedBlockCtx);
		const blockIdStr = nested ? undefined : `cv-${instanceId.current}`;
		const selection = useMessageSelection();
		// The effective ID for multi-select: own ID, or parent ToolCallCard's ID when nested + selecting
		const effectiveSelectionId = nested && selection.selectionMode ? nested : blockIdStr;
		const isSelected = !!(
			effectiveSelectionId &&
			selection.selectionMode &&
			selection.selectedBlockIds.has(effectiveSelectionId)
		);

		const handle = useMemo<ContentViewerHandle>(
			() => ({
				openFullscreen: () => open(),
				toggleWrap: () => {
					userToggled.current = true;
					setWordWrap((v) => !v);
				},
				getContent: () => fullContent ?? content,
			}),
			[content, fullContent, open],
		);

		useImperativeHandle(ref, () => handle, [handle]);

		// Register in global registry so parents can resolve via DOM lookup
		useEffect(() => {
			const id = instanceId.current;
			handleRegistry.set(id, handle);
			return () => {
				handleRegistry.delete(id);
			};
		}, [handle]);

		// Sync with user preferences once they load (unless user already toggled manually)
		useEffect(() => {
			if (!userToggled.current) {
				setWordWrap(defaultWrap);
			}
		}, [defaultWrap]);

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
		// ContentViewer uses its own boxRef for both swipe and other purposes (viewport detection).
		// excludeSelectors is empty because ContentViewer IS the content block.
		const handleDeselectBlock = useCallback(() => {
			if (effectiveSelectionId) selection.deselectBlock(effectiveSelectionId);
		}, [selection.deselectBlock, effectiveSelectionId]);

		const swipe = useSwipeMenu({
			enabled: true,
			externalBoxRef: boxRef,
			excludeSelectors: [".mantine-Menu-dropdown"],
			// In selection mode, nested ContentViewers act on behalf of the parent
			// ToolCallCard — use the parent's blockId so toggle/anchor targets the card.
			blockId: nested && selection.selectionMode ? nested : blockIdStr,
			anchorBlockId: nested ?? undefined,
			onSwipeRight: isSelected ? handleDeselectBlock : undefined,
		});

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

		// Desktop: right-click opens context menu (override hook's handler to gate on !isMobile)
		const handleContextMenu = useCallback(
			(e: React.MouseEvent) => {
				if (isMobile) return;
				const selection = window.getSelection();
				if (selection && selection.toString().trim().length > 0) return;
				e.preventDefault();
				e.stopPropagation();
				const x = Math.min(e.clientX, window.innerWidth - 200);
				const flipY = e.clientY > window.innerHeight - 300;
				swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
				swipe.setCtxMenuOpened(true);
			},
			[isMobile, swipe.setCtxMenuPos, swipe.setCtxMenuOpened],
		);

		// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
		// Mobile: double-tap to fullscreen (falls through to handleDoubleTap)
		const handleBlockClick = useCallback(
			(e: React.MouseEvent) => {
				if (isMobile) {
					handleDoubleTap();
					return;
				}
				if (nested || !blockIdStr) return;
				const isModKey = e.metaKey || e.ctrlKey;
				const isShift = e.shiftKey;
				if (!isModKey && !isShift) return;
				// Don't interfere with text selection — but when block selection
				// is already active, Shift+Click should always do range-select
				// (browser may have produced a text selection via native shift-click).
				if (!selection.selectionMode) {
					const sel = window.getSelection();
					if (sel && sel.toString().trim().length > 0) return;
				}
				e.preventDefault();
				if (isShift) {
					window.getSelection()?.removeAllRanges();
					selection.rangeSelectTo(blockIdStr);
				} else {
					selection.toggleBlock(blockIdStr);
				}
			},
			[
				isMobile,
				nested,
				handleDoubleTap,
				blockIdStr,
				selection.selectionMode,
				selection.toggleBlock,
				selection.rangeSelectTo,
			],
		);

		const iconSize = isMobile ? 18 : 12;
		const btnSize: "lg" | "xs" = isMobile ? "lg" : "xs";

		const makeCopyBtn = (value: string) => (
			<CopyButton value={value}>
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
		/** Prefer untruncated content everywhere it's available */
		const inlineContent = fullContent ?? content;
		const copyBtn = makeCopyBtn(inlineContent);
		const modalContent = fullContent ?? content;
		const modalCopyBtn = fullContent ? makeCopyBtn(modalContent) : copyBtn;

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
		const renderMarkdown = (text: string, extraStyle?: CSSProperties) =>
			showSource ? (
				<Code block style={{ ...style, ...wrapStyle, ...extraStyle }}>
					{text}
				</Code>
			) : (
				<Box px="xs" py={4} style={{ minWidth: 0, ...extraStyle }}>
					<MarkdownContent text={text} wordWrap={wordWrap} streaming={streaming} />
				</Box>
			);

		const SWIPE_REVEAL_WIDTH = 180;

		// Selected blocks get a visual offset to match the anchor's swipe (mobile only)
		// Nested ContentViewers skip visual selection — the parent ToolCallCard handles it.
		const showSelectedVisual = isSelected && !nested;
		const selectionOffset =
			isMobile && showSelectedVisual && !swipe.swipeRevealed ? SWIPE_REVEAL_WIDTH : 0;
		const effectiveOffset = swipe.swipeOffset > 0 ? swipe.swipeOffset : selectionOffset;

		return (
			<>
				<Box
					ref={boxRef}
					pos="relative"
					data-content-block
					data-cv-id={instanceId.current}
					{...(blockIdStr ? { [BLOCK_ID_ATTR]: blockIdStr } : {})}
					{...(msgCtx.messageId && !nested ? { "data-message-id": msgCtx.messageId } : {})}
					{...(blockIndex != null && !nested ? { "data-block-index": String(blockIndex) } : {})}
					style={{
						maxWidth: "100%",
						minWidth: 0,
						transform: effectiveOffset > 0 ? `translateX(-${effectiveOffset}px)` : undefined,
						transition: swipe.swipeTransition,
						outline: showSelectedVisual ? "2px solid var(--mantine-color-indigo-6)" : undefined,
						outlineOffset: showSelectedVisual ? -2 : undefined,
						borderRadius: showSelectedVisual ? 4 : undefined,
					}}
					onMouseEnter={isMobile ? undefined : () => setHovered(true)}
					onMouseLeave={isMobile ? undefined : () => setHovered(false)}
					onContextMenu={handleContextMenu}
					onClick={handleBlockClick}
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

					{/* Inline content — prefer fullContent when available so truncated
				    previews are replaced once the full payload has been fetched. */}
					{renderContent
						? renderContent(wordWrap)
						: (children ??
							(markdown ? (
								renderMarkdown(fullContent ?? content, {
									maxHeight: style?.maxHeight,
									overflowY: style?.maxHeight ? "auto" : undefined,
								})
							) : language && language !== "text" ? (
								<HighlightedCode
									code={fullContent ?? content}
									lang={language}
									style={{ ...style, ...wrapStyle, maxWidth: "100%" }}
								/>
							) : (
								<Code block style={{ ...style, ...wrapStyle, maxWidth: "100%" }}>
									{fullContent ?? content}
								</Code>
							)))}
				</Box>

				{/* Swipe-reveal action menu — portal to body, position:fixed to bypass containing blocks */}
				{(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
					(() => {
						const menuEl = swipe.swipeMenuRef.current;
						const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight ?? 200);
						return createPortal(
							<Box
								ref={swipe.swipeMenuRef}
								style={{
									position: "fixed",
									left: pos.left,
									top: pos.top,
									transform: "translateY(-50%)",
									zIndex: 1000,
									transition: swipe.swipeMenuTransition,
									pointerEvents: swipe.swipeClosing ? "none" : "auto",
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
												swipe.closeSwipe();
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
												swipe.closeSwipe();
											}}
										>
											{wordWrap ? t("noWrap") : t("wordWrap")}
										</Menu.Item>
										<Menu.Item
											leftSection={<IconCopy size={14} />}
											onClick={() => {
												navigator.clipboard.writeText(content);
												swipe.closeSwipe();
											}}
										>
											{t("copy")}
										</Menu.Item>
										{(msgCtx.onForkFromMessage ||
											msgCtx.onCompactBeforeMessage ||
											msgCtx.onDeleteBlock ||
											msgCtx.onRegenerateFromMessage ||
											msgCtx.onEditMessage ||
											msgCtx.onJumpToSource) && <Menu.Divider />}
										{msgCtx.onJumpToSource && (
											<Menu.Item
												leftSection={<IconExternalLink size={14} />}
												onClick={() => {
													msgCtx.onJumpToSource?.();
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_jumpToSource")}
											</Menu.Item>
										)}
										{msgCtx.onEditMessage && (
											<Menu.Item
												leftSection={<IconEdit size={14} />}
												onClick={() => {
													msgCtx.onEditMessage?.();
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_edit")}
											</Menu.Item>
										)}
										{msgCtx.onRegenerateFromMessage && (
											<Menu.Item
												leftSection={<IconRefresh size={14} />}
												onClick={() => {
													msgCtx.onRegenerateFromMessage?.();
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_regenerate")}
											</Menu.Item>
										)}
										{msgCtx.onForkFromMessage && (
											<Menu.Item
												leftSection={<IconGitFork size={14} />}
												onClick={() => {
													msgCtx.onForkFromMessage?.();
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_fork")}
											</Menu.Item>
										)}
										{msgCtx.onCompactBeforeMessage && (
											<Menu.Item
												leftSection={<IconArrowsMinimize size={14} />}
												onClick={() => {
													msgCtx.onCompactBeforeMessage?.();
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_compactBefore")}
											</Menu.Item>
										)}
										{msgCtx.onDeleteBlock && blockIndex != null && (
											<Menu.Item
												color="red"
												leftSection={<IconTrash size={14} />}
												onClick={() => {
													msgCtx.onDeleteBlock?.(blockIndex);
													swipe.closeSwipe();
												}}
											>
												{tNarrator("contextMenu_delete")}
											</Menu.Item>
										)}
										<Menu.Divider />
										<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
											{t("cancel")}
										</Menu.Item>
									</Menu.Dropdown>
								</Menu>
							</Box>,
							document.body,
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
						{modalCopyBtn}
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
								language={language}
							/>
						</Box>
					) : markdown ? (
						renderMarkdown(modalContent, { flex: 1, minHeight: 0, overflow: "auto" })
					) : language && language !== "text" ? (
						<HighlightedCode
							code={modalContent}
							lang={language}
							style={{
								...style,
								...wrapStyle,
								maxHeight: undefined,
								overflow: "auto",
								fontSize: isMobile ? 11 : 12,
								flex: 1,
								minHeight: 0,
							}}
						/>
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
							{modalContent}
						</Code>
					)}
				</Modal>

				{/* Context menu */}
				<Menu
					opened={swipe.ctxMenuOpened}
					onChange={swipe.setCtxMenuOpened}
					position="bottom-start"
					withinPortal
					styles={{
						dropdown: {
							position: "fixed",
							left: swipe.ctxMenuPos.x,
							...(swipe.ctxMenuPos.flipY
								? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
								: { top: swipe.ctxMenuPos.y }),
						},
					}}
				>
					<Menu.Target>
						<div
							style={{
								position: "fixed",
								left: swipe.ctxMenuPos.x,
								top: swipe.ctxMenuPos.y,
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
						{(msgCtx.onForkFromMessage ||
							msgCtx.onCompactBeforeMessage ||
							msgCtx.onDeleteBlock ||
							msgCtx.onRegenerateFromMessage ||
							msgCtx.onEditMessage ||
							msgCtx.onJumpToSource) && <Menu.Divider />}
						{msgCtx.onJumpToSource && (
							<Menu.Item
								leftSection={<IconExternalLink size={14} />}
								onClick={msgCtx.onJumpToSource}
							>
								{tNarrator("contextMenu_jumpToSource")}
							</Menu.Item>
						)}
						{msgCtx.onEditMessage && (
							<Menu.Item leftSection={<IconEdit size={14} />} onClick={msgCtx.onEditMessage}>
								{tNarrator("contextMenu_edit")}
							</Menu.Item>
						)}
						{msgCtx.onRegenerateFromMessage && (
							<Menu.Item
								leftSection={<IconRefresh size={14} />}
								onClick={msgCtx.onRegenerateFromMessage}
							>
								{tNarrator("contextMenu_regenerate")}
							</Menu.Item>
						)}
						{msgCtx.onForkFromMessage && (
							<Menu.Item leftSection={<IconGitFork size={14} />} onClick={msgCtx.onForkFromMessage}>
								{tNarrator("contextMenu_fork")}
							</Menu.Item>
						)}
						{msgCtx.onCompactBeforeMessage && (
							<Menu.Item
								leftSection={<IconArrowsMinimize size={14} />}
								onClick={msgCtx.onCompactBeforeMessage}
							>
								{tNarrator("contextMenu_compactBefore")}
							</Menu.Item>
						)}
						{msgCtx.onDeleteBlock && blockIndex != null && (
							<Menu.Item
								color="red"
								leftSection={<IconTrash size={14} />}
								onClick={() => msgCtx.onDeleteBlock?.(blockIndex)}
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
