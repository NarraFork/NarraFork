/**
 * Shared citation contract for assistant text blocks.
 *
 * Providers that run native web search (OpenAI/Codex Responses API, plugin
 * providers, …) attach source references to assistant text. Historically those
 * references arrived only as a private-use-area envelope embedded directly in the
 * visible text (`\ue200cite\ue202turn0search1\ue201`), which then leaked into the
 * UI, clipboard, full-text search and the model history.
 *
 * This module is the single source of truth for:
 *  - the structured `TextCitation` shape persisted in `contentJson`;
 *  - normalization / dedupe / hard limits applied on every ingress path;
 *  - parsing the inline envelope out of raw provider text;
 *  - projecting `{ text, citations }` into plain Markdown that every renderer
 *    (Classic, Pretext/VList, Pixi) already understands.
 *
 * The parsing half follows Codex's own approach for hidden inline markup
 * (`codex-rs/utils/stream-parser/`): literal delimiters and a streaming state
 * machine, never a regex over token shapes. NarraFork speaks five provider
 * protocols, so a parser that guessed at bare tokens would corrupt the four that
 * never emit this envelope.
 *
 * It must stay free of React, DOM and database imports so the server, the
 * frontend and unit tests can all share it.
 */

// === Types ===

export interface CitationSource {
	/** Provider-internal reference (e.g. `turn0search1`). Never rendered verbatim. */
	sourceRef?: string;
	/** Resolved http(s) URL when the provider supplied one. */
	url?: string;
	/** Human readable source title. */
	title?: string;
}

export interface TextCitation {
	/** UTF-16 index into the cleaned visible text where the cited range starts. */
	startIndex: number;
	/** UTF-16 index where the cited range ends; the reference number renders here. */
	endIndex: number;
	/** One or more sources backing this citation. */
	sources: CitationSource[];
}

export interface TextRange {
	start: number;
	end: number;
}

/** Hard limits: providers and plugins are untrusted input. */
export const CITATION_LIMITS = {
	maxCitations: 256,
	maxSourcesPerCitation: 16,
	maxUrlLength: 2048,
	maxTitleLength: 300,
	maxSourceRefLength: 128,
	/**
	 * Ceiling on a citation envelope's payload.
	 *
	 * The payload must already validate as a source-ref list, so this is a second
	 * guard rather than the primary one: it bounds the work done on adversarial
	 * input (a stream that opens an envelope and never closes it) instead of
	 * deciding what counts as a marker.
	 */
	maxMarkerLength: 512,
} as const;

// === Sanitizing helpers ===

/** Only http(s) URLs are safe to render as links. */
export function sanitizeCitationUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > CITATION_LIMITS.maxUrlLength) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	return trimmed;
}

function sanitizeShortText(raw: unknown, maxLength: number): string | undefined {
	if (typeof raw !== "string") return undefined;
	// Control characters would break both Markdown output and terminal logs.
	// Scanned by code point rather than a regex: a literal control-character
	// class is exactly what `noControlCharactersInRegex` forbids, and the scan
	// states the intent more plainly anyway.
	let cleaned = "";
	for (const char of raw) {
		const code = char.codePointAt(0) ?? 0;
		cleaned += code < 0x20 || code === 0x7f ? " " : char;
	}
	const trimmed = cleaned.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function sanitizeCitationSource(raw: unknown): CitationSource | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Record<string, unknown>;
	const url = sanitizeCitationUrl(input.url);
	const title = sanitizeShortText(input.title, CITATION_LIMITS.maxTitleLength);
	const sourceRef = sanitizeShortText(input.sourceRef, CITATION_LIMITS.maxSourceRefLength);
	if (!url && !title && !sourceRef) return undefined;
	const source: CitationSource = {};
	if (sourceRef) source.sourceRef = sourceRef;
	if (url) source.url = url;
	if (title) source.title = title;
	return source;
}

function sourceKey(source: CitationSource): string {
	return `${source.url ?? ""}\u0000${source.sourceRef ?? ""}\u0000${source.title ?? ""}`;
}

function dedupeSources(sources: CitationSource[]): CitationSource[] {
	const seen = new Set<string>();
	const out: CitationSource[] = [];
	for (const source of sources) {
		const key = sourceKey(source);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(source);
		if (out.length >= CITATION_LIMITS.maxSourcesPerCitation) break;
	}
	return out;
}

// === Normalization ===

