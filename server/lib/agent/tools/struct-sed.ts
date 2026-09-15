/**
 * struct-sed.ts — Structural mutations, addressed the same way StructView reads.
 *
 * The pairing is the point: whatever `StructView` can show you, `StructSed` can change
 * using the same address. `symbol: "PaymentService.charge"` resolves through the same
 * `locate` call, so "rewrite the function I just looked at" needs no line arithmetic and
 * no unique `old_string` to quote back.
 *
 * ── A core tool, paired with StructView ─────────────────────────────────────────────
 * Registered in the core set alongside `StructView`, because a read tool whose addresses
 * cannot be written to is only half a capability: "see it, then change it with the same
 * address" is the whole point of the pair.
 *
 * The extra reach that comes with that — one call can rewrite a whole function or delete a
 * whole class — is handled by `dry_run` defaulting to TRUE rather than by hiding the tool.
 * `Edit` requires quoting the exact text being replaced, which is itself evidence that the
 * model knows what it is touching; a structural address carries no such evidence, so the
 * first call on any target shows what WOULD change instead of doing it.
 *
 * ── Replayability ───────────────────────────────────────────────────────────────────
 * The recorded input carries the RESOLVED line range, not just the selector. Rebuild
 * replays by line range and never re-runs `locate`: by then the file has changed, a
 * same-named symbol may live elsewhere, and tree-sitter may not even be installed on the
 * machine doing the rebuild. See `applyToolCall` in file-state-rebuild.ts.
 */

import { extname } from "node:path";
import { z } from "zod";
import { LocalFileValidationError } from "../../../services/file-change-local-io";
import { executeLocalFileChange } from "../../../services/file-change-runtime";
import { withDeviceParam } from "../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../execution/path-resolve";
import { getToolBackend } from "../execution/tool-backend";
import {
	AddressError,
	languageIdForExtension,
	parseAddress,
	parseSymbolSelector,
	resolveAddress,
	resolveProvider,
	type StructDocument,
	type StructKind,
} from "../structural";
import {
	appendAfter,
	applyBatch,
	type BatchOperation,
	deleteRange,
	EditOpError,
	insertBefore,
	type LineRange,
	type MovePlacement,
	relocateRange,
	replaceRange,
	substituteInRange,
} from "../structural/edit-ops";
import type { ToolDefinition, ToolResult } from "../types";
import {
	applyLineEnding,
	decodeFileBytes,
	detectLineEnding,
	encodeFileBytes,
	normalizeLineEndings,
} from "./encoding";
import { replacementLineStats } from "./file-diff-stats";

const COMMANDS = ["replace", "substitute", "delete", "insert", "append", "copy", "move"] as const;
type Command = (typeof COMMANDS)[number];

/** Commands that relocate a block rather than rewriting one in place. */
const RELOCATION_COMMANDS = new Set<Command>(["copy", "move"]);

/** Same ceiling StructView uses, so an addressable file is always an editable one. */
const MAX_FILE_BYTES = 2_000_000;

/** Preview budget: enough to see the change, not enough to flood the context. */
const MAX_PREVIEW_LINES = 80;

/**
 * Cap on operations per batch.
 *
 * Bounds both the resolution work (each operation may run `locate`) and the preview size.
 * A larger refactor should be split into several calls, so a dry run stays readable.
 */
const MAX_BATCH_OPERATIONS = 50;

const DESCRIPTION = `Change a file by STRUCTURE rather than by quoting its text.

Addresses the same way StructView reads, so a symbol you just inspected can be rewritten
without re-quoting it: \`symbol: "PaymentService.charge"\` selects that method's full body.

Commands:
- replace: swap the selected node/range's body for \`content\`
- delete: remove the selected node/range (whole lines)
- insert: put \`content\` immediately before the selection
- append: put \`content\` immediately after the selection
- substitute: regex-replace inside the selection only (\`pattern\` + \`replacement\`, flags g/i)
- copy: duplicate the selection to another position in the SAME file
- move: relocate the selection to another position in the SAME file

Addressing (give exactly ONE):
- \`symbol\` — a declaration name, \`Class.method\` for a member, \`name#2\` to disambiguate.
  Needs a parsed language; run StructView first to see what is available.
- \`address\` — sed-style and grammar-free: \`42\`, \`10,20\`, \`10,$\`, \`$\`, \`/regex/\`,
  \`/from/,/to/\`. Works on any text file.

For copy/move, the destination is \`to_symbol\` or \`to_address\` (same syntax), with
\`placement: "before" | "after"\` (default "after"). Omit both to append at end of file.
A destination overlapping the source is refused. A moved block keeps its doc comment and
decorators, and is re-indented to its destination.

\`content\` is re-indented to the selection's own indent, so a block written at column 0
lands correctly inside a nested class. Internal relative indentation is preserved.

\`dry_run\` defaults to TRUE: the first call reports the resolved range and a preview
without touching the file. Pass \`dry_run: false\` to apply.`;

