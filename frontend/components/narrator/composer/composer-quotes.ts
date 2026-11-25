import {
	COMPOSER_ATTACHMENT_PLACEHOLDER,
	composerAttachmentPlaceholderName,
	unescapeComposerText,
} from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import type { FileReferenceInput } from "./file-reference-input";

/**
 * A quoted excerpt of conversation content (message text or tool output).
 *
 * Quotes are NOT a separate draft/message field: they live in the composer text
 * as canonical blockquotes. Quotes ahead of all typed text form a leading prefix;
 * a quote placed after typed text is projected where it stands, on its own line
 * (see composerDocumentProjection). Draft sync, the local draft mirror, input
 * history, queued-message edits, failed-send restore and the model all see the
 * same plain text, so no transport needs to know quotes exist. Sent bubbles turn
 * the blocks back into chips; the header is still readable as plain text.
 *
 *   > [quote] Selecting text in a message @@m:msgId
 *   > Selecting text in a message
 *   >
 *   > shows a chip
 *
 *   body text typed by the user
 */
export interface ComposerQuote {
	label: string;
	text: string;
	/**
	 * Where the excerpt came from, so a click can scroll back to it after send.
	 * `m:<messageId>` or `t:<toolUseId>`. Absent when the source has no stable id.
	 */
	anchor?: string;
}

/** Chip text: the start of the selection, with the file name in front when the source is a file tool. */
export const QUOTE_PREVIEW_CHARS = 36;

export function quotePreviewLabel(text: string, fileName?: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	const clipped =
		flat.length > QUOTE_PREVIEW_CHARS
			? `${flat.slice(0, QUOTE_PREVIEW_CHARS - 1)}${TRUNCATION_MARK}`
			: flat;
	if (!fileName) return clipped;
	const withFile = `${fileName} · ${clipped}`;
	return withFile.length > MAX_COMPOSER_QUOTE_LABEL_CHARS
		? `${withFile.slice(0, MAX_COMPOSER_QUOTE_LABEL_CHARS - 1)}${TRUNCATION_MARK}`
		: withFile;
}

/** `path/to/App.tsx:12` → `App.tsx`. The line suffix is the card's own decoration. */
export function fileQuoteName(raw: string): string {
	const trimmed = raw.trim().replace(/:\d+$/u, "");
	const base = trimmed.split(/[\\/]/u).pop() || trimmed;
	return base;
}

export const MAX_COMPOSER_QUOTES = 8;
export const MAX_COMPOSER_QUOTE_CHARS = 8000;
export const MAX_COMPOSER_QUOTE_LABEL_CHARS = 80;

const HEADER_PREFIX = "> [quote] ";
const HEADER = /^> \[quote\] (.+)$/;
/** Trailing jump target. The id is at least 4 characters so ordinary prose cannot collide. */
const ANCHOR_SUFFIX = / @@([mt]:[A-Za-z0-9_-]{4,})$/;
// A content line that would read as a header is escaped with one extra backslash.
const ESCAPABLE = /^\\*\[quote\]/;
const ESCAPED = /^\\+\[quote\]/;
const TRUNCATION_MARK = "…";

function clipLabel(label: string): string {
	const single = label.replace(/\s+/gu, " ").trim();
	return single.length > MAX_COMPOSER_QUOTE_LABEL_CHARS
		? `${single.slice(0, MAX_COMPOSER_QUOTE_LABEL_CHARS - 1)}${TRUNCATION_MARK}`
		: single;
}

export function splitQuoteHeader(headerBody: string): { label: string; anchor?: string } {
	const trimmed = headerBody.trim();
	const match = ANCHOR_SUFFIX.exec(trimmed);
	if (!match) return { label: trimmed };
	const label = trimmed.slice(0, match.index).trim();
	return label ? { label, anchor: match[1] } : { label: trimmed };
}

