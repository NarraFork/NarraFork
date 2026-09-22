import { MarkdownContentListItem } from "@frontend/components/common/MarkdownListMarker";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { Code, Divider, Table, Text } from "@mantine/core";
import {
	prepareMarkdownEmphasis,
	remarkStripEmphasisSentinel,
	stripEmphasisSentinel,
} from "@shared/markdown-emphasis-compat";
import { reactChildrenToHeadingText, slugifyHeading } from "@shared/pretext-layout/markdown-anchor";
import {
	Children,
	Component,
	createContext,
	Fragment,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Pluggable, PluggableList } from "unified";
import { hasUnclosedFence, splitStableAndTail } from "../streaming/streaming-markdown-split";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import classes from "./MarkdownContent.module.css";
import { MarkdownLink } from "./MarkdownLink";
import { MermaidDiagram } from "./MermaidDiagram";
import {
	hasMarkdownMath,
	hasUnclosedMath,
	isSafeForFlowtokenAnimation,
	isSafeForFlowtokenTail,
	normalizeMathDelimiters,
} from "./markdown-detection";
import { remarkLocalFileLinks } from "./remark-local-file-links";

export { MD_PATTERN } from "./markdown-detection";

/**
 * Marks the container that bounds ONE markdown body, so a `#heading` click can
 * find its own headings and no one else's.
 *
 * Needed because the streaming renderer splits a message into a memoised prefix
 * tree and an active tail tree; both are children of this single root, so the
 * scope stays whole while the split moves. Resolved via `closest` at click time
 * rather than passed down, since the component map is built once at module level.
 */
const MD_ROOT_ATTR = "data-md-body";

/**
 * Carries the live `streaming` flag down to the markdown `code` renderer so the
 * mermaid block can decide whether to render a diagram. During streaming the
 * fenced source is still incomplete, so calling mermaid.render on it would throw
 * and flash errors — we keep showing it as a plain code block until streaming ends.
 */
export const MermaidStreamingCtx = createContext(false);

/**
 * Render a ```mermaid block as a diagram, or — while still streaming — as a
 * normal code block (incomplete syntax must not reach mermaid.render).
 *
 * While streaming we use a plain Mantine <Code block> instead of
 * MarkdownCodeBlock: the latter lazy-loads Shiki and re-highlights on every
 * token, so its Suspense fallback flickers between plain and highlighted text
 * as the fence grows. A plain code block has no async highlight and stays
 * visually stable until streaming ends and the real diagram renders.
 */
function MermaidOrCode({ code }: { code: string }) {
	const streaming = useContext(MermaidStreamingCtx);
	// Track whether this diagram ever streamed live in this session. A diagram
	// that appeared during streaming defaults to "actual" (tall) size so the
	// user sees the fresh result at full height; diagrams loaded non-streaming
	// (page refresh / history) default to "fit" (compact) to keep scrollback tidy.
	const streamedRef = useRef(false);
	if (streaming) streamedRef.current = true;

	if (streaming) {
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
				{code}
			</Code>
		);
	}
	return <MermaidDiagram code={code} defaultSizeMode={streamedRef.current ? "actual" : "fit"} />;
}

/** Recursively extract plain text from React children */
export function extractText(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number")
		return stripEmphasisSentinel(String(node));
	if (Array.isArray(node)) return node.map(extractText).join("");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	if (typeof node === "object" && "props" in node) return extractText((node as any).props.children);
	return "";
}

interface MathPlugins {
	remarkMath: Pluggable;
	rehypeKatex: Pluggable;
}

let mathPluginsPromise: Promise<MathPlugins | null> | null = null;

function loadMathPlugins(): Promise<MathPlugins | null> {
	if (!mathPluginsPromise) {
		mathPluginsPromise = Promise.all([
			import("remark-math"),
			import("rehype-katex"),
			import("katex/dist/katex.min.css"),
		])
			.then(([remarkMathModule, rehypeKatexModule]) => ({
				remarkMath: remarkMathModule.default as Pluggable,
				rehypeKatex: rehypeKatexModule.default as Pluggable,
			}))
			.catch(() => {
				mathPluginsPromise = null;
				return null;
			});
	}

	return mathPluginsPromise;
}

