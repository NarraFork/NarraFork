import { prepareWithSegments } from "@chenglou/pretext";
import {
	constrainTextPreview,
	selectTextPreview,
	TEXT_PREVIEW_LINES,
} from "@shared/pretext-layout/text-preview";
import { accumulateFrame, type MeasuredElement, type PreparedBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";
import { pretextLineMetrics } from "./pretext-metrics";

export interface TextPreviewOptions {
	textExpanded?: boolean;
	direction?: "head" | "tail";
	preparedBlocks?: PreparedBlock[];
}

/** Long live tails are plain text: no guessing the omitted Markdown context. */
export function measureTextPreview(
	sourceText: string,
	contentWidth: number,
	opts: TextPreviewOptions = {},
): MeasuredElement {
	const expanded = opts.textExpanded === true;
	const direction = opts.direction ?? "head";
	const selected = selectTextPreview(sourceText, expanded, direction);
	const metrics = typographyMetrics();
	let measured: MeasuredElement;
	// First measure bounded markdown to discover height overflow; a live tail must
	// then use literal text even when only the HEIGHT (not chars) clips its context.
	const md =
		!expanded && direction === "tail" && selected.truncated
			? null
			: measureMarkdown(selected.text, contentWidth, {
					...(!selected.truncated && opts.preparedBlocks
						? { preparedBlocks: opts.preparedBlocks }
						: {}),
				});
	const plainText =
		!expanded &&
		direction === "tail" &&
		(selected.truncated || (md?.height ?? 0) > metrics.line.body * TEXT_PREVIEW_LINES);
	if (plainText) {
		const blocks: PreparedBlock[] = [
			{
				kind: "code",
				prepared: prepareWithSegments(selected.text, metrics.font.body, { whiteSpace: "pre-wrap" }),
				lang: null,
				lineHeight: metrics.line.body,
				marginTop: 0,
				contentLeft: 0,
				quoteRailLefts: [],
				markerText: null,
				markerLeft: null,
				markerClassName: null,
			},
		];
		const frame = accumulateFrame(blocks, contentWidth, pretextLineMetrics);
		measured = {
			blocks,
			frame,
			height: frame.contentHeight,
			contentWidth,
			usedWidth: frame.usedWidth,
		};
	} else {
		measured = md ?? measureMarkdown(selected.text, contentWidth);
	}
	if (selected.truncated) {
		measured = {
			...measured,
			blocks: measured.blocks.map((block) =>
				block.kind === "code" ? { ...block, copyText: null } : block,
			),
		};
	}
	return constrainTextPreview(
		measured,
		{
			sourceText,
			previewText: selected.text,
			charCount: sourceText.length,
			expanded,
			direction,
			plainText,
			sourceStart: selected.start,
		},
		metrics.line.body * TEXT_PREVIEW_LINES,
		metrics.line.xs,
	);
}
