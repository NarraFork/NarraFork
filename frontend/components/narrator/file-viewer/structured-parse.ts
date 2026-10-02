/**
 * structured-parse.ts — Parse structured config/data text into a collapsible
 * key/value node tree for the file viewer's "node" mode.
 *
 * Supported formats: json, toml, ini. Markdown deliberately has no node mode
 * (it renders as markdown instead), and YAML is out of scope — a conservative
 * hand-written YAML subset is the easiest way to silently display WRONG content,
 * so `.yaml` / `.yml` fall through to raw highlighting.
 *
 * Two hard rules:
 *
 *  1. **Never guess.** Any construct the parser does not fully understand makes
 *     the whole parse fail (`{ error }`), and the panel falls back to raw text.
 *     Showing a partially-understood config as if it were complete is worse than
 *     showing the source.
 *  2. **Bounded work.** Node count and depth are capped so a pathological file
 *     cannot lock the main thread building a giant tree. The input is already
 *     bounded twice (1 MB by `/api/fs/preview`, 120k chars by the panel's
 *     streaming read), so these caps only guard the tree expansion itself.
 *
 * Pure, synchronous, DOM-free — unit-testable in isolation.
 */

export type StructuredFormat = "json" | "toml" | "ini";

export type StructuredValueType = "string" | "number" | "boolean" | "null";

export type StructuredNode =
	| {
			kind: "leaf";
			key: string;
			value: string;
			valueType: StructuredValueType;
			/** 0-based source line, when the parser could locate the entry. */
			line?: number;
	  }
	| {
			kind: "branch";
			key: string;
			children: StructuredNode[];
			/** Direct child count (shown as a badge on a collapsed branch). */
			childCount: number;
			/** 0-based source line, when the parser could locate the entry. */
			line?: number;
	  };

export interface StructuredParseOk {
	nodes: StructuredNode[];
	/** True when a cap was hit and the tree is incomplete. */
	truncated: boolean;
}

export interface StructuredParseError {
	error: string;
}

export type StructuredParseResult = StructuredParseOk | StructuredParseError;

/** Maximum nesting depth expanded into nodes. */
export const MAX_STRUCTURED_DEPTH = 64;
/** Maximum total nodes produced. */
export const MAX_STRUCTURED_NODES = 20_000;

const FORMAT_BY_EXT: Record<string, StructuredFormat> = {
	json: "json",
	jsonc: "json",
	toml: "toml",
	ini: "ini",
	cfg: "ini",
	properties: "ini",
};

/** True when a parse result is the failure shape. */
export function isStructuredParseError(
	result: StructuredParseResult,
): result is StructuredParseError {
	return "error" in result;
}

/**
 * Resolve the node-mode format for a path, or null when the file has no node
 * representation (markdown, code, plain text, yaml).
 */
export function detectStructuredFormat(filePath: string): StructuredFormat | null {
	const base = filePath.split(/[/\\]/).pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null;
	const ext = base.slice(dot + 1).toLowerCase();
	return FORMAT_BY_EXT[ext] ?? null;
}

/** Parse `text` into a node tree, or return an error for raw fallback. */
export function parseStructured(text: string, format: StructuredFormat): StructuredParseResult {
	switch (format) {
		case "json":
			return parseJsonNodes(text);
		case "toml":
			return parseTomlNodes(text);
		case "ini":
			return parseIniNodes(text);
	}
}

// ── shared plain-object → node conversion ────────────────────────────────────

/** Mutable budget shared by one conversion pass. */
interface Budget {
	remaining: number;
	truncated: boolean;
}

/**
 * RFC 6901 escaping for path segments in the line map: keys may themselves
 * contain "/" or "~", and an unescaped join would make two distinct paths
 * collide onto one line entry.
 */
