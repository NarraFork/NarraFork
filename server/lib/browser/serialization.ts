export interface BrowserSerializeOptions {
	/** Pretty-print JSON values with indentation. */
	pretty?: boolean;
	/** Text to use if structured serialization fails. */
	fallbackText?: string;
}

function errorToJson(error: Error): Record<string, string> {
	return {
		name: error.name,
		message: error.message,
		...(error.stack ? { stack: error.stack } : {}),
	};
}

function createBrowserValueReplacer(): (_key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();
	return (_key, value) => {
		if (typeof value === "bigint") return `${value.toString()}n`;
		if (typeof value === "function") {
			return `[Function${value.name ? `: ${value.name}` : ""}]`;
		}
		if (typeof value === "symbol") return value.toString();
		if (value instanceof Error) return errorToJson(value);
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
		}
		return value;
	};
}

/**
 * Convert a value returned from the browser page context into stable tool output.
 *
 * Puppeteer may return `undefined` for valid scripts (for example no-return IIFEs),
 * and `JSON.stringify()` can also return `undefined` or throw for non-JSON values.
 * This helper keeps Browser tool output predictable for both direct evaluate results
 * and console argument capture.
 */
export function serializeBrowserValue(value: unknown, opts: BrowserSerializeOptions = {}): string {
	if (value === undefined) return "(undefined)";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "bigint") return `${value.toString()}n`;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
	if (value instanceof Error) {
		return serializeBrowserValue(errorToJson(value), opts);
	}

	try {
		const serialized = JSON.stringify(
			value,
			createBrowserValueReplacer(),
			opts.pretty ? 2 : undefined,
		);
		if (serialized !== undefined) return serialized;
	} catch {
		// Fall through to fallback/String conversion below.
	}

	if (opts.fallbackText) return opts.fallbackText;

	try {
		return String(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}
