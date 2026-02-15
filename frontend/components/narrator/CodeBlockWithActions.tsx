import {
	ActionIcon,
	Box,
	Code,
	CopyButton,
	Group,
	Modal,
	ScrollArea,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowsMaximize,
	IconCopy,
	IconDeviceMobileRotated,
	IconTextWrap,
	IconTextWrapDisabled,
} from "@tabler/icons-react";
import { type CSSProperties, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { DiffView } from "./DiffView";
import { MarkdownContent } from "./MarkdownContent";

export type CodeContentType = "markdown" | "code" | "diff";

interface CodeBlockWithActionsProps {
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

/** Desktop: hidden by default, shown on hover */
const actionBarBase: CSSProperties = {
	position: "absolute",
	top: 4,
	right: 4,
	zIndex: 2,
	transition: "opacity 150ms ease",
};

const actionBarHidden: CSSProperties = {
	...actionBarBase,
	opacity: 0,
	pointerEvents: "none",
};

const actionBarVisible: CSSProperties = {
	...actionBarBase,
	opacity: 1,
	pointerEvents: "auto",
};

/** Fullscreen modal toolbar */
const modalToolbarStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: 8,
	paddingBottom: 8,
};

/** Landscape container rotates content 90° to simulate landscape on portrait screens */
const landscapeContainerStyle: CSSProperties = {
	transform: "rotate(90deg)",
	transformOrigin: "top left",
	position: "absolute",
	top: 0,
	left: "100%",
	overflow: "auto",
};

export const CodeBlockWithActions = memo(function CodeBlockWithActions({
	content,
	style,
	title,
	diff,
	markdown,
	contentType = "code",
	children,
	renderContent,
}: CodeBlockWithActionsProps) {
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
	const [landscape, setLandscape] = useState(false);

	// Sync with user preferences once they load (unless user already toggled manually)
	useEffect(() => {
		if (!userToggled.current) {
			setWordWrap(defaultWrap);
		}
	}, [defaultWrap]);
	const isMobile = useMediaQuery("(max-width: 768px)");

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
				onClick={() => { userToggled.current = true; setWordWrap((v) => !v); }}
				aria-label={wordWrap ? t("noWrap") : t("wordWrap")}
			>
				{wordWrap ? <IconTextWrap size={iconSize} /> : <IconTextWrapDisabled size={iconSize} />}
			</ActionIcon>
		</Tooltip>
	);

	const wrapStyle: CSSProperties = wordWrap
		? { whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "hidden" }
		: { whiteSpace: "pre", overflowX: "auto" };

	return (
		<>
			<Box
				pos="relative"
				style={{ maxWidth: "100%", minWidth: 0 }}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
			>
				{/* Floating overlay on hover */}
				<Group gap={2} style={hovered ? actionBarVisible : actionBarHidden}>
					{wrapToggle}
					{copyBtn}
					{fullscreenBtn}
				</Group>

				{/* Inline content */}
				{renderContent
					? renderContent(wordWrap)
					: children ??
					(markdown ? (
						<Box px="xs" py={4} style={{ ...wrapStyle, maxHeight: style?.maxHeight ?? 480, overflowY: "auto" }}>
							<MarkdownContent text={content} />
						</Box>
					) : (
						<Code block style={{ ...style, ...wrapStyle }}>
							{content}
						</Code>
					))}
			</Box>

			{/* Fullscreen modal */}
			<Modal
				opened={fullscreen}
				onClose={() => {
					setLandscape(false);
					close();
				}}
				title={title}
				fullScreen
				styles={{
					body: {
						height: "calc(100vh - 60px)",
						overflow: landscape ? "hidden" : "auto",
						padding: isMobile ? 8 : undefined,
						position: "relative",
						display: "flex",
						flexDirection: "column",
					},
				}}
			>
				{/* Toolbar inside modal */}
				<div style={modalToolbarStyle}>
					{wrapToggle}
					{copyBtn}
					{isMobile && (
						<Tooltip label={t("landscape")} withArrow position="top">
							<ActionIcon
								size="lg"
								variant="filled"
								color={landscape ? "indigo" : "gray"}
								onClick={() => setLandscape((v) => !v)}
								aria-label={t("landscape")}
							>
								<IconDeviceMobileRotated size={18} />
							</ActionIcon>
						</Tooltip>
					)}
				</div>

				{/* Content — optionally rotated for landscape */}
				{landscape ? (
					<Box
						style={{
							...landscapeContainerStyle,
							width: "calc(100vh - 120px)",
							height: "calc(100vw - 16px)",
						}}
					>
						{diff ? (
							<DiffView oldStr={diff.oldStr} newStr={diff.newStr} maxHeight={undefined} wordWrap={wordWrap} />
						) : markdown ? (
							<Box px="md" py="xs" style={{ overflow: "auto", height: "100%", ...wrapStyle }}>
								<MarkdownContent text={content} />
							</Box>
						) : (
							<Code
								block
								style={{
									...style,
									...wrapStyle,
									maxHeight: undefined,
									overflow: "auto",
									fontSize: 11,
									height: "100%",
								}}
							>
								{content}
							</Code>
						)}
					</Box>
				) : diff ? (
					<Box style={{ flex: 1, minHeight: 0 }}>
						<DiffView oldStr={diff.oldStr} newStr={diff.newStr} maxHeight={undefined} wordWrap={wordWrap} />
					</Box>
				) : markdown ? (
					<Box px="md" py="xs" style={wrapStyle}>
						<MarkdownContent text={content} />
					</Box>
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