const rawJsonSchema = {
	type: "object",
	properties: {
		file_path: {
			description: "Absolute path to the file to change.",
			type: "string",
		},
		command: {
			description: "Which mutation to apply.",
			type: "string",
			enum: [...COMMANDS],
		},
		symbol: {
			description:
				'Structural address: declaration name. "Class.method" targets a member; "name#2" picks among duplicates. Mutually exclusive with `address`.',
			type: "string",
		},
		kind: {
			description: "Restrict the structural address to these kinds (comma-separated).",
			type: "string",
		},
		address: {
			description:
				'Line/regex address: "42", "10,20", "10,$", "$", "/regex/", "/from/,/to/". Needs no parser. Mutually exclusive with `symbol`.',
			type: "string",
		},
		content: {
			description: "New text for replace/insert/append. Re-indented to the selection.",
			type: "string",
		},
		to_symbol: {
			description:
				"For copy/move: destination declaration name (same syntax as `symbol`). Mutually exclusive with `to_address`.",
			type: "string",
		},
		to_address: {
			description:
				"For copy/move: destination line/regex address (same syntax as `address`). Mutually exclusive with `to_symbol`.",
			type: "string",
		},
		placement: {
			description:
				'For copy/move: put the block before or after the destination. Defaults to "after".',
			type: "string",
			enum: ["before", "after"],
		},
		pattern: {
			description: "For substitute: the regex to match inside the selection.",
			type: "string",
		},
		replacement: {
			description: "For substitute: the replacement text ($1 for capture groups).",
			type: "string",
		},
		flags: {
			description: 'For substitute: regex flags. Only "g" and "i" are supported.',
			type: "string",
		},
		dry_run: {
			description:
				"Preview instead of writing. Defaults to TRUE; pass false to actually apply the change.",
			type: "boolean",
		},
		operations: {
			description:
				"Apply SEVERAL operations to this file as one unit. Each entry takes the same fields as a single call (command, symbol/address, content, pattern, replacement, flags, to_symbol/to_address, placement). Every address is relative to the file as it is NOW, not to the result of earlier entries; overlapping ranges are rejected. Either all operations apply or none do. When present, the top-level command/address fields are ignored.",
			type: "array",
			items: { type: "object" },
		},
	},
	required: ["file_path"],
	additionalProperties: false,
};

function parseKinds(raw: unknown): StructKind[] | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const kinds = raw
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean) as StructKind[];
	return kinds.length > 0 ? kinds : null;
}

/** Context lines kept around a change when building the card's diff. */
const DIFF_CONTEXT_LINES = 3;

/**
 * Largest changed span (in lines) for which a diff card is built.
 *
 * Beyond this the diff is more overwhelming than the text preview — a move from the top of
 * a file to the bottom spans the whole file — so the card falls back to the preview instead.
 */
const MAX_DIFF_SPAN_LINES = 400;

/**
 * The window that actually changed between two texts, for the card's before/after diff.
 *
 * Computed by comparing the texts directly rather than from the command's range, so it is
 * correct for every command uniformly — including move/copy (two edited regions) and a
 * batch (many) — without reasoning about where each one writes. Returns null when nothing
 * changed or when the change is too large to show as a diff.
 */
