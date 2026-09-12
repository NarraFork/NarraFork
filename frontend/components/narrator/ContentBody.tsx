import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Code } from "@mantine/core";
import type { FileReferenceContext } from "@shared/file-reference";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import type { DiffDocument } from "@shared/pretext-layout/diff-core";
import { type CSSProperties, lazy, Suspense } from "react";
import { DiffContent } from "./diff/DiffContent";
import { FileReferenceScopeProvider } from "./FileReferenceScope";
import { MarkdownContent } from "./markdown/MarkdownContent";

const HighlightedCode = lazy(() =>
	import("./markdown/HighlightedCode").then((module) => ({ default: module.HighlightedCode })),
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
