import { Code, Text, TypographyStylesProvider } from "@mantine/core";
import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Patterns that indicate markdown formatting is present
const MD_PATTERN =
	/(?:^#{1,6}\s|(?:^|\n)```|\*\*|__|\*(?!\s)|_(?!\s)|\[.+?\]\(.+?\)|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\||!\[)/m;

function hasMarkdown(text: string): boolean {
	return MD_PATTERN.test(text);
}

const mdComponents: Components = {
	code({ children, className }) {
		const isBlock = className?.startsWith("language-");
		if (isBlock) {
			return (
				<Code block fz="xs">
					{children}
				</Code>
			);
		}
		return <Code fz="xs">{children}</Code>;
	},
	pre({ children }) {
		// react-markdown wraps code blocks in <pre><code>, we handle it in code()
		return <>{children}</>;
	},
};

const remarkPlugins = [remarkGfm];

interface MarkdownContentProps {
	text: string;
}

export const MarkdownContent = memo(function MarkdownContent({ text }: MarkdownContentProps) {
	const isMd = useMemo(() => hasMarkdown(text), [text]);

	if (!isMd) {
		return (
			<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
				{text}
			</Text>
		);
	}

	return (
		<TypographyStylesProvider fz="sm" p={0} m={0}>
			<Markdown remarkPlugins={remarkPlugins} components={mdComponents}>
				{text}
			</Markdown>
		</TypographyStylesProvider>
	);
});
