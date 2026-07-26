/**
 * RenderMarkdown.tsx — Reference render component + TEMPLATE for all vlist
 * render-*.tsx. It draws a MeasuredElement's prepared blocks using ABSOLUTE
 * positioning at the exact geometry the measure layer computed — no reflow, no
 * DOM measurement for ordinary blocks.
 *
 * The demo (markdown-chat.ts) is the reference: each block is an absolutely
 * positioned box; inline blocks materialize their line ranges via pretext
 * (walkRichInlineLineRanges + materializeRichInlineLineRange) and lay each line
 * out as a flex row of inline-block fragments; code blocks position each line.
 *
 * CRITICAL: fragments must be painted with the SAME font string that was
 * measured (block.fonts[itemIndex]); otherwise the browser rewraps differently
 * and the rendered height diverges from the predicted height.
 *
 * Unpredictable blocks (PreparedUnknownBlock: mermaid / katex / image-unknown)
 * are the SINGLE controlled zero-DOM-measure exception: they render real content
 * and may report their settled height back via `onUnknownHeight` so the list
 * shell can rewrite layout spacers.
 */

import { layoutWithLines } from "@chenglou/pretext";
import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { MEASURE_MARKDOWN_CODE_PADDING } from "../measure/measure-markdown";
import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import type {
	BlockFrame,
	InlineMathFragment,
	MeasuredElement,
	PreparedBlock,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedUnknownBlock,
} from "../prepared-block";
import { CODE_BLOCK_FONT_SIZE, FONT_WEIGHT, MONO_FAMILY } from "../pretext-fonts";
import { useShikiTokens } from "../useShikiTokens";
import { splitTokensByVisualLines } from "../vlist-token-lines";
import "../vlist-markdown.css";
import { CaretFiller } from "./caret-filler";
import { StreamAnimStore, splitFragmentForAnim } from "./stream-token-anim";
import { TokenText } from "./TokenLines";

/**
 * Module-level boundary memory shared by every streaming markdown render. Keyed
 * by `${animKeyBase}:${blockIndex}` so each inline block tracks its own append
 * boundary across the per-frame remounts of the streaming tail. Bounded LRU so
 * a finished stream's keys are eventually evicted (no cross-component cleanup).
 */
const streamAnimStore = new StreamAnimStore();

// Markdown fenced code renders at 11px monospace (settled Shiki parity). Must
// match measure (parse-markdown FONT_MARKDOWN_CODE / CODE_LINE_HEIGHT).
const CODE_FONT = `${FONT_WEIGHT.regular} ${CODE_BLOCK_FONT_SIZE}px ${MONO_FAMILY}`;

/** Lightweight mermaid host — reuses the real MermaidDiagram via dynamic import
 * so the vlist shell never statically depends on the heavy mermaid bundle
 * path at first paint. Failures fall back to a monospaced source box. */
