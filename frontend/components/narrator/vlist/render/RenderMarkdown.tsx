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
import { MarkdownListMarker } from "@frontend/components/common/MarkdownListMarker";
import { useShikiTokens } from "@frontend/hooks/useShikiTokens";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { Box } from "@mantine/core";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownLink } from "../../markdown/MarkdownLink";
import { MEASURE_MARKDOWN_CODE_PADDING } from "../measure/measure-markdown";
import { pretextLineMetrics } from "../measure/pretext-metrics";
import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import type {
	BlockFrame,
	InlineMathFragment,
	MeasuredElement,
	PreparedBlock,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedTableBlock,
	PreparedTableCell,
	PreparedUnknownBlock,
} from "../prepared-block";
import { DEFAULT_TABLE_METRICS, layoutTable, tableRowLineHeight } from "../prepared-block";
import { MONO_FAMILY, typographyMetrics } from "../pretext-fonts";
import { type CodeCopyPlacement, resolveCodeCopyPlacement } from "../vlist-content-view-float";
import { splitTokensByVisualLines } from "../vlist-token-lines";
import { hasUnpredictableBlock } from "../vlist-unpredictable-blocks";
import "../vlist-markdown.css";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { VListCodeCopyButton } from "../VListCodeCopyButton";
import { CaretFiller } from "./caret-filler";
import { FragmentGap, LineFragments } from "./line-fragments";
import { graphemeAnimAge, StreamAnimStore, splitFragmentForAnim } from "./stream-token-anim";
import { TokenText } from "./TokenLines";

/**
 * Module-level boundary memory shared by every streaming markdown render. Keyed
 * by `${animKeyBase}:${blockIndex}` so each inline block tracks its own append
 * boundary across the per-frame remounts of the streaming tail. Bounded LRU so
 * a finished stream's keys are eventually evicted (no cross-component cleanup).
 */
const streamAnimStore = new StreamAnimStore();

/**
 * Markdown fenced code renders at 11px monospace (settled Shiki parity), scaled by
 * the reader's typography. Must match measure, which prepares the block with
 * `typographyMetrics().font.markdownCode` — hence the same accessor here rather
 * than a second string built from the constants.
 *
 * A function for the same reason `mathBaseFontSize` is: a module-level capture
 * freezes the font at chunk-load time, and the resulting mismatch is silent (the
 * code panel keeps painting at 11px inside line boxes measured for a larger size).
 */
function codeFont(): string {
	return typographyMetrics().font.markdownCode;
}

/**
 * The fenced panel's border, per side. The measure layer folds it into the box's
 * vertical padding (MEASURE_MARKDOWN_CODE_PADDING.y = 10 xs + 1 border); the
 * render layer needs it on its own because absolutely positioned children are
 * placed against the PADDING box, which is 1px inside the border-box the frame
 * height describes.
 */
const CODE_PANEL_BORDER = 1;

/**
 * Bounds ONE markdown body for anchor resolution.
 *
 * The exact list mounts a separate `RenderMarkdown` per row, and different rows
 * legitimately repeat a heading ("## 结论" in two different answers), so a
 * `#结论` click must only look inside the row it was clicked in. Resolved through
 * `closest` at click time, which also means a row that scrolls out and remounts
 * needs no re-registration.
 */
const MD_BODY_ATTR = "data-md-body";

/**
 * Font size (px) every LaTeX formula is painted at. MUST equal the `basePx` the
 * measure layer passes to katex-geometry (parse-markdown reads
 * `typographyMetrics().mathSize`) — both resolve to the SCALED body size from the
 * one shared snapshot rather than being hardcoded, so the two cannot silently
 * diverge.
 *
 * Why this is load-bearing: KaTeX sizes its own root box RELATIVELY
 * (`.katex { font: normal 1.21em … }`), so the rendered geometry depends entirely
 * on the font size the formula's DOM ancestor carries. Left to inherit, KaTeX picks
 * up the document default (Mantine `body` = 16px) and paints ~14% larger than
 * measured — which the width-pinned, `overflow:hidden` host box then clips.
 *
 * A FUNCTION, not a constant: a module-level capture would pin every formula to the
 * typography that happened to be active when this chunk loaded, so changing the
 * font scale would rescale all the prose and leave the formulas behind (clipped, in
 * the direction that makes them larger than their measured box).
 */
function mathBaseFontSize(): number {
	return typographyMetrics().mathSize;
}

/** Lightweight mermaid host — reuses the real MermaidDiagram via dynamic import
 * so the vlist shell never statically depends on the heavy mermaid bundle
 * path at first paint. Failures fall back to a monospaced source box. */