function useMathPlugins(enabled: boolean): MathPlugins | null {
	const [plugins, setPlugins] = useState<MathPlugins | null>(null);

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;
		loadMathPlugins().then((loadedPlugins) => {
			if (!cancelled) setPlugins(loadedPlugins);
		});

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return enabled ? plugins : null;
}

/** Detect box-drawing / ASCII-art diagram characters that should never be word-wrapped */
const DIAGRAM_PATTERN =
	/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┘├┤┬┴┼╋╔╗╚╝╠╣╦╩╬║═╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫]|[┌┐└┘├┤┬┴┼│─]|[╭╮╯╰]|[+\-|]{3,}.*[+\-|]{3,}/;

// biome-ignore lint/suspicious/noExplicitAny: flowtoken animateText signature
type AnimateTextFn = (children: any) => any;

/**
 * Build react-markdown component overrides using Mantine components.
 * When `animateText` is provided (streaming mode), text children are wrapped
 * with flowtoken's animation. Otherwise children render as-is.
 */
function createMdComponents(animateText?: AnimateTextFn, sourceLines = false): Components {
	const at = animateText ?? ((c: ReactNode) => c);

	/**
	 * Opt-in source-line anchoring (file-editor split preview): block elements
	 * get `data-line="<0-based source line>"` so the editor↔preview scroll sync
	 * can interpolate real line numbers instead of guessing from total heights.
	 * Off for chat bodies — they mount hundreds of trees with no use for it.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: react-markdown hast node shape
	const sourceLineAttr = (node: any): { "data-line"?: string } => {
		const line = sourceLines ? node?.position?.start?.line : undefined;
		return typeof line === "number" ? { "data-line": String(line - 1) } : {};
	};

	// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
	function headingComponent({ children, node }: any) {
		const tag = (node?.tagName ?? "h3") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
		const Tag = tag;
		const sourceLine = sourceLineAttr(node);
		// The slug a `[x](#…)` link in the same body resolves against. Read off the
		// RENDERED children rather than the source, so a heading containing a link
		// slugs its visible label instead of the destination url.
		//
		// `reactChildrenToHeadingText` rather than this file's `extractText`: the same
		// markdown must advertise the same slug in the prepared (vlist) renderer, and
		// the two walks disagreed on images and math. It lives beside
		// `inlineTokensToPlainText` so the agreement is testable in one place.
		//
		// Carried in a data attribute, not `id`: the narrator message list mounts
		// hundreds of independent markdown bodies into one document and several
		// legitimately repeat a heading, which as ids would be duplicates.
		const slug = slugifyHeading(reactChildrenToHeadingText(children));
		return (
			<Tag {...sourceLine} {...(slug ? { [MD_HEADING_SLUG_ATTR]: slug } : {})}>
				{at(children)}
			</Tag>
		);
	}

	return {
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		p({ children, node }: any) {
			const sourceLine = sourceLineAttr(node);
			const text = extractText(children);
			const isDiagram = DIAGRAM_PATTERN.test(text);
			return (
				<p {...sourceLine} className={isDiagram ? classes.mdDiagram : undefined}>
					{isDiagram ? children : at(children)}
				</p>
			);
		},
		h1: headingComponent,
		h2: headingComponent,
		h3: headingComponent,
		h4: headingComponent,
		h5: headingComponent,
		h6: headingComponent,
		ul({ children }) {
			return <ul>{children}</ul>;
		},
		ol({ children }) {
			return <ol>{children}</ol>;
		},
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		li({ children, className, node }: any) {
			const sourceLine = sourceLineAttr(node);
			return (
				<MarkdownContentListItem className={className} dataLine={sourceLine["data-line"]}>
					{at(children)}
				</MarkdownContentListItem>
			);
		},
		a({ href, children, title }) {
			return (
				<MarkdownLink
					href={href}
					labelText={extractText(children)}
					linkClassName={classes.mdLink}
					title={title}
				>
					{at(children)}
				</MarkdownLink>
			);
		},
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		blockquote({ children, node }: any) {
			const sourceLine = sourceLineAttr(node);
			return (
				<blockquote {...sourceLine} className={classes.mdQuote}>
					{children}
				</blockquote>
			);
		},
		// Code blocks: no text animation — code content should not be split/animated
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		code({ children, className, node }: any) {
			const sourceLine = sourceLineAttr(node);
			const lang = className?.replace("language-", "");
			const isBlock = className?.startsWith("language-");
			if (isBlock) {
				const text = extractText(children);
				// Mermaid fenced blocks render as diagrams (checked before the ASCII
				// diagram heuristic, since mermaid sources can contain arrow glyphs).
				if (lang === "mermaid") {
					return <MermaidOrCode code={text} />;
				}
				const isDiagram = DIAGRAM_PATTERN.test(text);
				if (isDiagram) {
					return (
						<Code
							{...sourceLine}
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
				return (
					<MarkdownCodeBlock language={lang ?? "text"} dataLine={sourceLine["data-line"]}>
						{children}
					</MarkdownCodeBlock>
				);
			}
			return <code className={classes.mdCode}>{children}</code>;
		},
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		pre({ children, node }: any) {
			// For fenced code blocks without a language tag, react-markdown renders
			// <pre><code>...</code></pre> where the inner <code> has no className.
			// Detect diagram content and force no-wrap on those blocks.
			// Otherwise wrap in MarkdownCodeBlock for copy button + consistent styling.
			const sourceLine = sourceLineAttr(node);
			const text = extractText(children);
			const isDiagram = DIAGRAM_PATTERN.test(text);
			if (isDiagram) {
				return (
					<Code
						{...sourceLine}
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
			// react-markdown renders fenced blocks as <pre><code class="language-x">…>.
			// The inner <code> child is our own `code` component (see above), which has
			// already produced the right element — a MermaidDiagram for ```mermaid, an
			// ASCII <Code> for box-drawing art, or a MarkdownCodeBlock otherwise. We must
			// NOT re-wrap it: comparing `child.type === MarkdownCodeBlock` never matches
			// (the child's type is the `code` component function, not its return value),
			// so the old check always fell through and flattened every block — including
			// mermaid — back into a plain language="text" code block.
			//
			// Detect a fenced code child via its `language-*` className and pass it
			// through untouched. Only genuinely bare children (no code element) get
			// wrapped in MarkdownCodeBlock here.
			const firstChild = Array.isArray(children) ? children[0] : children;
			const childClassName =
				firstChild && typeof firstChild === "object" && "props" in firstChild
					? // biome-ignore lint/suspicious/noExplicitAny: react-markdown child element
						((firstChild as any).props?.className as string | undefined)
					: undefined;
			if (typeof childClassName === "string" && childClassName.startsWith("language-")) {
				return <>{children}</>;
			}
			return (
				<MarkdownCodeBlock language="text" dataLine={sourceLine["data-line"]}>
					{text}
				</MarkdownCodeBlock>
			);
		},
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		hr({ node }: any) {
			const sourceLine = sourceLineAttr(node);
			return <Divider {...sourceLine} my={4} />;
		},
		// biome-ignore lint/suspicious/noExplicitAny: react-markdown node structure
		table({ children, node }: any) {
			const sourceLine = sourceLineAttr(node);
			return (
				<div {...sourceLine} style={{ maxWidth: "100%", overflowX: "auto" }}>
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
			return <Table.Th>{at(children)}</Table.Th>;
		},
		td({ children }) {
			return <Table.Td>{at(children)}</Table.Td>;
		},
		strong({ children }) {
			return <strong>{at(children)}</strong>;
		},
		em({ children }) {
			return <em>{at(children)}</em>;
		},
	};
}

/** Static components (no animation) — created once at module level */
const staticComponents = createMdComponents();
/** Same components with data-line anchors — the split preview's scroll-sync variant. */
const staticSourceLineComponents = createMdComponents(undefined, true);

/**
 * Lightweight replacement for flowtoken's optional streaming animation.
 * Keeping this local avoids importing flowtoken's Prism language registry into
 * every narrator route; code highlighting remains handled by the Shiki loader.
 */
export interface MarkdownTextSegment {
	/** Stable for append-only streams because it is anchored to the code-unit offset. */
	id: string;
	text: string;
	start: number;
	end: number;
}

type GraphemeSegmenter = {
	segment(text: string): Iterable<{ segment: string; index: number }>;
};

let graphemeSegmenter: GraphemeSegmenter | null | undefined;

function getGraphemeSegmenter(): GraphemeSegmenter | null {
	if (graphemeSegmenter !== undefined) return graphemeSegmenter;
	try {
		if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
			graphemeSegmenter = null;
			return graphemeSegmenter;
		}
		graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	} catch {
		// Older WebViews may expose Intl but not Segmenter. Array.from below still
		// keeps surrogate pairs together and is a safe, deterministic fallback.
		graphemeSegmenter = null;
	}
	return graphemeSegmenter;
}

