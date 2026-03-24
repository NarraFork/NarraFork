import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from "@mantine/core";
import { Component, memo, type ReactNode, useMemo } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import classes from "./MarkdownContent.module.css";

/** Recursively extract plain text from React children */
export function extractText(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	if (typeof node === "object" && "props" in node) return extractText((node as any).props.children);
	return "";
}

export const MD_PATTERN =
	/(?:^#{1,6}\s|(?:^|\n)```|\*\*|__|\*(?!\s)|_(?!\s)|\[.+?\]\(.+?\)|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\||!\[)/m;

/** Detect box-drawing / ASCII-art diagram characters that should never be word-wrapped */
const DIAGRAM_PATTERN =
	/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┘├┤┬┴┼╋╔╗╚╝╠╣╦╩╬║═╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫]|[┌┐└┘├┤┬┴┼│─]|[╭╮╯╰]|[+\-|]{3,}.*[+\-|]{3,}/;

function hasMarkdown(text: string): boolean {
	return MD_PATTERN.test(text);
}

const HEADING_ORDER: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
	h1: 1,
	h2: 2,
	h3: 3,
	h4: 4,
	h5: 5,
	h6: 6,
};

const mdComponents: Components = {
	p({ children }) {
		const text = extractText(children);
		const isDiagram = DIAGRAM_PATTERN.test(text);
		return (
			<Text
				size="sm"
				style={{
					marginTop: "0.35em",
					marginBottom: 0,
					...(isDiagram && {
						whiteSpace: "pre",
						overflowX: "auto",
						wordBreak: "normal",
					}),
				}}
			>
				{children}
			</Text>
		);
	},
	h1: heading,
	h2: heading,
	h3: heading,
	h4: heading,
	h5: heading,
	h6: heading,
	ul({ children }) {
		return (
			<List size="sm" type="unordered" style={{ marginTop: "0.35em", marginBottom: 0 }}>
				{children}
			</List>
		);
	},
	ol({ children }) {
		return (
			<List size="sm" type="ordered" style={{ marginTop: "0.35em", marginBottom: 0 }}>
				{children}
			</List>
		);
	},
	li({ children }) {
		return <List.Item style={{ margin: 0 }}>{children}</List.Item>;
	},
	a({ href, children }) {
		return (
			<Anchor
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				size="sm"
				style={{ overflowWrap: "anywhere" }}
			>
				{children}
			</Anchor>
		);
	},
	blockquote({ children }) {
		return (
			<Blockquote p="xs" my={0}>
				{children}
			</Blockquote>
		);
	},
	code({ children, className }) {
		const lang = className?.replace("language-", "");
		const isBlock = className?.startsWith("language-");
		if (isBlock) {
			const text = extractText(children);
			const isDiagram = DIAGRAM_PATTERN.test(text);
			if (isDiagram) {
				return (
					<Code
						block
						fz="xs"
						style={{
							maxWidth: "100%",
							overflowX: "auto",
							whiteSpace: "pre",
							wordBreak: "normal",
						}}
					>
						{children}
					</Code>
				);
			}
			return <MarkdownCodeBlock language={lang ?? "text"}>{children}</MarkdownCodeBlock>;
		}
		return (
			<Code fz="xs" style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>
				{children}
			</Code>
		);
	},
	pre({ children }) {
		// For fenced code blocks without a language tag, react-markdown renders
		// <pre><code>...</code></pre> where the inner <code> has no className.
		// Detect diagram content and force no-wrap on those blocks.
		// Otherwise wrap in MarkdownCodeBlock for copy button + consistent styling.
		const text = extractText(children);
		const isDiagram = DIAGRAM_PATTERN.test(text);
		if (isDiagram) {
			return (
				<Code
					block
					fz="xs"
					style={{
						maxWidth: "100%",
						overflowX: "auto",
						whiteSpace: "pre",
						wordBreak: "normal",
					}}
				>
					{text}
				</Code>
			);
		}
		// If the inner <code> already rendered a MarkdownCodeBlock (has language),
		// just pass through. Otherwise wrap bare code in MarkdownCodeBlock.
		const child = Array.isArray(children) ? children[0] : children;
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown children structure
		const childType = child && typeof child === "object" && (child as any).type;
		if (childType === MarkdownCodeBlock) {
			return <>{children}</>;
		}
		return <MarkdownCodeBlock language="text">{text}</MarkdownCodeBlock>;
	},
	hr() {
		return <Divider my={4} />;
	},
	table({ children }) {
		return (
			<div style={{ maxWidth: "100%", overflowX: "auto" }}>
				<Table fz="sm" striped highlightOnHover style={{ margin: 0 }}>
					{children}
				</Table>
			</div>
		);
	},
	thead({ children }) {
		return <Table.Thead>{children}</Table.Thead>;
	},
	tbody({ children }) {
		return <Table.Tbody>{children}</Table.Tbody>;
	},
	tr({ children }) {
		return <Table.Tr>{children}</Table.Tr>;
	},
	th({ children }) {
		return <Table.Th>{children}</Table.Th>;
	},
	td({ children }) {
		return <Table.Td>{children}</Table.Td>;
	},
	strong({ children }) {
		return (
			<Text span fw={700} size="sm">
				{children}
			</Text>
		);
	},
	em({ children }) {
		return (
			<Text span fs="italic" size="sm">
				{children}
			</Text>
		);
	},
};

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function heading({ children, node }: any) {
	const tag = node?.tagName ?? "h3";
	const order = HEADING_ORDER[tag] ?? 3;
	return (
		<Title order={order} mt="0.4em" mb={0}>
			{children}
		</Title>
	);
}

