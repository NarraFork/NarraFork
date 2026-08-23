/**
 * RenderChatMessageBody.tsx — Draws a measured chat body at the EXACT geometry
 * `measureChatMessage` computed: every block absolutely positioned, every text
 * fragment painted with the font string the measure layer used.
 *
 * The font parity is load-bearing, not cosmetic. pretext bakes each fragment's
 * pixel advance into the prepared handle using a specific `font` string; painting
 * with a different one makes the browser wrap at different points, so the drawn
 * height diverges from the reserved height and the row either clips or leaves a
 * hole. This is the same rule `vlist/render/RenderMarkdown.tsx` follows.
 *
 * Zero DOM measurement here: chat bodies contain no unknown-height blocks (math
 * is not enabled and mermaid is retagged in `boundChatBody`), so there is nothing
 * to correct after paint.
 */

import { layoutWithLines } from "@chenglou/pretext";
import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import {
	handleMarkdownAnchorClick,
	MD_HEADING_SLUG_ATTR,
	markdownLinkTargetProps,
} from "@frontend/lib/markdown-anchor-scroll";
import { MARKDOWN_CONSTANTS } from "@shared/pretext-layout/parse-markdown";
import type {
	BlockFrame,
	PreparedCodeBlock,
	PreparedInlineBlock,
	PreparedTableBlock,
} from "@shared/pretext-layout/prepared-block";
import {
	DEFAULT_TABLE_METRICS,
	layoutTable,
	tableRowLineHeight,
} from "@shared/pretext-layout/prepared-block";
import { FONT_MARKDOWN_CODE } from "@shared/pretext-layout/pretext-fonts";
import { pretextLineMetrics } from "@shared/pretext-layout/pretext-metrics";
import { Fragment, useMemo } from "react";
import { CHAT_CODE_PADDING, type MeasuredChatMessage } from "./measure-chat-message";

/** Code panel border, per side. Folded into the measure layer's vertical padding. */
const CODE_PANEL_BORDER = 1;

/** Bounds ONE chat message for anchor resolution (see markdown-anchor-scroll). */
const MD_BODY_ATTR = "data-md-body";

/**
 * The font a fenced code line is painted with.
 *
 * MUST be the same string `parse-markdown` prepared the block with
 * (`FONT_MARKDOWN_CODE`), which is why it is imported rather than restated: a
 * different family or size would rewrap the code and break the reserved height.
 */
const CHAT_CODE_FONT = FONT_MARKDOWN_CODE;

export interface RenderChatMessageBodyProps {
	measured: MeasuredChatMessage;
	/** Rendered in place of the body when the message was soft-deleted. */
	deletedLabel: string;
}

export function RenderChatMessageBody({ measured, deletedLabel }: RenderChatMessageBodyProps) {
	if (measured.isDeletedPlaceholder) {
		return (
			<div
				style={{
					height: measured.bodyHeight,
					display: "flex",
					alignItems: "center",
					fontStyle: "italic",
					fontSize: "var(--mantine-font-size-sm)",
					color: "var(--mantine-color-dimmed)",
				}}
			>
				{deletedLabel}
			</div>
		);
	}

	return (
		<div
			data-chat-body
			// Bounds this message for same-document `#heading` anchor resolution, so a
			// link only finds headings in its own message rather than in whichever
			// message happens to come first in the room.
			{...{ [MD_BODY_ATTR]: "" }}
			style={{
				position: "relative",
				// Pinned to the measured height: the box never derives its size from
				// content, so a mispredicted line count can never move the rows below.
				height: measured.bodyHeight,
				// The wrap width the frame was computed at — NOT the shrink-wrapped
				// `usedWidth`, which is narrower and would re-wrap into a taller box.
				width: measured.contentWidth,
				overflow: "hidden",
			}}
		>
			{measured.blocks.map((block, index) => {
				const frame = measured.frame.blocks[index];
				if (!frame) return null;
				const key = `${block.kind}-${index}`;
				switch (block.kind) {
					case "inline":
						return (
							<ChatInlineBlock
								key={key}
								block={block}
								frame={frame}
								contentWidth={measured.contentWidth}
							/>
						);
					case "code":
						return (
							<ChatCodeBlock
								key={key}
								block={block}
								frame={frame}
								contentWidth={measured.contentWidth}
							/>
						);
					case "table":
						return (
							<ChatTableBlock
								key={key}
								block={block}
								frame={frame}
								contentWidth={measured.contentWidth}
							/>
						);
					case "rule":
						return (
							<div
								key={key}
								style={{
									position: "absolute",
									top: frame.top + Math.floor(frame.height / 2),
									left: block.contentLeft,
									right: 0,
									borderTop: "1px solid var(--mantine-color-default-border)",
								}}
							/>
						);
					// `fixed` carries no chat-specific payload today, and `unknown` is
					// unreachable (see the module header). Both reserve their space and
					// draw nothing rather than throwing inside a render pass.
					default:
						return null;
				}
			})}
		</div>
	);
}

