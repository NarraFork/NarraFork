import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";

export interface StaticInlineFragment {
	readonly text: string;
	readonly font: string;
	readonly className: string;
	readonly gapBefore: number;
	readonly href?: string | null;
	readonly math?: unknown | null;
}

export interface StaticInlineLine {
	readonly fragments: readonly StaticInlineFragment[];
}

const MAX_LINE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const GAP_MARKUP =
	'<span aria-hidden="true" data-vlist-frag-gap="true" style="font-size:0"> </span>';

function isControl(code: number): boolean {
	return code < 32 || (code >= 127 && code <= 159);
}

/** Font tokens must not consume the fixed declarations appended after them. */
function isSafeFont(font: string): boolean {
	if (/[;{}\\]/.test(font) || font.includes("/*") || font.includes("*/")) return false;
	let quote = 0;
	for (let index = 0; index < font.length; index++) {
		const code = font.charCodeAt(index);
		if (isControl(code)) return false;
		if (code === 34 || code === 39) {
			if (quote === code) quote = 0;
			else if (quote === 0) quote = code;
		}
	}
	return quote === 0;
}

function escapeHtml(value: string, attribute: boolean): string {
	return value.replace(attribute ? /[&<>"']/g : /[&<>]/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#x27;";
		}
	});
}

/**
 * Count BEFORE escaping/concatenating. UTF-16 length is a lower bound for the
 * escaped UTF-8 size, so even a huge input is rejected without scanning it.
 * All successful builders retain at most MAX_LINE_BYTES of output/chunks.
 */
class LineBuilder {
	#parts: string[] = [];
	#bytes = 0;

	ascii(value: string): boolean {
		if (this.#bytes + value.length > MAX_LINE_BYTES) return false;
		this.#bytes += value.length;
		this.#parts.push(value);
		return true;
	}

	escaped(value: string, attribute: boolean): boolean {
		const remaining = MAX_LINE_BYTES - this.#bytes;
		if (value.length > remaining) return false;
		let bytes = 0;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			// HTML normalises CR and NUL; other controls are not static text.
			if (isControl(code) && code !== 9 && code !== 10) return false;
			if (code === 38) bytes += 5;
			else if (code === 60 || code === 62) bytes += 4;
			else if (attribute && (code === 34 || code === 39)) bytes += 6;
			else if (code < 128) bytes += 1;
			else if (code < 2048) bytes += 2;
			else if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				value.charCodeAt(index + 1) >= 0xdc00 &&
				value.charCodeAt(index + 1) <= 0xdfff
			) {
				bytes += 4;
				index++;
			} else {
				// A parser/UTF-8 transport can replace unpaired UTF-16 code units.
				if (code >= 0xd800 && code <= 0xdfff) return false;
				bytes += 3;
			}
			if (bytes > remaining) return false;
		}
		this.#bytes += bytes;
		this.#parts.push(escapeHtml(value, attribute));
		return true;
	}

	finish(): string {
		return this.#parts.join("");
	}
}

function markupForLine(line: StaticInlineLine): string | null {
	const output = new LineBuilder();
	for (const fragment of line.fragments) {
		if (
			fragment.href != null ||
			fragment.math != null ||
			typeof fragment.text !== "string" ||
			typeof fragment.font !== "string" ||
			typeof fragment.className !== "string" ||
			!Number.isFinite(fragment.gapBefore) ||
			fragment.text.length > MAX_LINE_BYTES ||
			fragment.font.length > MAX_LINE_BYTES ||
			fragment.className.length > MAX_LINE_BYTES ||
			!isSafeFont(fragment.font)
		) {
			return null;
		}
		const spacing = letterSpacingForFont(fragment.font);
		if (!Number.isFinite(spacing)) return null;
		const style = fragmentTextStyle({
			font: fragment.font,
			gapBefore: fragment.gapBefore,
			letterSpacing: spacing,
		});
		// Only this fixed structure is serialised. Never enumerate arbitrary CSS.
		const css =
			`font:${style.font};margin-left:${style.marginLeft}px;` +
			`white-space:${style.whiteSpace};display:${style.display}` +
			(style.letterSpacing === undefined
				? ""
				: `;letter-spacing:${style.letterSpacing};margin-right:${style.marginRight}px`);
		if (
			(fragment.gapBefore > 0 && !output.ascii(GAP_MARKUP)) ||
			!output.ascii('<span class="') ||
			!output.escaped(fragment.className, true) ||
			!output.ascii('" style="') ||
			!output.escaped(css, true) ||
			!output.ascii('">') ||
			!output.escaped(fragment.text, false) ||
			!output.ascii("</span>")
		) {
			return null;
		}
	}
	return output.finish();
}