const LazyMermaidDiagram = lazy(() =>
	import("../../markdown/MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })),
);

interface RenderMarkdownProps {
	measured: MeasuredElement;
	/**
	 * Show `sourceText` as raw monospace text instead of the measured render.
	 *
	 * Height-neutral by construction: the raw source goes into a box pinned to the
	 * SAME `measured.height` and scrolls internally, exactly like a tool card's
	 * capped body. That is what lets a plain content row offer the toggle at all —
	 * the two forms wrap to completely different line counts, so anything but a
	 * fixed box would resize a committed row.
	 */
	showSource?: boolean;
	/** The raw markdown, needed only while `showSource` holds. */
	sourceText?: string;
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
	/**
	 * The anim store's mount-vs-live-birth SCOPE — the narratorId. Passed as its
	 * own value rather than parsed out of `animKeyBase`: the store used to slice
	 * that key at its first ":", so the key template's shape silently decided
	 * whether a new paragraph faded in or popped.
	 */
	animScope?: string;
}

/**
 * Render a measured markdown element. The outer box height equals the predicted
 * height (or an override applied by the shell); children are absolutely
 * positioned inside it.
 */
export function RenderMarkdown({
	measured,
	showSource,
	sourceText,
	onUnknownHeight,
	animateStreaming,
	animKeyBase,
	animScope,
}: RenderMarkdownProps) {
	const { blocks, frame, contentWidth } = measured;
	const hostRef = useRef<HTMLDivElement | null>(null);
	// Non-default copy-button corners, for panels that would otherwise sit under
	// the row's hover action bar (see resolveCodeCopyPlacements).
	const copyPlacements = useMemo(() => resolveCodeCopyPlacements(blocks, frame), [blocks, frame]);

	// One-shot observe: if any TRULY unpredictable block is present, report the
	// host's real height after paint/layout. ResizeObserver is the controlled
	// exception. Display math is excluded: katex-geometry measures it exactly, so
	// it needs no post-paint correction and must not drag the whole element onto
	// the flowing path.
	// Shared with the SHELL's dynamic-row predicate (vlist-unpredictable-blocks):
	// the shell decides whether to hand this row a reporter, this decides whether to
	// observe. Two copies of the rule would eventually disagree, and either half
	// disagreeing leaves the row clipped or un-recorded.
	const hasUnknown = useMemo(() => hasUnpredictableBlock(blocks), [blocks]);
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

	// Raw-source view. Deliberately BEFORE the unknown-block branch: the source is
	// plain text, so a mermaid/katex placeholder inside the rendered form is
	// irrelevant to it, and the flowing layout that branch installs would let the
	// source box decide its own height.
	if (showSource && sourceText) {
		return (
			<MarkdownSourceBody text={sourceText} width={contentWidth} height={frame.contentHeight} />
		);
	}

	// When any unpredictable block is present, switch the whole host to a
	// simple stacked flow. Absolute frame tops cannot reflow subsequent siblings
	// after a mermaid/katex grows past its placeholder; stacking lets the host
	// settle to the real total height, which the shell then writes back as an
	// override. Predicted `minHeight` still reserves space for the first paint.
	if (hasUnknown) {
		return (
			<div
				ref={hostRef}
				{...{ [MD_BODY_ATTR]: "" }}
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
								animScope={animScope}
								codeCopyPlacement={copyPlacements.get(index)}
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
			{...{ [MD_BODY_ATTR]: "" }}
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
							animScope={animScope}
							codeCopyPlacement={copyPlacements.get(index)}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}

/**
 * The raw markdown of a content row, inside a box pinned to the row's MEASURED
 * height.
 *
 * This is the one structural difference from the chunked path's source toggle. In
 * `ContentViewer` the source view reflows the row, because there the DOM owns the
 * height. Here the height was committed arithmetically from the RENDERED markdown
 * — headings, lists and wrapped prose — while the source is unwrapped monospace
 * text with a completely different line count. Letting it size itself would move
 * a committed row with every toggle (CONTRACT §0: a row's height changes only when
 * the reader asks for a height change), so the source scrolls inside the reserved
 * box instead. Exactly what a tool card's capped markdown body already does.
 */
function MarkdownSourceBody({
	text,
	width,
	height,
}: {
	text: string;
	width: number;
	height: number;
}) {
	const metrics = typographyMetrics();
	return (
		<div
			data-vlist-markdown-source
			style={{
				position: "relative",
				width,
				height,
				// The source is `pre-wrap`, so it never needs horizontal scrolling —
				// the chunked ContentViewer's wrapped state is `overflowX: hidden`.
				overflowY: "auto",
				overflowX: "hidden",
				// Follows the reader's typography like every other text surface here.
				// This body is not height-critical (it scrolls inside a box pinned to the
				// RENDERED markdown's height, see above), so it only has to be legible —
				// but leaving it unscaled would make the source toggle the one place in
				// the transcript that ignores the font-size setting.
				fontSize: metrics.codeSize,
				// The integer line box the measure layer uses for code, for the same
				// reason: a unitless ratio makes the browser pick a fractional height.
				lineHeight: `${metrics.line.code}px`,
				fontFamily: MONO_FAMILY,
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				boxSizing: "border-box",
			}}
		>
			{text}
		</div>
	);
}

/**
 * Where the FIRST fenced panel puts its copy button, keyed by block index.
 *
 * Why only the first: the row's hover action bar is a zero-height overlay parked
 * at the body's own top-right corner with `zIndex: 2`, deliberately above any
 * block-level chrome (`zIndex: 1`). A fenced panel pins its copy button to that
 * same corner, so a code block near the top of the body has its button covered
 * entirely. Every later panel is far below the bar and keeps the default corner.
 *
 * Read off the measured frame rather than assuming block 0, because both mistakes
 * are real: a body can open with a zero-height block and still put a panel under
 * the bar, and a panel starting one text line down already clears it and must not
 * be moved for no visible reason.
 */
function resolveCodeCopyPlacements(
	blocks: readonly PreparedBlock[],
	frame: MeasuredElement["frame"],
): Map<number, CodeCopyPlacement> {
	const out = new Map<number, CodeCopyPlacement>();
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		const blockFrame = frame.blocks[index];
		if (!block || !blockFrame) continue;
		// Only fenced panels paint in that corner today, so an early paragraph must
		// not end the scan and mask a following code block that does overlap it.
		if (block.kind !== "code") continue;
		const placement = resolveCodeCopyPlacement(blockFrame.top, blockFrame.height);
		// "top-right" is the component default; recording it would only add noise.
		if (placement !== "top-right") out.set(index, placement);
		break;
	}
	return out;
}

function BlockView({
	block,
	frame,
	contentWidth,
	flowing,
	animKey,
	animScope,
	codeCopyPlacement,
}: {
	block: PreparedBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** When true, unknown blocks use relative flow instead of fixed absolute height. */
	flowing: boolean;
	/** Streaming per-grapheme animation key for this block (undefined = no anim). */
	animKey?: string;
	/** The anim store's scope (narratorId) for this block's key. */
	animScope?: string;
	/** Non-default corner for a fenced panel's copy button; absent → top-right. */
	codeCopyPlacement?: CodeCopyPlacement;
}) {
	switch (block.kind) {
		case "inline":
			return (
				<InlineBlockView
					block={block}
					frame={frame}
					contentWidth={contentWidth}
					animKey={animKey}
					animScope={animScope}
				/>
			);
		case "code":
			return (
				<CodeBlockView
					block={block}
					frame={frame}
					contentWidth={contentWidth}
					copyPlacement={codeCopyPlacement}
				/>
			);
		case "table":
			return <TableBlockView block={block} frame={frame} contentWidth={contentWidth} />;
		case "rule":
			return <RuleBlockView frame={frame} block={block} />;
		case "fixed":
			return null; // rendered by the owning element's renderer via block.tag
		case "unknown":
			return <UnknownBlockView block={block} frame={frame} flowing={flowing} />;
	}
}

// ── Table block: solved columns, absolutely positioned cells ─────────────────

/**
 * Paint a GFM table WITHOUT a real `<table>`.
 *
 * The browser's `table-layout: auto` cannot be predicted arithmetically, so the
 * height model solves the columns itself (`layoutTable`) and this component
 * re-runs that same pure solver to place every cell. Because both sides call one
 * function with one set of inputs, the painted geometry is the predicted geometry
 * by construction — there is nothing left to drift.
 *
 * An overflowing table scrolls horizontally inside its own box, mirroring the
 * chunked path's `overflowX: auto` wrapper. The height model reserved a fixed
 * `scrollbarHeight` for that bar (see DEFAULT_TABLE_METRICS): rows are laid out
 * from the top, so if the platform's real bar is thinner or absent, only the gap
 * below the last row varies and no row ever moves.
 */
function TableBlockView({
	block,
	frame,
	contentWidth,
}: {
	block: PreparedTableBlock;
	frame: BlockFrame;
	contentWidth: number;
}) {
	const boxWidth = Math.max(1, contentWidth - block.contentLeft);
	const layout = useMemo(
		() => layoutTable(block, boxWidth, pretextLineMetrics, DEFAULT_TABLE_METRICS),
		[block, boxWidth],
	);

	const { paddingX, paddingY, rowBorder } = DEFAULT_TABLE_METRICS;
	const hasHeader = block.header.length > 0;
	// Row order matches the height model: header first (when present), then body.
	const allRows = hasHeader ? [block.header, ...block.rows] : block.rows;

	// Column x offsets, accumulated once so each cell is a lookup rather than a scan.
	// DEFAULT_TABLE_METRICS is a module constant, so paddingX is stable and stays
	// out of the dependency list.
	const columnLefts = useMemo(() => {
		const lefts: number[] = [];
		let x = 0;
		for (const width of layout.columnWidths) {
			lefts.push(x);
			x += width + paddingX * 2;
		}
		return lefts;
	}, [layout.columnWidths]);

	let rowTop = 0;

	return (
		<div
			data-vlist-table
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: boxWidth,
				height: frame.height,
				// Only an overflowing table scrolls; a fitting one must not create a
				// scroll container (it would clip the hover highlight at the edges).
				overflowX: layout.overflowing ? "auto" : "visible",
				overflowY: "hidden",
				// Pin the bar to a predictable thickness so the reserved space is close
				// to the real one on classic-scrollbar platforms.
				scrollbarWidth: "thin",
			}}
		>
			<div style={{ position: "relative", width: layout.tableWidth, height: frame.height }}>
				{allRows.map((cells, rowIndex) => {
					const rowHeight = layout.rowHeights[rowIndex] ?? 0;
					const top = rowTop;
					rowTop += rowHeight;
					const isHeader = hasHeader && rowIndex === 0;
					// Striping counts BODY rows only, matching Mantine's `striped="odd"`
					// applied to tbody (the header is never striped).
					const bodyIndex = hasHeader ? rowIndex - 1 : rowIndex;
					const striped = !isHeader && bodyIndex % 2 === 0;
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
							key={rowIndex}
							data-vlist-table-row={isHeader ? "header" : "body"}
							// Striping and hover live in CSS, not inline styles: an inline
							// background would outrank any class-based hover rule and force an
							// `!important` to claw it back.
							data-striped={striped ? "" : undefined}
							className="vlist-table-row"
							style={{
								position: "absolute",
								top,
								left: 0,
								width: layout.tableWidth,
								height: rowHeight,
								// The separator is inside the reserved row height (measure adds
								// `rowBorder` per row), so drawing it never shifts anything.
								borderBottom: `${rowBorder}px solid var(--vlist-table-border)`,
								boxSizing: "border-box",
							}}
						>
							{cells.map((cell, columnIndex) => {
								const width = layout.columnWidths[columnIndex];
								const left = columnLefts[columnIndex];
								if (width === undefined || left === undefined) return null;
								return (
									<TableCellView
										// biome-ignore lint/suspicious/noArrayIndexKey: cells are a stable ordered list
										key={columnIndex}
										cell={cell}
										width={width}
										left={left + paddingX}
										top={paddingY}
										lineHeight={tableRowLineHeight(cells, block.lineHeight)}
										align={block.align[columnIndex] ?? null}
									/>
								);
							})}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** One table cell's inline flow, materialized at the solved column width. */
function TableCellView({
	cell,
	width,
	left,
	top,
	lineHeight,
	align,
}: {
	cell: PreparedTableCell;
	width: number;
	left: number;
	top: number;
	lineHeight: number;
	align: "left" | "center" | "right" | null;
}) {
	const lines = useMemo(() => {
		const out: InlineLine[] = [];
		walkRichInlineLineRanges(cell.flow, width, (range) => {
			const line = materializeRichInlineLineRange(cell.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: cell.fonts[f.itemIndex] ?? "",
					className: cell.classNames[f.itemIndex] ?? "",
					href: cell.hrefs[f.itemIndex] ?? null,
					gapBefore: f.gapBefore,
					globalStart: 0,
					// A cell formula reaches here the same way a paragraph's does; leaving
					// this null painted the atom placeholder (an NBSP) instead of the KaTeX
					// markup, i.e. correctly-sized blank space.
					math: cell.mathHtmls?.[f.itemIndex] ?? null,
				})),
			});
		});
		return out;
	}, [cell, width]);

	const justifyContent =
		align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";

	return (
		<div style={{ position: "absolute", left, top, width }}>
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					data-vlist-line
					style={{
						position: "absolute",
						left: 0,
						top: lineIndex * lineHeight,
						width,
						height: lineHeight,
						display: "flex",
						alignItems: "center",
						justifyContent,
					}}
				>
					<LineFragments>
						{line.fragments.map((frag, fi) => (
							<Fragment
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
							>
								{/* Precedes the fragment: the space belongs to the boundary
								    before it, not to the fragment's own text. */}
								<FragmentGap gapBefore={frag.gapBefore} />
								{
									// Reuse the paragraph path's math host so a cell formula inherits
									// the same guards (measured width pin, KaTeX font-size base,
									// no-wrap).
									frag.math ? (
										<InlineMathView
											math={frag.math}
											gapBefore={frag.gapBefore}
											lineHeight={lineHeight}
										/>
									) : frag.href != null ? (
										<MarkdownLink
											lineNumbersInChildren
											href={frag.href}
											className={frag.className}
											style={fragmentTextStyle({
												font: frag.font,
												gapBefore: frag.gapBefore,
												letterSpacing: letterSpacingForFont(frag.font),
											})}
										>
											{frag.text}
										</MarkdownLink>
									) : (
										<span
											className={frag.className}
											style={fragmentTextStyle({
												font: frag.font,
												gapBefore: frag.gapBefore,
												letterSpacing: letterSpacingForFont(frag.font),
											})}
										>
											{frag.text}
										</span>
									)
								}
							</Fragment>
						))}
					</LineFragments>
				</div>
			))}
		</div>
	);
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
	animScope,
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** Streaming per-grapheme animation key for this block (undefined = no anim). */
	animKey?: string;
	/**
	 * Mount-vs-live-birth scope (the narratorId). Bound to the shared store once
	 * per render so peek and commit cannot disagree about it.
	 */
	animScope?: string;
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

	// Resolve this frame's animation state during render (pure — no store mutation),
	// then commit it after paint so the NEXT frame's boundary and ages are correct.
	// The streaming tail keeps a stable spec.key, so this component instance persists
	// across frames and the effect runs once per committed text.
	//
	// `now` is read once and used for BOTH halves: peek derives the seal offset and
	// the grapheme ages from it, and commit stamps the birth with it. Two clock reads
	// would date this frame's own birth slightly in the past and start its animation
	// already advanced.
	const now = animKey != null ? Date.now() : 0;
	// One scope handle for both halves of the frame. The scope defaults to the
	// animKey itself only when the shell supplied none: a key that is its own scope
	// can never be warmed by a sibling, so the first sighting seals — the safe
	// direction (a mount must not replay a fade), and the same thing the old
	// key-slicing did for a key without ":".
	const scoped = useMemo(
		() => streamAnimStore.scoped(animScope ?? animKey ?? ""),
		[animScope, animKey],
	);
	// Named `animFrame`, not `frame`: this component's `frame` prop is the measured
	// BlockFrame (geometry). Two different meanings of the word in one scope is how
	// a later edit reaches for the wrong one.
	const animFrame = animKey != null ? scoped.peekFrame(animKey, visibleText, now) : null;
	// `now` is deliberately NOT a dependency: it changes on every render, so including
	// it would commit a birth on renders that appended nothing (a hover, a resize, a
	// parent rebuild), restamping text that was already mid-fade and restarting its
	// animation. Excluding it means the closure keeps the `now` of the render where
	// `visibleText` actually changed — which is precisely the birth time wanted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `now` must stay out; see above
	useEffect(() => {
		if (animKey != null) scoped.commitFrame(animKey, visibleText, now);
	}, [animKey, visibleText, scoped]);
	// The split point is the SEAL offset, not the append boundary — a grapheme must
	// keep its span until its animation finishes (see stream-token-anim's header).
	const sealOffset = animFrame?.sealOffset ?? Number.POSITIVE_INFINITY;
	// Nothing to animate when every grapheme is already sealed.
	const animating = animFrame != null && sealOffset < totalLen;

	const isQuote = block.quoteRailLefts.length > 0;
	const quotePaddingY = isQuote ? MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING : 0;
	const quoteContentTop = isQuote ? quotePaddingY + MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP : 0;

	return (
		<div
			// Marks the boundary of ONE logical inline block (a paragraph, heading or
			// list item). The `data-vlist-line` children inside it are VISUAL lines
			// produced by soft wrapping, which the source had no newline for — the copy
			// handler (vlist-copy-text.ts) needs this boundary to tell "same paragraph,
			// wrapped" from "next paragraph".
			data-vlist-inline-block
			// Anchor target for a same-document `[x](#…)` link (see
			// lib/markdown-anchor-scroll). Height-neutral: an attribute only. Set on
			// the block box rather than on a line, because a wrapped heading has
			// several lines and a jump must land on the block's top.
			{...(block.headingSlug ? { [MD_HEADING_SLUG_ATTR]: block.headingSlug } : {})}
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
			<MarkdownListMarker block={block} top={quoteContentTop} />
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
					<LineFragments>
						{line.fragments.map((frag, fi) => {
							// An inline formula replaces its placeholder glyph with real KaTeX
							// output, pinned to the width the measure layer reserved.
							const body = frag.math ? (
								<InlineMathView
									math={frag.math}
									gapBefore={frag.gapBefore}
									lineHeight={block.lineHeight}
								/>
							) : (
								(() => {
									const content =
										animating &&
										animFrame != null &&
										sealOffset < frag.globalStart + frag.text.length ? (
											<FragmentAnimContent
												key="anim"
												frag={frag}
												sealOffset={sealOffset}
												births={animFrame.births}
												now={animFrame.now}
											/>
										) : (
											frag.text
										);
									return frag.href != null ? (
										<MarkdownLink
											lineNumbersInChildren
											href={frag.href}
											className={frag.className}
											style={fragmentTextStyle({
												font: frag.font,
												gapBefore: frag.gapBefore,
												letterSpacing: letterSpacingForFont(frag.font),
											})}
										>
											{content}
										</MarkdownLink>
									) : (
										<span
											className={frag.className}
											style={fragmentTextStyle({
												font: frag.font,
												gapBefore: frag.gapBefore,
												letterSpacing: letterSpacingForFont(frag.font),
											})}
										>
											{content}
										</span>
									);
								})()
							);
							return (
								<Fragment
									// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
									key={fi}
								>
									{/* Precedes the fragment: the space belongs to the boundary
									    before it, not to the fragment's own text. */}
									<FragmentGap gapBefore={frag.gapBefore} />
									{body}
								</Fragment>
							);
						})}
					</LineFragments>
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
 * the height model committed to always wins (zero-DOM contract). The geometry
 * model includes KaTeX's class-only `boxpad` padding, so `\boxed` remains inside
 * the reserved width instead of relying on visible overflow.
 *
 * `fontSize` is load-bearing, not cosmetic: KaTeX sizes its root box RELATIVELY
 * (`.katex { font: normal 1.21em … }`), so without an explicit base it inherits
 * the document default (Mantine `body` = 16px) and paints ~14% larger than
 * katex-geometry measured — which the width pin then clips. Pinning
 * `mathBaseFontSize()` reproduces the measurement context exactly.
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
		// KaTeX unavailable or failed: show the source so content is never lost — but
		// inside the SAME width-pinned, clipped box the rendered branch uses.
		//
		// The reserved slot was measured from the RENDERED width, and LaTeX source
		// bears no relation to it (`\sum_{i=1}^{n}` is far wider as text than as a
		// formula). Left to size itself, the source text would overflow its slot and
		// push every later fragment on the line sideways — measured geometry and
		// painted geometry disagree, which is the one thing this path may not do.
		//
		// `measureKatex`'s structural-failure branch returns `width: 0` (and
		// `mathPiece` then degrades to a text piece), so this branch is normally
		// reached only for `html: ""` with a real width. Pinning covers it either way:
		// a zero width collapses the box, which is the correct answer for a slot that
		// reserved nothing.
		return (
			<span
				className="vlist-frag vlist-frag--math-source"
				style={{
					marginLeft: gapBefore,
					whiteSpace: "pre",
					display: "inline-block",
					width: math.width,
					height: lineHeight,
					overflow: "hidden",
				}}
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
				// Reproduce the measurement context: KaTeX's `1.21em` root resolves
				// against this size, so it must match katex-geometry's `basePx`.
				fontSize: mathBaseFontSize(),
				// KaTeX splits a formula into several `.base` spans, cut after binary /
				// relation operators precisely so a browser MAY break there. The box is
				// pinned to the measured width with zero slack, so sub-pixel rounding was
				// enough to take one of those breaks and stack the formula onto a second
				// line (clipped by the fixed height) — seen on `x_1 + x_2`,
				// `\nabla f(x) = 0`, `f(x) = \sum…`. The atom is unbreakable by
				// construction in the measure layer (an NBSP placeholder with
				// `break: "never"`), so the paint must be unbreakable too. Widening the
				// box instead would desync it from the reserved geometry.
				whiteSpace: "nowrap",
			}}
		>
			{/* The LaTeX source, for copying only. KaTeX is rendered with
			    `output: "html"` (katex-geometry), so the MathML `<annotation>` that
			    normally carries the source is absent — without this the clipboard gets
			    the VISUAL spans instead, which read as "E=mc2": the superscript
			    structure is gone and the result is silently wrong maths. */}
			<MathSourceForCopy latex={math.latex} display={false} />
			<span
				// The visual layer must not reach the clipboard; the source above is what
				// gets copied. `aria-hidden` is already on KaTeX's own katex-html span, but
				// that governs assistive tech, not selection.
				style={{ userSelect: "none", WebkitUserSelect: "none" }}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-generated markup, not model text (trust:false blocks \href/\url)
				dangerouslySetInnerHTML={{ __html: math.html }}
			/>
		</span>
	);
}