const LazyMermaidDiagram = lazy(() =>
	import("../../MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })),
);

interface RenderMarkdownProps {
	measured: MeasuredElement;
	/**
	 * Fired once the unknown-block subtree settles at a real pixel height.
	 * Only used for PreparedUnknownBlock; ordinary blocks never call this.
	 * The list shell uses it to build height overrides for virtualization.
	 */
	onUnknownHeight?: (height: number) => void;
	/**
	 * When true, newly-appended text in the active (last) line of each inline
	 * block fades in per-grapheme (streaming tail only). Purely visual: uses
	 * compositor-only CSS so block heights are unaffected (zero-DOM contract).
	 */
	animateStreaming?: boolean;
	/** Stable per-element key base (the vlist item's spec.key) for anim memory. */
	animKeyBase?: string;
}

/**
 * Render a measured markdown element. The outer box height equals the predicted
 * height (or an override applied by the shell); children are absolutely
 * positioned inside it.
 */
export function RenderMarkdown({
	measured,
	onUnknownHeight,
	animateStreaming,
	animKeyBase,
}: RenderMarkdownProps) {
	const { blocks, frame, contentWidth } = measured;
	const hostRef = useRef<HTMLDivElement | null>(null);

	// One-shot observe: if any TRULY unpredictable block is present, report the
	// host's real height after paint/layout. ResizeObserver is the controlled
	// exception. Display math is excluded: katex-geometry measures it exactly, so
	// it needs no post-paint correction and must not drag the whole element onto
	// the flowing path.
	const hasUnknown = useMemo(
		() => blocks.some((b) => b.kind === "unknown" && !isExactlyMeasured(b)),
		[blocks],
	);
	useEffect(() => {
		if (!hasUnknown || !onUnknownHeight) return;
		const node = hostRef.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		let last = 0;
		const report = () => {
			const h = node.getBoundingClientRect().height;
			if (!Number.isFinite(h) || h <= 0) return;
			const rounded = Math.round(h);
			if (Math.abs(rounded - last) <= 1) return;
			last = rounded;
			onUnknownHeight(rounded);
		};
		// Initial report after first paint (mermaid may still be loading — RO will re-fire).
		const raf = requestAnimationFrame(report);
		const ro = new ResizeObserver(() => report());
		ro.observe(node);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	}, [hasUnknown, onUnknownHeight]);

	// When any unpredictable block is present, switch the whole host to a
	// simple stacked flow. Absolute frame tops cannot reflow subsequent siblings
	// after a mermaid/katex grows past its placeholder; stacking lets the host
	// settle to the real total height, which the shell then writes back as an
	// override. Predicted `minHeight` still reserves space for the first paint.
	if (hasUnknown) {
		return (
			<div
				ref={hostRef}
				style={{
					position: "relative",
					width: contentWidth,
					minHeight: frame.contentHeight,
				}}
			>
				{blocks.map((block, index) => {
					const blockFrame = frame.blocks[index];
					if (!blockFrame) return null;
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
							key={index}
							data-vlist-flow-block={block.kind}
							style={{
								position: "relative",
								width: "100%",
								minHeight: blockFrame.height,
								marginTop: block.marginTop,
								boxSizing: "border-box",
							}}
						>
							<BlockView
								block={block}
								frame={{ ...blockFrame, top: 0 }}
								contentWidth={contentWidth}
								flowing
								animKey={animateStreaming && animKeyBase ? `${animKeyBase}:${index}` : undefined}
							/>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div
			ref={hostRef}
			style={{
				position: "relative",
				width: contentWidth,
				height: frame.contentHeight,
			}}
		>
			{blocks.map((block, index) => {
				const blockFrame = frame.blocks[index];
				if (!blockFrame) return null;
				const marginTop = block.marginTop;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
					<Fragment key={index}>
						{/* The blank strip above this block (accumulateFrame advances by
						    marginTop before frame.top) belongs to no text box; fill it so a
						    drag-selection can resolve a caret there. */}
						<CaretFiller top={blockFrame.top - marginTop} height={marginTop} width={contentWidth} />
						<BlockView
							block={block}
							frame={blockFrame}
							contentWidth={contentWidth}
							flowing={false}
							animKey={animateStreaming && animKeyBase ? `${animKeyBase}:${index}` : undefined}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}

/**
 * True when an "unknown" block's geometry was in fact measured exactly, so the
 * render layer must NOT fall back to post-paint DOM measurement. Display math
 * measured by katex-geometry reports `intrinsicWidth`; mermaid and unknown-size
 * images do not.
 */
function isExactlyMeasured(block: PreparedUnknownBlock): boolean {
	return block.tag === "katex" && block.intrinsicWidth != null;
}

function BlockView({
	block,
	frame,
	contentWidth,
	flowing,
	animKey,
}: {
	block: PreparedBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** When true, unknown blocks use relative flow instead of fixed absolute height. */
	flowing: boolean;
	/** Streaming per-grapheme animation key for this block (undefined = no anim). */
	animKey?: string;
}) {
	switch (block.kind) {
		case "inline":
			return (
				<InlineBlockView
					block={block}
					frame={frame}
					contentWidth={contentWidth}
					animKey={animKey}
				/>
			);
		case "code":
			return <CodeBlockView block={block} frame={frame} contentWidth={contentWidth} />;
		case "rule":
			return <RuleBlockView frame={frame} block={block} />;
		case "fixed":
			return null; // rendered by the owning element's renderer via block.tag
		case "unknown":
			return <UnknownBlockView block={block} frame={frame} flowing={flowing} />;
	}
}

// ── Inline block: materialize line ranges and lay out fragments ──────────────

interface InlineFragment {
	text: string;
	font: string;
	className: string;
	href: string | null;
	gapBefore: number;
	/** Global code-unit offset of this fragment within the block's visible text. */
	globalStart: number;
	/** Set when this fragment is an inline formula rather than text. */
	math: InlineMathFragment | null;
}

interface InlineLine {
	fragments: InlineFragment[];
}

function InlineBlockView({
	block,
	frame,
	contentWidth,
	animKey,
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** Streaming per-grapheme animation key for this block (undefined = no anim). */
	animKey?: string;
}) {
	// Materialize lines + fragments, assigning each fragment a running GLOBAL
	// offset within the block's concatenated visible text. That offset is what
	// the streaming animation split uses to decide which graphemes are new.
	// `totalLen` is the block's total visible length; `visibleText` (only built
	// when animating) is the concatenated text for the store's append/rewrite
	// comparison.
	const { lines, totalLen, visibleText } = useMemo(() => {
		const lineWidth = Math.max(1, contentWidth - block.contentLeft);
		const out: InlineLine[] = [];
		let offset = 0;
		let text = "";
		const wantText = animKey != null;
		walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push({
				fragments: line.fragments.map((f) => {
					const globalStart = offset;
					offset += f.text.length;
					if (wantText) text += f.text;
					return {
						text: f.text,
						font: block.fonts[f.itemIndex] ?? "",
						className: block.classNames[f.itemIndex] ?? "",
						href: block.hrefs[f.itemIndex] ?? null,
						gapBefore: f.gapBefore,
						globalStart,
						math: block.mathHtmls?.[f.itemIndex] ?? null,
					};
				}),
			});
		});
		return { lines: out, totalLen: offset, visibleText: text };
	}, [block, contentWidth, animKey]);

	// Peek the animation boundary during render (pure — no store mutation), then
	// commit the text after paint so the NEXT frame's boundary is correct. The
	// streaming tail keeps a stable spec.key, so this component instance persists
	// across frames and the effect runs once per committed text.
	const boundary =
		animKey != null ? streamAnimStore.peekBoundary(animKey, visibleText) : Number.POSITIVE_INFINITY;
	useEffect(() => {
		if (animKey != null) streamAnimStore.commitText(animKey, visibleText);
	}, [animKey, visibleText]);
	// Nothing to animate when every grapheme is already sealed (boundary >= end).
	const animating = animKey != null && boundary < totalLen;

	const isQuote = block.quoteRailLefts.length > 0;
	const quotePaddingY = isQuote ? MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING : 0;
	const quoteContentTop = isQuote ? quotePaddingY + MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP : 0;

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				width: contentWidth,
				height: frame.height,
			}}
		>
			{/* Blockquote background fill (MarkdownContent.module.css .mdQuote):
			    tinted panel + trailing rounded corners, spanning from the
			    outermost rail to the right edge. Height-neutral (behind text). */}
			{isQuote ? (
				<div
					style={{
						position: "absolute",
						left: block.quoteRailLefts[0] ?? 0,
						top: 0,
						right: 0,
						bottom: 0,
						background: "var(--vlist-quote-bg)",
						borderStartEndRadius: "var(--mantine-radius-default)",
						borderEndEndRadius: "var(--mantine-radius-default)",
					}}
				/>
			) : null}
			{block.markerText != null && block.markerLeft != null ? (
				<span
					className={block.markerClassName ?? undefined}
					style={{ position: "absolute", left: block.markerLeft, top: quoteContentTop }}
				>
					{block.markerText}
				</span>
			) : null}
			{block.quoteRailLefts.map((railLeft, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: rails are a stable ordered list
					key={i}
					style={{
						position: "absolute",
						left: railLeft,
						top: 0,
						bottom: 0,
						width: 3,
						background: "var(--mantine-primary-color-filled)",
					}}
				/>
			))}
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					data-vlist-line
					style={{
						position: "absolute",
						left: block.contentLeft,
						top: quoteContentTop + lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						// Stretch past the text so the blank remainder of the line still
						// resolves a caret during a drag-selection; `max-content` ended the
						// row at the last glyph, leaving the rest of the line caret-less.
						// Purely horizontal, so the height model is untouched.
						minWidth: "max-content",
						width: `calc(100% - ${block.contentLeft}px)`,
					}}
				>
					{line.fragments.map((frag, fi) => {
						// An inline formula replaces its placeholder glyph with real KaTeX
						// output, pinned to the width the measure layer reserved.
						if (frag.math) {
							return (
								<InlineMathView
									// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
									key={fi}
									math={frag.math}
									gapBefore={frag.gapBefore}
									lineHeight={block.lineHeight}
								/>
							);
						}
						const content =
							animating && boundary < frag.globalStart + frag.text.length ? (
								<FragmentAnimContent key="anim" frag={frag} boundary={boundary} />
							) : (
								frag.text
							);
						return frag.href != null ? (
							<a
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
								href={frag.href}
								target="_blank"
								rel="noreferrer"
								className={frag.className}
								style={{
									font: frag.font,
									marginLeft: frag.gapBefore,
									whiteSpace: "pre",
									display: "inline-block",
								}}
							>
								{content}
							</a>
						) : (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
								className={frag.className}
								style={{
									font: frag.font,
									marginLeft: frag.gapBefore,
									whiteSpace: "pre",
									display: "inline-block",
								}}
							>
								{content}
							</span>
						);
					})}
				</div>
			))}
		</div>
	);
}

/**
 * An inline formula, painted at exactly the width the measure layer reserved.
 *
 * The box is width-pinned and `overflow:hidden` so a font-loading hiccup or a
 * KaTeX version drift can never push the surrounding text around — the geometry
 * the height model committed to always wins (zero-DOM contract).
 *
 * The markup comes from KaTeX's own renderer, not from model output: KaTeX
 * escapes anything it cannot parse and its default `trust: false` refuses
 * `\href` / `\url` / `\includegraphics`, which is the same guarantee the
 * react-markdown path gets from rehype-katex.
 */
function InlineMathView({
	math,
	gapBefore,
	lineHeight,
}: {
	math: InlineMathFragment;
	gapBefore: number;
	lineHeight: number;
}) {
	if (math.html.length === 0) {
		// KaTeX unavailable or failed: show the source so content is never lost.
		return (
			<span
				className="vlist-frag vlist-frag--math-source"
				style={{ marginLeft: gapBefore, whiteSpace: "pre", display: "inline-block" }}
			>
				{math.latex}
			</span>
		);
	}
	return (
		<span
			className="vlist-frag vlist-frag--math"
			data-vlist-math="inline"
			style={{
				marginLeft: gapBefore,
				display: "inline-flex",
				alignItems: "center",
				width: math.width,
				height: lineHeight,
				overflow: "hidden",
			}}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-generated markup, not model text (trust:false blocks \href/\url)
			dangerouslySetInnerHTML={{ __html: math.html }}
		/>
	);
}

/**
 * Fragment body for the streaming animation path: a static leading string
 * (already-sealed text) followed by per-grapheme animated spans keyed by their
 * GLOBAL offset within the block. Stable keys mean sealed graphemes reuse the
 * same node (no re-animate) while freshly-appended ones mount and play once.
 * `display:inline` keeps the grapheme spans from altering the fragment box, so
 * the measured geometry is preserved (zero-DOM contract).
 */
function FragmentAnimContent({ frag, boundary }: { frag: InlineFragment; boundary: number }) {
	const { staticText, animGraphemes } = splitFragmentForAnim(frag.text, frag.globalStart, boundary);
	return (
		<>
			{staticText}
			{animGraphemes.map((g) => (
				<span key={g.gid} className="vlist-anim-token">
					{g.text}
				</span>
			))}
		</>
	);
}

// ── Code block: monospace pre-wrap, positioned per line ──────────────────────
function CodeBlockView({
	block,
	frame,
	contentWidth,
}: {
	block: PreparedCodeBlock;
	frame: BlockFrame;
	contentWidth: number;
}) {
	const { x: padX, y: padY } = MEASURE_MARKDOWN_CODE_PADDING;
	const langTop = block.lang != null ? padY + 12 : padY;
	const boxWidth = Math.max(1, contentWidth - block.contentLeft);
	const lines = useMemo(() => {
		const innerWidth = Math.max(1, boxWidth - padX * 2);
		return layoutWithLines(block.prepared, innerWidth, block.lineHeight).lines;
	}, [block, boxWidth]);
	// MEASURE_MARKDOWN_CODE_PADDING.x is a module constant — padX is stable.

	// Shiki needs the ORIGINAL source, not the wrapped lines: joining visual lines
	// would insert newlines that aren't in the code and break the grammar context.
	// pretext's `segments` are the prepared text's own pieces, so joining them
	// reproduces the source byte-for-byte (only CRLF is normalized to LF, which is
	// exactly the text pretext laid out). ~0.06ms for a 20k-char block, memoized on
	// the prepared handle, so it runs once per code block.
	const source = useMemo(() => block.prepared.segments.join(""), [block.prepared]);
	const tokens = useShikiTokens(source, block.lang ?? undefined);
	// Shiki colours by PHYSICAL line; pretext wraps into VISUAL lines. Re-cut the
	// token stream so every painted row gets exactly its own characters' colours.
	const tokenLines = useMemo(() => splitTokensByVisualLines(tokens, lines), [tokens, lines]);

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: boxWidth,
				height: frame.height,
				borderRadius: "var(--mantine-radius-sm)",
				background: "var(--vlist-code-bg)",
				border: "1px solid var(--mantine-color-default-border)",
				boxSizing: "border-box",
				overflow: "hidden",
			}}
		>
			{block.lang != null ? (
				<span
					style={{
						position: "absolute",
						top: 4,
						left: 8,
						fontSize: 10,
						lineHeight: 1,
						color: "var(--mantine-color-dimmed)",
					}}
				>
					{block.lang}
				</span>
			) : null}
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: code lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: padX,
						top: langTop + lineIndex * block.lineHeight,
						whiteSpace: "pre",
						font: CODE_FONT,
						// Syntax colours arrive per token; this stays the fallback for
						// uncoloured tokens and for the pre-highlight / plain-text paint.
						color: "var(--vlist-code-fg)",
					}}
				>
					<TokenText text={line.text} tokens={tokenLines?.[lineIndex]} />
				</div>
			))}
		</div>
	);
}