interface InlineFragmentView {
	text: string;
	font: string;
	className: string;
	href: string | null;
	gapBefore: number;
}

function ChatInlineBlock({
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
		const out: InlineFragmentView[][] = [];
		walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push(
				line.fragments.map((fragment) => ({
					text: fragment.text,
					font: block.fonts[fragment.itemIndex] ?? "",
					className: block.classNames[fragment.itemIndex] ?? "",
					href: block.hrefs[fragment.itemIndex] ?? null,
					gapBefore: fragment.gapBefore,
				})),
			);
		});
		return out;
	}, [block, contentWidth]);

	const isQuote = block.quoteRailLefts.length > 0;
	const quotePaddingY = isQuote ? MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING : 0;
	const quoteContentTop = isQuote ? quotePaddingY + MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP : 0;

	return (
		<div
			data-chat-inline-block
			// Anchor target when this block is a heading. Attribute only — height-neutral,
			// so the reserved geometry is untouched.
			{...(block.headingSlug ? { [MD_HEADING_SLUG_ATTR]: block.headingSlug } : {})}
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				width: contentWidth,
				height: frame.height,
			}}
		>
			{isQuote ? (
				<div
					style={{
						position: "absolute",
						left: block.quoteRailLefts[0] ?? 0,
						top: 0,
						right: 0,
						bottom: 0,
						background: "var(--mantine-color-default-hover)",
						borderStartEndRadius: "var(--mantine-radius-sm)",
						borderEndEndRadius: "var(--mantine-radius-sm)",
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
			{lines.map((fragments, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					data-chat-line
					style={{
						position: "absolute",
						left: block.contentLeft,
						top: quoteContentTop + lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						minWidth: "max-content",
						width: `calc(100% - ${block.contentLeft}px)`,
					}}
				>
					{/*
					 * One block-level wrapper per line. CSS blockifies flex items, so
					 * without it the plain-text serializer would emit a newline around
					 * every inline fragment when the reader copies a selection.
					 * `flexShrink: 0` keeps the wrapper from being squeezed (which would
					 * rewrap the fragments and break the reserved height).
					 */}
					<span style={{ display: "block", flexShrink: 0, width: "max-content" }}>
						{fragments.map((fragment, fi) => (
							<Fragment
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
							>
								{/*
								 * pretext encodes inter-fragment spacing as PIXELS
								 * (`gapBefore` → margin-left), so the space is geometry and
								 * cannot be copied. A zero-font-size real space restores it
								 * for the serializer without adding any advance.
								 */}
								{fragment.gapBefore > 0 ? (
									<span aria-hidden style={{ fontSize: 0 }}>
										{" "}
									</span>
								) : null}
								{fragment.href != null ? (
									<a
										href={fragment.href}
										// A `#heading` anchor scrolls inside this message's own scroller
										// instead of navigating; real destinations still open in a new tab.
										{...markdownLinkTargetProps(fragment.href)}
										onClick={(event) => {
											handleMarkdownAnchorClick(
												event,
												fragment.href,
												event.currentTarget.closest(`[${MD_BODY_ATTR}]`),
											);
										}}
										className={fragment.className}
										style={{
											font: fragment.font,
											marginLeft: fragment.gapBefore,
											whiteSpace: "pre",
											display: "inline-block",
										}}
									>
										{fragment.text}
									</a>
								) : (
									<span
										className={fragment.className}
										style={{
											font: fragment.font,
											marginLeft: fragment.gapBefore,
											whiteSpace: "pre",
											display: "inline-block",
										}}
									>
										{fragment.text}
									</span>
								)}
							</Fragment>
						))}
					</span>
				</div>
			))}
		</div>
	);
}

function ChatCodeBlock({
	block,
	frame,
	contentWidth,
}: {
	block: PreparedCodeBlock;
	frame: BlockFrame;
	contentWidth: number;
}) {
	const { x: padX, y: padY } = CHAT_CODE_PADDING;
	const langTop = block.lang != null ? padY + MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP : padY;
	const boxWidth = Math.max(1, contentWidth - block.contentLeft);
	const innerWidth = Math.max(1, boxWidth - padX * 2);
	const lines = useMemo(
		() => layoutWithLines(block.prepared, innerWidth, block.lineHeight).lines,
		[block, innerWidth],
	);

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: boxWidth,
				height: frame.height,
				borderRadius: "var(--mantine-radius-sm)",
				background: "var(--mantine-color-default)",
				border: `${CODE_PANEL_BORDER}px solid var(--mantine-color-default-border)`,
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
						// Absolute children sit against the PADDING box, which is one
						// border inside the border-box the frame height describes.
						top: langTop + lineIndex * block.lineHeight - CODE_PANEL_BORDER,
						left: 0,
						width: Math.max(1, boxWidth - CODE_PANEL_BORDER * 2),
						height: block.lineHeight,
						paddingLeft: padX - CODE_PANEL_BORDER,
						boxSizing: "border-box",
						minWidth: "max-content",
						whiteSpace: "pre",
						font: CHAT_CODE_FONT,
						// MUST stay after `font`: the shorthand resets line-height to
						// `normal`, which would paint the text off the reserved line box.
						lineHeight: `${block.lineHeight}px`,
						color: "var(--mantine-color-text)",
					}}
				>
					{line.text}
				</div>
			))}
		</div>
	);
}

