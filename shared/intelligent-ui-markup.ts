/**
 * UI markup: the JSX subset a model streams to compose kit components inline.
 *
 * It is DATA, not code. Tags name kit components (or a few HTML elements), attributes
 * are literals, and the only behaviour is two host actions. Nothing here is evaluated,
 * which is what lets a half-received document render safely on every chunk: the parser
 * keeps every element whose opening tag has fully arrived, closes what is still open,
 * and drops the unfinished tail.
 *
 * Pure and dependency-free: the server validates with it and the chat renders with it.
 */

export interface UiElement {
	$node: "el";
	/** Component name, dotted member (`Tabs.List`), HTML tag, or "" for a fragment. */
	name: string;
	props: Record<string, UiValue>;
	children: UiNode[];
}
export interface UiText {
	$node: "text";
	text: string;
}
export type UiNode = UiElement | UiText;
export const UI_ACTIONS = ["sendPrompt", "openLink"] as const;
export type UiActionName = (typeof UI_ACTIONS)[number];
/** A click handler the host owns: send a chat message, or open a link after confirmation. */
export interface UiAction {
	$action: UiActionName;
	value: string;
}
export type UiValue =
	| string
	| number
	| boolean
	| null
	| UiValue[]
	| { [key: string]: UiValue }
	| UiElement
	| UiAction;

export interface UiDiagnostic {
	message: string;
	offset: number;
}
export interface UiMarkupResult {
	nodes: UiNode[];
	diagnostics: UiDiagnostic[];
	/** Elements kept, including those nested inside attribute values. */
	elements: number;
}

export const UI_MARKUP_LIMITS = Object.freeze({
	sourceChars: 12_000,
	elements: 1_500,
	depth: 48,
	diagnostics: 20,
});

/** HTML the markup may use directly. No script, style, frame or form-submission surface. */
const INTRINSIC = new Set(
	(
		"div span p a b i u s em strong small mark code pre kbd br hr h1 h2 h3 h4 h5 h6 ul ol li " +
		"dl dt dd blockquote figure figcaption img picture source table thead tbody tfoot tr th td " +
		"caption colgroup col section article header footer main nav aside details summary label " +
		"button input select option optgroup textarea progress meter time abbr sub sup svg path " +
		"circle rect line polyline polygon ellipse g text title"
	).split(" "),
);
/** The same allowlist, for the renderer inside the preview frame. */
export const UI_INTRINSIC_TAGS: readonly string[] = [...INTRINSIC];
const VOID = new Set(["br", "hr", "img", "input", "source", "col"]);
/**
 * Names that never survive, at any depth: as an attribute, or as a member of a literal a
 * component may spread onto a DOM node. They are how data would become HTML or script.
 */
export const UI_FORBIDDEN_PROPS: readonly string[] = [
	"dangerouslySetInnerHTML",
	"srcDoc",
	"innerHTML",
	"outerHTML",
];
const FORBIDDEN = new Set(UI_FORBIDDEN_PROPS);
/** Attributes React owns; not something markup sets. */
const REACT_OWNED = new Set(["ref", "key"]);
/** Marks of parser-made nodes and actions; a literal carrying one would pose as markup. */
const RESERVED_KEYS = new Set(["$node", "$action"]);
/**
 * The only places a host action may sit: handlers a reader triggers with a gesture.
 * Anything that fires on its own (onLoad, onError, a ref, an animation) could otherwise
 * send a chat message in the user's name the moment the UI is drawn.
 */
export const UI_ACTION_PROPS: readonly string[] = [
	"onClick",
	"onDoubleClick",
	"onPress",
	"onTap",
	"onSelect",
	"onAction",
	"onConfirm",
];
const ACTION_PROPS = new Set(UI_ACTION_PROPS);
const ACTION_PLACEMENT = `sendPrompt() and openLink() can only be the value of ${UI_ACTION_PROPS.join(", ")}`;
/**
 * Props through which a component renders as another tag. They may only name HTML the
 * markup could have written directly: `component="meta"` is a tag by another route.
 */