function RuleBlockView({ frame, block }: { frame: BlockFrame; block: PreparedBlock }) {
	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: "100%",
				height: frame.height,
			}}
		>
			<div
				style={{
					position: "absolute",
					top: Math.floor(frame.height / 2),
					left: 0,
					right: 0,
					height: 1,
					background: "var(--vlist-rule-color)",
				}}
			/>
		</div>
	);
}

function UnknownBlockView({
	block,
	frame,
	flowing,
}: {
	block: PreparedUnknownBlock;
	frame: BlockFrame;
	flowing: boolean;
}) {
	const source =
		typeof block.data?.source === "string"
			? block.data.source
			: typeof block.data?.code === "string"
				? block.data.code
				: "";

	const body = (() => {
		switch (block.tag) {
			case "mermaid":
				return source ? (
					<Suspense
						fallback={
							<pre
								style={{
									margin: 0,
									padding: 8,
									font: CODE_FONT,
									whiteSpace: "pre-wrap",
									color: "var(--mantine-color-dimmed)",
								}}
							>
								{source}
							</pre>
						}
					>
						<LazyMermaidDiagram code={source} />
					</Suspense>
				) : (
					<div style={{ padding: 8, color: "var(--mantine-color-dimmed)" }}>(empty mermaid)</div>
				);
			case "katex": {
				// Display math: the height model already measured this exactly (see
				// katex-geometry), so paint KaTeX's own markup. Falls back to the
				// source text when KaTeX has not loaded or could not parse it.
				const html = typeof block.data?.html === "string" ? block.data.html : "";
				if (html.length === 0) {
					return (
						<pre
							style={{
								margin: 0,
								padding: 8,
								font: CODE_FONT,
								whiteSpace: "pre-wrap",
								color: "var(--vlist-code-fg)",
							}}
						>
							{source || "(math)"}
						</pre>
					);
				}
				return (
					<div
						className="vlist-math-display"
						style={{ width: "100%", overflowX: "auto", overflowY: "hidden" }}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-generated markup, not model text (trust:false blocks \href/\url)
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				);
			}
			default:
				return (
					<div
						style={{
							width: "100%",
							minHeight: frame.height,
							background: "var(--vlist-placeholder-bg)",
						}}
					/>
				);
		}
	})();

	// In flowing mode (list host height:auto) unknown blocks use relative flow so
	// their intrinsic size contributes to the host. Predicted frame.top/height
	// remain the initial reservation.
	if (flowing) {
		return (
			<div
				data-vlist-unknown={block.tag}
				style={{
					position: "relative",
					width: "100%",
					minHeight: frame.height,
					boxSizing: "border-box",
				}}
			>
				{body}
			</div>
		);
	}

	return (
		<div
			data-vlist-unknown={block.tag}
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				width: "100%",
				height: frame.height,
				overflow: "hidden",
			}}
		>
			{body}
		</div>
	);
}
