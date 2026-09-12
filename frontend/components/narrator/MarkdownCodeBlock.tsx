import { ActionIcon, Code, CopyButton, Text, Tooltip } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { type CSSProperties, lazy, memo, type ReactNode, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { extractText } from "./MarkdownContent";
import classes from "./MarkdownContent.module.css";

const HighlightedCode = lazy(() =>
	import("./HighlightedCode").then((module) => ({ default: module.HighlightedCode })),
);

const fallbackCodeStyle: CSSProperties = {
	maxWidth: "100%",
	border: "none",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	overflowWrap: "break-word",
};

const MAX_MARKDOWN_CODE_RENDER_CHARS = 80_000;

interface MarkdownCodeBlockProps {
	language: string;
	/** 0-based source line, present only when the body opted into scroll-sync anchors. */
	dataLine?: string;
	children: ReactNode;
}

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
	language,
	dataLine,
	children,
}: MarkdownCodeBlockProps) {
	const { t } = useTranslation("common");
	const code = extractText(children).replace(/\n$/, "");
	const displayCode =
		code.length > MAX_MARKDOWN_CODE_RENDER_CHARS
			? `${code.slice(0, MAX_MARKDOWN_CODE_RENDER_CHARS)}\n\n${t("contentViewerTruncated")}`
			: code;

	const hasLang = language && language !== "text";
	const className = hasLang
		? `${classes.codeBlock} ${classes.codeBlockWithLang}`
		: classes.codeBlock;

	return (
		<div className={className} {...(dataLine ? { "data-line": dataLine } : {})}>
			{hasLang && (
				<Text className={classes.codeLang} component="span">
					{language}
				</Text>
			)}

			<div className={classes.codeCopy}>
				<CopyButton value={code}>
					{({ copied, copy }) => (
						<Tooltip label={copied ? t("copied") : t("copy")} withArrow position="left">
							<ActionIcon
								size="xs"
								variant="filled"
								color={copied ? "teal" : "gray"}
								onClick={copy}
								aria-label={copied ? t("copied") : t("copy")}
							>
								<IconCopy size={12} />
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
			</div>

			<Suspense
				fallback={
					<Code block fz="xs" style={fallbackCodeStyle}>
						{displayCode}
					</Code>
				}
			>
				<HighlightedCode
					code={displayCode}
					lang={language}
					style={{ maxWidth: "100%", border: "none" }}
				/>
			</Suspense>
		</div>
	);
});