/** Split streamed text at grapheme boundaries, with a code-point fallback. */
export function segmentMarkdownText(text: string): MarkdownTextSegment[] {
	const segmenter = getGraphemeSegmenter();
	if (segmenter) {
		return Array.from(segmenter.segment(text), ({ segment, index }) => ({
			id: `segment-${index}`,
			text: segment,
			start: index,
			end: index + segment.length,
		}));
	}

	const segments: MarkdownTextSegment[] = [];
	let offset = 0;
	for (const segment of Array.from(text)) {
		segments.push({
			id: `segment-${offset}`,
			text: segment,
			start: offset,
			end: offset + segment.length,
		});
		offset += segment.length;
	}
	return segments;
}

function commonPrefixLength(previous: string, next: string): number {
	const limit = Math.min(previous.length, next.length);
	let offset = 0;
	while (offset < limit && previous.charCodeAt(offset) === next.charCodeAt(offset)) offset++;
	return offset;
}

function isWhitespaceSegment(segment: MarkdownTextSegment): boolean {
	return /^\s+$/u.test(segment.text);
}

/**
 * Stateful text leaf used by the streaming markdown renderer. Existing grapheme
 * nodes keep their offset-based keys while only the appended suffix receives the
 * animation class. This is important for a word that is still being typed and
 * for CJK text, where there may be no whitespace boundary at all.
 */
