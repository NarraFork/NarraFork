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

interface MarkdownCodeBlockProps {
	language: string;
	children: ReactNode;
}

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
	language,
	children,
}: MarkdownCodeBlockProps) {
	const { t } = useTranslation("common");
	const code = extractText(children).replace(/\n$/, "");

	const hasLang = language && language !== "text";
	const className = hasLang
		? `${classes.codeBlock} ${classes.codeBlockWithLang}`
		: classes.codeBlock;

	return (
		<div className={className}>
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
						{code}
					</Code>
				}
			>
				<HighlightedCode code={code} lang={language} style={{ maxWidth: "100%", border: "none" }} />
			</Suspense>
		</div>
	);
});