function diffWindow(
	before: string,
	after: string,
): { oldText: string; newText: string; startLine: number } | null {
	const b = before.split("\n");
	const a = after.split("\n");

	let first = 0;
	while (first < b.length && first < a.length && b[first] === a[first]) first++;

	let bEnd = b.length - 1;
	let aEnd = a.length - 1;
	while (bEnd >= first && aEnd >= first && b[bEnd] === a[aEnd]) {
		bEnd--;
		aEnd--;
	}

	// No divergence: identical texts are handled by the caller before this runs.
	if (bEnd < first && aEnd < first) return null;

	const span = Math.max(bEnd, aEnd) - first;
	if (span > MAX_DIFF_SPAN_LINES) return null;

	const winStart = Math.max(0, first - DIFF_CONTEXT_LINES);
	const bWinEnd = Math.min(b.length - 1, bEnd + DIFF_CONTEXT_LINES);
	const aWinEnd = Math.min(a.length - 1, aEnd + DIFF_CONTEXT_LINES);
	return {
		oldText: b.slice(winStart, bWinEnd + 1).join("\n"),
		newText: a.slice(winStart, aWinEnd + 1).join("\n"),
		startLine: winStart + 1,
	};
}

/** A bounded excerpt of the changed region, so a preview cannot flood the context. */
function previewRegion(text: string, range: LineRange): string {
	const lines = normalizeLineEndings(text).split("\n");
	const start = Math.max(1, range.startLine);
	const end = Math.min(lines.length, range.endLine);
	const shown = lines.slice(start - 1, Math.min(end, start - 1 + MAX_PREVIEW_LINES));
	const numbered = shown.map(
		(line: string, i: number) => `${String(start + i).padStart(6)}│${line}`,
	);
	const omitted = end - start + 1 - shown.length;
	if (omitted > 0) numbered.push(`       … ${omitted} more line${omitted === 1 ? "" : "s"}`);
	return numbered.join("\n");
}

/**
 * Resolve one address (structural or sed-style) to a line range.
 *
 * Shared by the source and the copy/move destination so the two cannot diverge: a
 * destination written the same way as a source must select the same lines.
 *
 * Returns `{ error }` rather than throwing, because every failure here is a message for the
 * model (ambiguous symbol, no match, no parser) rather than an exception.
 */
