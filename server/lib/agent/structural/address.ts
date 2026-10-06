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
 *   `/re/,$`      from a line matching the regex to end of file
 *   `/re/,120`    from a line matching the regex to line 120
 *   `10,/re/`     from line 10 to the next line matching the regex
 *
 * The last three are MIXED ranges: each endpoint is independently a line number,
 * `$`, or a regex. They exist because the common shape of a structural edit is
 * "from this landmark to the end of the file" — `/rendering helpers/,$` — and
 * requiring both endpoints to be the same kind forced callers back to counting
 * line numbers by hand, which goes stale on the first edit above the region.
 */

/** One end of a range: a fixed line, end-of-file, or the first matching line. */
export type AddressEndpoint =
	| { kind: "line"; line: number }
	| { kind: "last" }
	| { kind: "regex"; pattern: string; flags: string };

export type Address =
	| { kind: "line"; line: number }
	| { kind: "range"; start: number; end: number | "last" }
	| { kind: "last" }
	| { kind: "regex"; pattern: string; flags: string }
	| { kind: "regex-range"; from: string; to: string; flags: string }
	| { kind: "mixed-range"; from: AddressEndpoint; to: AddressEndpoint };

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

	// Mixed range: exactly one endpoint is a regex, the other a line or `$`. Tried
	// last so every pure form above keeps its own dedicated branch and behavior.
	const mixed = parseMixedRange(input);
	if (mixed) return mixed;

	throw new AddressError(
		`unrecognized address "${raw}". Use a line number, "start,end", "$", "/regex/", ` +
			`"/from/,/to/", or a mixed range like "/from/,$", "/from/,120" or "10,/to/".`,
	);
}

/**
 * Split `a,b` where at least one side is a regex.
 *
 * Hand-scanned rather than regex-matched: finding the separating comma means
 * knowing whether a comma sits inside a `/…/` literal, and a pattern like
 * `/a{1,2}/,$` has one that does. A slash-aware scan gets that right; a single
 * regex over the whole address would either miss the case or split at the wrong
 * comma and report a confusing "invalid regex".
 */
function parseMixedRange(input: string): Address | null {
	const comma = findTopLevelComma(input);
	if (comma === null) return null;

	const left = input.slice(0, comma).trim();
	const right = input.slice(comma + 1).trim();
	if (left.length === 0 || right.length === 0) return null;

	const from = parseEndpoint(left);
	const to = parseEndpoint(right);
	if (!from || !to) return null;
	// Both-numeric and both-regex are handled by the dedicated branches above; if
	// neither side is a regex this is not a mixed range and must not be claimed here.
	if (from.kind !== "regex" && to.kind !== "regex") return null;

	if (from.kind === "last") {
		throw new AddressError('"$" cannot start a range — it already means the last line');
	}
	return { kind: "mixed-range", from, to };
}

/** Index of the comma separating the two endpoints, ignoring commas inside `/…/`. */
function findTopLevelComma(input: string): number | null {
	let inRegex = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\") {
			i++; // Skip the escaped character, including an escaped slash.
			continue;
		}
		if (ch === "/") {
			inRegex = !inRegex;
			continue;
		}
		if (ch === "," && !inRegex) return i;
	}
	return null;
}

function parseEndpoint(raw: string): AddressEndpoint | null {
	if (raw === "$") return { kind: "last" };

	const regex = /^\/((?:[^/\\]|\\.)*)\/([a-z]*)$/.exec(raw);
	if (regex?.[1] !== undefined) {
		return { kind: "regex", pattern: regex[1], flags: sanitizeFlags(regex[2]) };
	}

	const line = /^(\d+)$/.exec(raw);
	if (line?.[1]) {
		const value = Number(line[1]);
		if (value < 1) throw new AddressError("line numbers are 1-based");
		return { kind: "line", line: value };
	}
	return null;
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
		case "mixed-range": {
			if (total === 0) return { blocks: [], truncated: false };
			const start = resolveEndpoint(address.from, lines, scanLimit, total, 1);
			if (start === null) return { blocks: [], truncated: false };
			// The end is searched from the line AFTER the start: a regex end that also
			// matches the start line would otherwise collapse the range to one line.
			const end = resolveEndpoint(address.to, lines, scanLimit, total, start + 1);
			// No end match runs to EOF, matching sed's unterminated range.
			return {
				blocks: [{ startLine: start, endLine: end === null ? total : end }],
				truncated: false,
			};
		}
	}
}

/**
 * First line satisfying an endpoint at or after `searchFrom`, or null.
 *
 * A line-number endpoint before `searchFrom` yields null rather than clamping:
 * `80,/x/` where the only `x` sits at line 12 describes a range that runs
 * backwards, and quietly turning that into a forward range would edit a region
 * the caller never named.
 */
function resolveEndpoint(
	endpoint: AddressEndpoint,
	lines: readonly string[],
	scanLimit: number,
	total: number,
	searchFrom: number,
): number | null {
	switch (endpoint.kind) {
		case "line":
			if (endpoint.line > total || endpoint.line < searchFrom) return null;
			return endpoint.line;
		case "last":
			return total < searchFrom ? null : total;
		case "regex": {
			const regex = compile(endpoint.pattern, endpoint.flags);
			for (let i = searchFrom - 1; i < scanLimit; i++) {
				const line = lines[i];
				if (line === undefined) continue;
				if (regex.test(line)) return i + 1;
			}
			return null;
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
