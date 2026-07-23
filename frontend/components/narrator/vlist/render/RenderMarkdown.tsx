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
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { MEASURE_MARKDOWN_CODE_PADDING } from "../measure/measure-markdown";
import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import type {
	BlockFrame,
	MeasuredElement,
	PreparedBlock,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedUnknownBlock,
} from "../prepared-block";
import { FONT_SIZE, FONT_WEIGHT, MONO_FAMILY } from "../pretext-fonts";
import "../vlist-markdown.css";

const CODE_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${MONO_FAMILY}`;

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
}

/**
 * Render a measured markdown element. The outer box height equals the predicted
 * height (or an override applied by the shell); children are absolutely
 * positioned inside it.
 */
export function RenderMarkdown({ measured, onUnknownHeight }: RenderMarkdownProps) {
	const { blocks, frame, contentWidth } = measured;
	const hostRef = useRef<HTMLDivElement | null>(null);

	// One-shot observe: if any unknown block is present, report the host's real
	// height after paint/layout. ResizeObserver is the controlled exception.
	const hasUnknown = useMemo(() => blocks.some((b) => b.kind === "unknown"), [blocks]);
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
				return (
					<BlockView
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are a stable ordered list
						key={index}
						block={block}
						frame={blockFrame}
						contentWidth={contentWidth}
						flowing={false}
					/>
				);
			})}
		</div>
	);
}

function BlockView({
	block,
	frame,
	contentWidth,
	flowing,
}: {
	block: PreparedBlock;
	frame: BlockFrame;
	contentWidth: number;
	/** When true, unknown blocks use relative flow instead of fixed absolute height. */
	flowing: boolean;
}) {
	switch (block.kind) {
		case "inline":
			return <InlineBlockView block={block} frame={frame} contentWidth={contentWidth} />;
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
function InlineBlockView({
	block,
	frame,
	contentWidth,
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	contentWidth: number;
}) {
	const lines = useMemo(() => {
		const lineWidth = Math.max(1, contentWidth - block.contentLeft);
		const out: Array<{
			fragments: Array<{
				text: string;
				font: string;
				className: string;
				href: string | null;
				gapBefore: number;
			}>;
		}> = [];
		walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: block.fonts[f.itemIndex] ?? "",
					className: block.classNames[f.itemIndex] ?? "",
					href: block.hrefs[f.itemIndex] ?? null,
					gapBefore: f.gapBefore,
				})),
			});
		});
		return out;
	}, [block, contentWidth]);
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
						opacity: 0.4,
					}}
				/>
			))}
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: block.contentLeft,
						top: quoteContentTop + lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						width: "max-content",
					}}
				>
					{line.fragments.map((frag, fi) =>
						frag.href != null ? (
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
								{frag.text}
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
								{frag.text}
							</span>
						),
					)}
				</div>
			))}
		</div>
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

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: boxWidth,
				height: frame.height,
				borderRadius: 4,
				background: "var(--mantine-color-dark-8)",
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
						color: "var(--mantine-color-gray-3)",
					}}
				>
					{line.text}
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
					background: "var(--mantine-color-dark-4)",
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
			case "katex":
				// Lightweight fallback: keep source visible; full KaTeX render is
				// optional/lazy and may be layered later without changing height wiring.
				return (
					<pre
						style={{
							margin: 0,
							padding: 8,
							font: CODE_FONT,
							whiteSpace: "pre-wrap",
							color: "var(--mantine-color-gray-3)",
						}}
					>
						{source || "(math)"}
					</pre>
				);
			default:
				return (
					<div
						style={{
							width: "100%",
							minHeight: frame.height,
							background: "var(--mantine-color-dark-6)",
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
