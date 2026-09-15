/**
 * StructView — read a file by its structure instead of by line windows.
 *
 * The problem it solves: understanding a 2000-line module today costs several
 * `Read` pages plus a `Grep` plus the reasoning to reassemble what was found into a
 * mental model of the file. Every one of those steps pours text into the context.
 * StructView answers the structural questions directly — what's in this file, what
 * is this symbol's body, which function does line 412 belong to, what does this
 * module export — at a fraction of the tokens.
 *
 * All modes are read-only and share the structural kernel's provider chain, so an
 * uninstalled grammar degrades to a heuristic outline (clearly labelled) rather
 * than failing.
 */
import { extname } from "node:path";
import { z } from "zod/v4";
import { withDeviceParam } from "../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../execution/path-resolve";
import { getToolBackend } from "../execution/tool-backend";
import {
	AddressError,
	type ElementNode,
	type LocatedNode,
	languageIdForExtension,
	type OutlineNode,
	parseAddress,
	parsePosition,
	parseSymbolSelector,
	referenceCounts,
	resolveAddress,
	resolveProvider,
	type StructDocument,
	type StructKind,
} from "../structural";
import type { ToolDefinition, ToolResult } from "../types";
import { decodeFileBytes } from "./encoding";
import { looseNumber, normalizeNumber } from "./number-param";

/** Cap on bytes read for structural inspection. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Cap on the tool's own output, independent of the file size. */
const MAX_OUTPUT_CHARS = 60_000;

/** Default outline nesting depth: top level plus one (class → its methods). */
const DEFAULT_DEPTH = 2;

/** Bound on `print` output so a broad regex cannot dump the file. */
const MAX_PRINT_BLOCKS = 200;
const MAX_PRINT_LINES = 2000;

type Mode =
	| "outline"
	| "extract"
	| "print"
	| "enclosing"
	| "api"
	| "imports"
	| "tree"
	| "refs"
	| "calls"
	| "report";

const MODES: Mode[] = [
	"outline",
	"extract",
	"print",
	"enclosing",
	"api",
	"imports",
	"tree",
	"refs",
	"calls",
	"report",
];

/** Rows shown by the ranking modes before the tail is summarized. */
const MAX_RANKED_ROWS = 25;

/** Hard cap on report output; the point is to be cheaper than 6 separate calls. */
const MAX_REPORT_LINES = 800;

/** A symbol occupying more than this share of the file is worth calling out. */
const DOMINANT_SYMBOL_RATIO = 0.4;

const DESCRIPTION = `Read and analyze a source file by its structure rather than by line ranges.

Use this INSTEAD of paging through a large file with Read, and instead of \`grep -c\` for
counting things inside one file — the AST counts are exact where a regex silently
undercounts (e.g. \`grep -c 'useState('\` misses the generic form \`useState<T>(\`).

Modes:
- report: START HERE for an unfamiliar file. One call returns the summary, layered skeleton, top calls, single-reference (likely dead) symbols and the largest symbols. Replaces the 6-8 calls that analysis otherwise takes.
- outline (default): declaration skeleton — classes/functions/methods/types with line ranges, plus statement-level structural calls (useEffect, describe, app.route) with their dependency arrays. Add \`with_refs: true\` to annotate each entry with its in-file reference count.
- extract: the full body of one symbol. \`symbol: "Class.method"\` targets a member; a bare name matches at any depth; \`symbol: "name#2"\` picks among duplicates. Destructured names are searchable too.
- api: exported/public declarations, signatures only, bodies hidden.
- enclosing: given a line (from Grep output, a stack trace, a diff), which function/class it belongs to. Returns the symbol chain, e.g. "PaymentService.charge".
- imports: the file's imports plus its exported symbols.
- tree: nested element (JSX) skeleton — which components are rendered, how deep, and which are behind a condition or a .map. Attribute values are omitted. Answers what outline cannot for UI files, whose render block is often most of the file.
- refs: every declaration with how many times its name appears in this file, fewest first. \`refs: 1\` means "defined and never used here" — the fastest dead-code signal available.
- calls: call frequency inside the file, with \`filter\` for a prefix (\`filter: "use"\` for hooks). Also lists JSX component usage counts.
- print: sed-style line/regex output filtering. Needs no grammar, so it works on any text file (config, log, unsupported language).

Addresses for print: \`42\` (one line), \`10,20\` (range), \`10,$\` (to EOF), \`$\` (last line), \`/regex/\` (each matching line), \`/from/,/to/\` (block).

Notes:
- Accurate structure needs the language's tree-sitter grammar (installed under Settings → Structural Parsing). Without it, outline/extract fall back to text heuristics and say so; tree/refs/calls/report require a real grammar and report that plainly rather than guessing.
- Counts and structure are syntactic and single-file: two same-named symbols collapse together, and a symbol used only in OTHER files still shows refs: 1. Confirm cross-file usage with Grep before deleting anything.`;

const rawJsonSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		file_path: {
			description: "Absolute path to the file to inspect.",
			type: "string",
		},
		mode: {
			description:
				"What to return. Defaults to 'outline'. Use 'extract' with `symbol`, 'enclosing' with `position`, 'print' with `address'.",
			type: "string",
			enum: MODES,
		},
		symbol: {
			description:
				'For mode=extract: the symbol to return. "Class.method" targets a member; a bare name matches at any depth. Append "#N" to pick the Nth match among duplicates.',
			type: "string",
		},
		kind: {
			description:
				'Comma-separated declaration kinds to keep (e.g. "function,method" or "interface,type"). Applies to outline, extract and api.',
			type: "string",
		},
		depth: {
			description:
				"For mode=outline and mode=tree: maximum nesting depth. Outline defaults to 2 (top level plus one, so classes show their members); tree defaults to 6. Use 1 for a top-level-only skeleton.",
			type: "number",
		},
		with_refs: {
			description:
				"For mode=outline: annotate each entry with how many times its name appears in this file (definition included). Requires an installed grammar.",
			type: "boolean",
		},
		filter: {
			description:
				'For mode=calls: keep only callees containing this substring (e.g. "use" for React hooks).',
			type: "string",
		},
		limit: {
			description: "For mode=refs and mode=calls: maximum rows to return. Defaults to 25.",
			type: "number",
		},
		include_html: {
			description:
				"For mode=tree: include lowercase HTML host elements. Off by default, since components carry the structure.",
			type: "boolean",
		},
		address: {
			description:
				'For mode=print: line number, "start,end", "start,$", "$", "/regex/", or "/from/,/to/".',
			type: "string",
		},
		line_numbers: {
			description: "For mode=print: prefix output lines with their numbers. Defaults to true.",
			type: "boolean",
		},
		position: {
			description: 'For mode=enclosing: a line number, or "line:column".',
			type: "string",
		},
	},
	required: ["file_path"],
	additionalProperties: false,
};

