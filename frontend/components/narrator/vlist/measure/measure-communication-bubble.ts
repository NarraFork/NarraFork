/** Outgoing teammate messages: the injection bubble's geometry, with bounded body viewing. */
import {
	TEXT_PREVIEW_BUTTON_GAP,
	TEXT_PREVIEW_LINES,
	TEXT_PREVIEW_MAX_CHARS,
} from "@shared/pretext-layout/text-preview";
import { DEFAULT_RENDER_LOD, type MeasuredElement, type RenderLod } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import {
	INJECTION_BUBBLE_PADDING,
	INJECTION_NOTE_GAP,
	measureInjectionBubble,
} from "./measure-injection-bubble";
import type { TextPreviewOptions } from "./measure-text-preview";

export const COMMUNICATION_BODY_MAX_CHARS = TEXT_PREVIEW_MAX_CHARS;
/** Neutral-typography snapshot; runtime measurement follows the active line metric. */
export const COMMUNICATION_BODY_MAX_HEIGHT = typographyMetrics().line.body * TEXT_PREVIEW_LINES;
export const COMMUNICATION_ERROR_MAX_CHARS = 2048;

/** Structural subset: shared adapter data owns recipients and tool/source identity. */
export interface MeasureCommunicationBubbleInput {
	message: string;
	messageBody?: { text?: string; textTruncated?: boolean };
	sourceTruncated?: boolean;
	messageTruncated?: boolean;
	status?: string;
	error?: string | null;
	warning?: string | null;
}

export interface MeasuredCommunicationBubble extends MeasuredElement {
	form: "communication";
	measuredMarkdown: string;
	bodyTop: number;
	bodyHeight: number;
	/** A capped error line is separate from the body, so long messages cannot hide failures. */
	errorTop: number;
	errorText: string;
	warningTop: number;
	warningText: string;
	viewFullTop: number;
	isTruncated: boolean;
}

export function measureCommunicationBubble(
	input: MeasureCommunicationBubbleInput,
	contentWidth: number,
	lod: RenderLod = DEFAULT_RENDER_LOD,
	opts: TextPreviewOptions = {},
): MeasuredCommunicationBubble {
	// Reuse the framed markdown's width discipline, including the second pass for
	// full-bleed code blocks. Never re-wrap in the render copy's narrower frame.
	const sourceText = input.messageBody?.text ?? input.message;
	const isTruncated =
		input.sourceTruncated ?? input.messageBody?.textTruncated ?? input.messageTruncated === true;
	const body = measureInjectionBubble({ markdown: sourceText }, contentWidth, lod, opts);
	// True upstream truncation also needs an in-place fetch/disclosure affordance
	// even when the available prefix happens to be short.
	if (isTruncated) {
		body.textPreview = {
			...(body.textPreview ?? {
				sourceText,
				previewText: body.measuredMarkdown,
				charCount: sourceText.length,
				expanded: opts.textExpanded === true,
				clipped: false,
				direction: "head" as const,
				plainText: false,
				bodyHeight: body.frame.contentHeight,
				sourceStart: 0,
			}),
			buttonHeight:
				body.textPreview?.buttonHeight || typographyMetrics().line.xs + TEXT_PREVIEW_BUTTON_GAP,
		};
	}
	const bodyHeight = body.frame.contentHeight + (body.textPreview?.buttonHeight ?? 0);
	const hasError =
		Boolean(input.error) ||
		input.status === "fail" ||
		input.status === "error" ||
		input.status === "failed";
	const lineHeight = typographyMetrics().line.xs;
	let bottom = body.bodyTop + bodyHeight;
	const errorTop = hasError ? bottom + INJECTION_NOTE_GAP : -1;
	const warningTop = !hasError && input.warning ? bottom + INJECTION_NOTE_GAP : -1;
	if (hasError) bottom = errorTop + lineHeight;
	else if (warningTop >= 0) bottom = warningTop + lineHeight;
	const viewFullTop = isTruncated ? bottom + INJECTION_NOTE_GAP : -1;
	if (isTruncated) bottom = viewFullTop + lineHeight;
	return {
		form: "communication",
		textPreview: body.textPreview,
		height: bottom + INJECTION_BUBBLE_PADDING,
		blocks: body.blocks,
		frame: body.frame,
		contentWidth: body.contentWidth,
		usedWidth: body.usedWidth,
		measuredMarkdown: body.measuredMarkdown,
		bodyTop: body.bodyTop,
		bodyHeight,
		errorTop,
		errorText: input.error?.slice(0, COMMUNICATION_ERROR_MAX_CHARS) ?? "",
		warningTop,
		warningText: input.warning?.slice(0, COMMUNICATION_ERROR_MAX_CHARS) ?? "",
		viewFullTop,
		isTruncated,
	};
}