function escapePathSegment(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Map key for the line of the node at `segments` (e.g. `/a/[0]/b`). */
function pathKey(segments: readonly string[]): string {
	let out = "";
	for (const segment of segments) out += `/${escapePathSegment(segment)}`;
	return out;
}

function leafFor(key: string, value: unknown): StructuredNode {
	if (value === null) return { kind: "leaf", key, value: "null", valueType: "null" };
	switch (typeof value) {
		case "number":
			return {
				kind: "leaf",
				key,
				value: Number.isFinite(value) ? String(value) : "null",
				valueType: Number.isFinite(value) ? "number" : "null",
			};
		case "boolean":
			return { kind: "leaf", key, value: value ? "true" : "false", valueType: "boolean" };
		case "string":
			return { kind: "leaf", key, value, valueType: "string" };
		default:
			// undefined / function / symbol never survive JSON.parse; treat defensively.
			return { kind: "leaf", key, value: String(value), valueType: "string" };
	}
}

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	return typeof value === "object" && value !== null;
}

/**
 * Convert a parsed value into nodes, honouring the depth + node budget. When a
 * cap is hit the branch gets a synthetic truncation leaf and `budget.truncated`
 * is set so the panel can say so.
 *
 * `lines` maps escaped path keys (see `pathKey`) to 0-based source lines; it is
 * what lets the split view scroll-sync a node tree against the source. Missing
 * entries simply leave the node anchorless.
 */
function valueToNodes(
	value: unknown,
	depth: number,
	budget: Budget,
	keyPrefix = "",
	lines?: ReadonlyMap<string, number>,
): StructuredNode[] {
	if (!isPlainContainer(value)) return [];
	if (depth >= MAX_STRUCTURED_DEPTH) {
		budget.truncated = true;
		return [];
	}

	const entries: [string, unknown][] = Array.isArray(value)
		? value.map((item, index) => [`[${index}]`, item] as [string, unknown])
		: Object.entries(value);

	const nodes: StructuredNode[] = [];
	for (const [key, child] of entries) {
		if (budget.remaining <= 0) {
			budget.truncated = true;
			break;
		}
		budget.remaining -= 1;
		const line = lines?.get(`${keyPrefix}/${escapePathSegment(key)}`);
		let node: StructuredNode;
		if (isPlainContainer(child)) {
			const children = valueToNodes(
				child,
				depth + 1,
				budget,
				`${keyPrefix}/${escapePathSegment(key)}`,
				lines,
			);
			node = { kind: "branch", key, children, childCount: children.length };
		} else {
			node = leafFor(key, child);
		}
		if (line !== undefined) node.line = line;
		nodes.push(node);
	}
	return nodes;
}

function toResult(value: unknown, lines?: ReadonlyMap<string, number>): StructuredParseResult {
	const budget: Budget = { remaining: MAX_STRUCTURED_NODES, truncated: false };
	if (!isPlainContainer(value)) {
		// A bare scalar document (e.g. `42`) has no tree worth showing.
		return { error: "Document root is not an object or array" };
	}
	const nodes = valueToNodes(value, 0, budget, "", lines);
	return { nodes, truncated: budget.truncated };
}

// ── json ─────────────────────────────────────────────────────────────────────

/**
 * Record the 0-based source line of every object member and array element in a
 * JSON document, keyed by escaped path (`/a/[0]/b`). `JSON.parse` discards
 * position information, and the split view's scroll sync needs a line per tree
 * node — so this is a separate iterative pass over the text.
 *
 * Why iterative and defensive: the input can be up to 1 MB, which permits
 * nesting deep enough to overflow a recursive descent; and while the scanner is
 * only consulted after `JSON.parse` has accepted the document, any internal
 * surprise must degrade to "no lines" (proportional scroll sync) rather than
 * break the node view. Object members record the KEY's line (the tree row shows
 * the key); array elements record the element's start line. Depth beyond
 * MAX_STRUCTURED_DEPTH is structurally walked but not recorded — the node
 * conversion truncates there anyway.
 */
