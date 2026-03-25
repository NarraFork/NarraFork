import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from "@mantine/core";
import { Component, memo, type ReactNode, useLayoutEffect, useRef } from "react";
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

// ---------------------------------------------------------------------------
// Streaming per-character blur-in animation hook
// ---------------------------------------------------------------------------

const CHAR_IN_CLASS = "nf-char-in";

/**
 * Count total visible text characters inside a DOM subtree by walking all
 * TEXT_NODE children. Skips nodes inside <code>/<pre> blocks.
 */
function countTextChars(root: HTMLElement): number {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (parent?.closest("pre, code")) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let count = 0;
	while (walker.nextNode()) {
		count += (walker.currentNode as globalThis.Text).length;
	}
	return count;
}

/**
 * Walk text nodes and wrap the last `newCount` characters in animated spans.
 * Returns the number of characters actually wrapped (may be less if DOM is
 * shorter than expected due to markdown re-parsing).
 */
function wrapNewChars(root: HTMLElement, newCount: number): number {
	// Collect all eligible text nodes
	const textNodes: globalThis.Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (parent?.closest("pre, code")) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as globalThis.Text);
	}

	// Total chars across all text nodes
	let totalChars = 0;
	for (const tn of textNodes) totalChars += tn.length;

	// The boundary: chars before this index are "old", after are "new"
	const boundary = totalChars - newCount;
	if (boundary < 0) return totalChars; // everything is new

	let charsSoFar = 0;
	let wrapped = 0;

	for (const textNode of textNodes) {
		const nodeLen = textNode.length;
		const nodeEnd = charsSoFar + nodeLen;

		if (nodeEnd <= boundary) {
			// Entirely old — skip
			charsSoFar = nodeEnd;
			continue;
		}

		// How many chars in this node are old vs new
		const oldInNode = Math.max(0, boundary - charsSoFar);
		const newText = textNode.textContent?.slice(oldInNode) ?? "";

		if (!newText) {
			charsSoFar = nodeEnd;
			continue;
		}

		// Split: keep old part as-is, wrap new part in animated span
		const parent = textNode.parentNode;
		if (!parent) {
			charsSoFar = nodeEnd;
			continue;
		}

		if (oldInNode > 0) {
			// Split the text node: [old part] | [new part]
			const newNode = textNode.splitText(oldInNode);
			const span = document.createElement("span");
			span.className = CHAR_IN_CLASS;
			parent.replaceChild(span, newNode);
			span.appendChild(newNode);
		} else {
			// Entire node is new
			const span = document.createElement("span");
			span.className = CHAR_IN_CLASS;
			parent.replaceChild(span, textNode);
			span.appendChild(textNode);
		}

		wrapped += newText.length;
		charsSoFar = nodeEnd;
	}

	return wrapped;
}

/**
 * Remove all animated spans: unwrap their text content back into the parent.
 */
function cleanupAnimSpans(root: HTMLElement) {
	const spans = root.querySelectorAll(`.${CHAR_IN_CLASS}`);
	for (const span of spans) {
		const parent = span.parentNode;
		if (!parent) continue;
		while (span.firstChild) {
			parent.insertBefore(span.firstChild, span);
		}
		parent.removeChild(span);
		parent.normalize(); // merge adjacent text nodes
	}
}

/**
 * Hook that applies per-character blur-in animation to newly streamed text.
 *
 * On each render where `streaming` is true, it compares the current DOM text
 * length against the previously recorded length and wraps only the delta
 * characters in `<span class="nf-char-in">`. When the animation finishes
 * (or on the next tick), the spans are cleaned up to avoid DOM bloat.
 */
function useStreamingCharAnim(
	containerRef: React.RefObject<HTMLElement | null>,
	streaming: boolean | undefined,
) {
	const prevLenRef = useRef(0);
	const cleanupTimerRef = useRef(0);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el || !streaming) {
			// Reset when streaming stops
			if (!streaming) {
				prevLenRef.current = 0;
				if (el) cleanupAnimSpans(el);
			}
			return;
		}

		// Clean up any leftover spans from the previous tick before measuring
		cleanupAnimSpans(el);

		const currentLen = countTextChars(el);
		const prevLen = prevLenRef.current;
		const delta = currentLen - prevLen;

		if (delta > 0) {
			wrapNewChars(el, delta);

			// Schedule cleanup after animation completes (180ms + small buffer)
			if (cleanupTimerRef.current) cancelAnimationFrame(cleanupTimerRef.current);
			cleanupTimerRef.current = requestAnimationFrame(() => {
				// Use a timeout matching the animation duration
				setTimeout(() => {
					if (containerRef.current) cleanupAnimSpans(containerRef.current);
					cleanupTimerRef.current = 0;
				}, 200);
			});
		}

		prevLenRef.current = currentLen;
	});

	// Cleanup on unmount
	useLayoutEffect(() => {
		return () => {
			if (cleanupTimerRef.current) cancelAnimationFrame(cleanupTimerRef.current);
			const el = containerRef.current;
			if (el) cleanupAnimSpans(el);
		};
	}, [containerRef]);
}

// ---------------------------------------------------------------------------
// MarkdownContent component
// ---------------------------------------------------------------------------

interface MarkdownContentProps {
	text: string;
	/** When false, disable word-wrap so long lines scroll horizontally. Defaults to true. */
	wordWrap?: boolean;
	/** Whether this content is currently being streamed (enables per-char animation) */
	streaming?: boolean;
}

export const MarkdownContent = memo(function MarkdownContent({
	text,
	wordWrap = true,
	streaming,
}: MarkdownContentProps) {
	const trimmed = text.trim();
	const containerRef = useRef<HTMLDivElement>(null);

	useStreamingCharAnim(containerRef, streaming);

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
			<div ref={containerRef} className={wordWrap ? classes.root : classes.rootNoWrap}>
				<Markdown remarkPlugins={remarkPlugins} components={mdComponents}>
					{trimmed}
				</Markdown>
			</div>
		</MarkdownErrorBoundary>
	);
});