/**
 * The copyable LaTeX source of a formula, visually absent and geometry-neutral.
 *
 * Why it has to exist at all: `katex-geometry` renders with `output: "html"`, so the
 * MathML subtree — and with it the `<annotation encoding="application/x-tex">` that
 * normally holds the source — is never emitted. That leaves only the visual spans for
 * the serializer to read, and they serialize as flattened nonsense: `E = mc^2` comes
 * out `"E=mc \n2"` (verified in Chrome 146), i.e. the exponent silently becomes a
 * factor. `\sum_{i=1}^{n} i` fares worse.
 *
 * Restoring MathML just for this would double the markup for every formula on a path
 * whose whole point is minimal DOM, and its `textContent` still needs filtering. The
 * source is already in hand (`InlineMathFragment.latex`), so it is carried directly.
 *
 * Hidden with the standard clip technique rather than `display:none` /
 * `visibility:hidden` (which remove the text from the selection entirely) and rather
 * than `width: 0; overflow: hidden` (which Chrome also drops from serialization — the
 * same trap `FragmentGap` hit). `position: absolute` keeps it out of flow, so the
 * formula box measures exactly as before.
 *
 * The delimiters are included so the pasted text is valid markdown that round-trips
 * back into a formula.
 */
function MathSourceForCopy({ latex, display }: { latex: string; display: boolean }) {
	const delimiter = display ? "$$" : "$";
	return (
		<span
			data-vlist-math-source
			style={{
				position: "absolute",
				width: 1,
				height: 1,
				overflow: "hidden",
				// `inset(50%)` collapses the painted area to nothing while leaving the box
				// (and therefore its text) part of the document for selection purposes.
				clipPath: "inset(50%)",
				whiteSpace: "nowrap",
			}}
		>
			{`${delimiter}${latex}${delimiter}`}
		</span>
	);
}