function ChatTableBlock({
	block,
	frame,
	contentWidth,
}: {
	block: PreparedTableBlock;
	frame: BlockFrame;
	contentWidth: number;
}) {
	// The same metrics object the measure layer used, so the row heights this
	// render solves are byte-identical to the ones reserved.
	const metrics = DEFAULT_TABLE_METRICS;
	const boxWidth = Math.max(1, contentWidth - block.contentLeft);
	const layout = useMemo(
		() => layoutTable(block, boxWidth, pretextLineMetrics, DEFAULT_TABLE_METRICS),
		[block, boxWidth],
	);

	const rows = block.header.length > 0 ? [block.header, ...block.rows] : block.rows;

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: block.contentLeft,
				width: boxWidth,
				height: frame.height,
				overflowX: layout.overflowing ? "auto" : "hidden",
				overflowY: "hidden",
				scrollbarWidth: "thin",
			}}
		>
			<div style={{ position: "relative", width: layout.tableWidth, height: frame.height }}>
				{rows.map((cells, rowIndex) => {
					const top = layout.rowHeights.slice(0, rowIndex).reduce((sum, height) => sum + height, 0);
					const rowHeight = layout.rowHeights[rowIndex] ?? 0;
					const lineHeight = tableRowLineHeight(cells, block.lineHeight);
					let left = 0;
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
							key={rowIndex}
							style={{
								position: "absolute",
								top,
								left: 0,
								width: layout.tableWidth,
								height: rowHeight,
								borderBottom: `${metrics.rowBorder}px solid var(--mantine-color-default-border)`,
								boxSizing: "border-box",
							}}
						>
							{cells.map((cell, cellIndex) => {
								const columnWidth = layout.columnWidths[cellIndex] ?? 0;
								const cellLeft = left;
								left += columnWidth + metrics.paddingX * 2;
								return (
									<ChatTableCell
										// biome-ignore lint/suspicious/noArrayIndexKey: cells are a stable ordered list
										key={cellIndex}
										cell={cell}
										left={cellLeft + metrics.paddingX}
										top={metrics.paddingY}
										width={columnWidth}
										lineHeight={lineHeight}
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

function ChatTableCell({
	cell,
	left,
	top,
	width,
	lineHeight,
}: {
	cell: PreparedTableBlock["rows"][number][number];
	left: number;
	top: number;
	width: number;
	lineHeight: number;
}) {
	const lines = useMemo(() => {
		const out: InlineFragmentView[][] = [];
		walkRichInlineLineRanges(cell.flow, width, (range) => {
			const line = materializeRichInlineLineRange(cell.flow, range);
			out.push(
				line.fragments.map((fragment) => ({
					text: fragment.text,
					font: cell.fonts[fragment.itemIndex] ?? "",
					className: cell.classNames[fragment.itemIndex] ?? "",
					href: cell.hrefs?.[fragment.itemIndex] ?? null,
					gapBefore: fragment.gapBefore,
				})),
			);
		});
		return out;
	}, [cell, width]);

	return (
		<div style={{ position: "absolute", left, top, width }}>
			{lines.map((fragments, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						top: lineIndex * lineHeight,
						left: 0,
						width,
						height: lineHeight,
						display: "flex",
						alignItems: "center",
					}}
				>
					<span style={{ display: "block", flexShrink: 0, width: "max-content" }}>
						{fragments.map((fragment, fi) => (
							<Fragment
								// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
								key={fi}
							>
								{fragment.gapBefore > 0 ? (
									<span aria-hidden style={{ fontSize: 0 }}>
										{" "}
									</span>
								) : null}
								<span
									className={fragment.className}
									style={{
										font: fragment.font,
										marginLeft: fragment.gapBefore,
										whiteSpace: "pre",
										display: "inline-block",
									}}
								>
									{fragment.text}
								</span>
							</Fragment>
						))}
					</span>
				</div>
			))}
		</div>
	);
}