export const UI_TAG_PROPS: readonly string[] = [
	"component",
	"as",
	"is",
	"tag",
	"tagName",
	"element",
	"elementType",
];
const TAG_PROPS = new Set(UI_TAG_PROPS);
const PROP_ALIASES: Record<string, string> = { class: "className", for: "htmlFor" };
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export function isUiIntrinsicTag(name: string): boolean {
	return INTRINSIC.has(name.toLowerCase()) && name === name.toLowerCase();
}

function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (match, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[body] ?? match;
	});
}

/** JSX whitespace: indentation and line breaks collapse, inline spaces survive. */
function jsxText(raw: string): string {
	if (!/[\r\n]/.test(raw)) return decodeEntities(raw);
	const lines = raw.split(/\r\n|\n|\r/);
	const kept: string[] = [];
	lines.forEach((line, index) => {
		let text = line.replaceAll("\t", " ");
		if (index !== 0) text = text.replace(/^ +/, "");
		if (index !== lines.length - 1) text = text.replace(/ +$/, "");
		if (text) kept.push(text);
	});
	return decodeEntities(kept.join(" "));
}

/** Thrown when the source ends inside a construct that cannot be rendered yet. */
const INCOMPLETE = Symbol("incomplete");
/** An expression the subset does not evaluate; the attribute or child is omitted. */
const OMIT = Symbol("omit");
type Parsed = UiValue | typeof OMIT;

class Parser {
	private i = 0;
	private depth = 0;
	private valueDepth = 0;
	elements = 0;
	readonly diagnostics: UiDiagnostic[] = [];
	private readonly open: string[] = [];

	constructor(private readonly s: string) {}

	private report(message: string, offset = this.i): void {
		if (this.diagnostics.length < UI_MARKUP_LIMITS.diagnostics)
			this.diagnostics.push({ message, offset });
	}

	private eof(): boolean {
		return this.i >= this.s.length;
	}

	private skipSpace(): void {
		for (;;) {
			while (!this.eof() && /\s/.test(this.s[this.i] as string)) this.i++;
			if (this.s.startsWith("/*", this.i)) {
				const end = this.s.indexOf("*/", this.i + 2);
				if (end < 0) {
					this.i = this.s.length;
					throw INCOMPLETE;
				}
				this.i = end + 2;
			} else if (this.s.startsWith("//", this.i)) {
				const end = this.s.indexOf("\n", this.i);
				this.i = end < 0 ? this.s.length : end + 1;
			} else return;
		}
	}

	/** Children of `parent` (null at the top level) are appended as they complete. */
	parseChildren(into: UiNode[], parent: string | null): void {
		for (;;) {
			if (this.eof()) return;
			const char = this.s[this.i];
			// HTML comments are not JSX, but models write them; they are not content.
			if (char === "<" && this.s[this.i + 1] === "!") {
				const rest = this.s.slice(this.i, this.i + 4);
				if (rest === "<!--") {
					const end = this.s.indexOf("-->", this.i + 4);
					this.i = end < 0 ? this.s.length : end + 3;
					if (end < 0) throw INCOMPLETE;
					continue;
				}
				// "<!" or "<!-" at the end of the stream may still become a comment.
				if (this.i + rest.length >= this.s.length && "<!--".startsWith(rest)) {
					this.i = this.s.length;
					throw INCOMPLETE;
				}
			}
			if (char === "<" && this.s[this.i + 1] === "/") {
				const start = this.i;
				const end = this.s.indexOf(">", this.i);
				if (end < 0) {
					this.i = this.s.length;
					throw INCOMPLETE;
				}
				const name = this.s.slice(this.i + 2, end).trim();
				if (parent !== null && name === parent) {
					this.i = end + 1;
					return;
				}
				// A stray close that matches an ancestor ends this element too; let the
				// ancestor consume it. Anything else is noise from the model.
				if (parent !== null && this.open.includes(name)) {
					this.report(`<${parent || "fragment"}> was not closed before </${name}>`, start);
					return;
				}
				this.report(`Unexpected closing tag </${name}>`, start);
				this.i = end + 1;
				continue;
			}
			if (char === "<" && /[A-Za-z>]/.test(this.s[this.i + 1] ?? "")) {
				this.parseElement(into);
				continue;
			}
			if (char === "<" && this.i + 1 >= this.s.length) {
				this.i = this.s.length;
				throw INCOMPLETE;
			}
			if (char === "{") {
				this.parseChildExpression(into);
				continue;
			}
			let end = this.i + 1;
			while (end < this.s.length) {
				const next = this.s[end];
				if (next === "{") break;
				if (next === "<" && /[A-Za-z>/!]/.test(this.s[end + 1] ?? "")) break;
				// A trailing "<" may be the first byte of the next tag: hold it back.
				if (next === "<" && end + 1 >= this.s.length) break;
				end++;
			}
			const text = jsxText(this.s.slice(this.i, end));
			this.i = end;
			if (text) into.push({ $node: "text", text });
		}
	}