async function resolveToRange(input: {
	symbol: string;
	address: string;
	role: "source" | "destination";
	filePath: string;
	resolvedPath: string;
	text: string;
	kind?: unknown;
	signal?: AbortSignal;
}): Promise<{ range: LineRange; label: string } | { error: ToolResult }> {
	const { symbol, address, role, filePath, resolvedPath, text } = input;
	const field = role === "source" ? "symbol" : "to_symbol";
	const addressField = role === "source" ? "address" : "to_address";

	if (symbol) {
		const languageId = languageIdForExtension(extname(resolvedPath));
		const doc: StructDocument = {
			filePath: resolvedPath,
			text,
			languageId,
			...(input.signal ? { signal: input.signal } : {}),
		};
		const resolved = await resolveProvider(doc);
		if (!resolved) {
			return {
				error: {
					output: `No structure provider could handle ${filePath}. Use \`${addressField}\` for a line or regex range instead.`,
					isError: true,
				},
			};
		}
		const parsed = parseSymbolSelector(symbol);
		const kinds = parseKinds(input.kind);
		const matches = await resolved.provider.locate(doc, {
			symbol: parsed.symbol,
			...(parsed.nth != null ? { nth: parsed.nth } : {}),
			...(kinds ? { kinds } : {}),
		});
		if (matches.length === 0) {
			// The advice depends on WHY there was no match. With a real parse, the symbol
			// simply is not there and the outline shows what is. Without one (an unknown
			// language answered by the heuristic provider), pointing at the outline sends
			// the model to a guess — an address is the tool that actually works there.
			const advice =
				resolved.support === "full"
					? "Run StructView mode=outline to see what is there."
					: `${languageId ? `No parser is installed for ${languageId}` : "This file has no known language"}, so structural addressing is unreliable here. Use \`${addressField}\` with a line or regex range instead.`;
			return {
				error: {
					output: `No ${role} symbol matching "${symbol}" in ${filePath}. ${advice}`,
					isError: true,
					title: filePath,
				},
			};
		}
		// Ambiguity is reported, never resolved by picking: editing the wrong overload
		// looks exactly like a successful edit.
		if (matches.length > 1) {
			const list = matches
				.map((m, i) => `  #${i + 1}  L${m.startLine}-${m.endLine}  ${m.kind} ${m.symbolPath}`)
				.join("\n");
			return {
				error: {
					output: `\`${field}\` "${symbol}" matches ${matches.length} declarations in ${filePath}. Disambiguate with "${symbol}#N" or \`kind\`:\n${list}`,
					isError: true,
					title: filePath,
				},
			};
		}
		const hit = matches[0];
		if (!hit) {
			return { error: { output: `Could not resolve "${symbol}".`, isError: true } };
		}
		return {
			range: { startLine: hit.startLine, endLine: hit.endLine },
			label: `${hit.kind} ${hit.symbolPath} (L${hit.startLine}-${hit.endLine})`,
		};
	}

	const lines = text.split("\n");
	try {
		const parsed = parseAddress(address);
		const result = resolveAddress(parsed, lines, { maxBlocks: 1 });
		const block = result.blocks[0];
		if (!block) {
			return {
				error: {
					output: `${role === "source" ? "Address" : "Destination address"} "${address}" matched nothing in ${filePath}.`,
					isError: true,
					title: filePath,
				},
			};
		}
		return {
			range: { startLine: block.startLine, endLine: block.endLine },
			label: `L${block.startLine}-${block.endLine}`,
		};
	} catch (err) {
		return {
			error: {
				output:
					err instanceof AddressError
						? `Invalid ${addressField}: ${err.message}`
						: `Error resolving ${addressField}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			},
		};
	}
}

/** One operation after field-level validation, before its address is resolved. */
interface ValidatedSpec {
	index: number;
	command: Command;
	isRelocation: boolean;
	symbol: string;
	address: string;
	toSymbol: string;
	toAddress: string;
	placement: MovePlacement;
	kind?: unknown;
	content?: string;
	pattern?: string;
	replacement?: string;
	flags?: string;
}

/**
 * Validate one operation's fields.
 *
 * Shared by the single-call and batch shapes so a batch entry cannot accept something a
 * single call rejects. `batched` only affects the wording, so an error inside a batch says
 * which entry it came from.
 */
function validateSpec(
	spec: Record<string, unknown>,
	index: number,
	batched: boolean,
): { spec: ValidatedSpec } | { error: ToolResult } {
	const at = batched ? ` (operation ${index})` : "";
	const fail = (output: string): { error: ToolResult } => ({
		error: { output: `${output}${at}`, isError: true },
	});

	const command = spec.command as Command;
	if (!COMMANDS.includes(command)) {
		return fail(
			`Unknown command "${String(spec.command)}". Expected one of: ${COMMANDS.join(", ")}.`,
		);
	}

	const symbol = typeof spec.symbol === "string" ? spec.symbol.trim() : "";
	const address = typeof spec.address === "string" ? spec.address.trim() : "";
	// Both given is an ambiguous request, not a choice to make on the model's behalf:
	// picking one silently could delete a different range than the one it named.
	if (symbol && address) {
		return fail(
			"Give either `symbol` or `address`, not both - they select different things and there is no safe way to guess which one you meant.",
		);
	}
	if (!symbol && !address) {
		return fail(
			"An address is required: pass `symbol` for a declaration, or `address` for a line/regex range.",
		);
	}

	const isRelocation = RELOCATION_COMMANDS.has(command);
	const toSymbol = typeof spec.to_symbol === "string" ? spec.to_symbol.trim() : "";
	const toAddress = typeof spec.to_address === "string" ? spec.to_address.trim() : "";
	if (toSymbol && toAddress) {
		return fail("Give either `to_symbol` or `to_address`, not both.");
	}
	// A destination on a command that does not relocate is a misunderstanding worth naming:
	// silently ignoring it would leave the model believing the block moved.
	if (!isRelocation && (toSymbol || toAddress)) {
		return fail(
			`command=${command} does not take a destination. Use copy or move to relocate a block.`,
		);
	}
	if (!isRelocation && spec.placement !== undefined) {
		return fail(
			`command=${command} does not take \`placement\`; it only applies to copy and move.`,
		);
	}

	return {
		spec: {
			index,
			command,
			isRelocation,
			symbol,
			address,
			toSymbol,
			toAddress,
			placement: spec.placement === "before" ? "before" : "after",
			...(spec.kind !== undefined ? { kind: spec.kind } : {}),
			...(typeof spec.content === "string" ? { content: spec.content } : {}),
			...(typeof spec.pattern === "string" ? { pattern: spec.pattern } : {}),
			...(typeof spec.replacement === "string" ? { replacement: spec.replacement } : {}),
			...(typeof spec.flags === "string" ? { flags: spec.flags } : {}),
		},
	};
}

/** Apply the command to LF-normalized text. Throws `EditOpError` on an invalid request. */
function applyCommand(
	command: Command,
	text: string,
	range: LineRange,
	args: {
		content?: string;
		pattern?: string;
		replacement?: string;
		flags?: string;
		/** Resolved destination for copy/move; absent means end of file. */
		anchor?: LineRange;
		placement?: MovePlacement;
	},
): { text: string; replacements?: number } {
	switch (command) {
		case "delete":
			return { text: deleteRange(text, range) };
		case "copy":
		case "move":
			return {
				text: relocateRange(text, range, {
					...(args.anchor ? { anchor: args.anchor } : {}),
					placement: args.placement ?? "after",
					removeSource: command === "move",
				}),
			};
		case "replace": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=replace requires `content`.");
			}
			return { text: replaceRange(text, range, normalizeLineEndings(args.content)) };
		}
		case "insert": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=insert requires `content`.");
			}
			return { text: insertBefore(text, range, normalizeLineEndings(args.content)) };
		}
		case "append": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=append requires `content`.");
			}
			return { text: appendAfter(text, range, normalizeLineEndings(args.content)) };
		}
		case "substitute": {
			if (typeof args.pattern !== "string" || !args.pattern) {
				throw new EditOpError("command=substitute requires `pattern`.");
			}
			if (typeof args.replacement !== "string") {
				throw new EditOpError("command=substitute requires `replacement`.");
			}
			const result = substituteInRange(text, range, args.pattern, args.replacement, {
				...(args.flags ? { flags: args.flags } : {}),
			});
			return { text: result.text, replacements: result.replacements };
		}
	}
}

