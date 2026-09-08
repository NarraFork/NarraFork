import type { CSSProperties } from "react";
import { AutoFollowScroll, type ContentViewportLayout } from "../AutoFollowScroll";
import { ContentBody } from "../ContentBody";
import type { VListViewTarget } from "./vlist-content-view-target";

/** Fullscreen paint budget. Copy retains the original available payload. */
export const VIEW_MODAL_MAX_CHARS = 120_000;

export function isMarkdownTarget(target: VListViewTarget): boolean {
	return target.kind === "markdown";
}

export function clampViewText(text: string): { text: string; clamped: boolean } {
	return text.length > VIEW_MODAL_MAX_CHARS
		? { text: text.slice(0, VIEW_MODAL_MAX_CHARS), clamped: true }
		: { text, clamped: false };
}

export interface VListViewBodyProps {
	/** Declared Diff fullscreen viewport only; code/markdown always retain the DOM path. */
	layout?: ContentViewportLayout;
	target: VListViewTarget;
	wordWrap: boolean;
	showSource: boolean;
	text: string;
	style?: CSSProperties;
}

/** A fresh viewport, not a fresh source model: inline and modal readers are independent. */
export function VListViewBody({
	layout,
	target,
	wordWrap,
	showSource,
	text,
	style,
}: VListViewBodyProps) {
	const model = target.model;
	return (
		<AutoFollowScroll
			bodyId={target.id}
			layout={target.kind === "diff" ? layout : undefined}
			live={model?.live}
			revision={model?.revision}
			followTarget={target.kind === "diff" ? "row" : "end"}
			style={{ flex: 1, minHeight: 0 }}
			viewportStyle={{ height: "100%", overflowX: wordWrap ? "hidden" : "auto" }}
			contentStyle={style}
		>
			<ContentBody
				format={target.kind === "term" ? "text" : target.kind}
				text={text}
				diffDocument={model?.diffDocument}
				wordWrap={wordWrap}
				showSource={showSource}
				language={model?.codeLang ?? target.codeLang}
				codeLangPath={model?.codeLangPath ?? target.codeLangPath}
				fileReferenceContext={target.fileReferenceContext ?? null}
				style={style}
			/>
		</AutoFollowScroll>
	);
}
