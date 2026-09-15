/**
 * sed-style line/regex addressing.
 *
 * Lives outside the provider layer on purpose: an address like `120,180` or
 * `/TODO/` needs no grammar, no parse and no language detection, so `print` keeps
 * working on a YAML file, a log, or a language whose grammar was never downloaded.
 * StructSed will reuse the same parser for its own addresses, so a user learns one
 * address syntax for reading and writing.
 *
 * Supported forms:
 *   `42`          single line
 *   `10,20`       inclusive line range
 *   `10,$`        line 10 to end of file
 *   `$`           last line
 *   `/re/`        every line matching the regex
 *   `/re/,/re2/`  from a line matching the first regex to one matching the second
 */

export type Address =
	| { kind: "line"; line: number }
	| { kind: "range"; start: number; end: number | "last" }
	| { kind: "last" }
	| { kind: "regex"; pattern: string; flags: string }
	| { kind: "regex-range"; from: string; to: string; flags: string };

export interface AddressBlock {
	/** 1-based inclusive. */
	startLine: number;
	endLine: number;
}

export class AddressError extends Error {}

/** Parse an address string. Throws `AddressError` with a model-readable message. */
export function parseAddress(raw: string): Address {
	const input = raw.trim();
	if (input.length === 0) throw new AddressError("address is empty");

	if (input === "$") return { kind: "last" };

	// Regex range: /a/,/b/ — split before the single-regex case so the comma is not
	// mistaken for a numeric range separator.
	const regexRange = /^\/((?:[^/\\]|\\.)*)\/\s*,\s*\/((?:[^/\\]|\\.)*)\/([a-z]*)$/.exec(input);
	if (regexRange?.[1] !== undefined && regexRange[2] !== undefined) {
		return {
			kind: "regex-range",
			from: regexRange[1],
			to: regexRange[2],
			flags: sanitizeFlags(regexRange[3]),
		};
	}

	const regexOnly = /^\/((?:[^/\\]|\\.)*)\/([a-z]*)$/.exec(input);
	if (regexOnly?.[1] !== undefined) {
		return { kind: "regex", pattern: regexOnly[1], flags: sanitizeFlags(regexOnly[2]) };
	}

	const range = /^(\d+)\s*,\s*(\d+|\$)$/.exec(input);
	if (range?.[1] && range[2]) {
		const start = Number(range[1]);
		if (start < 1) throw new AddressError("line numbers are 1-based");
		if (range[2] === "$") return { kind: "range", start, end: "last" };
		const end = Number(range[2]);
		if (end < start) throw new AddressError(`range end ${end} precedes start ${start}`);
		return { kind: "range", start, end };
	}

	const single = /^(\d+)$/.exec(input);
	if (single?.[1]) {
		const line = Number(single[1]);
		if (line < 1) throw new AddressError("line numbers are 1-based");
		return { kind: "line", line };
	}

	throw new AddressError(
		`unrecognized address "${raw}". Use a line number, "start,end", "$", "/regex/", or "/from/,/to/".`,
	);
}

export interface ResolveAddressOptions {
	/** Stop after this many blocks. */
	maxBlocks?: number;
	/** Bound regex scanning on very large files. */
	maxScanLines?: number;
}

export interface ResolveAddressResult {
	blocks: AddressBlock[];
	/** True when `maxBlocks` cut the result short. */
	truncated: boolean;
}

/**
 * Resolve an address against file lines.
 *
 * Out-of-range line numbers produce no blocks rather than an error: an address
 * derived from stale output should read as "nothing there", not as a failed call.
 */
export function resolveAddress(
	address: Address,
	lines: readonly string[],
	options: ResolveAddressOptions = {},
): ResolveAddressResult {
	const maxBlocks = options.maxBlocks ?? 200;
	const total = lines.length;
	const scanLimit = Math.min(total, options.maxScanLines ?? 500_000);

	switch (address.kind) {
		case "line": {
			if (address.line > total) return { blocks: [], truncated: false };
			return { blocks: [{ startLine: address.line, endLine: address.line }], truncated: false };
		}
		case "last": {
			if (total === 0) return { blocks: [], truncated: false };
			return { blocks: [{ startLine: total, endLine: total }], truncated: false };
		}
		case "range": {
			if (total === 0 || address.start > total) return { blocks: [], truncated: false };
			const end = address.end === "last" ? total : Math.min(address.end, total);
			return { blocks: [{ startLine: address.start, endLine: end }], truncated: false };
		}
		case "regex": {
			const regex = compile(address.pattern, address.flags);
			const blocks: AddressBlock[] = [];
			for (let i = 0; i < scanLimit; i++) {
				const line = lines[i];
				if (line === undefined) continue;
				if (!regex.test(line)) continue;
				blocks.push({ startLine: i + 1, endLine: i + 1 });
				if (blocks.length >= maxBlocks) return { blocks, truncated: true };
			}
			return { blocks, truncated: false };
		}
		case "regex-range": {
			const fromRegex = compile(address.from, address.flags);
			const toRegex = compile(address.to, address.flags);
			const blocks: AddressBlock[] = [];
			let open: number | null = null;
			for (let i = 0; i < scanLimit; i++) {
				const line = lines[i];
				if (line === undefined) continue;
				if (open === null) {
					if (fromRegex.test(line)) open = i + 1;
					continue;
				}
				if (toRegex.test(line)) {
					blocks.push({ startLine: open, endLine: i + 1 });
					open = null;
					if (blocks.length >= maxBlocks) return { blocks, truncated: true };
				}
			}
			// An unterminated range runs to EOF, matching sed.
			if (open !== null) blocks.push({ startLine: open, endLine: scanLimit });
			return { blocks, truncated: false };
		}
	}
}

/**
 * Build a regex from a model-supplied pattern.
 *
 * Compiled per address (not per line) and used with `.test`, so no `lastIndex`
 * state leaks between lines. Only case-insensitivity is honored from the flag
 * suffix — `g`/`y` would make `.test` stateful and silently skip matches.
 */
function compile(pattern: string, flags: string): RegExp {
	try {
		return new RegExp(pattern, flags);
	} catch (err) {
		throw new AddressError(
			`invalid regex /${pattern}/: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function sanitizeFlags(raw: string | undefined): string {
	if (!raw) return "";
	return raw.includes("i") ? "i" : "";
}