/**
 * Fragment body for the streaming animation path: a static leading string
 * (text whose animation has finished) followed by per-grapheme spans keyed by
 * their GLOBAL offset within the block.
 *
 * The split uses the time-driven SEAL offset, so a grapheme holds one stable span
 * for its whole fade rather than losing it to the next delta — the bug that made
 * continuous output look almost unanimated (see stream-token-anim's header).
 *
 * `display:inline` keeps the grapheme spans from altering the fragment box, so the
 * measured geometry is preserved (zero-DOM contract).
 */
function FragmentAnimContent({
	frag,
	sealOffset,
	births,
	now,
}: {
	frag: InlineFragment;
	sealOffset: number;
	births: readonly { offset: number; ts: number }[];
	now: number;
}) {
	const { staticText, animGraphemes } = splitFragmentForAnim(
		frag.text,
		frag.globalStart,
		sealOffset,
	);
	return (
		<>
			{staticText}
			{animGraphemes.map((g) => {
				// A span can be REMOUNTED mid-animation when the line rewraps and its
				// parent changes, which restarts the keyframes from zero and blurs the
				// same character twice. A negative delay makes progress a function of the
				// grapheme's age instead of its mount time, so a remount resumes.
				const age = graphemeAnimAge(births, g.gid, now);
				return (
					<span
						key={g.gid}
						className="vlist-anim-token"
						style={age > 0 ? { animationDelay: `-${age}ms` } : undefined}
					>
						{g.text}
					</span>
				);
			})}
		</>
	);
}