/**
 * Normalize arbitrary (provider / plugin / persisted) citation input into the
 * canonical contract: clamped indices, sanitized sources, merged duplicates,
 * stable ordering and enforced hard limits.
 *
 * `textLength` is the length of the cleaned visible text the indices refer to.
 * Citations pointing outside that range are clamped; sourceless citations are
 * dropped because they cannot render anything meaningful.
 */
export function normalizeTextCitations(raw: unknown, textLength: number): TextCitation[] {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const collected: TextCitation[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const input = item as Record<string, unknown>;
		const rawSources = Array.isArray(input.sources) ? input.sources : [];
		const sources: CitationSource[] = [];
		for (const rawSource of rawSources) {
			const source = sanitizeCitationSource(rawSource);
			if (source) sources.push(source);
		}
		if (sources.length === 0) continue;

		const rawStart = typeof input.startIndex === "number" ? input.startIndex : Number.NaN;
		const rawEnd = typeof input.endIndex === "number" ? input.endIndex : Number.NaN;
		if (!Number.isFinite(rawEnd)) continue;
		const end = clampIndex(rawEnd, textLength);
		const start = Number.isFinite(rawStart) ? clampIndex(rawStart, textLength) : end;
		collected.push({
			startIndex: Math.min(start, end),
			endIndex: end,
			sources: dedupeSources(sources),
		});
	}
	if (collected.length === 0) return [];

	collected.sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);

	// Merge citations that render at the same position so a single reference
	// group is emitted instead of repeated numbers at one anchor.
	const merged: TextCitation[] = [];
	for (const citation of collected) {
		const last = merged[merged.length - 1];
		if (last && last.startIndex === citation.startIndex && last.endIndex === citation.endIndex) {
			last.sources = dedupeSources([...last.sources, ...citation.sources]);
			continue;
		}
		merged.push(citation);
		if (merged.length >= CITATION_LIMITS.maxCitations) break;
	}
	return merged;
}

function clampIndex(value: number, textLength: number): number {
	if (!Number.isFinite(value)) return 0;
	const rounded = Math.trunc(value);
	if (rounded < 0) return 0;
	return rounded > textLength ? textLength : rounded;
}

// === Markdown code awareness ===

/**
 * Find fenced code blocks and inline code spans so citation parsing/projection
 * never rewrites text a user may be deliberately showing as an example.
 * Ranges are returned sorted and non-overlapping.
 */
export function findCodeRanges(text: string): TextRange[] {
	const ranges: TextRange[] = [];
	const lines = text.split("\n");
	let offset = 0;
	let fenceChar: string | null = null;
	let fenceLength = 0;
	let fenceStart = 0;

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1;
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1][0];
				fenceLength = fence[1].length;
				fenceStart = lineStart;
			}
			continue;
		}
		// Inside a fence: only a matching fence of at least the same length closes it.
		if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
			ranges.push({ start: fenceStart, end: Math.min(offset, text.length) });
			fenceChar = null;
		}
	}
	// Unterminated fence: treat the remainder as code.
	if (fenceChar !== null) ranges.push({ start: fenceStart, end: text.length });

	for (const inline of findInlineCodeRanges(text, ranges)) ranges.push(inline);
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	return mergeRanges(ranges);
}

function findInlineCodeRanges(text: string, fenced: TextRange[]): TextRange[] {
	const out: TextRange[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		if (isInsideRanges(i, fenced)) {
			i++;
			continue;
		}
		let runLength = 0;
		while (i + runLength < text.length && text[i + runLength] === "`") runLength++;
		const ticks = "`".repeat(runLength);
		const searchFrom = i + runLength;
		const closing = findClosingTicks(text, searchFrom, ticks);
		if (closing < 0) {
			i += runLength;
			continue;
		}
		out.push({ start: i, end: closing + runLength });
		i = closing + runLength;
	}
	return out;
}

function findClosingTicks(text: string, from: number, ticks: string): number {
	let cursor = from;
	while (cursor < text.length) {
		const found = text.indexOf(ticks, cursor);
		if (found < 0) return -1;
		// A longer backtick run is not a valid closer for a shorter opener.
		let runLength = 0;
		while (found + runLength < text.length && text[found + runLength] === "`") runLength++;
		if (runLength === ticks.length) return found;
		cursor = found + runLength;
	}
	return -1;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
	const out: TextRange[] = [];
	for (const range of ranges) {
		if (range.end <= range.start) continue;
		const last = out[out.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
			continue;
		}
		out.push({ ...range });
	}
	return out;
}