/** Null when nothing quotable remains. Over-long text is clipped with a visible mark. */
export function normalizeComposerQuote(
	label: string,
	text: string,
	anchor?: string,
): ComposerQuote | null {
	const cleanLabel = clipLabel(label);
	const lines = text
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/u, ""));
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	let body = lines.join("\n");
	if (!cleanLabel || !body) return null;
	if (body.length > MAX_COMPOSER_QUOTE_CHARS) {
		body = `${body.slice(0, MAX_COMPOSER_QUOTE_CHARS - 1).replace(/\s+$/u, "")}${TRUNCATION_MARK}`;
	}
	const quote: ComposerQuote = { label: cleanLabel, text: body };
	if (anchor && ANCHOR_SUFFIX.test(` @@${anchor}`)) quote.anchor = anchor;
	return quote;
}

export function sameComposerQuote(a: ComposerQuote, b: ComposerQuote): boolean {
	return a.label === b.label && a.text === b.text && a.anchor === b.anchor;
}

function serializeQuote(quote: ComposerQuote): string {
	const content = quote.text
		.split("\n")
		.map((line) => {
			const escaped = ESCAPABLE.test(line) ? `\\${line}` : line;
			return escaped ? `> ${escaped}` : ">";
		})
		.join("\n");
	const suffix = quote.anchor ? ` @@${quote.anchor}` : "";
	return `${HEADER_PREFIX}${clipLabel(quote.label)}${suffix}\n${content}\n\n`;
}

export function serializeComposerQuotes(quotes: readonly ComposerQuote[]): string {
	return quotes.map(serializeQuote).join("");
}

function unescapeContentLine(raw: string): string {
	const line = raw.startsWith("> ") ? raw.slice(2) : raw.slice(1);
	return ESCAPED.test(line) ? line.slice(1) : line;
}

function lineEnd(text: string, from: number): number {
	const end = text.indexOf("\n", from);
	return end < 0 ? text.length : end;
}

/**
 * One quote block starting at `pos`: a header, at least one `>` content line, then a blank
 * line, another header, or the end of the text. `end` is past the terminator.
 */
function parseQuoteBlockAt(
	text: string,
	pos: number,
): { quote: ComposerQuote; end: number } | null {
	const headerEnd = lineEnd(text, pos);
	const header = HEADER.exec(text.slice(pos, headerEnd));
	if (!header || headerEnd >= text.length) return null;
	let cursor = headerEnd + 1;
	const lines: string[] = [];
	while (cursor < text.length && text[cursor] === ">") {
		const end = lineEnd(text, cursor);
		const raw = text.slice(cursor, end);
		if (HEADER.test(raw)) break;
		lines.push(unescapeContentLine(raw));
		cursor = end < text.length ? end + 1 : text.length;
	}
	if (!lines.length) return null;
	const { label, anchor } = splitQuoteHeader(header[1]);
	if (!label) return null;
	const quote: ComposerQuote = { label, text: lines.join("\n") };
	if (anchor) quote.anchor = anchor;
	if (cursor >= text.length) return { quote, end: text.length };
	if (text[cursor] === "\n") return { quote, end: cursor + 1 };
	if (text.startsWith(HEADER_PREFIX, cursor)) return { quote, end: cursor };
	return null;
}

/**
 * Parse the leading quote blocks. A block must be a header, at least one `>`
 * content line, then a blank line, another header, or the end of the text; a
 * block that is not terminated that way is left in the body untouched.
 */
export function parseComposerQuotePrefix(text: string): {
	quotes: ComposerQuote[];
	prefixLength: number;
} {
	const quotes: ComposerQuote[] = [];
	let prefixLength = 0;
	while (prefixLength < text.length && quotes.length < MAX_COMPOSER_QUOTES) {
		const block = parseQuoteBlockAt(text, prefixLength);
		if (!block) break;
		quotes.push(block.quote);
		prefixLength = block.end;
	}
	return { quotes, prefixLength };
}

/** Attachment names as the bubble knows them, in upload order per kind. */
export interface ComposerSegmentAttachments {
	images: readonly string[];
	files: readonly string[];
}

