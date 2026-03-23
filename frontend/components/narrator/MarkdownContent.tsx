import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from "@mantine/core";
import { Component, memo, type ReactNode, useEffect, useMemo, useRef } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import classes from "./MarkdownContent.module.css";
import { useStreamingReveal } from "./StreamingRevealContext";

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

// ---------------------------------------------------------------------------
// Streaming inline-element blur-in reveal
// ---------------------------------------------------------------------------

/**
 * Mutable counter threaded through the react-markdown component tree.
 * Tracks a character offset from the start of the document; inline elements
 * whose text falls entirely within the trailing `freshStart..totalLen` range
 * get the blur-in animation.
 */
interface RevealState {
	/** Character offset consumed so far (incremented as we visit elements) */
	offset: number;
	/** Characters before this offset are "stable" (no animation) */
	freshStart: number;
}

/** Count plain-text characters inside a ReactNode tree. */
function textLen(node: ReactNode): number {
	return extractText(node).length;
}

/**
 * Wrap `children` in a `.nf-inline-in` span if the element's text range
 * falls within the fresh (newly-arrived) portion of the stream.
 * Advances `state.offset` by the text length of `children`.
 */
function maybeWrapInline(children: ReactNode, state: RevealState): ReactNode {
	const len = textLen(children);
	const start = state.offset;
	state.offset += len;
	if (len === 0 || start < state.freshStart) return children;
	return (
		<span className="nf-inline-in" key="reveal">
			{children}
		</span>
	);
}

/**
 * Build streaming-aware `Components` that apply blur-in only to inline
 * elements whose text falls after `freshStart` in the document.
 *
 * The returned components reset the mutable offset counter on every call
 * to each component function, but the offset is scoped to a single
 * react-markdown render pass.  To be safe under React StrictMode (which
 * may invoke the render twice), callers should create a **new** Components
 * object for every render via `useMemo` keyed on `freshStart`.
 */
function buildStreamingComponents(freshStart: number): Components {
	// Each react-markdown render pass gets its own mutable state.
	// Because we create a new Components object per render (via useMemo
	// with changing deps), StrictMode double-renders each get a fresh state.
	const state: RevealState = { offset: 0, freshStart };
	return {
		...mdComponents,
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
					{maybeWrapInline(children, state)}
				</Text>
			);
		},
		li({ children }) {
			return <List.Item style={{ margin: 0 }}>{maybeWrapInline(children, state)}</List.Item>;
		},
		strong({ children }) {
			return (
				<Text span fw={700} size="sm">
					{maybeWrapInline(children, state)}
				</Text>
			);
		},
		em({ children }) {
			return (
				<Text span fs="italic" size="sm">
					{maybeWrapInline(children, state)}
				</Text>
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
			// Inline code — apply reveal animation
			return <Code fz="xs">{maybeWrapInline(children, state)}</Code>;
		},
		a({ href, children }) {
			return (
				<Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
					{maybeWrapInline(children, state)}
				</Anchor>
			);
		},
	};
}

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
			<Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
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
		return <Code fz="xs">{children}</Code>;
	},
	pre({ children }) {
		// For fenced code blocks without a language tag, react-markdown renders
		// <pre><code>…</code></pre> where the inner <code> has no className.
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
 * which throws in Safari < 16.4 / older iOS WebKit.  When unsupported we skip
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
	const { newCharCount, justBecameMd } = useStreamingReveal();

	// Track the previous isMd state so we know the stable text length
	// at the moment markdown was first detected.  When isMd flips to true,
	// everything that was already rendered as plain text is "stable" and
	// should not get the blur-in animation.
	//
	// Refs are updated in useEffect (after commit) to stay safe under
	// React StrictMode / Concurrent Mode.
	const prevIsMdRef = useRef(isMd);
	const stableLenRef = useRef(0);

	// Derive stableLen for the *current* render from committed ref values.
	// The refs reflect the state from the previous committed render.
	const stableLen = useMemo(() => {
		if (isMd && !prevIsMdRef.current) {
			// Transition frame: all existing text is stable
			return trimmed.length - newCharCount;
		}
		if (!isMd) return 0;
		return stableLenRef.current;
	}, [isMd, trimmed.length, newCharCount]);

	// Commit ref updates after render so they're ready for the next pass.
	useEffect(() => {
		prevIsMdRef.current = isMd;
		stableLenRef.current = stableLen;
	});

	// Build streaming components for the markdown path.
	// freshStart = character offset where "new" text begins.
	const freshStart = justBecameMd
		? stableLen
		: newCharCount > 0
			? trimmed.length - newCharCount
			: trimmed.length;

	// Create new Components per render when streaming is active.
	// buildStreamingComponents creates its own mutable offset state internally,
	// so each render (including StrictMode double-renders) gets a fresh counter.
	const streamingComps = useMemo(() => {
		if (newCharCount <= 0 && !justBecameMd) return null;
		return buildStreamingComponents(freshStart);
	}, [newCharCount, justBecameMd, freshStart]);

	if (!isMd) {
		// Plain text path — wrap only the newly-arrived tail in a blur-in span
		if (newCharCount > 0 && trimmed.length > 0) {
			const take = Math.min(newCharCount, trimmed.length);
			const stable = trimmed.slice(0, trimmed.length - take);
			const fresh = trimmed.slice(trimmed.length - take);
			return (
				<Text
					size="sm"
					style={wordWrap ? { whiteSpace: "pre-wrap" } : { whiteSpace: "pre", overflowX: "auto" }}
				>
					{stable}
					<span className="nf-inline-in">{fresh}</span>
				</Text>
			);
		}
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
				<Markdown remarkPlugins={remarkPlugins} components={streamingComps ?? mdComponents}>
					{trimmed}
				</Markdown>
			</div>
		</MarkdownErrorBoundary>
	);
});