export function isInsideRanges(index: number, ranges: TextRange[]): boolean {
	for (const range of ranges) {
		if (index < range.start) return false;
		if (index < range.end) return true;
	}
	return false;
}

// === Legacy inline marker parsing ===

/**
 * The exact ChatGPT native-search citation envelope.
 *
 * Verified against every affected row in this deployment: the persisted bytes are
 * always `U+E200 "cite" U+E202 <ref> (U+E202 <ref>)* U+E201`. No `navlist`
 * variant and no U+E203/E204 separator occurs, so they are deliberately NOT
 * matched — an unused branch here is not dead weight, it is a way to delete user
 * content by accident.
 *
 * Treating these code points as citation syntax on their own would be wrong:
 * U+E200–U+E2A9 is where Nerd Fonts maps "Font Awesome Extension", so an
 * assistant relaying a shell prompt or terminal output emits them legitimately.
 * Requiring the full literal opener is what separates a marker from a glyph.
 */
export const CHATGPT_CITATION_OPEN = "\ue200cite\ue202";
export const CHATGPT_CITATION_CLOSE = "\ue201";
export const CHATGPT_CITATION_SOURCE_SEPARATOR = "\ue202";

/**
 * Validate the opaque source-ref payload without guessing a fixed kind list.
 *
 * Observed values are `turn0search3`, `turn0view0`, `turn204588view0`, …; the
 * stable grammar is `turn` + digits + lowercase letters + digits. Matching the
 * grammar rather than an allowlist of kind words means a new upstream kind needs
 * no code change, and — because the value only ever appears INSIDE a validated
 * envelope — there is no incentive to loosen it into bare-token matching.
 *
 * A scanner rather than a regex: this mirrors how Codex's stream parser works on
 * literal bytes, and it makes the accepted shape readable at a glance.
 */
export function isChatGptCitationSourceRef(value: string): boolean {
	if (!value.startsWith("turn") || value.length > CITATION_LIMITS.maxSourceRefLength) return false;
	let cursor = 4;
	const firstDigitsStart = cursor;
	while (cursor < value.length && isAsciiDigit(value.charCodeAt(cursor))) cursor++;
	if (cursor === firstDigitsStart) return false;
	const kindStart = cursor;
	while (cursor < value.length && isAsciiLowercase(value.charCodeAt(cursor))) cursor++;
	if (cursor === kindStart) return false;
	const finalDigitsStart = cursor;
	while (cursor < value.length && isAsciiDigit(value.charCodeAt(cursor))) cursor++;
	return cursor === value.length && cursor > finalDigitsStart;
}

function isAsciiDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function isAsciiLowercase(code: number): boolean {
	return code >= 97 && code <= 122;
}

function parseCitationPayload(payload: string): CitationSource[] | null {
	if (!payload || payload.length > CITATION_LIMITS.maxMarkerLength) return null;
	const refs = payload.split(CHATGPT_CITATION_SOURCE_SEPARATOR);
	if (refs.length === 0 || refs.length > CITATION_LIMITS.maxSourcesPerCitation) return null;
	const sources: CitationSource[] = [];
	for (const sourceRef of refs) {
		if (!isChatGptCitationSourceRef(sourceRef)) return null;
		sources.push({ sourceRef });
	}
	return sources;
}

/** Cheap exact-opener pre-check: no opener means a byte-identical no-op. */
export function hasLegacyCitationMarkers(text: string): boolean {
	return text.includes(CHATGPT_CITATION_OPEN);
}

export interface LegacyCitationParseResult {
	/** Visible text with all internal markers removed. */
	text: string;
	/** Citations recovered from the markers, indexed against `text`. */
	citations: TextCitation[];
	/** Removed marker ranges in the ORIGINAL text coordinates. */
	removals: TextRange[];
	/** True when anything was removed. */
	changed: boolean;
}

/**
 * Strip complete citation envelopes from persisted assistant text.
 *
 * Literal delimiter matching, following Codex's `InlineHiddenTagParser`
 * (`codex-rs/utils/stream-parser/src/inline_hidden_tag.rs`): find the exact
 * opener, hide up to the exact closer, and auto-close an unterminated tag at EOF.
 * Codex applies the same discipline to its own `<oai-mem-citation>` tag; the only
 * difference here is the delimiter and an additional payload validation, since
 * this envelope's body is a machine ref list rather than free text.
 *
 * Two deliberate divergences from Codex, both because this parser runs over
 * ALREADY PERSISTED user-visible history rather than a trusted live stream:
 *  - code fences and inline code are preserved, so a message explaining the
 *    marker syntax keeps its example intact;
 *  - an envelope whose payload is not a valid ref list fails OPEN (stays visible)
 *    instead of being swallowed.
 */
