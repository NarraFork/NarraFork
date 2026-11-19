/**
 * Order-preserving XML tokenizer for OOXML parts.
 *
 * OOXML semantics live in element ORDER (run order inside a paragraph, paragraph order
 * inside a body), so a general-purpose parser returning objects keyed by tag name loses
 * exactly the information this reader needs. A flat event stream keeps order for free and
 * never materialises the whole tree.
 *
 * Scope is intentionally narrow: elements, attributes, text, CDATA, comments and
 * processing instructions. No DTD, and no entity expansion beyond the five predefined
 * entities plus numeric references — a document must not be able to make this reader
 * allocate arbitrary memory.
 *
 * Ported from `examples/plugins/doc-markdown/server/lib/xml.js` (branch
 * `experiment/doc-to-markdown`) into ESM + types.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

export interface XmlOpenEvent {
	name: string;
	attributes: Record<string, string>;
	selfClosing: boolean;
}

export interface XmlHandlers {
	/** Return `false` to stop the walk (how callers keep a bounded read). */
	open?(event: XmlOpenEvent): boolean | undefined;
	close?(event: { name: string }): boolean | undefined;
	text?(chunk: string): boolean | undefined;
}

export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const isHex = entity[1] === "x" || entity[1] === "X";
			const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
			if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		}
		return Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match;
	});
}

const ATTRIBUTE_PATTERN = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	ATTRIBUTE_PATTERN.lastIndex = 0;
	let match = ATTRIBUTE_PATTERN.exec(source);
	while (match) {
		const value = match[3] !== undefined ? match[3] : match[4];
		attributes[match[1]] = decodeEntities(value);
		match = ATTRIBUTE_PATTERN.exec(source);
	}
	return attributes;
}

/**
 * Walk the document and call `handlers` in order.
 *
 * Returns `false` when a handler stopped the walk early.
 */
export function walkXml(source: string, handlers: XmlHandlers): boolean {
	let index = 0;
	let stopped = false;
	const length = source.length;

	while (index < length && !stopped) {
		const lt = source.indexOf("<", index);
		if (lt < 0) {
			const tail = source.slice(index);
			if (tail && handlers.text) stopped = handlers.text(decodeEntities(tail)) === false;
			break;
		}
		if (lt > index && handlers.text) {
			const chunk = source.slice(index, lt);
			if (handlers.text(decodeEntities(chunk)) === false) break;
		}

		if (source.startsWith("<!--", lt)) {
			const end = source.indexOf("-->", lt + 4);
			index = end < 0 ? length : end + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", lt)) {
			const end = source.indexOf("]]>", lt + 9);
			const raw = source.slice(lt + 9, end < 0 ? length : end);
			if (raw && handlers.text) stopped = handlers.text(raw) === false;
			index = end < 0 ? length : end + 3;
			continue;
		}
		if (source.startsWith("<?", lt)) {
			const end = source.indexOf("?>", lt + 2);
			index = end < 0 ? length : end + 2;
			continue;
		}
		if (source.startsWith("<!", lt)) {
			const end = source.indexOf(">", lt + 2);
			index = end < 0 ? length : end + 1;
			continue;
		}

		const gt = source.indexOf(">", lt + 1);
		if (gt < 0) break;
		const inner = source.slice(lt + 1, gt);
		index = gt + 1;

		if (inner.startsWith("/")) {
			if (handlers.close) stopped = handlers.close({ name: inner.slice(1).trim() }) === false;
			continue;
		}

		const selfClosing = inner.endsWith("/");
		const body = selfClosing ? inner.slice(0, -1) : inner;
		const spaceIndex = body.search(/[\s/]/);
		const name = spaceIndex < 0 ? body : body.slice(0, spaceIndex);
		const attributes = spaceIndex < 0 ? {} : parseAttributes(body.slice(spaceIndex));

		if (handlers.open) stopped = handlers.open({ name, attributes, selfClosing }) === false;
		// A self-closing element reports its close immediately, but the close callback must
		// not overwrite a stop already requested by `open` — otherwise `<br/>` silently
		// resurrects a walk the caller wanted to end.
		if (!stopped && selfClosing && handlers.close) stopped = handlers.close({ name }) === false;
	}

	return !stopped;
}
