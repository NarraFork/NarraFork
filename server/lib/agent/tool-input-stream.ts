/** Decoded offsets count raw UTF-16 code units: no CRLF normalization or code-point folding. */
export interface ToolInputFieldDelta {
	name: string;
	delta: string;
	startsField: boolean;
	offset: number;
	complete: boolean;
}

const JSON_STRING_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

interface Field {
	name: string;
	chunks: string[];
	pending: string[];
	fragment: string;
	offset: number;
	complete: boolean;
	materialized?: string;
}
interface Container {
	kind: "object" | "array";
	state: "key" | "colon" | "value" | "after";
	key?: string;
}

/**
 * Append-only JSON scanner. Only feed scans input; drain joins unsent decoded fragments,
 * never the cumulative input. A closed root is only a candidate: JSON.parse remains the
 * authority, and runs once at that candidate (or at the native final boundary).
 */
export class ToolInputStream {
	readonly rawChunks: string[] = [];
	readonly stats = {
		scannedChars: 0,
		parseAttempts: 0,
		rawMaterializations: 0,
		fieldMaterializations: 0,
	};
	totalChars = 0;
	private rawCache?: string;
	private readonly stack: Container[] = [];
	private rootStarted = false;
	private rootClosed = false;
	private trailingGarbage = false;
	private inString = false;
	private stringIsKey = false;
	private keyText = "";
	private escape = "";
	private unicode = "";
	private primitive = "";
	private primitiveField?: string;
	private active?: Field;
	private readonly fields = new Map<string, Field>();
	private queue: Field[] = [];
	private dirty: Record<string, string> = {};
	private candidateAttempted = false;
	private valid = false;
	private parsed?: Record<string, unknown>;
	private readonly short: ReadonlySet<string>;
	private readonly large: ReadonlySet<string>;

	constructor(short: Iterable<string> = [], large: Iterable<string> = []) {
		this.short = new Set(short);
		this.large = new Set(large);
	}