export const structViewTool: ToolDefinition = {
	name: "StructView",
	executionRouting: {
		kind: "single",
		resolve(input) {
			const path = typeof input.file_path === "string" ? input.file_path : undefined;
			return {
				key: "primary",
				operation: "read",
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
		file_path: z.string().describe("Absolute path to the file to inspect."),
		mode: z.enum(MODES).optional().describe("What to return. Defaults to 'outline'."),
		symbol: z.string().optional().describe("For mode=extract: the symbol to return."),
		kind: z.string().optional().describe("Comma-separated declaration kinds to keep."),
		depth: looseNumber("For mode=outline/tree: maximum nesting depth."),
		address: z.string().optional().describe("For mode=print: line/range/regex address."),
		line_numbers: z.boolean().optional().describe("For mode=print: prefix line numbers."),
		position: z.string().optional().describe('For mode=enclosing: line number or "line:column".'),
		with_refs: z.boolean().optional().describe("For mode=outline: annotate reference counts."),
		filter: z.string().optional().describe("For mode=calls: substring filter on the callee."),
		limit: looseNumber("For mode=refs/calls: maximum rows. Defaults to 25."),
		include_html: z.boolean().optional().describe("For mode=tree: include HTML host elements."),
	}),
	metadata: { readOnly: true },

	async execute(args, ctx): Promise<ToolResult> {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		if (!filePath) {
			return { output: "file_path is required.", isError: true };
		}
		const mode: Mode = MODES.includes(args.mode as Mode) ? (args.mode as Mode) : "outline";

		const backend = getToolBackend(ctx, typeof args.device === "string" ? args.device : undefined);
		const resolvedPath =
			ctx.executionTarget?.lexicalPath ??
			resolveBackendPath(backend, toolBaseCwd(backend, ctx.cwd), filePath);
		const canonicalPath = ctx.executionTarget?.canonicalPath;
		const ioPath = canonicalPath ?? resolvedPath;

		let text: string;
		let truncatedRead = false;
		try {
			const stat = await backend.statFile(ioPath);
			if (stat?.isDirectory) {
				return {
					output: `${filePath} is a directory. StructView inspects a single file; use Glob or Read to list a directory.`,
					isError: true,
				};
			}
			const read = await backend.readFileBytes(ioPath, {
				maxBytes: MAX_FILE_BYTES,
				...(canonicalPath ? { expectedResolvedPath: canonicalPath } : {}),
				signal: ctx.signal,
			});
			truncatedRead = read.truncated;
			({ text } = decodeFileBytes(read.bytes));
		} catch (err) {
			return {
				output: `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}

		if (text.length === 0) {
			return { output: `${filePath} is empty.`, title: filePath };
		}

		// `print` is intentionally decided before any language detection: line and
		// regex addresses need no grammar, so it must work on a log or a config file
		// exactly as it does on TypeScript.
		if (mode === "print") {
			return runPrint(filePath, text, args, truncatedRead);
		}

		const languageId = languageIdForExtension(extname(resolvedPath));
		const doc: StructDocument = {
			filePath: resolvedPath,
			text,
			languageId,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		};

		const resolved = await resolveProvider(doc);
		if (!resolved) {
			return {
				output: `No structure provider could handle ${filePath}. Use Read or StructView mode=print instead.`,
				isError: true,
			};
		}

		const notes: string[] = [];
		if (resolved.limitation) notes.push(resolved.limitation);
		else if (resolved.support === "degraded") {
			notes.push(
				resolved.provider.explainLimitation
					? String((await resolved.provider.explainLimitation(doc)) ?? "")
					: "Result is approximate.",
			);
		}
		if (truncatedRead) {
			notes.push(
				`File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB and was truncated before parsing; ` +
					`structure past the cut-off is missing.`,
			);
		}

		const kinds = parseKinds(typeof args.kind === "string" ? args.kind : undefined);

		switch (mode) {
			case "outline":
				return runOutline(filePath, doc, resolved, kinds, args, notes);
			case "api":
				return runApi(filePath, doc, resolved, kinds, notes);
			case "extract":
				return runExtract(filePath, doc, resolved, kinds, args, notes);
			case "enclosing":
				return runEnclosing(filePath, doc, resolved, args, notes);
			case "imports":
				return runImports(filePath, doc, resolved, notes);
			case "tree":
				return runElementTree(filePath, doc, resolved, args, notes);
			case "refs":
				return runRefs(filePath, doc, resolved, args, notes);
			case "calls":
				return runCalls(filePath, doc, resolved, args, notes);
			case "report":
				return runReport(filePath, doc, resolved, notes);
			default:
				return { output: `Unsupported mode: ${mode}`, isError: true };
		}
	},
};

type Resolved = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;

// ── modes ────────────────────────────────────────────────────────────

async function runOutline(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	kinds: StructKind[] | null,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	const depth = normalizeNumber(args.depth, { min: 1 }) ?? DEFAULT_DEPTH;
	const nodes = await resolved.provider.outline(doc);

	let annotated = nodes;
	if (args.with_refs === true) {
		const counts = await referenceCounts(doc);
		if (counts) annotated = annotateRefs(nodes, counts);
		else {
			notes.push(
				"Reference counts need an installed grammar for this language, so they were omitted.",
			);
		}
	}

	const limited = limitDepth(annotated, depth);
	const filtered = kinds ? filterKinds(limited, kinds) : limited;

	if (filtered.length === 0) {
		return {
			output: renderEmpty(filePath, doc, resolved, notes, "No declarations found."),
			title: filePath,
			metadata: { mode: "outline", provider: resolved.provider.id, declarations: 0 },
		};
	}

	const lines: string[] = [];
	renderOutline(filtered, lines);
	const body = clampOutput(lines.join("\n"));
	const head = headerWithDominant(filePath, doc, resolved, nodes);

	return {
		output: withFooter(head, body, notes),
		title: filePath,
		metadata: {
			mode: "outline",
			provider: resolved.provider.id,
			support: resolved.support,
			languageId: doc.languageId,
			declarations: countNodes(filtered),
		},
	};
}

async function runApi(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	kinds: StructKind[] | null,
	notes: string[],
): Promise<ToolResult> {
	const nodes = await resolved.provider.outline(doc);
	// `api` is an exports-only projection of the outline, not a separate parse: a
	// provider only has to report `exported` correctly to support it.
	const exported = keepExported(nodes);
	const filtered = kinds ? filterKinds(exported, kinds) : exported;

	if (filtered.length === 0) {
		return {
			output: renderEmpty(
				filePath,
				doc,
				resolved,
				notes,
				"No exported declarations found. The module may export nothing, or exports may be indirect (re-exports, dynamic assignment).",
			),
			title: filePath,
			metadata: { mode: "api", provider: resolved.provider.id, exports: 0 },
		};
	}

	const lines: string[] = [];
	renderOutline(filtered, lines);
	return {
		output: withFooter(`Public API of ${filePath}`, clampOutput(lines.join("\n")), notes),
		title: filePath,
		metadata: {
			mode: "api",
			provider: resolved.provider.id,
			support: resolved.support,
			exports: countNodes(filtered),
		},
	};
}

async function runExtract(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	kinds: StructKind[] | null,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	const rawSymbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
	if (!rawSymbol) {
		return {
			output: "mode=extract requires `symbol`. Run mode=outline first to see available symbols.",
			isError: true,
		};
	}

	const parsed = parseSymbolSelector(rawSymbol);
	const matches = await resolved.provider.locate(doc, {
		symbol: parsed.symbol,
		...(parsed.nth != null ? { nth: parsed.nth } : {}),
		...(kinds ? { kinds } : {}),
	});

	if (matches.length === 0) {
		const available = await suggestSymbols(doc, resolved);
		return {
			output:
				`No symbol matching "${rawSymbol}" in ${filePath}.` +
				(available ? `\n\nDeclarations present:\n${available}` : ""),
			isError: true,
			title: filePath,
		};
	}

	// Several matches is a real ambiguity, so the candidates are listed rather than
	// one being picked: extracting the wrong overload looks like a successful read.
	if (matches.length > 1) {
		const list = matches
			.map((m, i) => `  #${i + 1}  L${m.startLine}-${m.endLine}  ${m.kind} ${m.symbolPath}`)
			.join("\n");
		return {
			output:
				`"${rawSymbol}" matches ${matches.length} declarations in ${filePath}:\n${list}\n\n` +
				`Re-run with symbol="${parsed.symbol}#N" (or a fuller path like "Class.method") to pick one.`,
			title: filePath,
			metadata: { mode: "extract", ambiguous: true, matches: matches.length },
		};
	}

	const node = matches[0];
	if (!node) {
		return { output: `No symbol matching "${rawSymbol}" in ${filePath}.`, isError: true };
	}
	const snippet = doc.text.slice(node.startIndex, node.endIndex);
	const numbered = numberLines(snippet.split("\n"), node.startLine);

	return {
		output: withFooter(
			`${filePath}  ${node.kind} ${node.symbolPath}  (L${node.startLine}-${node.endLine})`,
			clampOutput(numbered),
			notes,
		),
		title: `${filePath} → ${node.symbolPath}`,
		metadata: {
			mode: "extract",
			provider: resolved.provider.id,
			support: resolved.support,
			symbolPath: node.symbolPath,
			kind: node.kind,
			startLine: node.startLine,
			endLine: node.endLine,
			exported: node.exported,
		},
	};
}

async function runEnclosing(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	const raw = typeof args.position === "string" ? args.position : "";
	const position = raw ? parsePosition(raw) : null;
	if (!position) {
		return {
			output: 'mode=enclosing requires `position` as a line number or "line:column".',
			isError: true,
		};
	}

	const chain = await resolved.provider.enclosing(doc, position);
	if (chain.length === 0) {
		return {
			output: withFooter(
				`${filePath}:${position.line}`,
				"Line is at file scope — not inside any named declaration.",
				notes,
			),
			title: filePath,
			metadata: { mode: "enclosing", provider: resolved.provider.id, depth: 0 },
		};
	}

	const innermost = chain[0];
	if (!innermost) {
		return { output: `No enclosing declaration at ${filePath}:${position.line}.`, isError: true };
	}
	const lines = chain.map(
		(node, i) =>
			`${i === 0 ? "→" : " "} ${node.kind} ${node.symbolPath}  (L${node.startLine}-${node.endLine})`,
	);

	return {
		output: withFooter(
			`${filePath}:${position.line} is inside ${innermost.symbolPath}`,
			lines.join("\n"),
			notes,
		),
		title: `${filePath}:${position.line}`,
		metadata: {
			mode: "enclosing",
			provider: resolved.provider.id,
			support: resolved.support,
			symbolPath: innermost.symbolPath,
			kind: innermost.kind,
			startLine: innermost.startLine,
			endLine: innermost.endLine,
			chain: chain.map((n) => n.symbolPath),
		},
	};
}

async function runImports(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	notes: string[],
): Promise<ToolResult> {
	if (!resolved.provider.imports) {
		return {
			output: `Provider "${resolved.provider.id}" does not support mode=imports for this file.`,
			isError: true,
		};
	}
	const info = await resolved.provider.imports(doc);
	const sections: string[] = [];

	if (info.imports.length > 0) {
		sections.push(
			`Imports (${info.imports.length}):\n` +
				info.imports.map((imp) => `  L${imp.line}  ${imp.module}`).join("\n"),
		);
	}
	if (info.exports.length > 0) {
		sections.push(
			`Exports (${info.exports.length}):\n` +
				info.exports.map((exp) => `  L${exp.line}  ${exp.kind} ${exp.name}`).join("\n"),
		);
	}
	if (sections.length === 0) sections.push("No imports or exports detected.");

	return {
		output: withFooter(header(filePath, doc, resolved), clampOutput(sections.join("\n\n")), notes),
		title: filePath,
		metadata: {
			mode: "imports",
			provider: resolved.provider.id,
			imports: info.imports.length,
			exports: info.exports.length,
		},
	};
}

function runPrint(
	filePath: string,
	text: string,
	args: Record<string, unknown>,
	truncatedRead: boolean,
): ToolResult {
	const raw = typeof args.address === "string" ? args.address : "";
	if (!raw) {
		return {
			output:
				'mode=print requires `address`, e.g. "42", "10,20", "10,$", "$", "/TODO/", or "/BEGIN/,/END/".',
			isError: true,
		};
	}

	const lines = text.split("\n");
	let resolvedBlocks: ReturnType<typeof resolveAddress>;
	try {
		resolvedBlocks = resolveAddress(parseAddress(raw), lines, { maxBlocks: MAX_PRINT_BLOCKS });
	} catch (err) {
		if (err instanceof AddressError) {
			return { output: `Invalid address: ${err.message}`, isError: true };
		}
		throw err;
	}

	if (resolvedBlocks.blocks.length === 0) {
		// A bare "matched nothing" cannot be told apart from a mistyped regex, which makes
		// the call a dead end. Naming the scan size and the likely cause makes the retry
		// informed instead of a guess.
		const isRegex = raw.trim().startsWith("/");
		const hint = isRegex
			? " The address is a regex — check escaping (backslashes, ^ and $ anchors), or run mode=outline to see the file's real structure."
			: " Line numbers are 1-based and this file may be shorter than the address.";
		return {
			output: `Address "${raw}" matched nothing · scanned ${lines.length} lines of ${filePath}.${hint}`,
			title: filePath,
			metadata: { mode: "print", blocks: 0, totalLines: lines.length },
		};
	}

	const showNumbers = args.line_numbers !== false;
	const chunks: string[] = [];
	let emittedLines = 0;
	let cappedByLines = false;

	for (const block of resolvedBlocks.blocks) {
		if (emittedLines >= MAX_PRINT_LINES) {
			cappedByLines = true;
			break;
		}
		const available = MAX_PRINT_LINES - emittedLines;
		const slice = lines.slice(block.startLine - 1, block.endLine).slice(0, available);
		emittedLines += slice.length;
		if (slice.length < block.endLine - block.startLine + 1) cappedByLines = true;
		chunks.push(showNumbers ? numberLines(slice, block.startLine) : slice.join("\n"));
	}

	const notes: string[] = [];
	if (resolvedBlocks.truncated) {
		notes.push(`Stopped after ${MAX_PRINT_BLOCKS} matching blocks; narrow the address.`);
	}
	if (cappedByLines) {
		notes.push(`Output capped at ${MAX_PRINT_LINES} lines.`);
	}
	if (truncatedRead) {
		notes.push(`File was truncated at ${MAX_FILE_BYTES / 1024 / 1024} MB before matching.`);
	}

	// A blank line between blocks; sed prints them contiguously, but a model reading
	// several disjoint regions needs to see where one ends and the next begins.
	const blockCount = resolvedBlocks.blocks.length;
	return {
		output: withFooter(
			// The scan denominator is what distinguishes "only one match exists" from
			// "my pattern was wrong and happened to hit once".
			`${filePath}  address ${raw} · ${blockCount} ${blockCount === 1 ? "match" : "matches"} in ${lines.length} lines scanned`,
			clampOutput(chunks.join("\n\n")),
			notes,
		),
		title: filePath,
		metadata: {
			mode: "print",
			blocks: resolvedBlocks.blocks.length,
			printedLines: emittedLines,
			totalLines: lines.length,
		},
	};
}

async function runElementTree(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	if (!resolved.provider.elementTree) {
		return {
			output: unsupportedModeMessage("tree", doc, resolved),
			isError: true,
			title: filePath,
		};
	}
	const roots = await resolved.provider.elementTree(doc);
	if (!roots || roots.length === 0) {
		return {
			output: withFooter(
				header(filePath, doc, resolved),
				"No nested elements found. This mode reads JSX; for other structure use mode=outline.",
				notes,
			),
			title: filePath,
			metadata: { mode: "tree", elements: 0 },
		};
	}

	const lines: string[] = [];
	renderElementTree(roots, lines, 0, normalizeNumber(args.depth, { min: 1 }));
	return {
		output: withFooter(header(filePath, doc, resolved), clampOutput(lines.join("\n")), notes),
		title: filePath,
		metadata: { mode: "tree", provider: resolved.provider.id, elements: countElements(roots) },
	};
}

async function runRefs(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	const counts = await referenceCounts(doc);
	if (!counts) {
		return {
			output: unsupportedModeMessage("refs", doc, resolved),
			isError: true,
			title: filePath,
		};
	}
	const limit = normalizeNumber(args.limit, { min: 1 }) ?? MAX_RANKED_ROWS;
	const nodes = flattenPublic(await resolved.provider.outline(doc));

	// Declarations only: a `call` entry's name is a callee, so an identifier tally for it
	// would silently answer a different question than the row implies.
	const rows = nodes
		.filter((node) => node.kind !== "call")
		.map((node) => ({ node, refs: refsForNode(node, counts) }))
		.filter((row): row is { node: OutlineNode; refs: number } => row.refs != null)
		.sort((a, b) => a.refs - b.refs || a.node.startLine - b.node.startLine);

	if (rows.length === 0) {
		return {
			output: withFooter(header(filePath, doc, resolved), "No declarations to count.", notes),
			title: filePath,
			metadata: { mode: "refs", declarations: 0 },
		};
	}

	const unused = rows.filter((row) => row.refs <= 1);
	const shown = rows.slice(0, limit);
	const body = shown
		.map(
			(row) =>
				`${String(row.refs).padStart(4)}  L${String(row.node.startLine).padEnd(6)} ${row.node.kind} ${row.node.name}`,
		)
		.join("\n");

	const summary =
		`${unused.length} of ${rows.length} declarations appear only once (defined, never used in this file).` +
		(unused.length > 0
			? " A symbol used only from OTHER files also looks like this — confirm with Grep before deleting."
			: "");

	return {
		output: withFooter(
			`${header(filePath, doc, resolved)}\nrefs  line     declaration`,
			`${body}${rows.length > shown.length ? `\n…  ${rows.length - shown.length} more (raise \`limit\`)` : ""}\n\n${summary}`,
			notes,
		),
		title: filePath,
		metadata: {
			mode: "refs",
			provider: resolved.provider.id,
			declarations: rows.length,
			singleReference: unused.length,
		},
	};
}

async function runCalls(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	if (!resolved.provider.statistics) {
		return {
			output: unsupportedModeMessage("calls", doc, resolved),
			isError: true,
			title: filePath,
		};
	}
	const stats = await resolved.provider.statistics(doc);
	if (!stats) {
		return {
			output: unsupportedModeMessage("calls", doc, resolved),
			isError: true,
			title: filePath,
		};
	}

	const limit = normalizeNumber(args.limit, { min: 1 }) ?? MAX_RANKED_ROWS;
	const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : undefined;
	const calls = (
		filter ? stats.calls.filter((c) => c.name.toLowerCase().includes(filter)) : stats.calls
	).slice(0, limit);

	const sections: string[] = [];
	if (calls.length > 0) {
		sections.push(
			`Calls${filter ? ` matching "${filter}"` : ""}:\n${calls
				.map((c) => `${String(c.count).padStart(5)}  ${c.name}`)
				.join("\n")}`,
		);
	} else {
		sections.push(filter ? `No calls matching "${filter}".` : "No calls found.");
	}

	if (!filter && stats.elements.length > 0) {
		sections.push(
			`Elements rendered:\n${stats.elements
				.slice(0, limit)
				.map((e) => `${String(e.count).padStart(5)}  ${e.name}`)
				.join("\n")}`,
		);
	}

	if (stats.truncated) {
		notes.push("File is large enough that the walk hit its node cap; counts are lower bounds.");
	}

	return {
		output: withFooter(header(filePath, doc, resolved), clampOutput(sections.join("\n\n")), notes),
		title: filePath,
		metadata: {
			mode: "calls",
			provider: resolved.provider.id,
			distinctCalls: stats.calls.length,
		},
	};
}

/**
 * One-call file analysis.
 *
 * Exists because "analyze this file" is a frequent intent that previously took 6-8
 * calls to assemble. Every section reuses the SAME cached parse, so this is cheaper
 * than the individual modes it replaces rather than the sum of them.
 */
async function runReport(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	notes: string[],
): Promise<ToolResult> {
	const nodes = await resolved.provider.outline(doc);
	const flat = flattenPublic(nodes);
	const stats = (await resolved.provider.statistics?.(doc)) ?? null;
	const counts = stats ? new Map(stats.identifiers.map((e) => [e.name, e.count])) : null;
	const sections: string[] = [];

	// 1. Layered skeleton, top level only — the layering IS the point, so members are
	// deliberately collapsed here; `outline` gives detail on request.
	if (nodes.length > 0) {
		const lines: string[] = [];
		renderOutline(
			counts ? annotateRefs(limitDepth(nodes, 1), counts) : limitDepth(nodes, 1),
			lines,
		);
		sections.push(`STRUCTURE (top level, ${flat.length} declarations total)\n${lines.join("\n")}`);
	}

	// 2. Largest symbols: which parts of the file actually hold the volume.
	const largest = [...flat]
		.map((node) => ({ node, lines: node.endLine - node.startLine + 1 }))
		.sort((a, b) => b.lines - a.lines)
		.slice(0, 10);
	if (largest.length > 0) {
		sections.push(
			`LARGEST SYMBOLS\n${largest
				.map(
					(entry) =>
						`${String(entry.lines).padStart(6)} lines  L${entry.node.startLine}-${entry.node.endLine}  ${entry.node.kind} ${entry.node.name}`,
				)
				.join("\n")}`,
		);
	}

	// 3. Call frequency.
	if (stats && stats.calls.length > 0) {
		sections.push(
			`TOP CALLS\n${stats.calls
				.slice(0, 20)
				.map((c) => `${String(c.count).padStart(5)}  ${c.name}`)
				.join("\n")}`,
		);
	}

	// 4. Dead-code candidates.
	if (counts) {
		const single = flat
			.filter((node) => node.kind !== "call")
			.map((node) => ({ node, refs: refsForNode(node, counts) }))
			.filter((row) => row.refs === 1);
		const orphanBindings = unusedBindings(flat, counts);

		const parts: string[] = [];
		if (single.length > 0) {
			parts.push(
				`SINGLE-REFERENCE SYMBOLS (${single.length}) — defined but never used in this file.\n` +
					`Cross-file usage is invisible here; confirm with Grep before deleting.\n${single
						.slice(0, 30)
						.map((row) => `  L${row.node.startLine}  ${row.node.kind} ${row.node.name}`)
						.join("\n")}` +
					(single.length > 30 ? `\n  … ${single.length - 30} more` : ""),
			);
		} else {
			parts.push("SINGLE-REFERENCE SYMBOLS: none — every declaration is used at least twice here.");
		}
		if (orphanBindings.length > 0) {
			parts.push(
				`UNUSED BINDINGS (${orphanBindings.length}) — bound by a live destructure but never read.\n` +
					`Typically the unused half of \`const [value, setValue] = …\`.\n${orphanBindings
						.slice(0, 20)
						.map((entry) => `  L${entry.line}  ${entry.name}`)
						.join("\n")}` +
					(orphanBindings.length > 20 ? `\n  … ${orphanBindings.length - 20} more` : ""),
			);
		}
		sections.push(parts.join("\n\n"));
	}

	// 5. Render tree, when the file has one.
	const elements = (await resolved.provider.elementTree?.(doc)) ?? null;
	if (elements && elements.length > 0) {
		const lines: string[] = [];
		renderElementTree(elements, lines, 0, 3);
		sections.push(`RENDER TREE (depth 3; use mode=tree for more)\n${lines.join("\n")}`);
	}

	if (!stats) {
		notes.push(
			"Call counts and reference counts need an installed grammar for this language and were omitted.",
		);
	}

	const body = sections.join("\n\n");
	const lines = body.split("\n");
	const clamped =
		lines.length > MAX_REPORT_LINES
			? `${lines.slice(0, MAX_REPORT_LINES).join("\n")}\n… [report capped at ${MAX_REPORT_LINES} lines — use a specific mode for detail]`
			: body;

	return {
		output: withFooter(headerWithDominant(filePath, doc, resolved, nodes), clamped, notes),
		title: filePath,
		metadata: {
			mode: "report",
			provider: resolved.provider.id,
			declarations: flat.length,
			hasStatistics: stats != null,
			hasRenderTree: (elements?.length ?? 0) > 0,
		},
	};
}

// ── rendering helpers ────────────────────────────────────────────────

/**
 * Header line, including the quantitative facts a reader needs up front.
 *
 * The totals are here rather than in a separate mode because every one of them was
 * previously obtained with a separate `wc -l` / `grep -c` call.
 */
function header(filePath: string, doc: StructDocument, resolved: Resolved): string {
	const lang = doc.languageId ?? "unknown";
	const via =
		resolved.support === "full"
			? resolved.provider.label
			: `${resolved.provider.label}, approximate`;
	const lineCount = doc.text.split("\n").length;
	const kb = Math.round(Buffer.byteLength(doc.text, "utf8") / 1024);
	return `${filePath}  [${lang}, via ${via}]  ${lineCount} lines · ${kb} KB`;
}

/**
 * A "this file is really one giant thing" warning, when true.
 *
 * Only shown past the ratio threshold: on a normal file the largest symbol occupying
 * 15% of it is unremarkable, and printing that every time would train the reader to
 * skip the line that matters when it says 92%.
 */
function dominantSymbolLine(nodes: readonly OutlineNode[], totalLines: number): string | null {
	if (totalLines <= 0) return null;
	let best: { node: OutlineNode; span: number } | null = null;
	for (const node of nodes) {
		const span = node.endLine - node.startLine + 1;
		if (!best || span > best.span) best = { node, span };
	}
	if (!best) return null;
	const ratio = best.span / totalLines;
	if (ratio < DOMINANT_SYMBOL_RATIO) return null;
	return `largest: ${best.node.kind} ${best.node.name} L${best.node.startLine}-${best.node.endLine} (${Math.round(ratio * 100)}% of file)`;
}

/** Header plus the dominant-symbol callout, when there is one. */
function headerWithDominant(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	nodes: readonly OutlineNode[],
): string {
	const base = header(filePath, doc, resolved);
	const dominant = dominantSymbolLine(nodes, doc.text.split("\n").length);
	return dominant ? `${base}\n${dominant}` : base;
}

function unsupportedModeMessage(mode: string, doc: StructDocument, resolved: Resolved): string {
	const lang = doc.languageId ?? "this file type";
	return (
		`mode=${mode} needs parsed structure, which is unavailable for ${lang} ` +
		`(currently using ${resolved.provider.label}). ` +
		`Install the grammar under Settings → Structural Parsing, or use mode=outline / mode=print, which work without one.`
	);
}

function renderElementTree(
	nodes: readonly ElementNode[],
	out: string[],
	indent: number,
	maxDepth?: number,
): void {
	if (maxDepth != null && indent >= maxDepth) return;
	for (const node of nodes) {
		const pad = "  ".repeat(indent);
		const attrs = node.attributes?.length ? ` ${node.attributes.join(" ")}` : "";
		const cond = node.condition ? `{${node.condition}} ` : "";
		const range = node.line === node.endLine ? `L${node.line}` : `L${node.line}-${node.endLine}`;
		out.push(`${range.padEnd(12)} ${pad}${cond}<${node.name}${attrs}>`);
		if (node.children?.length) renderElementTree(node.children, out, indent + 1, maxDepth);
	}
}

function countElements(nodes: readonly ElementNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1;
		if (node.children) total += countElements(node.children);
	}
	return total;
}

/** Flatten an outline into document order, for the analysis modes. */
function flattenPublic(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	const walk = (list: readonly OutlineNode[]): void => {
		for (const node of list) {
			out.push(node);
			if (node.children) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

/**
 * Reference count for one outline entry.
 *
 * A destructuring declaration takes the MAXIMUM over its bindings, not the sum: the
 * question at the declaration level is "is any of this used", and summing 27 bound
 * names would manufacture usage that does not exist.
 *
 * The cost of that choice is that a partially-dead destructure looks alive, which for
 * `const [value, setValue] = useState()` is the common case rather than an edge one —
 * an unused `value` beside a used `setValue` is invisible here. `unusedBindings` covers
 * it separately instead of distorting this number.
 */
function refsForNode(node: OutlineNode, counts: ReadonlyMap<string, number>): number | undefined {
	if (node.bindings && node.bindings.length > 0) {
		let max = 0;
		for (const binding of node.bindings) max = Math.max(max, counts.get(binding) ?? 0);
		return max > 0 ? max : undefined;
	}
	return counts.get(node.name);
}

/**
 * Individually unused names inside otherwise-live destructures.
 *
 * `const [_phase, setPhase] = useState()` where only the setter is used is a real and
 * frequent shape; the declaration is alive, one of its bindings is not. Rest elements
 * are excluded because `...rest` being unreferenced says nothing useful.
 */
function unusedBindings(
	nodes: readonly OutlineNode[],
	counts: ReadonlyMap<string, number>,
): Array<{ name: string; line: number }> {
	const found: Array<{ name: string; line: number }> = [];
	for (const node of nodes) {
		if (!node.bindings || node.bindings.length < 2) continue;
		for (const binding of node.bindings) {
			if (binding.startsWith("...")) continue;
			if ((counts.get(binding) ?? 0) <= 1) found.push({ name: binding, line: node.startLine });
		}
	}
	return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function annotateRefs(
	nodes: readonly OutlineNode[],
	counts: ReadonlyMap<string, number>,
): OutlineNode[] {
	return nodes.map((node) => {
		const refs = node.kind === "call" ? undefined : refsForNode(node, counts);
		return {
			...node,
			...(refs != null ? { refs } : {}),
			...(node.children ? { children: annotateRefs(node.children, counts) } : {}),
		};
	});
}

function withFooter(head: string, body: string, notes: string[]): string {
	const parts = [head, "", body];
	const real = notes.filter((n) => n.trim().length > 0);
	if (real.length > 0) {
		parts.push("", ...real.map((note) => `note: ${note}`));
	}
	return parts.join("\n");
}

function renderEmpty(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	notes: string[],
	message: string,
): string {
	return withFooter(header(filePath, doc, resolved), message, notes);
}

function renderOutline(nodes: readonly OutlineNode[], out: string[], indent = 0): void {
	for (const node of nodes) {
		const pad = "  ".repeat(indent);
		const range =
			node.startLine === node.endLine ? `L${node.startLine}` : `L${node.startLine}-${node.endLine}`;
		const attrs: string[] = [];
		if (node.exported) attrs.push("exported");
		if (node.modifiers?.length) attrs.push(...node.modifiers);
		if (node.initializer) attrs.push(`= ${node.initializer}`);
		// refs:1 is the dead-code signal, so it is worth its own emphasis rather than
		// being just another number in the attribute list.
		if (node.refs != null) attrs.push(node.refs === 1 ? "refs:1 ⚠" : `refs:${node.refs}`);
		const suffix = attrs.length > 0 ? `  · ${attrs.join(" ")}` : "";
		out.push(
			`${pad}${range.padEnd(12)} ${node.kind} ${node.name}${node.signature ? ` ${node.signature}` : ""}${suffix}`,
		);
		if (node.children?.length) renderOutline(node.children, out, indent + 1);
	}
}

function numberLines(lines: readonly string[], startLine: number): string {
	return lines
		.map((line, i) => `${String(startLine + i).padStart(6)}│${truncateLine(line)}`)
		.join("\n");
}

const MAX_LINE_CHARS = 2000;

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} chars total]`;
}

function clampOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output capped at ${MAX_OUTPUT_CHARS} chars — narrow the request]`;
}

// ── outline transforms ───────────────────────────────────────────────

function limitDepth(nodes: readonly OutlineNode[], maxDepth: number): OutlineNode[] {
	if (maxDepth <= 1) return nodes.map((node) => stripChildren(node));
	return nodes.map((node) =>
		node.children?.length
			? { ...node, children: limitDepth(node.children, maxDepth - 1) }
			: { ...node },
	);
}

function stripChildren(node: OutlineNode): OutlineNode {
	const { children: _children, ...rest } = node;
	return rest;
}

/**
 * Keep exported declarations, retaining a non-exported parent that contains one.
 *
 * A class does not have to be exported for its public methods to matter (a default
 * export, a class returned from a factory), and dropping the parent would leave
 * methods floating with no indication of what they belong to.
 */
function keepExported(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	for (const node of nodes) {
		const children = node.children ? keepExported(node.children) : [];
		if (node.exported) {
			out.push(children.length > 0 ? { ...node, children } : stripChildren(node));
		} else if (children.length > 0) {
			out.push({ ...node, children });
		}
	}
	return out;
}

/** Keep nodes of the requested kinds, plus ancestors needed to reach them. */
function filterKinds(nodes: readonly OutlineNode[], kinds: StructKind[]): OutlineNode[] {
	const wanted = new Set(kinds);
	const out: OutlineNode[] = [];
	for (const node of nodes) {
		const children = node.children ? filterKinds(node.children, kinds) : [];
		if (wanted.has(node.kind)) {
			out.push(children.length > 0 ? { ...node, children } : stripChildren(node));
		} else if (children.length > 0) {
			out.push({ ...node, children });
		}
	}
	return out;
}

function countNodes(nodes: readonly OutlineNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1;
		if (node.children) total += countNodes(node.children);
	}
	return total;
}

const KNOWN_KINDS = new Set<string>([
	"function",
	"method",
	"class",
	"interface",
	"struct",
	"enum",
	"trait",
	"impl",
	"type",
	"constant",
	"variable",
	"property",
	"field",
	"module",
	"namespace",
	"constructor",
	"getter",
	"setter",
	"test",
	"unknown",
]);

function parseKinds(raw: string | undefined): StructKind[] | null {
	if (!raw) return null;
	const kinds = raw
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter((part) => KNOWN_KINDS.has(part)) as StructKind[];
	return kinds.length > 0 ? kinds : null;
}

/** Compact symbol list for a failed `extract`, so the retry is informed. */
async function suggestSymbols(doc: StructDocument, resolved: Resolved): Promise<string | null> {
	const nodes = await resolved.provider.outline(doc);
	const flat: LocatedNode[] = [];
	const walk = (list: readonly OutlineNode[], prefix: string): void => {
		for (const node of list) {
			const path = prefix ? `${prefix}.${node.name}` : node.name;
			flat.push({
				kind: node.kind,
				name: node.name,
				symbolPath: path,
				startIndex: 0,
				endIndex: 0,
				startLine: node.startLine,
				endLine: node.endLine,
				exported: node.exported,
			});
			if (node.children) walk(node.children, path);
		}
	};
	walk(nodes, "");
	if (flat.length === 0) return null;
	const shown = flat.slice(0, 60);
	const lines = shown.map((n) => `  L${n.startLine}  ${n.kind} ${n.symbolPath}`);
	if (flat.length > shown.length) lines.push(`  … ${flat.length - shown.length} more`);
	return lines.join("\n");
}