/**
 * Detect whether the browser supports RegExp lookbehind assertions.
 * `mdast-util-gfm-autolink-literal` (used by remark-gfm) relies on lookbehind
 * which throws in Safari < 16.4 / older iOS WebKit. When unsupported we skip
 * remark-gfm entirely and fall back to plain react-markdown.
 */
const supportsLookbehind = (() => {
	try {
		// biome-ignore lint/complexity/useRegexLiterals: must use constructor so unsupported syntax is caught at runtime
		new RegExp("(?<=a)b");
		return true;
	} catch {
		return false;
	}
})();

const remarkPlugins = supportsLookbehind ? [remarkGfm] : [];

/** Thin error boundary so a remark-gfm regex crash doesn't blank the chat. */
class MarkdownErrorBoundary extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ hasError: boolean }
> {
	state = { hasError: false };
	static getDerivedStateFromError() {
		return { hasError: true };
	}
	render() {
		return this.state.hasError ? this.props.fallback : this.props.children;
	}
}

interface MarkdownContentProps {
	text: string;
	/** When false, disable word-wrap so long lines scroll horizontally. Defaults to true. */
	wordWrap?: boolean;
}

export const MarkdownContent = memo(function MarkdownContent({
	text,
	wordWrap = true,
}: MarkdownContentProps) {
	const trimmed = text.trim();
	const isMd = useMemo(() => hasMarkdown(trimmed), [trimmed]);

	if (!isMd) {
		return (
			<Text
				size="sm"
				style={wordWrap ? { whiteSpace: "pre-wrap" } : { whiteSpace: "pre", overflowX: "auto" }}
			>
				{trimmed}
			</Text>
		);
	}

	const plainFallback = (
		<Text
			size="sm"
			style={wordWrap ? { whiteSpace: "pre-wrap" } : { whiteSpace: "pre", overflowX: "auto" }}
		>
			{trimmed}
		</Text>
	);

	return (
		<MarkdownErrorBoundary fallback={plainFallback}>
			<div className={wordWrap ? classes.root : classes.rootNoWrap}>
				<Markdown remarkPlugins={remarkPlugins} components={mdComponents}>
					{trimmed}
				</Markdown>
			</div>
		</MarkdownErrorBoundary>
	);
});
