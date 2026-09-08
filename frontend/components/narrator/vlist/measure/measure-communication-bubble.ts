/** Outgoing teammate messages: the injection bubble's geometry, with bounded body viewing. */
import {
	COMMUNICATION_PREVIEW_MAX_CHARS,
	limitCommunicationPreview,
} from "@shared/communication-tool";
import { DEFAULT_RENDER_LOD, type MeasuredElement, type RenderLod } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import {
	INJECTION_BUBBLE_PADDING,
	INJECTION_NOTE_GAP,
	measureInjectionBubble,
} from "./measure-injection-bubble";

export const COMMUNICATION_BODY_MAX_CHARS = COMMUNICATION_PREVIEW_MAX_CHARS;
export const COMMUNICATION_BODY_MAX_HEIGHT = 480;
export const COMMUNICATION_ERROR_MAX_CHARS = 2048;

/** Structural subset: shared adapter data owns recipients and tool/source identity. */
export interface MeasureCommunicationBubbleInput {
	message: string;
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
): MeasuredCommunicationBubble {
	// Reuse the framed markdown's width discipline, including the second pass for
	// full-bleed code blocks. Never re-wrap in the render copy's narrower frame.
	const preview = limitCommunicationPreview(input.message);
	const body = measureInjectionBubble({ markdown: preview.text }, contentWidth, lod);
	const bodyHeight = Math.min(body.frame.contentHeight, COMMUNICATION_BODY_MAX_HEIGHT);
	const isTruncated =
		input.messageTruncated === true || preview.truncated || bodyHeight < body.frame.contentHeight;
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
