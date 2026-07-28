/**
 * vlist-content-view-body.tsx — the fullscreen viewer's body renderer, shared by
 * every visual a `VListViewTarget` can take.
 *
 * Kept separate from the modal shell (and from the action bar) so the three
 * visuals — diff, markdown, highlighted code — live in ONE place. The chunked
 * `ContentViewer` has the same three branches inline; duplicating them a second
 * time in the vlist modal is how the two paths would drift.
 *
 * Nothing here participates in the height model: the modal is a portal, and the
 * inline bodies this module's `wrapStyle` feeds are fixed-height, internally
 * scrolling boxes (see vlist-content-view-target.ts's header note).
 */

import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Code } from "@mantine/core";
import { type CSSProperties, lazy, Suspense } from "react";
import { DiffView } from "../DiffView";
import { MarkdownContent } from "../MarkdownContent";
import type { VListViewTarget } from "./vlist-content-view-target";

/**
 * The modal renders at most this many characters. Mirrors ContentViewer's
 * MODAL_FULL_CONTENT_MAX_CHARS: a multi-megabyte payload would otherwise freeze
 * the tab on open, and copy still yields the whole thing.
 */
export const VIEW_MODAL_MAX_CHARS = 120_000;

const HighlightedCode = lazy(() =>
	import("../HighlightedCode").then((module) => ({ default: module.HighlightedCode })),
);

/** Wrap vs horizontal-scroll, matching ContentViewer's two states exactly. */
export function wrapStyle(wordWrap: boolean): CSSProperties {
	return wordWrap
		? { whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "hidden" }
		: { whiteSpace: "pre", overflowX: "auto" };
}

/** Resolve a target's Shiki language id, or undefined for plain text. */
export function resolveTargetLang(target: VListViewTarget): string | undefined {
	if (target.codeLang) return target.codeLang;
	if (target.codeLangPath) {
		const lang = getShikiLang(target.codeLangPath);
		return lang === "text" ? undefined : lang;
	}
	return undefined;
}

/** Whether the target's body can be shown as rendered markdown. */
export function isMarkdownTarget(target: VListViewTarget): boolean {
	return target.kind === "markdown";
}

/**
 * Clamp the body for display and report whether anything was cut, so the caller
 * can append the same "[preview truncated]" notice the chunked modal uses.
 */
export function clampViewText(text: string): { text: string; clamped: boolean } {
	return text.length > VIEW_MODAL_MAX_CHARS
		? { text: text.slice(0, VIEW_MODAL_MAX_CHARS), clamped: true }
		: { text, clamped: false };
}

export interface VListViewBodyProps {
	target: VListViewTarget;
	/** Soft-wrap (markdown/code) or horizontal scroll. */
	wordWrap: boolean;
	/** Markdown targets only: show the raw source instead of the rendered form. */
	showSource: boolean;
	/** Body text to paint (already clamped / suffixed by the caller). */
	text: string;
	/** Extra styles for the scrolling body box. */
	style?: CSSProperties;
}

/**
 * One body, in whichever visual its target calls for. Fills its parent (the
 * caller owns the height), so the modal can hand it the remaining flex space.
 */
export function VListViewBody({ target, wordWrap, showSource, text, style }: VListViewBodyProps) {
	const fill: CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", ...style };

	if (target.kind === "diff" && target.diff) {
		return (
			<div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
				<DiffView
					oldStr={target.diff.oldStr}
					newStr={target.diff.newStr}
					maxHeight={undefined}
					wordWrap={wordWrap}
					language={resolveTargetLang(target)}
				/>
			</div>
		);
	}

	if (isMarkdownTarget(target) && !showSource) {
		return (
			<div style={{ ...fill, minWidth: 0 }}>
				<MarkdownContent text={text} wordWrap={wordWrap} />
			</div>
		);
	}

	const lang = isMarkdownTarget(target) ? undefined : resolveTargetLang(target);
	const bodyStyle: CSSProperties = { ...fill, ...wrapStyle(wordWrap), maxWidth: "100%" };
	if (lang) {
		return (
			<Suspense
				fallback={
					<Code block style={bodyStyle}>
						{text}
					</Code>
				}
			>
				<HighlightedCode code={text} lang={lang} style={bodyStyle} />
			</Suspense>
		);
	}
	return (
		<Code block style={bodyStyle}>
			{text}
		</Code>
	);
}
