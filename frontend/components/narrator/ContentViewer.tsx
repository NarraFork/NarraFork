import { ActionIcon, Box, Code, CopyButton, Group, Modal, Tooltip } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowsMaximize,
	IconCode,
	IconCopy,
	IconDeviceMobileRotated,
	IconMarkdown,
	IconTextWrap,
	IconTextWrapDisabled,
} from "@tabler/icons-react";
import {
	type CSSProperties,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { DiffView } from "./DiffView";
import { MarkdownContent } from "./MarkdownContent";

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

/** Visible but not yet interactive — used during the touch guard period */
const actionBarVisibleInert: CSSProperties = {
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

/** Cross-instance coordination: when one ContentViewer shows its action bar,
 *  all others should hide theirs.  Simple pub/sub via a Set of callbacks. */
type DismissCallback = (sourceId: number) => void;
const dismissListeners = new Set<DismissCallback>();
let nextInstanceId = 0;

export const ContentViewer = memo(function ContentViewer({
	content,
	style,
	title,
	diff,
	markdown,
	contentType = "code",
	children,
	renderContent,
}: ContentViewerProps) {
	const { t } = useTranslation("common");
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
	const [touched, setTouched] = useState(false);
	const [touchInteractive, setTouchInteractive] = useState(false);
	const touchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const interactiveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const boxRef = useRef<HTMLDivElement>(null);
	const actionBarRef = useRef<HTMLDivElement>(null);
	const modalBodyRef = useRef<HTMLDivElement>(null);
	const instanceId = useRef(nextInstanceId++);

	// Subscribe to cross-instance dismiss events
	useEffect(() => {
		const cb: DismissCallback = (sourceId) => {
			if (sourceId !== instanceId.current) {
				setTouched(false);
				setTouchInteractive(false);
				clearTimeout(touchTimer.current);
				clearTimeout(interactiveTimer.current);
				touchTimer.current = undefined;
			}
		};
		dismissListeners.add(cb);
		return () => {
			dismissListeners.delete(cb);
		};
	}, []);

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
				await screen.orientation?.lock?.("landscape").catch(() => {});
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

	// Mobile: show on touchend (tap), delay interactivity to prevent accidental clicks,
	// hide on scroll or after 3s
	const showTouched = useCallback(() => {
		// Dismiss action bars on all other ContentViewer instances
		for (const cb of dismissListeners) cb(instanceId.current);
		setTouched(true);
		setTouchInteractive(false);
		clearTimeout(touchTimer.current);
		clearTimeout(interactiveTimer.current);
		interactiveTimer.current = setTimeout(() => setTouchInteractive(true), 300);
		touchTimer.current = setTimeout(() => {
			setTouched(false);
			setTouchInteractive(false);
			touchTimer.current = undefined;
		}, 3000);
	}, []);

	useEffect(() => {
		if (!isMobile) return;
		const node = boxRef.current;
		if (!node) return;
		const onTouchEnd = (e: TouchEvent) => {
			// Don't reset touch state when tapping on the action buttons themselves
			if (actionBarRef.current?.contains(e.target as Node)) return;
			// Toggle: hide if already visible, show if hidden
			if (touchTimer.current) {
				setTouched(false);
				setTouchInteractive(false);
				clearTimeout(touchTimer.current);
				clearTimeout(interactiveTimer.current);
				touchTimer.current = undefined;
			} else {
				showTouched();
			}
		};
		const onScroll = () => {
			setTouched(false);
			setTouchInteractive(false);
			clearTimeout(touchTimer.current);
			clearTimeout(interactiveTimer.current);
			touchTimer.current = undefined;
		};
		node.addEventListener("touchend", onTouchEnd, { passive: true });
		window.addEventListener("scroll", onScroll, { passive: true, capture: true });
		return () => {
			node.removeEventListener("touchend", onTouchEnd);
			window.removeEventListener("scroll", onScroll, { capture: true });
			clearTimeout(touchTimer.current);
			clearTimeout(interactiveTimer.current);
		};
	}, [isMobile, showTouched]);

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

	return (
		<>
			<Box
				ref={boxRef}
				pos="relative"
				style={{ maxWidth: "100%", minWidth: 0 }}
				onMouseEnter={isMobile ? undefined : () => setHovered(true)}
				onMouseLeave={isMobile ? undefined : () => setHovered(false)}
			>
				{/* Sticky bar: stays at top during vertical scroll, constrained to container width */}
				<div style={actionStickyWrapper} ref={actionBarRef}>
					<Group
						gap={2}
						style={
							hovered || touched
								? hovered || touchInteractive
									? actionBarVisible
									: actionBarVisibleInert
								: actionBarHidden
						}
						wrap="nowrap"
					>
						{sourceToggle}
						{wrapToggle}
						{copyBtn}
						{fullscreenBtn}
					</Group>
				</div>

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
		</>
	);
});