function scanJsonLines(text: string): Map<string, number> {
	const lines = new Map<string, number>();
	const n = text.length;
	let i = 0;
	let line = 0;

	type Frame =
		| {
				kind: "object";
				/** Escaped path key of this container, or null past the recording depth. */
				key: string | null;
				pendingKey: string | null;
				pendingLine: number;
				expectValue: boolean;
		  }
		| { kind: "array"; key: string | null; index: number };
	const stack: Frame[] = [];

	const skipSpace = () => {
		while (i < n) {
			const code = text.charCodeAt(i);
			if (code === 10) {
				line++;
				i++;
			} else if (code === 13) {
				i++;
				if (text.charCodeAt(i) === 10) i++;
				line++;
			} else if (code === 32 || code === 9) {
				i++;
			} else break;
		}
	};

	/** Consume the string token at `i` (text[i] === '"'); returns it decoded, or null. */
	const scanString = (): string | null => {
		const start = i;
		i++;
		while (i < n) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === '"') {
				i++;
				try {
					return JSON.parse(text.slice(start, i)) as string;
				} catch {
					return null;
				}
			}
			// Raw newlines are invalid inside JSON strings; count defensively anyway.
			if (ch === "\n") line++;
			else if (ch === "\r") {
				if (text[i + 1] === "\n") i++;
				line++;
			}
			i++;
		}
		return null;
	};

	/** Skip a number / true / false / null token at `i`. */
	const skipAtom = () => {
		while (i < n && !",}] \t\r\n".includes(text[i] as string)) i++;
	};

	/** Handle the value starting at `i`: push a frame for containers, skip scalars. */
	const openValue = (entryKey: string | null) => {
		const ch = text[i];
		if (ch === "{" || ch === "[") {
			// Frames past the recording depth keep the structure walk correct but
			// carry a null key so nothing inside them is recorded.
			const key = entryKey !== null && stack.length <= MAX_STRUCTURED_DEPTH ? entryKey : null;
			if (ch === "{") {
				stack.push({ kind: "object", key, pendingKey: null, pendingLine: 0, expectValue: false });
			} else {
				stack.push({ kind: "array", key, index: 0 });
			}
			i++;
			return;
		}
		if (ch === '"') scanString();
		else skipAtom();
	};

	if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM: line 0 content, skip for the root check
	skipSpace();
	if (text[i] === "{") {
		stack.push({ kind: "object", key: "", pendingKey: null, pendingLine: 0, expectValue: false });
		i++;
	} else if (text[i] === "[") {
		stack.push({ kind: "array", key: "", index: 0 });
		i++;
	} else {
		return lines; // scalar root — rejected by toResult anyway
	}

	while (stack.length > 0 && i < n) {
		skipSpace();
		if (i >= n) break;
		const frame = stack[stack.length - 1] as Frame;
		const ch = text[i];

		if (frame.kind === "object") {
			if (!frame.expectValue) {
				if (ch === "}") {
					stack.pop();
					i++;
					continue;
				}
				if (ch === ",") {
					i++;
					continue;
				}
				if (ch !== '"') return lines; // unexpected token — bail, keep what we have
				const keyLine = line;
				const key = scanString();
				if (key === null) return lines;
				skipSpace();
				if (text[i] !== ":") return lines;
				i++;
				frame.pendingKey = key;
				frame.pendingLine = keyLine;
				frame.expectValue = true;
				continue;
			}
			// Value position for the pending member key.
			frame.expectValue = false;
			const entryKey =
				frame.key === null ? null : `${frame.key}/${escapePathSegment(frame.pendingKey as string)}`;
			if (entryKey !== null) lines.set(entryKey, frame.pendingLine);
			frame.pendingKey = null;
			openValue(entryKey);
			continue;
		}

		// Array frame: value, "," or "]".
		if (ch === "]") {
			stack.pop();
			i++;
			continue;
		}
		if (ch === ",") {
			i++;
			continue;
		}
		const entryKey =
			frame.key === null ? null : `${frame.key}/${escapePathSegment(`[${frame.index}]`)}`;
		if (entryKey !== null) lines.set(entryKey, line);
		frame.index++;
		openValue(entryKey);
	}
	return lines;
}

function parseJsonNodes(text: string): StructuredParseResult {
	const trimmed = text.trim();
	if (!trimmed) return { error: "Empty file" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		return { error: err instanceof Error ? err.message : "Invalid JSON" };
	}
	// Scan the ORIGINAL text: trim() removes leading blank lines, which would
	// shift every recorded line away from the editor's line numbers.
	let lines: Map<string, number> | undefined;
	try {
		lines = scanJsonLines(text);
	} catch {
		lines = undefined; // anchorless tree beats no tree
	}
	return toResult(parsed, lines);
}

