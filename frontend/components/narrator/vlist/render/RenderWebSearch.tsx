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
 *       text lines                     at left chromeLeft, top of the lane
 *
 * CRITICAL: each text fragment is painted with the SAME font string that was
 * measured (block.fonts[itemIndex]); label vs query colour comes from the
 * fragment class the measure layer tagged.
 *
 * Vertical alignment: the 17px xs line box next to the 18px icon already looks
 * a hair low, and an inherited body strut (16px × 1.55) makes it worse — the
 * inline-block fragments sit on that strut's baseline, so the ink reads a few
 * pixels below the icon. Kill the strut (`fontSize: 0` on the line) and paint
 * fragments at `lineHeight: 1` so flex can centre the 12px em-box in the
 * reserved line, matching RenderMedia's header row.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { Divider, Loader, Paper, ThemeIcon } from "@mantine/core";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { IconWorldSearch } from "@tabler/icons-react";
import { Fragment, useMemo } from "react";
import {
	type MeasuredWebSearch,
	WEB_SEARCH_BORDER,
	WEB_SEARCH_ICON_SIZE,
	WEB_SEARCH_LABEL_CLASS,
	WEB_SEARCH_LOADER_SIZE,
	WEB_SEARCH_PADDING,
	WEB_SEARCH_QUERY_CLASS,
	webSearchChromeLeft,
} from "../measure/measure-web-search";
import type { MeasuredElement, PreparedInlineBlock } from "../prepared-block";
import { FragmentGap, LineFragments } from "./line-fragments";

interface RenderWebSearchProps {
	measured: MeasuredElement;
	/** Whether the block is still searching (shows the loader). */
	isSearching?: boolean;
}

const LABEL_COLOR = "var(--mantine-color-dimmed)";
/* Scheme-aware `c="teal"` equivalent: teal-4 on dark, teal-filled on light. */
const QUERY_COLOR = "var(--mantine-color-teal-text)";

export function RenderWebSearch({ measured, isSearching = false }: RenderWebSearchProps) {
	const { blocks, contentWidth } = measured;
	const { inRun, isLast } = measured as Partial<MeasuredWebSearch>;
	const divider = inRun && !isLast ? 1 : 0;
	const border = inRun ? 0 : WEB_SEARCH_BORDER * 2;
	const textBlock = blocks[0] as PreparedInlineBlock | undefined;

	const chromeLeft = webSearchChromeLeft(isSearching);
	// Content-lane height inside the padding+border (== measured rowHeight).
	const laneHeight = measured.height - WEB_SEARCH_PADDING * 2 - border - divider;

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
	// Icon (+ optional loader) is centred in the lane. Text starts at the top
	// (`textTop` is always 0: the reserved row is max(icon, text), so there is
	// never leftover vertical slack to split). Optical centring of the 12px
	// glyphs against the 18px icon happens inside each 17px line — see the
	// fontSize:0 / lineHeight:1 notes on the line box below.
	const iconTop = Math.max(0, (laneHeight - WEB_SEARCH_ICON_SIZE) / 2);
	const loaderTop = Math.max(0, (laneHeight - WEB_SEARCH_LOADER_SIZE) / 2);

	return (
		<div>
			<Paper
				withBorder={!inRun}
				radius={inRun ? 0 : "sm"}
				p="xs"
				style={{
					position: "relative",
					width: "100%",
					height: measured.height - divider,
					...(inRun ? { border: 0, background: "transparent" } : {}),
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
					<div
						data-vlist-ws-text=""
						style={{ position: "absolute", left: chromeLeft, top: 0, right: 0 }}
					>
						{lines.map((line, lineIndex) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
								key={lineIndex}
								data-vlist-ws-line=""
								style={{
									position: "absolute",
									left: 0,
									top: lineIndex * lineHeight,
									height: lineHeight,
									display: "flex",
									alignItems: "center",
									width: "max-content",
									// Kill the inherited body strut (16px × 1.55). Without this the
									// inline-block fragments sit on that taller baseline and the
									// 12px ink reads several pixels below the 18px icon.
									fontSize: 0,
									lineHeight: 1,
								}}
							>
								<LineFragments>
									{line.fragments.map((frag, fi) => (
										<Fragment
											// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
											key={fi}
										>
											<FragmentGap gapBefore={frag.gapBefore} />
											<span
												style={{
													...fragmentTextStyle({
														font: frag.font,
														gapBefore: frag.gapBefore,
														letterSpacing: letterSpacingForFont(frag.font),
													}),
													// `font` restores the 12px size the parent zeroed out.
													// lineHeight:1 shrinks the box to the em-square so flex
													// can centre the glyphs in the reserved 17px line.
													lineHeight: 1,
													color: fragColor(frag.className),
												}}
											>
												{frag.text}
											</span>
										</Fragment>
									))}
								</LineFragments>
							</div>
						))}
					</div>
				</div>
			</Paper>
			{divider ? <Divider color="var(--mantine-color-default-border)" size={1} /> : null}
		</div>
	);
}

function fragColor(className: string): string {
	if (className === WEB_SEARCH_QUERY_CLASS) return QUERY_COLOR;
	if (className === WEB_SEARCH_LABEL_CLASS) return LABEL_COLOR;
	return LABEL_COLOR;
}