export const structSedTool: ToolDefinition = {
	name: "StructSed",
	executionRouting: {
		kind: "single",
		resolve(input) {
			const path = typeof input.file_path === "string" ? input.file_path : undefined;
			return {
				key: "primary",
				// A dry run still only reads, but routing is resolved before the flag is
				// known to be trustworthy; declaring `write` keeps the stricter path.
				operation: "write",
				...(typeof input.device === "string" ? { deviceId: input.device } : {}),
				...(path ? { path } : {}),
			};
		},
	},
	description: DESCRIPTION,
	rawJsonSchema,
	getRawJsonSchema(config) {
		return withDeviceParam(rawJsonSchema, config);
	},
	parameters: z.object({
		file_path: z.string().describe("Absolute path to the file to change."),
		command: z
			.enum(COMMANDS)
			.optional()
			.describe("Which mutation to apply. Required unless `operations` is given."),
		symbol: z.string().optional().describe("Structural address: declaration name."),
		kind: z.string().optional().describe("Restrict the structural address to these kinds."),
		address: z.string().optional().describe("Line/regex address; needs no parser."),
		content: z.string().optional().describe("New text for replace/insert/append."),
		to_symbol: z.string().optional().describe("For copy/move: destination declaration name."),
		to_address: z.string().optional().describe("For copy/move: destination line/regex address."),
		placement: z
			.enum(["before", "after"])
			.optional()
			.describe('For copy/move: side of the destination. Defaults to "after".'),
		pattern: z.string().optional().describe("For substitute: the regex to match."),
		replacement: z.string().optional().describe("For substitute: the replacement text."),
		flags: z.string().optional().describe('For substitute: flags, "g" and "i" only.'),
		dry_run: z.boolean().optional().describe("Preview instead of writing. Defaults to true."),
		operations: z
			.array(z.record(z.string(), z.unknown()))
			.optional()
			.describe("Several operations applied to this file as one unit, or none at all."),
	}),

	async execute(args, ctx): Promise<ToolResult> {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		if (!filePath) return { output: "file_path is required.", isError: true };

		// A single call is treated as a batch of ONE, so the two shapes cannot drift apart:
		// identical validation, resolution, application and replay code runs either way.
		const rawBatch = Array.isArray(args.operations) ? args.operations : null;
		if (rawBatch && rawBatch.length === 0) {
			return { output: "`operations` was empty; give at least one operation.", isError: true };
		}
		if (rawBatch && rawBatch.length > MAX_BATCH_OPERATIONS) {
			return {
				output: `A batch is limited to ${MAX_BATCH_OPERATIONS} operations; this call has ${rawBatch.length}. Split it into several calls.`,
				isError: true,
			};
		}
		// Top-level command fields alongside `operations` are ambiguous: the model may believe
		// either one applies. Naming it beats silently ignoring half the request.
		if (
			rawBatch &&
			(args.command !== undefined || args.symbol !== undefined || args.address !== undefined)
		) {
			return {
				output:
					"Give either `operations` or the top-level command/symbol/address fields, not both - put every operation inside `operations`.",
				isError: true,
			};
		}

		const isBatch = rawBatch !== null;
		const specs: Array<Record<string, unknown>> = rawBatch
			? rawBatch.map((entry) => (entry ?? {}) as Record<string, unknown>)
			: [args as Record<string, unknown>];

		const validated: ValidatedSpec[] = [];
		for (const [i, spec] of specs.entries()) {
			const result = validateSpec(spec, i + 1, isBatch);
			if ("error" in result) return result.error;
			validated.push(result.spec);
		}

		const backend = getToolBackend(ctx, (args as { device?: string }).device);
		// The write pipeline is local-only. Failing loudly beats silently editing the
		// wrong machine's copy of the file.
		if (backend.kind !== "local") {
			return {
				output:
					"StructSed can only edit files on the local backend. Use Read/Edit against the remote device, or run this on the local workspace.",
				isError: true,
			};
		}

		const baseCwd = toolBaseCwd(backend, ctx.cwd);
		const resolvedPath =
			ctx.executionTarget?.lexicalPath ?? resolveBackendPath(backend, baseCwd, filePath);
		const canonicalPath = ctx.executionTarget?.canonicalPath;
		const ioPath = canonicalPath ?? resolvedPath;

		let originalText: string;
		try {
			const stat = await backend.statFile(ioPath);
			if (stat?.isDirectory) {
				return { output: `${filePath} is a directory.`, isError: true };
			}
			const read = await backend.readFileBytes(ioPath, {
				maxBytes: MAX_FILE_BYTES,
				...(canonicalPath ? { expectedResolvedPath: canonicalPath } : {}),
				signal: ctx.signal,
			});
			if (read.truncated) {
				return {
					output: `${filePath} is larger than ${MAX_FILE_BYTES} bytes; StructSed will not edit a partially read file.`,
					isError: true,
				};
			}
			({ text: originalText } = decodeFileBytes(read.bytes));
		} catch (err) {
			return {
				output: `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}

		const normalized = normalizeLineEndings(originalText);

		// `kind` is per-operation: a batch may filter each address differently.
		const resolveOne = (
			symbol: string,
			address: string,
			role: "source" | "destination",
			kind: unknown,
		) =>
			resolveToRange({
				symbol,
				address,
				role,
				filePath,
				resolvedPath,
				text: normalized,
				kind,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});

		// Resolve every operation's addresses against the ORIGINAL text. That is what makes
		// batch addresses predictable: no address shifts because of another operation.
		interface ResolvedOp {
			spec: ValidatedSpec;
			range: LineRange;
			anchor?: LineRange;
			label: string;
		}
		const resolvedOps: ResolvedOp[] = [];
		for (const spec of validated) {
			const source = await resolveOne(spec.symbol, spec.address, "source", spec.kind);
			if ("error" in source) return source.error;
			let anchor: LineRange | undefined;
			let anchorLabel = "end of file";
			if (spec.isRelocation && (spec.toSymbol || spec.toAddress)) {
				const destination = await resolveOne(
					spec.toSymbol,
					spec.toAddress,
					"destination",
					spec.kind,
				);
				if ("error" in destination) return destination.error;
				anchor = destination.range;
				anchorLabel = destination.label;
			}
			// A relocation names both ends. Reporting only the source would leave the reader
			// unable to tell where the block actually went.
			const label = spec.isRelocation
				? `${source.label} → ${spec.placement} ${anchorLabel}`
				: source.label;
			resolvedOps.push({ spec, range: source.range, ...(anchor ? { anchor } : {}), label });
		}

		const first = resolvedOps[0];
		if (!first) return { output: "No operation to apply.", isError: true };
		const addressLabel = isBatch
			? `${resolvedOps.length} operations`
			: `${first.spec.command} on ${first.label}`;

		// Substitute reports how many replacements it made. Summed across the batch, since a
		// batch reports one figure for the whole call.
		let replacements: number | undefined;
		const runOne = (op: ResolvedOp, text: string, range: LineRange): string => {
			const applied = applyCommand(op.spec.command, text, range, {
				...(op.spec.content !== undefined ? { content: op.spec.content } : {}),
				...(op.spec.pattern !== undefined ? { pattern: op.spec.pattern } : {}),
				...(op.spec.replacement !== undefined ? { replacement: op.spec.replacement } : {}),
				...(op.spec.flags !== undefined ? { flags: op.spec.flags } : {}),
				...(op.anchor ? { anchor: op.anchor } : {}),
				...(op.spec.isRelocation ? { placement: op.spec.placement } : {}),
			});
			if (applied.replacements != null) {
				replacements = (replacements ?? 0) + applied.replacements;
			}
			return applied.text;
		};

		// Built from one function so the preview and the write cannot disagree about what the
		// call does — an earlier version assembled the arguments separately and the copy/move
		// anchor was missing from both, so the block would have appended at EOF while the card
		// reported the requested destination.
		const buildOperations = (): BatchOperation[] =>
			resolvedOps.map((op) => ({
				index: op.spec.index,
				label: op.spec.command,
				range: op.range,
				apply: (text: string, range: LineRange) => runOne(op, text, range),
			}));

		let nextText: string;
		try {
			nextText = applyBatch(normalized, buildOperations());
		} catch (err) {
			return {
				output:
					err instanceof EditOpError
						? err.message
						: `Error applying ${addressLabel}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
				title: filePath,
			};
		}

		if (nextText === normalized) {
			return {
				output: `No changes: ${addressLabel} produced identical content.`,
				title: filePath,
			};
		}

		const range = first.range;
		const command = first.spec.command;
		const oldRegion = normalized
			.split("\n")
			.slice(range.startLine - 1, range.endLine)
			.join("\n");
		const stats = replacementLineStats(oldRegion, first.spec.content ?? "");

		/** One operation's replayable record: selector for readability, range for replay. */
		const recordOne = (op: (typeof resolvedOps)[number]): Record<string, unknown> => ({
			command: op.spec.command,
			...(op.spec.symbol ? { symbol: op.spec.symbol } : {}),
			...(op.spec.address ? { address: op.spec.address } : {}),
			...(op.spec.content !== undefined ? { content: op.spec.content } : {}),
			...(op.spec.pattern !== undefined ? { pattern: op.spec.pattern } : {}),
			...(op.spec.replacement !== undefined ? { replacement: op.spec.replacement } : {}),
			...(op.spec.flags !== undefined ? { flags: op.spec.flags } : {}),
			resolvedStartLine: op.range.startLine,
			resolvedEndLine: op.range.endLine,
			// The destination is recorded resolved for the same reason as the source: replay
			// must not re-run `locate` against content that has since changed.
			...(op.anchor
				? { resolvedToStartLine: op.anchor.startLine, resolvedToEndLine: op.anchor.endLine }
				: {}),
			...(op.spec.isRelocation ? { placement: op.spec.placement } : {}),
		});

		// A single call keeps the flat shape it has always had, so existing recorded history
		// stays replayable by the same branch; a batch adds `operations`.
		const recordedInput: Record<string, unknown> = isBatch
			? { operations: resolvedOps.map(recordOne) }
			: (recordOne(first) as Record<string, unknown>);

		// Default-on preview. The model sees the resolved range and the result before
		// anything is written, which is the check a structural address does not carry.
		const dryRun = args.dry_run !== false;
		if (dryRun) {
			const afterRange: LineRange =
				command === "delete"
					? { startLine: Math.max(1, range.startLine - 1), endLine: range.startLine }
					: { startLine: range.startLine, endLine: range.endLine + 4 };
			// A batch lists every operation, because the whole point of previewing one is
			// seeing all of what it will do before any of it happens.
			const plan = isBatch
				? `${resolvedOps.map((op) => `  ${op.spec.index}. ${op.spec.command} → ${op.label}`).join("\n")}\n`
				: `${addressLabel}\n`;
			// The card renders this as a real before/after diff. Computed from the two texts
			// (not the command's range) so it is correct for move/copy and batches too, and
			// omitted for a change too large to diff — the card then keeps its text preview.
			const window = diffWindow(normalized, nextText);
			return {
				output:
					`DRY RUN — nothing written. Pass dry_run: false to apply.\n\n` +
					plan +
					(replacements != null ? `${replacements} replacement(s)\n` : "") +
					`\nBefore:\n${previewRegion(normalized, range)}\n` +
					`\nAfter:\n${previewRegion(nextText, afterRange)}`,
				title: filePath,
				metadata: {
					dryRun: true,
					command,
					startLine: range.startLine,
					endLine: range.endLine,
					...(isBatch ? { operations: resolvedOps.length } : {}),
					...(replacements != null ? { replacements } : {}),
					...(window
						? {
								diffBefore: window.oldText,
								diffAfter: window.newText,
								diffStartLine: window.startLine,
							}
						: {}),
				},
			};
		}

		try {
			const recorded = await executeLocalFileChange({
				ctx,
				backend,
				toolName: "StructSed",
				filePath,
				// Every operation is recorded with its RESOLVED range so rebuild can replay by
				// line number without re-running `locate` against changed content. A batch
				// records ALL of them: recording only the first would replay a multi-operation
				// call as a single edit, silently dropping the rest.
				input: recordedInput,
				construct(before) {
					if (before.bytes === null) {
						throw new LocalFileValidationError(`File not found: ${filePath}`);
					}
					const decoded = decodeFileBytes(before.bytes);
					const current = normalizeLineEndings(decoded.text);
					// Re-apply against the bytes observed under the write lock rather than
					// trusting the earlier read: the file may have changed in between, and
					// writing the stale result would clobber that change.
					// The SAME batch the preview ran, so the two cannot disagree, and so a batch
					// is applied as one unit here too: `applyBatch` returns a single string, so
					// a failure part-way through throws and nothing is written.
					let appliedText: string;
					try {
						appliedText = applyBatch(current, buildOperations());
					} catch (error) {
						throw new LocalFileValidationError(
							error instanceof Error ? error.message : String(error),
						);
					}
					const ending = detectLineEnding(decoded.text);
					return {
						nextBytes: encodeFileBytes(applyLineEnding(appliedText, ending), decoded.encoding),
						lineStats: stats,
						result: {
							output:
								`${command} applied to ${filePath} → ${addressLabel}` +
								(replacements != null ? ` (${replacements} replacement(s))` : ""),
							title: filePath,
							metadata: {
								command,
								startLine: range.startLine,
								endLine: range.endLine,
								...(replacements != null ? { replacements } : {}),
							},
						},
					};
				},
			});
			// `undefined` means the pipeline declined: no tool-call binding, so the change
			// would carry no snapshot, attribution or tree boundary. Edit has a legacy
			// fallback that writes anyway; StructSed deliberately refuses instead. A
			// structural rewrite with no recorded evidence is not revertable, and this tool
			// exists to make large edits, which is exactly when revert matters.
			if (!recorded) {
				return {
					output:
						"StructSed requires a recorded tool call to write (for snapshot and revert evidence) and this call has none. Use Edit if you need to write without it.",
					isError: true,
					title: filePath,
				};
			}
			return recorded;
		} catch (err) {
			return {
				output: `Error editing ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
				title: filePath,
			};
		}
	},
};
