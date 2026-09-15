import { getShikiLang } from "@frontend/lib/shiki-lang";
import {
	STRUCT_THEME_DARK,
	STRUCT_THEME_LIGHT,
	tokenizeStructViewBody,
} from "@frontend/lib/struct-view-tokens";
import { Code, useComputedColorScheme } from "@mantine/core";
import type { FileReferenceContext } from "@shared/file-reference";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import type { DiffDocument } from "@shared/pretext-layout/diff-core";
import { type CSSProperties, lazy, Suspense, useMemo } from "react";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { DiffContent } from "../diff/DiffContent";
import { MarkdownContent } from "../markdown/MarkdownContent";
import { TokenFlowText } from "../vlist/render/TokenLines";

const HighlightedCode = lazy(() =>
	import("../markdown/HighlightedCode").then((module) => ({ default: module.HighlightedCode })),
);

/** The painter has no scrollport, ref, follow state, or reader-progress listener. */
export interface ContentBodyProps {
	format: "text" | "code" | "markdown" | "diff";
	text: string;
	diffDocument?: DiffDocument;
	wordWrap?: boolean;
	showSource?: boolean;
	language?: string;
	codeLangPath?: string;
	/** Colour a structured report by its own grammar instead of a language's. */
	customHighlight?: "struct-view";
	contentWidth?: number;
	streaming?: boolean;
	maxHighlightChars?: number;
	fileReferenceContext?: FileReferenceContext | null;
	style?: CSSProperties;
}

export function contentLanguage(language?: string, path?: string): string | undefined {
	const resolved = language || (path ? getShikiLang(path) : undefined);
	return resolved === "text" ? undefined : resolved;
}

/** Report colours for the chunked surface; the vlist has its own copy of this pairing. */
function CustomHighlightedContent({ text, kind }: { text: string; kind: "struct-view" }) {
	const dark = useComputedColorScheme("dark") !== "light";
	const tokens = useMemo(
		() =>
			kind === "struct-view"
				? tokenizeStructViewBody(text, dark ? STRUCT_THEME_DARK : STRUCT_THEME_LIGHT)
				: null,
		[text, kind, dark],
	);
	return <TokenFlowText text={text} tokens={tokens} />;
}

export function contentWrapStyle(wordWrap: boolean): CSSProperties {
	return wordWrap
		? { whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "break-word" }
		: { whiteSpace: "pre", wordBreak: "normal", overflowWrap: "normal" };
}

export function ContentBody({
	format,
	text,
	diffDocument,
	wordWrap = true,
	showSource = false,
	language,
	codeLangPath,
	customHighlight,
	contentWidth,
	streaming,
	maxHighlightChars,
	fileReferenceContext,
	style,
}: ContentBodyProps) {
	const lang = contentLanguage(language, codeLangPath);
	if (format === "diff") {
		return (
			<DiffContent
				document={diffDocument}
				language={lang}
				wordWrap={wordWrap}
				contentWidth={contentWidth}
			/>
		);
	}
	if (format === "markdown" && !showSource) {
		const markdown = <MarkdownContent text={text} wordWrap={wordWrap} streaming={streaming} />;
		return (
			<div style={{ minWidth: 0, ...style }}>
				{fileReferenceContext === undefined ? (
					markdown
				) : (
					<FileReferenceScopeProvider
						value={{ context: normalizeFileReferenceContext(fileReferenceContext) }}
					>
						{markdown}
					</FileReferenceScopeProvider>
				)}
			</div>
		);
	}
	const paintStyle: CSSProperties = {
		margin: 0,
		maxWidth: "100%",
		...style,
		...contentWrapStyle(wordWrap),
		// Mantine Code's block default scrolls; only the surrounding viewport may do that.
		overflow: "visible",
		maxHeight: undefined,
	};
	const plain = (
		<Code block style={paintStyle}>
			{text}
		</Code>
	);
	// A report body is coloured by its own tokenizer, not a language grammar. Kept in sync
	// with the vlist path on purpose: two card surfaces showing the same body in different
	// colours would be worse than leaving one of them plain.
	if (customHighlight && !showSource && format !== "markdown") {
		return (
			<Code block style={paintStyle}>
				<CustomHighlightedContent text={text} kind={customHighlight} />
			</Code>
		);
	}
	return lang && format !== "markdown" ? (
		<Suspense fallback={plain}>
			<HighlightedCode
				code={text}
				lang={lang}
				style={paintStyle}
				maxHighlightChars={maxHighlightChars}
			/>
		</Suspense>
	) : (
		plain
	);
}