// ── line splitting shared by toml + ini ──────────────────────────────────────

function splitLines(text: string): string[] {
	// Strip a UTF-8 BOM so the first key is not named "\uFEFFkey".
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	return body.split(/\r\n|\r|\n/);
}

/** Container built while walking lines: ordered key → value | nested container. */
type Container = Map<string, unknown>;

function newContainer(): Container {
	return new Map();
}

/** Depth-first conversion of the Map tree into plain objects for `toResult`. */
function containerToPlain(container: Container): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of container) {
		if (value instanceof Map) out[key] = containerToPlain(value);
		else if (Array.isArray(value)) {
			out[key] = value.map((item) => (item instanceof Map ? containerToPlain(item) : item));
		} else out[key] = value;
	}
	return out;
}

// ── ini ──────────────────────────────────────────────────────────────────────

function parseIniNodes(text: string): StructuredParseResult {
	const root = newContainer();
	const lines = new Map<string, number>();
	let section: Container = root;
	let sectionName: string | null = null;
	let sawAny = false;

	const sourceLines = splitLines(text);
	for (let i = 0; i < sourceLines.length; i++) {
		const raw = sourceLines[i] ?? "";
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;

		if (line.startsWith("[")) {
			if (!line.endsWith("]")) return { error: `Line ${i + 1}: unterminated section header` };
			const name = line.slice(1, -1).trim();
			if (!name) return { error: `Line ${i + 1}: empty section name` };
			const existing = root.get(name);
			if (existing instanceof Map) {
				section = existing;
			} else {
				section = newContainer();
				root.set(name, section);
			}
			sectionName = name;
			// First occurrence wins: a re-opened section keeps its original anchor.
			if (!lines.has(pathKey([name]))) lines.set(pathKey([name]), i);
			sawAny = true;
			continue;
		}

		const eq = line.indexOf("=");
		if (eq === -1) return { error: `Line ${i + 1}: expected "key = value"` };
		const key = line.slice(0, eq).trim();
		if (!key) return { error: `Line ${i + 1}: empty key` };
		// INI values are untyped text; keep quotes stripped but do not coerce.
		section.set(key, stripQuotes(line.slice(eq + 1).trim()));
		lines.set(pathKey(sectionName ? [sectionName, key] : [key]), i);
		sawAny = true;
	}

	if (!sawAny) return { error: "No INI entries found" };
	return toResult(containerToPlain(root), lines);
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

// ── toml ─────────────────────────────────────────────────────────────────────

/**
 * Conservative line-oriented TOML subset:
 *   [table] / [a.b.c]        — nested tables
 *   [[array]] / [[a.b]]      — arrays of tables
 *   key = value              — single-line scalars and single-line arrays
 *   # comment                — full-line and trailing comments (outside strings)
 *
 * Anything else — multi-line basic/literal strings (`"""` / `'''`), multi-line
 * arrays, inline tables spanning lines — makes the parse fail so the panel shows
 * raw text rather than a half-understood document.
 */
function parseTomlNodes(text: string): StructuredParseResult {
	const root = newContainer();
	const lines = new Map<string, number>();
	let current: Container = root;
	// Resolved path of `current` (array-of-tables hops spelled `[i]`), so entry
	// lines can be keyed by the path the node tree will actually show.
	let currentPath: string[] = [];
	let sawAny = false;

	const sourceLines = splitLines(text);
	for (let i = 0; i < sourceLines.length; i++) {
		const line = stripTomlComment((sourceLines[i] ?? "").trim());
		if (!line) continue;

		if (line.startsWith("[[")) {
			if (!line.endsWith("]]")) return { error: `Line ${i + 1}: unterminated [[table]] header` };
			const path = parseTomlKeyPath(line.slice(2, -2).trim());
			if (!path) return { error: `Line ${i + 1}: invalid table name` };
			const next = pushArrayTable(root, path);
			if (!next) return { error: `Line ${i + 1}: conflicting table path` };
			current = next.container;
			currentPath = next.resolved;
			recordLinePrefixes(lines, next.resolved, i);
			sawAny = true;
			continue;
		}

		if (line.startsWith("[")) {
			if (!line.endsWith("]")) return { error: `Line ${i + 1}: unterminated [table] header` };
			const path = parseTomlKeyPath(line.slice(1, -1).trim());
			if (!path) return { error: `Line ${i + 1}: invalid table name` };
			const next = descendResolved(root, path);
			if (!next) return { error: `Line ${i + 1}: conflicting table path` };
			current = next.container;
			currentPath = next.resolved;
			recordLinePrefixes(lines, next.resolved, i);
			sawAny = true;
			continue;
		}

		const eq = findTomlAssignment(line);
		if (eq === -1) return { error: `Line ${i + 1}: expected "key = value"` };
		const path = parseTomlKeyPath(line.slice(0, eq).trim());
		if (!path) return { error: `Line ${i + 1}: invalid key` };
		const parsedValue = parseTomlValue(line.slice(eq + 1).trim());
		if (parsedValue === UNPARSEABLE) {
			return { error: `Line ${i + 1}: unsupported TOML value` };
		}
		const leafKey = path[path.length - 1] as string;
		// descendResolved reports a path RELATIVE to `current`; prefix it with the
		// current table's resolved path so the line keys match the node tree.
		const owner =
			path.length > 1
				? descendResolved(current, path.slice(0, -1))
				: { container: current, resolved: [] as string[] };
		if (!owner) return { error: `Line ${i + 1}: conflicting key path` };
		owner.container.set(leafKey, parsedValue);
		recordLinePrefixes(lines, [...currentPath, ...owner.resolved, leafKey], i);
		sawAny = true;
	}

	if (!sawAny) return { error: "No TOML entries found" };
	return toResult(containerToPlain(root), lines);
}

/** Sentinel for "this line uses TOML syntax we do not support". */
const UNPARSEABLE = Symbol("unparseable");

/**
 * Remove a trailing `#` comment, respecting quoted strings so a `#` inside a
 * value is preserved.
 */
function stripTomlComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && inDouble) {
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i).trim();
	}
	return line;
}