export const AnimatedMarkdownText = memo(function AnimatedMarkdownText({ text }: { text: string }) {
	const previousTextRef = useRef<string | null>(null);
	const previousText = previousTextRef.current;
	const animationBoundary =
		previousText === null
			? 0
			: text.startsWith(previousText)
				? previousText.length
				: commonPrefixLength(previousText, text);
	const segments = segmentMarkdownText(text);

	// Updating this during render keeps the append boundary correct even when a
	// parent re-renders several stream deltas before effects flush.
	previousTextRef.current = text;

	return (
		<>
			{segments.map((segment) => {
				if (isWhitespaceSegment(segment)) {
					return <Fragment key={segment.id}>{segment.text}</Fragment>;
				}
				const isNew = segment.end > animationBoundary;
				return (
					<span
						key={segment.id}
						className={isNew ? classes.animatedWord : undefined}
						data-markdown-segment-id={segment.id}
						{...(isNew ? { "data-markdown-segment-new": "true" } : {})}
					>
						{segment.text}
					</span>
				);
			})}
		</>
	);
});

function animateText(children: ReactNode): ReactNode {
	if (Array.isArray(children)) {
		// Also key the new animated text leaves between autolink elements.
		return Children.map(children, (child) => animateText(child));
	}
	if (typeof children !== "string") return children;
	return <AnimatedMarkdownText text={children} />;
}

