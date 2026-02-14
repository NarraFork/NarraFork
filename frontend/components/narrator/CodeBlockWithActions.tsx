import { ActionIcon, Box, Code, CopyButton, Group, Modal, Tooltip } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowsMaximize,
	IconCopy,
	IconDeviceMobileRotated,
	IconTextWrap,
	IconTextWrapDisabled,
} from "@tabler/icons-react";
import { type CSSProperties, memo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "./DiffView";

interface CodeBlockWithActionsProps {
	/** Text content to display and copy */
	content: string;
	/** Style applied to the Code block */
	style?: CSSProperties;
	/** Modal title when fullscreen */
	title?: string;
	/** If provided, renders DiffView instead of Code in fullscreen */
	diff?: { oldStr: string; newStr: string };
	/** Extra children rendered inside the wrapper (e.g. existing Code block) */
	children?: ReactNode;
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

/** Mobile: always-visible strip below the code block with larger touch targets */
const mobileBarStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: 8,
	paddingTop: 6,
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
	children,
}: CodeBlockWithActionsProps) {
	const { t } = useTranslation("common");
	const [fullscreen, { open, close }] = useDisclosure(false);
	const [hovered, setHovered] = useState(false);
	const [wordWrap, setWordWrap] = useState(true);
	const [landscape, setLandscape] = useState(false);
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
				onClick={() => setWordWrap((v) => !v)}
				aria-label={wordWrap ? t("noWrap") : t("wordWrap")}
			>
				{wordWrap ? <IconTextWrap size={iconSize} /> : <IconTextWrapDisabled size={iconSize} />}
			</ActionIcon>
		</Tooltip>
	);

	const wrapStyle: CSSProperties = wordWrap
		? { whiteSpace: "pre-wrap", wordBreak: "break-all" }
		: { whiteSpace: "pre", overflowX: "auto" };

	return (
		<>
			<Box
				pos="relative"
				onMouseEnter={isMobile ? undefined : () => setHovered(true)}
				onMouseLeave={isMobile ? undefined : () => setHovered(false)}
			>
				{/* Desktop: floating overlay on hover */}
				{!isMobile && (
					<Group gap={2} style={hovered ? actionBarVisible : actionBarHidden}>
						{wrapToggle}
						{copyBtn}
						{fullscreenBtn}
					</Group>
				)}

				{/* Inline content */}
				{children ?? (
					<Code block style={{ ...style, ...wrapStyle }}>
						{content}
					</Code>
				)}

				{/* Mobile: always-visible bar below content */}
				{isMobile && (
					<div style={mobileBarStyle}>
						{wrapToggle}
						{copyBtn}
						{fullscreenBtn}
					</div>
				)}
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
							<DiffView oldStr={diff.oldStr} newStr={diff.newStr} maxHeight={undefined} />
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
					<DiffView oldStr={diff.oldStr} newStr={diff.newStr} maxHeight={undefined} />
				) : (
					<Code
						block
						style={{
							...style,
							...wrapStyle,
							maxHeight: undefined,
							overflow: undefined,
							fontSize: isMobile ? 11 : 12,
						}}
					>
						{content}
					</Code>
				)}
			</Modal>
		</>
	);
});