/** Index of the top-level `=` in a key/value line, or -1. */
function findTomlAssignment(line: string): number {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && inDouble) {
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "=" && !inSingle && !inDouble) return i;
	}
	return -1;
}

/** Split a dotted key path (`a.b."c.d"`), or null when malformed. */
function parseTomlKeyPath(raw: string): string[] | null {
	if (!raw) return null;
	const parts: string[] = [];
	let buffer = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i] as string;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				const next = raw[i + 1];
				if (next === undefined) return null;
				buffer += next;
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ".") {
			const segment = buffer.trim();
			if (!segment) return null;
			parts.push(segment);
			buffer = "";
			continue;
		}
		buffer += ch;
	}
	if (quote) return null;
	const last = buffer.trim();
	if (!last) return null;
	parts.push(last);
	return parts;
}

/**
 * `descend` plus the RESOLVED path (array-of-tables hops spelled `[i]`), which
 * is the path the node tree will actually show — needed to key line numbers.
 */
function descendResolved(
	root: Container,
	path: string[],
): { container: Container; resolved: string[] } | null {
	const resolved: string[] = [];
	let node = root;
	for (const segment of path) {
		const existing = node.get(segment);
		if (existing instanceof Map) {
			node = existing;
			resolved.push(segment);
			continue;
		}
		if (Array.isArray(existing)) {
			// `[[a]]` then `[a.b]` targets the LAST element of the array of tables.
			const tail = existing[existing.length - 1];
			if (!(tail instanceof Map)) return null;
			resolved.push(segment, `[${existing.length - 1}]`);
			node = tail;
			continue;
		}
		if (existing !== undefined) return null;
		const created = newContainer();
		node.set(segment, created);
		resolved.push(segment);
		node = created;
	}
	return { container: node, resolved };
}