	feed(delta: string): void {
		if (!delta) return;
		this.rawChunks.push(delta);
		this.totalChars += delta.length;
		this.rawCache = undefined;
		for (let i = 0; i < delta.length; i++) {
			const ch = delta[i];
			this.stats.scannedChars++;
			if (this.inString) {
				this.stringChar(ch);
				continue;
			}
			if (this.primitive) {
				if (!/[ \t\r\n,}\]]/.test(ch)) {
					this.primitive += ch;
					continue;
				}
				this.endPrimitive();
			}
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
			if (this.rootClosed) {
				this.trailingGarbage = true;
				continue;
			}
			const parent = this.stack.at(-1);
			if (ch === '"') {
				this.rootStarted = true;
				this.inString = true;
				this.stringIsKey = parent?.kind === "object" && parent.state === "key";
				this.keyText = "";
				this.escape = "";
				this.unicode = "";
				if (!this.stringIsKey && this.stack.length === 1 && parent?.key) {
					const name = parent.key;
					if (this.short.has(name) || this.large.has(name)) {
						this.active = {
							name,
							chunks: [],
							pending: [],
							fragment: "",
							offset: 0,
							complete: false,
						};
						this.fields.set(name, this.active);
						if (this.large.has(name)) this.queue.push(this.active);
					}
				}
			} else if (ch === "{" || ch === "[") {
				this.rootStarted = true;
				this.stack.push({
					kind: ch === "{" ? "object" : "array",
					state: ch === "{" ? "key" : "value",
				});
			} else if (ch === "}" || ch === "]") {
				this.stack.pop();
				this.endValue();
			} else if (ch === ":" && parent) {
				parent.state = "value";
			} else if (ch === "," && parent) {
				parent.state = parent.kind === "object" ? "key" : "value";
				parent.key = undefined;
			} else {
				this.rootStarted = true;
				this.primitive = ch;
				this.primitiveField = this.stack.length === 1 ? parent?.key : undefined;
			}
		}
		this.flushFragment();
	}

	private emit(text: string): void {
		if (this.stringIsKey) this.keyText += text;
		else if (this.active) this.active.fragment += text;
	}

	private stringChar(ch: string): void {
		if (this.escape === "unicode") {
			if (!/[\da-fA-F]/.test(ch)) {
				this.emit(`\\u${this.unicode}`);
				this.escape = "";
				this.stringChar(ch);
				return;
			}
			this.unicode += ch;
			if (this.unicode.length === 4) {
				this.emit(
					/^[\da-fA-F]{4}$/.test(this.unicode)
						? String.fromCharCode(Number.parseInt(this.unicode, 16))
						: `\\u${this.unicode}`,
				);
				this.escape = "";
			}
			return;
		}
		if (this.escape === "slash") {
			if (ch === "u") {
				this.escape = "unicode";
				this.unicode = "";
			} else {
				this.emit(JSON_STRING_ESCAPES[ch] ?? `\\${ch}`);
				this.escape = "";
			}
			return;
		}
		if (ch === "\\") this.escape = "slash";
		else if (ch === '"') {
			this.inString = false;
			if (this.stringIsKey) {
				const parent = this.stack.at(-1);
				if (parent) {
					parent.key = this.keyText;
					parent.state = "colon";
				}
			} else {
				if (this.active) {
					this.flushFragment();
					this.active.complete = true;
					if (this.short.has(this.active.name))
						this.dirty[this.active.name] = this.getField(this.active.name) ?? "";
					this.active = undefined;
				}
				this.endValue();
			}
		} else this.emit(ch);
	}

	private flushFragment(): void {
		if (!this.active?.fragment) return;
		const field = this.active;
		field.chunks.push(field.fragment);
		field.pending.push(field.fragment);
		field.fragment = "";
	}

	private endPrimitive(): void {
		if (this.primitiveField && this.short.has(this.primitiveField)) {
			this.dirty[this.primitiveField] = this.primitive;
		}
		this.primitive = "";
		this.primitiveField = undefined;
		this.endValue();
	}

	private endValue(): void {
		const parent = this.stack.at(-1);
		if (parent) parent.state = "after";
		else if (this.rootStarted) this.rootClosed = true;
	}

	get hasClosedFields(): boolean {
		return this.queue.some((field) => field.complete);
	}

	takeShortFields(): Record<string, string> {
		const dirty = this.dirty;
		this.dirty = {};
		return dirty;
	}

	/** Completed values are joined lazily once (notably Edit.old_string metadata). */
	getField(name: string): string | undefined {
		const field = this.fields.get(name);
		if (!field?.complete) return undefined;
		if (field.materialized === undefined) {
			this.stats.fieldMaterializations++;
			field.materialized = field.chunks.join("");
		}
		return field.materialized;
	}

	drainFields(): ToolInputFieldDelta[] {
		const result: ToolInputFieldDelta[] = [];
		const next: Field[] = [];
		for (const field of this.queue) {
			const delta = field.pending.join("");
			field.pending = [];
			if (delta || field.complete) {
				result.push({
					name: field.name,
					delta,
					startsField: field.offset === 0,
					offset: field.offset,
					complete: field.complete,
				});
				field.offset += delta.length;
			}
			if (!field.complete) next.push(field);
		}
		this.queue = next;
		return result;
	}

	materializeRaw(): string {
		if (this.rawCache === undefined) {
			this.stats.rawMaterializations++;
			this.rawCache = this.rawChunks.join("");
		}
		return this.rawCache;
	}

	parseComplete(): Record<string, unknown> | undefined {
		if (!this.rootClosed || this.trailingGarbage) return undefined;
		if (!this.candidateAttempted) this.parse();
		return this.parsed;
	}

	hasCompleteInput(): boolean {
		this.parseComplete();
		return this.rootClosed && !this.trailingGarbage && this.valid;
	}

	private parse(): void {
		this.candidateAttempted = true;
		this.stats.parseAttempts++;
		try {
			this.parsed = JSON.parse(this.materializeRaw());
			this.valid = true;
		} catch {
			this.parsed = undefined;
		}
	}

	finish(): Record<string, unknown> {
		if (!this.totalChars) return {};
		if (!this.candidateAttempted) this.parse();
		if (this.trailingGarbage) return { _raw: this.materializeRaw() };
		return this.valid ? (this.parsed as Record<string, unknown>) : { _raw: this.materializeRaw() };
	}
}

/** Lazy initialization also accepts legacy/test accumulators with an initial args snapshot. */
export function toolInputStreamFor(acc: {
	args?: string;
	inputStream?: ToolInputStream;
}): ToolInputStream {
	if (!acc.inputStream) {
		acc.inputStream = new ToolInputStream();
		if (acc.args) acc.inputStream.feed(acc.args);
		acc.args = undefined;
	}
	return acc.inputStream;
}

/** Native done arguments are a snapshot, not an append. Compare only at this final boundary. */
export function finalToolInput(
	acc: { args?: string; inputStream?: ToolInputStream },
	raw: unknown,
): { finalInput?: string } {
	if (typeof raw !== "string" || raw === toolInputStreamFor(acc).materializeRaw()) return {};
	return { finalInput: raw };
}