export type ComposerTextSegment =
	| { type: "text"; text: string }
	| { type: "quote"; quote: ComposerQuote }
	| { type: "attachment"; kind: "image" | "file"; index: number };

/**
 * A sent message's projection, back in document order: quote blocks wherever they start a
 * line, and attachment placeholders that name a real attachment (first occurrence only).
 * Anything else, including look-alike placeholders, stays literal text, with the escapes the
 * projection added to typed look-alikes removed.
 */
export function parseComposerSegments(
	text: string,
	attachments: ComposerSegmentAttachments = { images: [], files: [] },
): ComposerTextSegment[] {
	const segments: ComposerTextSegment[] = [];
	const pushText = (raw: string) => {
		if (!raw) return;
		const value = unescapeComposerText(raw);
		const last = segments[segments.length - 1];
		if (last?.type === "text") last.text += value;
		else segments.push({ type: "text", text: value });
	};
	const used = new Set<string>();
	let quotes = 0;
	let pos = 0;
	let textStart = 0;
	const placeholder = new RegExp(COMPOSER_ATTACHMENT_PLACEHOLDER.source, "uy");
	while (pos < text.length) {
		if ((pos === 0 || text[pos - 1] === "\n") && quotes < MAX_COMPOSER_QUOTES) {
			const block = parseQuoteBlockAt(text, pos);
			if (block) {
				pushText(text.slice(textStart, pos));
				segments.push({ type: "quote", quote: block.quote });
				quotes++;
				pos = textStart = block.end;
				continue;
			}
		}
		// A backslash marks typed text that only looks like a placeholder.
		if (text[pos] === "[" && text[pos - 1] !== "\\") {
			placeholder.lastIndex = pos;
			const match = placeholder.exec(text);
			if (match) {
				const kind = match[1] === "image" ? "image" : "file";
				const index = Number(match[2]) - 1;
				const names = kind === "image" ? attachments.images : attachments.files;
				const key = `${kind}:${index}`;
				if (
					index < names.length &&
					!used.has(key) &&
					composerAttachmentPlaceholderName(names[index] ?? "") === match[3]
				) {
					used.add(key);
					pushText(text.slice(textStart, pos));
					segments.push({ type: "attachment", kind, index });
					pos = textStart = pos + match[0].length;
					continue;
				}
			}
		}
		pos++;
	}
	pushText(text.slice(textStart));
	return segments;
}

/**
 * One-glance plain text for places that show a sent or queued message as a single string:
 * quote blocks shrink to their label and placeholders to the attachment's name.
 */