export function parseLegacyCitationMarkers(text: string): LegacyCitationParseResult {
	if (!text || !hasLegacyCitationMarkers(text)) {
		return { text, citations: [], removals: [], changed: false };
	}
	const codeRanges = findCodeRanges(text);
	const citations: TextCitation[] = [];
	const removals: TextRange[] = [];
	let cleaned = "";
	let visibleCursor = 0;
	let searchCursor = 0;

	while (searchCursor < text.length) {
		const start = text.indexOf(CHATGPT_CITATION_OPEN, searchCursor);
		if (start < 0) break;
		if (isInsideRanges(start, codeRanges)) {
			searchCursor = start + CHATGPT_CITATION_OPEN.length;
			continue;
		}

		const payloadStart = start + CHATGPT_CITATION_OPEN.length;
		const close = text.indexOf(CHATGPT_CITATION_CLOSE, payloadStart);
		const payloadEnd = close < 0 ? text.length : close;
		if (payloadEnd - payloadStart > CITATION_LIMITS.maxMarkerLength) {
			searchCursor = payloadStart;
			continue;
		}
		const sources = parseCitationPayload(text.slice(payloadStart, payloadEnd));
		if (!sources) {
			searchCursor = payloadStart;
			continue;
		}

		const end = close < 0 ? text.length : close + CHATGPT_CITATION_CLOSE.length;
		cleaned += text.slice(visibleCursor, start);
		const anchor = cleaned.length;
		citations.push({ startIndex: anchor, endIndex: anchor, sources });
		removals.push({ start, end });
		visibleCursor = end;
		searchCursor = end;
	}

	if (removals.length === 0) {
		return { text, citations: [], removals: [], changed: false };
	}
	cleaned += text.slice(visibleCursor);
	return {
		text: cleaned,
		citations: normalizeTextCitations(citations, cleaned.length),
		removals,
		changed: true,
	};
}

/**
 * Translate an index from original text coordinates into cleaned coordinates
 * after `removals` were applied. Indices landing inside a removed marker
 * collapse to the marker start.
 */
export function remapIndexThroughRemovals(index: number, removals: TextRange[]): number {
	let shift = 0;
	for (const range of removals) {
		if (index <= range.start) break;
		if (index < range.end) return range.start - shift;
		shift += range.end - range.start;
	}
	return index - shift;
}

// === Markdown projection ===

export interface CitationReference {
	/** 1-based reference number as rendered in the text. */
	number: number;
	source: CitationSource;
}

export interface CitationProjection {
	/** Markdown-safe text with `[n]` / `[n](<url>)` reference markers inserted. */
	markdown: string;
	/** Numbered sources in first-appearance order. */
	references: CitationReference[];
}

/**
 * Whether the cited range already contains this URL as the model's own link.
 *
 * Providers running native search report a source BOTH ways at once: the model
 * writes an ordinary Markdown link in the prose AND the API reports a
 * `url_citation` annotation covering it. Appending a reference number on top
 * renders the identical URL twice, and because the annotation range ends after
 * the model's closing paren the number lands inside it —
 * `([example.com](url)[1](<url>))`. Verified by replaying the documented
 * web_search wire shape, not inferred from a stored sample.
 *
 * Scoped strictly to the range the provider itself reported. A point anchor
 * (`startIndex === endIndex`) cites no text, so there is nothing to compare and
 * the citation is numbered normally: guessing a lookbehind window would risk
 * reaching an unrelated sentence and silently swallowing a real reference.
 */
function citedTextAlreadyLinks(text: string, citation: TextCitation, url: string): boolean {
	if (citation.startIndex >= citation.endIndex) return false;
	return text.slice(citation.startIndex, citation.endIndex).includes(url);
}

/**
 * Project cleaned text + structured citations into plain Markdown.
 *
 * Resolved sources become `[n](<url>)` links; sources with only an internal ref
 * become a plain `[n]` label so provider-internal identifiers are never shown.
 * Insertion points falling inside code spans are skipped, and a source the model
 * already linked inline is not numbered again (see `citedTextAlreadyLinks`).
 */