/** Append a fresh table to the array of tables at `path`. */
function pushArrayTable(
	root: Container,
	path: string[],
): { container: Container; resolved: string[] } | null {
	const parentPath = path.slice(0, -1);
	const key = path[path.length - 1] as string;
	const parent =
		parentPath.length > 0
			? descendResolved(root, parentPath)
			: { container: root, resolved: [] as string[] };
	if (!parent) return null;
	const existing = parent.container.get(key);
	const created = newContainer();
	if (existing === undefined) {
		parent.container.set(key, [created]);
		return { container: created, resolved: [...parent.resolved, key, "[0]"] };
	}
	if (Array.isArray(existing)) {
		existing.push(created);
		return { container: created, resolved: [...parent.resolved, key, `[${existing.length - 1}]`] };
	}
	return null;
}

/** Record `line` for `segments` and every unrecorded prefix of it (first wins). */
function recordLinePrefixes(
	lines: Map<string, number>,
	segments: readonly string[],
	line: number,
): void {
	for (let end = segments.length; end >= 1; end--) {
		const key = pathKey(segments.slice(0, end));
		if (lines.has(key)) continue;
		lines.set(key, line);
	}
}

/** Parse a single-line TOML value, or return UNPARSEABLE. */
function parseTomlValue(raw: string): unknown | typeof UNPARSEABLE {
	if (!raw) return UNPARSEABLE;
	// Multi-line string / array openers are explicitly unsupported.
	if (raw.startsWith('"""') || raw.startsWith("'''")) return UNPARSEABLE;
	if (raw === "true") return true;
	if (raw === "false") return false;

	if (raw.startsWith('"')) {
		const parsed = parseQuoted(raw, '"');
		return parsed ?? UNPARSEABLE;
	}
	if (raw.startsWith("'")) {
		const parsed = parseQuoted(raw, "'");
		return parsed ?? UNPARSEABLE;
	}
	if (raw.startsWith("[")) {
		if (!raw.endsWith("]")) return UNPARSEABLE; // multi-line array
		return parseInlineArray(raw.slice(1, -1));
	}
	// Inline tables would need their own recursive parse; not supported.
	if (raw.startsWith("{")) return UNPARSEABLE;

	// Numbers (TOML allows `_` separators). Dates/times stay strings on purpose.
	const numeric = raw.replace(/_/g, "");
	if (/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(numeric)) {
		const value = Number(numeric);
		if (Number.isFinite(value)) return value;
	}
	if (/^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(raw)) return raw;
	return UNPARSEABLE;
}

/** Parse a fully-quoted single-line string, or null when it is not one. */
function parseQuoted(raw: string, quote: '"' | "'"): string | null {
	let out = "";
	for (let i = 1; i < raw.length; i++) {
		const ch = raw[i] as string;
		if (quote === '"' && ch === "\\") {
			const next = raw[i + 1];
			if (next === undefined) return null;
			out += unescapeChar(next);
			i++;
			continue;
		}
		if (ch === quote) {
			// The closing quote must be the last character (trailing junk → fail).
			return i === raw.length - 1 ? out : null;
		}
		out += ch;
	}
	return null;
}

function unescapeChar(ch: string): string {
	switch (ch) {
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "\\":
			return "\\";
		case '"':
			return '"';
		default:
			return ch;
	}
}

/** Split a single-line inline array body on top-level commas. */
function parseInlineArray(body: string): unknown[] | typeof UNPARSEABLE {
	const trimmed = body.trim();
	if (!trimmed) return [];
	const items: unknown[] = [];
	let depth = 0;
	let quote: '"' | "'" | null = null;
	let start = 0;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i] as string;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			const item = parseTomlValue(trimmed.slice(start, i).trim());
			if (item === UNPARSEABLE) return UNPARSEABLE;
			items.push(item);
			start = i + 1;
		}
	}
	if (quote || depth !== 0) return UNPARSEABLE;
	const tail = trimmed.slice(start).trim();
	// A trailing comma leaves an empty tail — valid TOML.
	if (tail) {
		const item = parseTomlValue(tail);
		if (item === UNPARSEABLE) return UNPARSEABLE;
		items.push(item);
	}
	return items;
}