// ── Code block: monospace pre-wrap, positioned per line ──────────────────────
function CodeBlockView({
	block,
	frame,
	contentWidth,
	copyPlacement,
}: {
	block: PreparedCodeBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** Non-default corner for the copy button; absent → the usual top-right. */
	copyPlacement?: CodeCopyPlacement;
}) {
	const { x: padX, y: padY } = MEASURE_MARKDOWN_CODE_PADDING;
	const langTop = block.lang != null ? padY + 12 : padY;
	const boxWidth = Math.max(1, contentWidth - block.contentLeft);
	// MEASURE_MARKDOWN_CODE_PADDING.x is a module constant — padX is stable.
	const innerWidth = Math.max(1, boxWidth - padX * 2);
	const lines = useMemo(
		() => layoutWithLines(block.prepared, innerWidth, block.lineHeight).lines,
		[block, innerWidth],
	);
	// Absolute children are laid out against the PADDING box, so the geometry a
	// full-bleed child spans is the frame minus the border on each side.
	const innerBoxWidth = Math.max(1, boxWidth - CODE_PANEL_BORDER * 2);
	const innerBoxHeight = Math.max(0, frame.height - CODE_PANEL_BORDER * 2);
	/** Bottom of the painted line stack — the start of the panel's bottom padding. */
	const linesBottom = langTop + lines.length * block.lineHeight;

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
	// Hover/focus-gated copy overlay (chunked MarkdownCodeBlock parity). Always
	// mounted so keyboard users can reach it via Tab, but visually hidden until
	// hover or focus-within. Height-neutral: the overlay is absolute inside the
	// already-reserved panel box.
	const [showCopy, setShowCopy] = useState(false);

	return (
		// A Mantine Box (not a raw div) keeps the pointer handlers off a static host
		// element — the same pattern VListContentViewHost uses for its hover bar. The
		// handlers only reveal the copy overlay; the button inside is a real,
		// keyboard-reachable control.
		<Box
			onMouseEnter={() => setShowCopy(true)}
			onMouseLeave={() => setShowCopy(false)}
			onFocus={() => setShowCopy(true)}
			onBlur={(e) => {
				// Only hide if focus leaves the panel entirely (not moving between
				// elements within it, e.g. tooltip → button).
				if (!e.currentTarget.contains(e.relatedTarget as Node)) {
					setShowCopy(false);
				}
			}}
			tabIndex={0}
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
			<VListCodeCopyButton value={source} hidden={!showCopy} placement={copyPlacement} />
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
			{/* The panel's own padding carries no text: the top strip (plus the
			    language label band) above the first line, and the bottom strip below
			    the last one. Every child here is absolutely positioned, so the panel
			    has no line box of its own to fall back on — without a filler a drag
			    through those strips resolves no caret and the selection snaps to the
			    start of the scroll container. */}
			<CaretFiller top={0} height={langTop} width={innerBoxWidth} />
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: code lines are a stable ordered list
					key={lineIndex}
					data-vlist-code-line
					style={{
						position: "absolute",
						left: 0,
						top: langTop + lineIndex * block.lineHeight,
						// Fill the whole slot the measure layer reserved, in both axes.
						// The row used to be a shrink-to-fit box: ~13px tall (see
						// `lineHeight` below) inside a 17px slot and only as wide as its
						// glyphs, so the 4px leading between rows, the blank remainder
						// past the last glyph and the box padding all belonged to NO line
						// box — the caret-less strips that made a drag selection snap back
						// to the top of the history. `paddingLeft` (with border-box) keeps
						// the glyphs at exactly `padX` while the row's box spans edge to
						// edge; `minWidth` preserves the old overflow behaviour for a long
						// line (still clipped by the panel).
						width: innerBoxWidth,
						height: block.lineHeight,
						paddingLeft: padX,
						boxSizing: "border-box",
						minWidth: "max-content",
						whiteSpace: "pre",
						font: codeFont(),
						// MUST stay after `font`: the shorthand resets line-height to
						// `normal` (~13px at 11px), which both left the leading uncovered
						// and painted the text ~2px above the settled Shiki view — that one
						// half-leads at 11px/1.55, i.e. exactly this line height.
						lineHeight: `${block.lineHeight}px`,
						// Syntax colours arrive per token; this stays the fallback for
						// uncoloured tokens and for the pre-highlight / plain-text paint.
						color: "var(--vlist-code-fg)",
					}}
				>
					<TokenText text={line.text} tokens={tokenLines?.[lineIndex]} />
				</div>
			))}
			<CaretFiller top={linesBottom} height={innerBoxHeight - linesBottom} width={innerBoxWidth} />
		</Box>
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
									font: codeFont(),
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
								font: codeFont(),
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
						style={{
							// `relative` anchors the absolutely-positioned copy source below;
							// it establishes no new geometry of its own.
							position: "relative",
							width: "100%",
							overflowX: "auto",
							overflowY: "hidden",
							// Same relative-root problem as inline math: KaTeX's `1.21em`
							// must resolve against the base the height model measured with,
							// or the block renders taller than its reserved frame.
							fontSize: mathBaseFontSize(),
						}}
					>
						{/* Same reasoning as the inline case: with `output: "html"` there is
						    no MathML annotation to copy, and the visual spans serialize as
						    broken maths. Display math needs it more, not less — natively it
						    copied as a column of loose symbols. */}
						<MathSourceForCopy latex={source} display />
						<span
							style={{ userSelect: "none", WebkitUserSelect: "none" }}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-generated markup, not model text (trust:false blocks \href/\url)
							dangerouslySetInnerHTML={{ __html: html }}
						/>
					</div>
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