export function projectCitationsToMarkdown(
	text: string,
	citations: readonly TextCitation[] | undefined,
): CitationProjection {
	if (!citations || citations.length === 0) return { markdown: text, references: [] };
	const normalized = normalizeTextCitations(citations as unknown[], text.length);
	if (normalized.length === 0) return { markdown: text, references: [] };

	const codeRanges = findCodeRanges(text);
	const numbers = new Map<string, number>();
	const references: CitationReference[] = [];
	const inserts: Array<{ at: number; markdown: string }> = [];

	for (const citation of normalized) {
		if (isInsideRanges(citation.endIndex, codeRanges)) continue;
		let rendered = "";
		for (const source of citation.sources) {
			// The model already linked this source in the prose: numbering it again
			// would duplicate the URL and break the surrounding punctuation.
			if (source.url && citedTextAlreadyLinks(text, citation, source.url)) continue;
			const key = sourceKey(source);
			let number = numbers.get(key);
			if (number == null) {
				number = references.length + 1;
				numbers.set(key, number);
				references.push({ number, source });
			}
			rendered += source.url ? `[${number}](${encodeMarkdownUrl(source.url)})` : `[${number}]`;
		}
		if (rendered) inserts.push({ at: citation.endIndex, markdown: rendered });
	}
	if (inserts.length === 0) return { markdown: text, references: [] };

	// Apply back-to-front so earlier indices stay valid.
	let markdown = text;
	for (let i = inserts.length - 1; i >= 0; i--) {
		const insert = inserts[i];
		markdown = markdown.slice(0, insert.at) + insert.markdown + markdown.slice(insert.at);
	}
	return { markdown, references };
}

/** Wrap in angle brackets and escape the few characters that break link syntax. */
function encodeMarkdownUrl(url: string): string {
	const escaped = url.replace(/[<>\\\s]/g, (char) => encodeURIComponent(char));
	return `<${escaped}>`;
}

/**
 * One-shot projection for text that may still contain legacy inline markers and
 * may additionally carry structured citations.
 *
 * Used on every read path (frontend renderers, provider history) so historical
 * messages display correctly without rewriting stored rows.
 */
export function projectAssistantTextForDisplay(
	text: string,
	citations?: readonly TextCitation[],
): string {
	const parsed = parseLegacyCitationMarkers(text);
	const hasStructured = !!citations && citations.length > 0;
	if (parsed.citations.length === 0 && !hasStructured) return parsed.text;

	// Structured citations index the text as the provider produced it. When
	// legacy markers were also present, cleaning shifted those coordinates, so
	// remap before merging with the marker-derived citations.
	const structured = hasStructured
		? parsed.changed
			? (citations as readonly TextCitation[]).map((citation) => ({
					...citation,
					startIndex: remapIndexThroughRemovals(citation.startIndex, parsed.removals),
					endIndex: remapIndexThroughRemovals(citation.endIndex, parsed.removals),
				}))
			: (citations as readonly TextCitation[])
		: [];
	return projectCitationsToMarkdown(parsed.text, [...structured, ...parsed.citations]).markdown;
}

/**
 * Resolve what an assistant text block should DISPLAY versus what it should COPY.
 *
 * These deliberately differ: the display carries numbered reference markers (and
 * Markdown links for resolved sources), while the clipboard carries the prose the
 * model actually wrote. Pasting `[1](<https://…>)` into a document would put link
 * syntax the author never typed into the user's text.
 *
 * Streaming and settled text take the SAME path. Deltas are forwarded verbatim
 * by the loop, so both arrive here raw and one projection covers both. An earlier
 * design stripped at the delta boundary instead, which meant two parsers over the
 * same bytes — and two ways for them to disagree (they did, twice). A partial
 * opener may therefore be visible for one frame mid-stream; that is a single
 * unrenderable character until the next delta, and the alternative was guessing
 * which trailing bytes are a marker prefix, which risks deleting a real glyph.
 *
 * `copyText` is `null` when the two are identical, so callers can skip passing an
 * override and keep the default copy path untouched.
 */
export function resolveAssistantTextDisplay(
	text: string,
	citations?: readonly TextCitation[],
): { display: string; copyText: string | null } {
	if (!text) return { display: text, copyText: null };
	const display = projectAssistantTextForDisplay(text, citations);
	const copy = cleanAssistantText(text).text;
	return { display, copyText: copy === display ? null : copy };
}

/**
 * Remove legacy internal markers from assistant text. Safe to call on every
 * read: returns the input untouched when no marker is present.
 */
export function cleanAssistantText(text: string): {
	text: string;
	citations: TextCitation[];
	changed: boolean;
} {
	const parsed = parseLegacyCitationMarkers(text);
	return { text: parsed.text, citations: parsed.citations, changed: parsed.changed };
}