export function composerPreviewText(
	text: string,
	attachments: ComposerSegmentAttachments = { images: [], files: [] },
): string {
	const segments = parseComposerSegments(text, attachments);
	return (
		segments
			.map((segment, index) => {
				if (segment.type === "attachment")
					return `[${(segment.kind === "image" ? attachments.images : attachments.files)[segment.index]}]`;
				if (segment.type === "quote")
					return `[❝ ${segment.quote.label}]${index < segments.length - 1 ? " " : ""}`;
				// The projection puts every quote block on its own line; a preview keeps one line.
				return segments[index + 1]?.type === "quote"
					? segment.text.replace(/\n$/u, " ")
					: segment.text;
			})
			.join("")
			// This is a plain-text summary, not an authored-document parser. Keep canonical
			// identity links readable here without manufacturing reference atoms or authority.
			.replace(
				/\[(@(?:\\.|[^[\]\\\n])*)\]\(nf-agent:\/\/open\?id=[A-Za-z0-9_-]{1,128}\)/gu,
				(_link, label: string) => label.replace(/\\([\\[\]`*_<>])/gu, "$1"),
			)
			.trimEnd()
	);
}

function shiftReferences(
	references: readonly FileReference[],
	offset: number,
	minStart: number,
): FileReference[] {
	return references.map((reference) => {
		if (!reference.inputRange) return reference;
		const [start, end] = reference.inputRange;
		if (start < minStart) {
			const { inputRange: _dropped, ...detached } = reference;
			return detached;
		}
		return { ...reference, inputRange: [start + offset, end + offset] as [number, number] };
	});
}

export interface QuotedComposerInput {
	quotes: ComposerQuote[];
	/** Text after the quote prefix, with file-token offsets relative to it. */
	body: FileReferenceInput;
}

export function splitQuotedComposerInput(input: FileReferenceInput): QuotedComposerInput {
	const { quotes, prefixLength } = parseComposerQuotePrefix(input.text);
	if (!prefixLength) return { quotes, body: input };
	return {
		quotes,
		body: {
			text: input.text.slice(prefixLength),
			fileReferences: shiftReferences(input.fileReferences, -prefixLength, prefixLength),
		},
	};
}

/** One clickable quote block in a sent user message, after the jump id is hidden. */
export interface QuoteDisplayJump {
	/** Displayed header line, `> [quote] <label>`, with no anchor suffix. */
	header: string;
	anchor: string;
	/** Text to look for at the source. The leading file-name line is not part of it. */
	highlight: string;
	/** Position of this quote in the prefix. Identical labels stay distinct. */
	index: number;
}

/**
 * A single source line to highlight. A leading line with no spaces is the file
 * name prepended for the model, not part of what the reader selected.
 */
export function quoteHighlightNeedle(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const body = lines.length > 1 && lines[0] && !/\s/u.test(lines[0]) ? lines[1] : lines[0];
	const line = body ?? "";
	return line.length > 80 ? line.slice(0, 80) : line;
}

/**
 * The text a user bubble measures and paints. Anchors stay in the stored message
 * (so a click still knows where to go) but not on screen.
 */
export function quoteDisplayText(text: string): { text: string; jumps: QuoteDisplayJump[] } {
	const { quotes, prefixLength } = parseComposerQuotePrefix(text);
	if (!prefixLength) return { text, jumps: [] };
	const jumps: QuoteDisplayJump[] = [];
	let display = "";
	for (const [index, quote] of quotes.entries()) {
		const header = `${HEADER_PREFIX}${quote.label}`;
		display += serializeQuote({ label: quote.label, text: quote.text });
		if (quote.anchor) {
			jumps.push({
				header,
				anchor: quote.anchor,
				highlight: quoteHighlightNeedle(quote.text),
				index,
			});
		}
	}
	return { text: display + text.slice(prefixLength), jumps };
}

/**
 * Which stored jump a painted line belongs to.
 *
 * Headers are matched by their position in the prefix, not by label text: two
 * quotes can open with the same words. A `>` continuation walks back to its
 * header. A quote with no anchor occupies an index and is not clickable.
 */
export function quoteJumpForLine(
	lines: readonly { text: string }[],
	index: number,
	jumps: readonly QuoteDisplayJump[] | undefined,
): QuoteDisplayJump | undefined {
	if (!jumps?.length || index < 0 || index >= lines.length) return undefined;
	let headerIndex = index;
	while (
		headerIndex > 0 &&
		!lines[headerIndex]?.text.startsWith(HEADER_PREFIX) &&
		(lines[headerIndex]?.text.startsWith(">") ?? false)
	) {
		headerIndex -= 1;
	}
	if (!lines[headerIndex]?.text.startsWith(HEADER_PREFIX)) return undefined;
	let ordinal = -1;
	for (let lineIndex = 0; lineIndex <= headerIndex; lineIndex++) {
		if (lines[lineIndex]?.text.startsWith(HEADER_PREFIX)) ordinal += 1;
	}
	return jumps.find((jump) => jump.index === ordinal);
}

export function joinQuotedComposerInput(
	quotes: readonly ComposerQuote[],
	body: FileReferenceInput,
): FileReferenceInput {
	const prefix = serializeComposerQuotes(quotes);
	if (!prefix) return body;
	return {
		text: prefix + body.text,
		fileReferences: shiftReferences(body.fileReferences, prefix.length, 0),
	};
}