	private parseChildExpression(into: UiNode[]): void {
		const start = this.i;
		this.i++;
		this.skipSpace();
		if (this.s[this.i] === "}") {
			this.i++;
			return;
		}
		if (this.eof()) throw INCOMPLETE;
		const value = this.parseValue();
		this.closeBrace(start);
		this.appendChild(into, value, start);
	}

	private appendChild(into: UiNode[], value: Parsed, offset: number): void {
		if (value === OMIT || value === null || typeof value === "boolean") return;
		if (typeof value === "string" || typeof value === "number") {
			into.push({ $node: "text", text: String(value) });
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) this.appendChild(into, item, offset);
			return;
		}
		if ((value as UiElement).$node === "el") {
			into.push(value as UiElement);
			return;
		}
		this.report("Objects cannot be rendered as children", offset);
	}

	/** Consume up to the `}` that ends an expression container. */
	private closeBrace(start: number): void {
		this.skipSpace();
		if (this.eof()) throw INCOMPLETE;
		if (this.s[this.i] === "}") {
			this.i++;
			return;
		}
		this.report("Unsupported expression", start);
		this.skipExpression();
		if (this.eof()) throw INCOMPLETE;
		if (this.s[this.i] === "}") this.i++;
	}

	/** Parses one element; it is attached to `into` once its opening tag is complete. */
	private parseElement(into: UiNode[]): UiElement {
		const start = this.i;
		this.i++;
		let name = "";
		if (this.s[this.i] === ">") {
			this.i++;
		} else {
			const begin = this.i;
			while (!this.eof() && /[\w.-]/.test(this.s[this.i] as string)) this.i++;
			// A name at the very end of the stream may still be growing.
			if (this.eof()) throw INCOMPLETE;
			name = this.s.slice(begin, this.i);
		}
		const element: UiElement = { $node: "el", name, props: {}, children: [] };
		if (++this.depth > UI_MARKUP_LIMITS.depth || this.elements >= UI_MARKUP_LIMITS.elements) {
			this.report("UI markup is too deep or has too many elements", start);
			this.i = this.s.length;
			throw INCOMPLETE;
		}
		let selfClosed = false;
		if (name !== "") {
			for (;;) {
				this.skipSpace();
				if (this.eof()) throw INCOMPLETE;
				if (this.s[this.i] === "/" && this.s[this.i + 1] === ">") {
					this.i += 2;
					selfClosed = true;
					break;
				}
				if (this.s[this.i] === "/" && this.i + 1 >= this.s.length) throw INCOMPLETE;
				if (this.s[this.i] === ">") {
					this.i++;
					break;
				}
				if (this.s[this.i] === "{") {
					this.report("Spread attributes are not supported");
					this.i++;
					this.skipExpression();
					if (this.eof()) throw INCOMPLETE;
					this.i++;
					continue;
				}
				const begin = this.i;
				while (!this.eof() && /[\w:.@-]/.test(this.s[this.i] as string)) this.i++;
				if (this.i === begin) {
					this.report(`Unexpected "${this.s[this.i]}" in <${name}>`);
					this.i++;
					continue;
				}
				if (this.eof()) throw INCOMPLETE;
				const raw = this.s.slice(begin, this.i);
				this.skipSpace();
				let value: Parsed = true;
				if (this.s[this.i] === "=") {
					this.i++;
					this.skipSpace();
					value = this.parseAttributeValue();
				} else if (this.eof()) throw INCOMPLETE;
				const prop = PROP_ALIASES[raw] ?? raw;
				if (REACT_OWNED.has(prop)) {
					this.report(`"${prop}" is not supported`, begin);
					continue;
				}
				const admitted = this.admit(prop, value, begin);
				if (admitted !== OMIT)
					// React rejects a string `style` outright, taking the whole subtree
					// down with it; HTML-style text is what models write half the time.
					element.props[prop] =
						prop === "style" && typeof admitted === "string" ? cssTextToStyle(admitted) : admitted;
			}
		}
		this.elements++;
		into.push(element);
		if (!selfClosed && !(VOID.has(name) && isUiIntrinsicTag(name))) {
			this.open.push(name);
			try {
				this.parseChildren(element.children, name);
			} finally {
				this.open.pop();
			}
		}
		this.depth--;
		return element;
	}

	private parseAttributeValue(): Parsed {
		if (this.eof()) throw INCOMPLETE;
		const quote = this.s[this.i];
		if (quote === '"' || quote === "'") {
			const end = this.s.indexOf(quote, this.i + 1);
			if (end < 0) {
				this.i = this.s.length;
				throw INCOMPLETE;
			}
			const text = decodeEntities(this.s.slice(this.i + 1, end));
			this.i = end + 1;
			return text;
		}
		if (quote === "{") {
			const start = this.i;
			this.i++;
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			const value = this.parseValue();
			this.closeBrace(start);
			return value;
		}
		// HTML-style bare value (`cols=3`): tolerated because models emit it.
		const begin = this.i;
		while (!this.eof() && !/[\s/>]/.test(this.s[this.i] as string)) this.i++;
		if (this.eof()) throw INCOMPLETE;
		const token = this.s.slice(begin, this.i);
		return /^-?\d+(?:\.\d+)?$/.test(token) ? Number(token) : token;
	}

	private parseValue(): Parsed {
		// Literals nest by recursion; unbounded, a few thousand "[" would exhaust the
		// stack instead of producing a diagnostic.
		if (this.valueDepth >= UI_MARKUP_LIMITS.depth) {
			this.report("A value is nested too deeply");
			this.i = this.s.length;
			throw INCOMPLETE;
		}
		this.valueDepth++;
		try {
			return this.parseValueBody();
		} finally {
			this.valueDepth--;
		}
	}

	private parseValueBody(): Parsed {
		this.skipSpace();
		if (this.eof()) throw INCOMPLETE;
		const start = this.i;
		const char = this.s[this.i] as string;
		if (char === '"' || char === "'" || char === "`") return this.parseString(char);
		if (char === "[") return this.parseArray();
		if (char === "{") return this.parseObject();
		if (char === "<") {
			const holder: UiNode[] = [];
			return this.parseElement(holder);
		}
		// `() => sendPrompt("…")` is how models naturally write a handler; the wrapper
		// carries no behaviour of its own, so it is accepted and discarded.
		const arrow = /^(?:\(\s*[A-Za-z_$]?[\w$]*\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(
			this.s.slice(this.i, this.i + 80),
		);
		if (arrow) return this.parseHandler(start, arrow[0].length);
		if (char === "(") {
			this.i++;
			const inner = this.parseValue();
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			if (this.s[this.i] === ")") {
				this.i++;
				// `(a) => …` is a function, which this subset does not run.
				this.skipSpace();
				if (this.s.startsWith("=>", this.i)) return this.unsupported(start);
				return inner;
			}
			return this.unsupported(start);
		}
		const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(
			this.s.slice(this.i, this.i + 40),
		);
		if (number) {
			// Digits at the end of the stream may be a prefix of a longer number.
			if (this.i + number[0].length >= this.s.length) throw INCOMPLETE;
			this.i += number[0].length;
			return Number(number[0]);
		}
		const word = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 80));
		if (word) {
			if (this.i + word[0].length >= this.s.length) throw INCOMPLETE;
			const after = this.i + word[0].length;
			let next = after;
			while (next < this.s.length && /\s/.test(this.s[next] as string)) next++;
			if (this.s[next] === "(" && (UI_ACTIONS as readonly string[]).includes(word[0])) {
				this.i = next + 1;
				const argument = this.parseValue();
				this.skipSpace();
				if (this.eof()) throw INCOMPLETE;
				if (this.s[this.i] !== ")" || typeof argument !== "string")
					return this.unsupported(start, `${word[0]}() takes one string literal`);
				this.i++;
				return { $action: word[0] as UiActionName, value: argument };
			}
			if (this.s[next] !== "(" && this.s[next] !== "." && this.s[next] !== "=") {
				if (word[0] === "true" || word[0] === "false") {
					this.i = after;
					return word[0] === "true";
				}
				if (word[0] === "null") {
					this.i = after;
					return null;
				}
				if (word[0] === "undefined") {
					this.i = after;
					return OMIT;
				}
			}
		}
		return this.unsupported(start);
	}

	private parseHandler(start: number, prefix: number): Parsed {
		const message = "Handlers may only call sendPrompt() or openLink()";
		this.i = start + prefix;
		this.skipSpace();
		if (this.eof()) throw INCOMPLETE;
		const block = this.s[this.i] === "{";
		if (block) {
			this.i++;
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
		}
		const word = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 80));
		if (word && this.i + word[0].length >= this.s.length) throw INCOMPLETE;
		if (!word || !(UI_ACTIONS as readonly string[]).includes(word[0]))
			return this.unsupported(start, message);
		const value = this.parseValue();
		if (value === OMIT) {
			// Already reported; skip the whole handler, including a block body.
			this.i = start;
			this.skipExpression();
			return OMIT;
		}
		if (block) {
			this.skipSpace();
			if (this.s[this.i] === ";") this.i++;
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			if (this.s[this.i] !== "}") return this.unsupported(start, message);
			this.i++;
		}
		return value;
	}

	private unsupported(
		start: number,
		message = "Only literals, JSX, sendPrompt() and openLink() are supported",
	): typeof OMIT {
		this.i = start;
		this.report(message, start);
		this.skipExpression();
		return OMIT;
	}

	/** Skip to the unnested `,` `}` `]` or `)` that ends the current expression. */
	private skipExpression(): void {
		let nesting = 0;
		while (!this.eof()) {
			const char = this.s[this.i] as string;
			if (char === '"' || char === "'" || char === "`") {
				const end = this.stringEnd(char, this.i + 1);
				if (end < 0) {
					this.i = this.s.length;
					return;
				}
				this.i = end + 1;
				continue;
			}
			if (char === "(" || char === "[" || char === "{") nesting++;
			else if (char === ")" || char === "]" || char === "}") {
				if (nesting === 0) return;
				nesting--;
			} else if (char === "," && nesting === 0) return;
			this.i++;
		}
	}

	private stringEnd(quote: string, from: number): number {
		for (let at = from; at < this.s.length; at++) {
			if (this.s[at] === "\\") at++;
			else if (this.s[at] === quote) return at;
		}
		return -1;
	}

	private parseString(quote: string): Parsed {
		const end = this.stringEnd(quote, this.i + 1);
		if (end < 0) {
			this.i = this.s.length;
			throw INCOMPLETE;
		}
		const body = this.s.slice(this.i + 1, end);
		const start = this.i;
		this.i = end + 1;
		if (quote === "`" && body.includes("${"))
			this.report("Template interpolation is not evaluated", start);
		return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_match, code: string) => {
			if (code[0] === "u" && code.length === 5)
				return String.fromCharCode(Number.parseInt(code.slice(1), 16));
			if (code[0] === "x" && code.length === 3)
				return String.fromCharCode(Number.parseInt(code.slice(1), 16));
			return (
				({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as const)[
					code as "n"
				] ?? (code === "\n" ? "" : code)
			);
		});
	}

	private parseArray(): Parsed {
		this.i++;
		const items: UiValue[] = [];
		for (;;) {
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			if (this.s[this.i] === "]") {
				this.i++;
				return items;
			}
			if (this.s[this.i] === ",") {
				this.i++;
				continue;
			}
			const before = this.i;
			const value = this.parseValue();
			// An array slot has no name, so it is never a handler a reader triggers.
			if (isAction(value)) this.report(ACTION_PLACEMENT, before);
			else if (value !== OMIT) items.push(value);
			if (this.i === before) this.i++;
		}
	}

	private parseObject(): Parsed {
		this.i++;
		const object: Record<string, UiValue> = {};
		for (;;) {
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			const char = this.s[this.i] as string;
			if (char === "}") {
				this.i++;
				return object;
			}
			if (char === ",") {
				this.i++;
				continue;
			}
			let key: string;
			if (char === '"' || char === "'") {
				key = this.parseString(char) as string;
			} else {
				const word = /^[A-Za-z_$][\w$-]*|^\d+/.exec(this.s.slice(this.i, this.i + 120));
				if (!word) {
					this.report("Unsupported object member");
					this.skipExpression();
					if (!this.eof() && this.s[this.i] !== "}" && this.s[this.i] !== ",") this.i++;
					continue;
				}
				if (this.i + word[0].length >= this.s.length) throw INCOMPLETE;
				key = word[0];
				this.i += key.length;
			}
			this.skipSpace();
			if (this.eof()) throw INCOMPLETE;
			if (this.s[this.i] !== ":") {
				this.report(`Object member "${key}" needs a value`);
				this.skipExpression();
				continue;
			}
			this.i++;
			const at = this.i;
			const value = this.parseValue();
			// `$node` and `$action` are how the parser marks what it made from real tags
			// and real calls. A literal that could carry them would be markup in
			// disguise: an element with no tag check, a handler with no gesture.
			if (RESERVED_KEYS.has(key)) {
				this.report(`"${key}" is reserved`, at);
				continue;
			}
			const admitted = this.admit(key, value, at);
			// Own keys only, never the prototype chain of the object the renderer builds.
			if (admitted !== OMIT && key !== "__proto__" && key !== "constructor" && key !== "prototype")
				object[key] = admitted;
		}
	}

	/**
	 * The rules a named value must pass wherever the name appears: as an attribute, or
	 * as a member of a literal that a component may spread onto a DOM node.
	 */
	private admit(name: string, value: Parsed, offset: number): Parsed {
		if (value === OMIT) return OMIT;
		if (FORBIDDEN.has(name)) {
			this.report(`"${name}" is not supported`, offset);
			return OMIT;
		}
		if (isAction(value) && !ACTION_PROPS.has(name)) {
			this.report(ACTION_PLACEMENT, offset);
			return OMIT;
		}
		if (TAG_PROPS.has(name) && !(typeof value === "string" && isUiIntrinsicTag(value))) {
			this.report(`"${name}" may only name a permitted HTML tag`, offset);
			return OMIT;
		}
		return value;
	}
}