const animatedComponents = createMdComponents(animateText);

function AnimatedMarkdownTree({
	source,
	remarkPlugins,
	rehypePlugins,
}: {
	source: string;
	remarkPlugins: PluggableList;
	rehypePlugins: PluggableList;
}) {
	return (
		<Markdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={animatedComponents}
		>
			{prepareMarkdownEmphasis(source)}
		</Markdown>
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

const STREAMING_ANIM_MAX_CHARS = 4_000;
const STREAMING_MARKDOWN_MAX_CHARS = 12_000;
const STATIC_MARKDOWN_MAX_CHARS = 80_000;

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
// Static markdown tree (no wrapper element)
// ---------------------------------------------------------------------------

/**
 * Renders one markdown string with react-markdown + our Mantine components.
 * Emits ONLY the react-markdown output (a Fragment of block elements) with no
 * wrapping div, so a caller can place several of these as direct children of a
 * single `.root` container and have block spacing behave exactly as if the
 * whole document were rendered once (see the split renderer below).
 */
function StaticMarkdownTree({
	source,
	remarkPlugins,
	rehypePlugins,
	sourceLines,
}: {
	source: string;
	remarkPlugins: PluggableList;
	rehypePlugins: PluggableList;
	sourceLines?: boolean;
}) {
	// Prepare here (not on the whole streaming message) so `splitStableAndTail`
	// sees append-only source text: an open-side flank insert must not rewrite
	// bytes a sealed prefix already matched against.
	return (
		<Markdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={sourceLines ? staticSourceLineComponents : staticComponents}
		>
			{prepareMarkdownEmphasis(source)}
		</Markdown>
	);
}

/**
 * Sealed leading blocks of a streaming message. Memoised on the prefix string
 * so that — while the tail keeps growing every frame — this subtree is skipped
 * entirely by React (no re-render, no reflow). The prefix is append-only, so a
 * new string only ever means "more sealed blocks", never a rewrite of old ones.
 */
const StablePrefixMarkdown = memo(function StablePrefixMarkdown({
	source,
	remarkPlugins,
	rehypePlugins,
}: {
	source: string;
	remarkPlugins: PluggableList;
	rehypePlugins: PluggableList;
}) {
	return (
		<StaticMarkdownTree
			source={source}
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
		/>
	);
});

/**
 * The active (still-streaming) tail of a message. Re-rendered every frame, but
 * the tail is short (at most the last couple of blocks), so its parse+render
 * cost is bounded and constant instead of growing with the whole message.
 *
 * Animates the tail with flowtoken when it is safe to (advanced-anim on, no raw
 * HTML/math, no unclosed fence); otherwise renders it statically.
 */
function ActiveTailMarkdown({
	source,
	animate,
	remarkPlugins,
	rehypePlugins,
}: {
	source: string;
	animate: boolean;
	remarkPlugins: PluggableList;
	rehypePlugins: PluggableList;
}) {
	if (animate) {
		return (
			<AnimatedMarkdownTree
				source={source}
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
			/>
		);
	}
	return (
		<StaticMarkdownTree
			source={source}
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
		/>
	);
}

/**
 * Streaming split renderer: keeps a stable, memoised prefix on top and an active
 * tail below, both as direct children of the SAME `.root` container so block
 * spacing across the boundary matches single-pass rendering (no reflow when a
 * block "graduates" from tail to prefix).
 */
function StreamingSplitMarkdown({
	text,
	wordWrap,
	tailAnimate,
	remarkPlugins,
	rehypePlugins,
}: {
	text: string;
	wordWrap: boolean;
	tailAnimate: boolean;
	remarkPlugins: PluggableList;
	rehypePlugins: PluggableList;
}) {
	// Remember the last stable prefix so the split stays monotonic (append-only):
	// the prefix can only grow, never retreat, so already-rendered blocks above
	// never jitter. Reset is handled inside splitStableAndTail.
	const prevPrefixRef = useRef("");
	const { stablePrefix, tail } = splitStableAndTail(text, prevPrefixRef.current);
	prevPrefixRef.current = stablePrefix;

	// Only animate the tail when it carries no unclosed fence AND no half-written
	// formula this frame. Feeding an incomplete `$…` to katex flashes a parse error,
	// so those frames fall back to a static render until the formula closes.
	const animateTail = tailAnimate && !hasUnclosedFence(tail) && !hasUnclosedMath(tail);

	return (
		<div {...{ [MD_ROOT_ATTR]: "" }} className={wordWrap ? classes.root : classes.rootNoWrap}>
			{stablePrefix && (
				<StablePrefixMarkdown
					source={stablePrefix}
					remarkPlugins={remarkPlugins}
					rehypePlugins={rehypePlugins}
				/>
			)}
			{tail && (
				<ActiveTailMarkdown
					source={tail}
					animate={animateTail}
					remarkPlugins={remarkPlugins}
					rehypePlugins={rehypePlugins}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// MarkdownContent component
// ---------------------------------------------------------------------------

interface MarkdownContentProps {
	text: string;
	/** When false, disable word-wrap so long lines scroll horizontally. Defaults to true. */
	wordWrap?: boolean;
	/** Whether this content is currently being streamed (enables per-word animation) */
	streaming?: boolean;
	/** Stamp `data-line` source anchors on block elements (split-preview scroll sync). */
	sourceLines?: boolean;
}

export const MarkdownContent = memo(function MarkdownContent({
	text,
	wordWrap = true,
	streaming,
	sourceLines,
}: MarkdownContentProps) {
	const trimmed = text.trim();

	const canAnimateStreaming = !!streaming && trimmed.length <= STREAMING_ANIM_MAX_CHARS;
	const advancedAnim =
		canAnimateStreaming &&
		typeof document !== "undefined" &&
		document.documentElement.getAttribute("data-advanced-anim") === "true";

	// Whole-text plain animation (legacy fast path): the entire message is plain
	// text short enough to animate as-is, with no markdown structure at all.
	const shouldAnimate =
		canAnimateStreaming &&
		advancedAnim &&
		supportsLookbehind &&
		isSafeForFlowtokenAnimation(trimmed);

	const tooLargeForMarkdown = trimmed.length > STATIC_MARKDOWN_MAX_CHARS;
	const streamingTooLarge = !!streaming && trimmed.length > STREAMING_MARKDOWN_MAX_CHARS;

	// Streaming split path: while streaming a markdown message that is not the
	// tiny plain-text animate case, seal completed leading blocks and only
	// re-render the growing tail.
	//
	// Math used to disable splitting for the WHOLE message, so any answer
	// containing a formula re-parsed its entire text every frame. remark-math is a
	// per-block tokenizer (there is no cross-block katex state to lose), so math
	// only needs two narrower guards, both applied where they belong:
	//   - splitStableAndTail never cuts inside an unclosed `$$…$$`;
	//   - the tail does not animate while a formula is still being written.
	const hasMath = hasMarkdownMath(trimmed);
	const usesSplitStreaming =
		!!streaming && !shouldAnimate && !streamingTooLarge && !tooLargeForMarkdown;

	// Math plugins are needed by the static path AND by the split path (both the
	// sealed prefix and the active tail render formulas).
	const usesStaticMarkdown = !tooLargeForMarkdown && !streamingTooLarge && !shouldAnimate;
	const mathPlugins = useMathPlugins((usesStaticMarkdown || usesSplitStreaming) && hasMath);
	const remarkPlugins = useMemo<PluggableList>(() => {
		const plugins: PluggableList = supportsLookbehind ? [remarkGfm] : [];
		if (mathPlugins) plugins.push(mathPlugins.remarkMath);
		plugins.push(remarkLocalFileLinks);
		plugins.push(remarkStripEmphasisSentinel);
		return plugins;
	}, [mathPlugins]);
	const rehypePlugins = useMemo<PluggableList>(() => {
		return mathPlugins ? [mathPlugins.rehypeKatex] : [];
	}, [mathPlugins]);

	// Rewrite `\(...\)` / `\[...\]` to `$...$` / `$$...$$` so remark-math can
	// parse formulas emitted by models that use backslash-delimited LaTeX.
	// Only run when math plugins are active to avoid touching non-math content.
	//
	// Emphasis flanking (`prepareMarkdownEmphasis`) is applied per parse tree in
	// Static/AnimatedMarkdownTree, NOT here: the streaming split must see
	// append-only source, and an open-side flank insert would rewrite history.
	// The remark plugin above strips the flank sentinels from text nodes.
	const markdownSource = useMemo(
		() => (mathPlugins ? normalizeMathDelimiters(trimmed) : trimmed),
		[mathPlugins, trimmed],
	);

	// Whether the tail may animate: advanced-anim on, lookbehind support, and the
	// relaxed tail-safety check (allows markdown, blocks raw HTML). Math is allowed
	// here — flowtoken receives the katex plugins like every other renderer — but
	// StreamingSplitMarkdown additionally refuses to animate a frame whose tail
	// holds a half-written formula.
	const tailAnimate =
		!!streaming &&
		advancedAnim &&
		supportsLookbehind &&
		trimmed.length <= STREAMING_ANIM_MAX_CHARS &&
		isSafeForFlowtokenTail(trimmed);

	const plainFallback = (
		<Text
			size="sm"
			style={wordWrap ? { whiteSpace: "pre-wrap" } : { whiteSpace: "pre", overflowX: "auto" }}
		>
			{trimmed}
		</Text>
	);

	if (streamingTooLarge || tooLargeForMarkdown) {
		return plainFallback;
	}

	// Streaming mode (whole-text plain animation): AnimatedMarkdown for the entire
	// short plain-text message with flowtoken's per-word blur-in.
	if (shouldAnimate) {
		return (
			<MarkdownErrorBoundary fallback={plainFallback}>
				<MermaidStreamingCtx.Provider value={true}>
					<div {...{ [MD_ROOT_ATTR]: "" }} className={wordWrap ? classes.root : classes.rootNoWrap}>
						<AnimatedMarkdownTree
							source={trimmed}
							remarkPlugins={remarkPlugins}
							rehypePlugins={rehypePlugins}
						/>
					</div>
				</MermaidStreamingCtx.Provider>
			</MarkdownErrorBoundary>
		);
	}

	// Streaming split mode: memoised stable prefix + active tail (see above).
	if (usesSplitStreaming) {
		return (
			<MarkdownErrorBoundary fallback={plainFallback}>
				<MermaidStreamingCtx.Provider value={true}>
					<StreamingSplitMarkdown
						// Normalized so `\(…\)` / `\[…\]` formulas render on this path too.
						// Rewriting is length-preserving per delimiter pair only for the
						// dollar forms, but the split is recomputed from this same string
						// every frame, so prefix monotonicity is unaffected.
						text={markdownSource}
						wordWrap={wordWrap}
						tailAnimate={tailAnimate}
						remarkPlugins={remarkPlugins}
						rehypePlugins={rehypePlugins}
					/>
				</MermaidStreamingCtx.Provider>
			</MarkdownErrorBoundary>
		);
	}

	// Static mode: react-markdown with the same Mantine components (no animation).
	// `streaming` can still be true here (e.g. a mermaid fence, or a math message),
	// so we forward the real streaming flag (incomplete fence shown as code).
	return (
		<MarkdownErrorBoundary fallback={plainFallback}>
			<MermaidStreamingCtx.Provider value={!!streaming}>
				<div {...{ [MD_ROOT_ATTR]: "" }} className={wordWrap ? classes.root : classes.rootNoWrap}>
					<StaticMarkdownTree
						source={markdownSource}
						remarkPlugins={remarkPlugins}
						rehypePlugins={rehypePlugins}
						sourceLines={sourceLines}
					/>
				</div>
			</MermaidStreamingCtx.Provider>
		</MarkdownErrorBoundary>
	);
});