interface CacheEntry {
	readonly owner: WeakRef<object>;
	readonly key: string;
	readonly markup: readonly (string | null)[];
	readonly bytes: number;
}

/**
 * Derived-only LRU: immutable prepared identity + width + REAL typography revision.
 * Owners are weak, and no prepared lines/fragments/DOM/React/callbacks are retained.
 * bytes accounts UTF-16 strings (2 bytes/code unit) plus 8 bytes/result slot and
 * 16 bytes/result array, so even empty/null-only histories cannot evade the budget.
 * The caller must exclude animated blocks before calling get().
 */
export class StaticInlineMarkupCache {
	#owners = new WeakMap<object, Map<string, CacheEntry>>();
	#lru = new Map<CacheEntry, true>();
	#bytes = 0;
	readonly #maxBytes: number;
	readonly #maxEntries: number;

	constructor(options: { maxBytes?: number; maxEntries?: number } = {}) {
		const bound = (value: number | undefined, ceiling: number) =>
			value === undefined || !Number.isFinite(value)
				? ceiling
				: Math.max(0, Math.min(ceiling, Math.floor(value)));
		this.#maxBytes = bound(options.maxBytes, MAX_CACHE_BYTES);
		this.#maxEntries = bound(options.maxEntries, MAX_CACHE_ENTRIES);
	}

	get(
		block: object,
		contentWidth: number,
		lines: readonly StaticInlineLine[],
		typographyRevision: number,
	): readonly (string | null)[] {
		const key = `${contentWidth}:${typographyRevision}`;
		const existing = this.#owners.get(block)?.get(key);
		if (existing) {
			this.#lru.delete(existing);
			this.#lru.set(existing, true);
			return existing.markup;
		}
		const markup = Object.freeze(lines.map(markupForLine));
		let bytes = 16 + markup.length * 8;
		for (const line of markup) bytes += line === null ? 0 : line.length * 2;
		if (
			bytes > this.#maxBytes ||
			this.#maxEntries === 0 ||
			!Number.isFinite(contentWidth) ||
			!Number.isFinite(typographyRevision)
		) {
			return markup;
		}
		while (this.#bytes + bytes > this.#maxBytes || this.#lru.size >= this.#maxEntries) {
			const oldest = this.#lru.keys().next().value;
			if (!oldest) break;
			this.#lru.delete(oldest);
			this.#bytes -= oldest.bytes;
			const owner = oldest.owner.deref();
			if (owner) {
				const keys = this.#owners.get(owner);
				keys?.delete(oldest.key);
				if (keys?.size === 0) this.#owners.delete(owner);
			}
		}
		const entry: CacheEntry = { owner: new WeakRef(block), key, markup, bytes };
		let keys = this.#owners.get(block);
		if (!keys) {
			keys = new Map();
			this.#owners.set(block, keys);
		}
		keys.set(key, entry);
		this.#lru.set(entry, true);
		this.#bytes += bytes;
		return markup;
	}

	clear(): void {
		this.#owners = new WeakMap();
		this.#lru.clear();
		this.#bytes = 0;
	}

	inspect(): { entries: number; bytes: number } {
		return { entries: this.#lru.size, bytes: this.#bytes };
	}
}

export const staticInlineMarkupCache = new StaticInlineMarkupCache();
