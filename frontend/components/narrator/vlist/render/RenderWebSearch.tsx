/**
 * RenderWebSearch.tsx — Render copy for the `web_search` block.
 *
 * Pairs with measure-web-search.ts. Draws the bordered card at the measured
 * geometry using absolute positioning so the rendered height matches the
 * predicted height exactly (zero DOM measurement here).
 *
 * Layout (mirrors MessageBubble.tsx WebSearchBlock):
 *   Paper withBorder radius="sm" p="xs" (boxSizing border-box, height = measured)
 *     content lane (relative, height = rowHeight):
 *       ThemeIcon size={18}            at left 0, vertically centred
 *       [Loader size={12}]             at left 24, vertically centred (searching)
 *       text lines                     at left chromeLeft, vertically centred
 *
 * CRITICAL: each text fragment is painted with the SAME font string that was
 * measured (block.fonts[itemIndex]); label vs query colour comes from the
 * fragment class the measure layer tagged.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Loader, Paper, ThemeIcon } from "@mantine/core";
import { IconWorldSearch } from "@tabler/icons-react";
import { useMemo } from "react";
import {
	WEB_SEARCH_BORDER,
	WEB_SEARCH_ICON_SIZE,
	WEB_SEARCH_LABEL_CLASS,
	WEB_SEARCH_LOADER_SIZE,
	WEB_SEARCH_PADDING,
	WEB_SEARCH_QUERY_CLASS,
	webSearchChromeLeft,
} from "../measure/measure-web-search";
import type { MeasuredElement, PreparedInlineBlock } from "../prepared-block";

interface RenderWebSearchProps {
	measured: MeasuredElement;
	/** Whether the block is still searching (shows the loader). */
	isSearching?: boolean;
}

const LABEL_COLOR = "var(--mantine-color-dimmed)";
const QUERY_COLOR = "var(--mantine-color-teal-4)";

export function RenderWebSearch({ measured, isSearching = false }: RenderWebSearchProps) {
	const { blocks, frame, contentWidth } = measured;
	const textBlock = blocks[0] as PreparedInlineBlock | undefined;
	const textFrame = frame.blocks[0];

	const chromeLeft = webSearchChromeLeft(isSearching);
	// Content-lane height inside the padding+border (== measured rowHeight).
	const laneHeight = measured.height - WEB_SEARCH_PADDING * 2 - WEB_SEARCH_BORDER * 2;
	const textHeight = textFrame?.height ?? WEB_SEARCH_ICON_SIZE;

	const lines = useMemo(() => {
		if (!textBlock || textBlock.kind !== "inline") return [];
		const lineWidth = Math.max(1, contentWidth - chromeLeft);
		const out: Array<{
			fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
		}> = [];
		walkRichInlineLineRanges(textBlock.flow, lineWidth, (range) => {
			const line = materializeRichInlineLineRange(textBlock.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: textBlock.fonts[f.itemIndex] ?? "",
					className: textBlock.classNames[f.itemIndex] ?? "",
					gapBefore: f.gapBefore,
				})),
			});
		});
		return out;
	}, [textBlock, contentWidth, chromeLeft]);

	const lineHeight = textBlock?.kind === "inline" ? textBlock.lineHeight : WEB_SEARCH_ICON_SIZE;
	// Vertical centring offsets within the content lane (mirrors Group align=center).
	const iconTop = Math.max(0, (laneHeight - WEB_SEARCH_ICON_SIZE) / 2);
	const loaderTop = Math.max(0, (laneHeight - WEB_SEARCH_LOADER_SIZE) / 2);
	const textTop = Math.max(0, (laneHeight - textHeight) / 2);

	return (
		<Paper
			withBorder
			radius="sm"
			p="xs"
			style={{
				position: "relative",
				width: contentWidth,
				height: measured.height,
				boxSizing: "border-box",
			}}
		>
			<div style={{ position: "relative", width: "100%", height: laneHeight }}>
				<ThemeIcon
					size={WEB_SEARCH_ICON_SIZE}
					variant="light"
					color="teal"
					radius="sm"
					style={{ position: "absolute", left: 0, top: iconTop }}
				>
					<IconWorldSearch size={12} />
				</ThemeIcon>
				{isSearching ? (
					<div
						style={{
							position: "absolute",
							left: WEB_SEARCH_ICON_SIZE + 6,
							top: loaderTop,
						}}
					>
						<Loader size={WEB_SEARCH_LOADER_SIZE} color="teal" type="dots" />
					</div>
				) : null}
				<div style={{ position: "absolute", left: chromeLeft, top: textTop, right: 0 }}>
					{lines.map((line, lineIndex) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
							key={lineIndex}
							style={{
								position: "absolute",
								left: 0,
								top: lineIndex * lineHeight,
								height: lineHeight,
								display: "flex",
								alignItems: "center",
								width: "max-content",
							}}
						>
							{line.fragments.map((frag, fi) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
									key={fi}
									style={{
										font: frag.font,
										marginLeft: frag.gapBefore,
										whiteSpace: "pre",
										display: "inline-block",
										color: fragColor(frag.className),
									}}
								>
									{frag.text}
								</span>
							))}
						</div>
					))}
				</div>
			</div>
		</Paper>
	);
}

function fragColor(className: string): string {
	if (className === WEB_SEARCH_QUERY_CLASS) return QUERY_COLOR;
	if (className === WEB_SEARCH_LABEL_CLASS) return LABEL_COLOR;
	return LABEL_COLOR;
}