function isAction(value: Parsed): value is UiAction {
	return (
		value !== OMIT &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"$action" in value
	);
}

/**
 * `margin-top: 8px; color: red` as the object React requires. Declarations that are not
 * `name: value` are dropped; custom properties keep their name.
 */
function cssTextToStyle(text: string): Record<string, UiValue> {
	const style: Record<string, UiValue> = {};
	for (const declaration of text.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon <= 0) continue;
		const name = declaration.slice(0, colon).trim();
		const value = declaration.slice(colon + 1).trim();
		if (!value || !/^-{0,2}[A-Za-z][\w-]*$/.test(name)) continue;
		const key = name.startsWith("--")
			? name
			: name
					.replace(/^-ms-/, "ms-")
					.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
		if (key !== "__proto__" && key !== "constructor" && key !== "prototype") style[key] = value;
	}
	return style;
}

/**
 * Models often wrap markup in a Markdown fence; the fence is not part of the UI. While
 * the document is still streaming, neither is a fence line that has only half arrived.
 */
function stripFence(source: string, complete: boolean): string {
	if (!complete && /^\s*`{1,3}[\w-]*[ \t]*\r?$/.test(source)) return "";
	const fenced = /^\s*```[\w-]*[ \t]*\r?\n/.exec(source);
	if (!fenced) return source;
	const body = source.slice(fenced[0].length);
	const close = body.lastIndexOf("```");
	if (close >= 0 && body.slice(close + 3).trim() === "") return body.slice(0, close);
	// Inside a fence, a line of one or two backticks at the very end is its closing
	// line on the way in.
	return complete ? body : body.replace(/(^|\n)`{1,2}$/, "$1");
}

/**
 * Parse a complete or still-streaming document. With `complete: false` an unfinished
 * tail is silently dropped; with `complete: true` it is reported.
 */
export function parseUiMarkup(
	source: string,
	options: { complete?: boolean } = {},
): UiMarkupResult {
	const complete = options.complete !== false;
	const text = stripFence(source.slice(0, UI_MARKUP_LIMITS.sourceChars), complete);
	const parser = new Parser(text);
	const nodes: UiNode[] = [];
	try {
		parser.parseChildren(nodes, null);
	} catch (error) {
		// This runs on every streamed chunk in the chat and on the server for every
		// call: whatever the model wrote, the answer is a tree and diagnostics, never
		// an exception. Everything parsed before the failure is kept.
		if (error !== INCOMPLETE)
			parser.diagnostics.push({ message: "UI markup could not be parsed", offset: text.length });
		else if (complete)
			parser.diagnostics.push({ message: "UI markup ends unexpectedly", offset: text.length });
	}
	if (complete && source.length > UI_MARKUP_LIMITS.sourceChars)
		parser.diagnostics.push({
			message: `UI markup exceeds ${UI_MARKUP_LIMITS.sourceChars} characters`,
			offset: UI_MARKUP_LIMITS.sourceChars,
		});
	return {
		nodes,
		diagnostics: complete ? parser.diagnostics : [],
		elements: parser.elements,
	};
}

function isElement(value: unknown): value is UiElement {
	return !!value && typeof value === "object" && (value as UiElement).$node === "el";
}

function visitValue(value: UiValue, visit: (element: UiElement) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visitValue(item, visit);
	} else if (isElement(value)) {
		visitElements([value], visit);
	} else if (value && typeof value === "object" && !("$action" in value)) {
		for (const item of Object.values(value)) visitValue(item, visit);
	}
}

/** Every element, including those passed as attribute values (slots). */
export function visitElements(nodes: UiNode[], visit: (element: UiElement) => void): void {
	for (const node of nodes) {
		if (node.$node !== "el") continue;
		visit(node);
		for (const value of Object.values(node.props)) visitValue(value, visit);
		visitElements(node.children, visit);
	}
}

/**
 * Names the kit must provide: the root of each component tag (`Tabs` for `Tabs.List`).
 * HTML tags and fragments are excluded.
 */
export function collectUiComponentNames(nodes: UiNode[]): string[] {
	const names = new Set<string>();
	visitElements(nodes, (element) => {
		if (element.name === "" || isUiIntrinsicTag(element.name)) return;
		names.add(element.name.split(".")[0] as string);
	});
	return [...names];
}

/** Tags that are neither kit components nor permitted HTML. */
export function findUnknownUiTags(
	nodes: UiNode[],
	isComponent: (name: string) => boolean,
): string[] {
	const unknown = new Set<string>();
	visitElements(nodes, (element) => {
		if (element.name === "" || isUiIntrinsicTag(element.name)) return;
		const root = element.name.split(".")[0] as string;
		if (/^[a-z]/.test(element.name) || !isComponent(root)) unknown.add(element.name);
	});
	return [...unknown];
}
