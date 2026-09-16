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
import { withDeviceParam } from "../../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../../execution/path-resolve";
import { getToolBackend } from "../../execution/tool-backend";
import { languageIdForExtension, resolveProvider, type StructDocument } from "../../structural";
import type { ToolDefinition, ToolResult } from "../../types";
import { decodeFileBytes } from "../encoding";
import { looseNumber } from "../number-param";
import { MAX_FILE_BYTES, MODES, type Mode, REPO_MODES } from "./constants";
import { runCalls, runRefs, runReport } from "./modes/analysis";
import { runFind } from "./modes/find";
import { runApi, runEnclosing, runExtract, runImports, runOutline } from "./modes/outline-api";
import { runStash } from "./modes/stash";
import { runElementTree, runInterface, runUsages } from "./modes/structure";
import { runLandmarks, runPrint } from "./modes/text";
import { parseKinds } from "./nodes";

const DESCRIPTION = `Read and analyze a source file by its structure rather than by line ranges.

Use this INSTEAD of paging through a large file with Read, and instead of \`grep -c\` for
counting things inside one file — the AST counts are exact where a regex silently
undercounts (e.g. \`grep -c 'useState('\` misses the generic form \`useState<T>(\`).

Reach for this first when you are about to:
- **grep for where something is defined** → \`mode=find\` (needs no file_path; returns real declarations, not call sites or comments)
- **read a long file to understand it** → \`mode=report\`, then \`mode=extract\` for the one symbol
- **grep to see who uses a symbol** → \`mode=usages\` (parses each hit; follows one barrel re-export)
- **copy code out of one file to put it in another** → \`mode=stash\`, then StructSed \`from_stash\`

Grep is still better for free-text search across files (log messages, config values, strings); this tool answers questions about CODE STRUCTURE.

Modes:
- report: START HERE for an unfamiliar file. One call returns the summary, layered skeleton, top calls, single-reference (likely dead) symbols and the largest symbols. Replaces the 6-8 calls that analysis otherwise takes.
- outline (default): declaration skeleton — classes/functions/methods/types with line ranges, plus statement-level structural calls (useEffect, describe, app.route) with their dependency arrays. Add \`with_refs: true\` to annotate each entry with its in-file reference count.
- extract: the full body of one symbol. \`symbol: "Class.method"\` targets a member; a bare name matches at any depth; \`symbol: "name#2"\` picks among duplicates. Destructured names are searchable too. Pass \`line_numbers: false\` for bare source with no \`123│\` prefixes — that output can go straight into StructSed's \`content\`, so moving a symbol needs no manual de-numbering.
- api: exported/public declarations, signatures only, bodies hidden.
- enclosing: given a line (from Grep output, a stack trace, a diff), which function/class it belongs to. Returns the symbol chain, e.g. "PaymentService.charge".
- imports: the file's imports plus its exported symbols.
- tree: nested element (JSX) skeleton — which components are rendered, how deep, and which are behind a condition or a .map. Attribute values are omitted. Answers what outline cannot for UI files, whose render block is often most of the file.
- refs: every declaration with how many times its name appears in this file AND the lines it appears on, fewest first. \`refs: 1\` means "defined and never used here" — the fastest dead-code signal available. The positions answer the follow-up a bare count cannot: whether all uses sit inside a range you mean to extract.
- calls: call frequency inside the file, with \`filter\` for a prefix (\`filter: "use"\` for hooks). Also lists JSX component usage counts.
- landmarks: the boundaries the AUTHOR drew — section banners (\`// --- Scroll state ---\`), \`#region\` blocks, and TODO/FIXME/HACK markers. outline reports what a file declares; this reports where its writer thought the seams were, which is the better starting point for splitting a long file. Needs no parser.
- interface: given a line range (\`address\`) or a \`symbol\`, what extracting it would require — which outside symbols it uses (become parameters), which of its own symbols are used outside (must be exported), and which are self-contained (move with it). Answers "is this a clean seam and what's the signature", the question outline cannot.
- usages: where a \`symbol\` is referenced in OTHER files. ripgrep prefilters, then the parser drops comment/string matches. Results split into **confirmed** (the file imports the name from this module, aliases followed to their local name) and **unverified** (same name, no import this check could tie to the definition — possibly a different symbol, possibly reached via a re-export). Still name-based, not type-resolved, so confirm before renaming or deleting. This is the cross-file view refs/report cannot give.
- find: WHICH FILE declares a \`symbol\`, across the whole repo — the one mode that needs no \`file_path\`. **Start here when you do not yet know where something lives, instead of grepping for it.** ripgrep narrows the candidates, then each is parsed and only real declarations are kept, so call sites, comments and strings drop out and each hit reports its kind and line. Feed the result straight into another mode's \`file_path\`.
- stash: hold a range (by \`address\` or \`symbol\`) server-side and get back a handle. **This is how you move code between files.** The content never enters your context, so nothing has to be retyped — pass the handle to StructSed as \`from_stash\`, which supplies the content when writing and the verified range when deleting the original. Also the only way to move a block larger than this tool's output cap, since a truncated block would corrupt the target. Stashing does NOT modify the source; remove the original with a separate StructSed delete.
- print: sed-style line/regex output filtering. Needs no parser, so it works on any text file (config, log, unsupported language).

Addresses for print: \`42\` (one line), \`10,20\` (range), \`10,$\` (to EOF), \`$\` (last line), \`/regex/\` (each matching line), \`/from/,/to/\` (block). Range endpoints mix freely, so \`/section marker/,$\` takes a landmark to EOF and \`/start/,120\` or \`10,/end/\` anchor one end only.

Notes:
- Accurate structure needs the language's parser installed (Settings → Structural Parsing). Without it, outline/extract fall back to text heuristics and say so; tree/refs/calls/report need the parser and report that plainly rather than guessing.
- Counts and structure are syntactic and single-file: two same-named symbols collapse together, and a symbol used only in OTHER files still shows refs: 1. Confirm cross-file usage with Grep before deleting anything.`;

const rawJsonSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		file_path: {
			description:
				"Absolute path to the file to inspect. Omit for mode=find, which searches the repository.",
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
				'For mode=extract: the symbol to return. "Class.method" targets a member; a bare name matches at any depth. Append "#N" to pick the Nth match among duplicates. For mode=find/usages: the bare name to locate across the repository.',
			type: "string",
		},
		kind: {
			description:
				'Comma-separated declaration kinds to keep (e.g. "function,method" or "interface,type"). Applies to outline, extract and api. For mode=landmarks it filters landmark kinds instead: "section", "region", "marker".',
			type: "string",
		},
		depth: {
			description:
				"For mode=outline and mode=tree: maximum nesting depth. Outline defaults to 2 (top level plus one, so classes show their members); tree defaults to 6. Use 1 for a top-level-only skeleton.",
			type: "number",
		},
		with_refs: {
			description:
				"For mode=outline: annotate each entry with how many times its name appears in this file (definition included). Requires an installed language parser.",
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
				'For mode=print: line number, "start,end", "start,$", "$", "/regex/", "/from/,/to/", ' +
				'or a mixed range like "/from/,$", "/from/,120", "10,/to/".',
			type: "string",
		},
		line_numbers: {
			description:
				"For mode=print and mode=extract: prefix output lines with their numbers. " +
				"Defaults to true. Set false on extract to get bare source suitable for StructSed content.",
			type: "boolean",
		},
		position: {
			description: 'For mode=enclosing: a line number, or "line:column".',
			type: "string",
		},
	},
	// `file_path` is deliberately NOT required: mode=find searches the repository and has
	// no file to name. The execute path enforces it for every other mode.
	required: [],
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
		file_path: z
			.string()
			.optional()
			.describe("Absolute path to the file to inspect. Not needed for mode=find."),
		mode: z.enum(MODES).optional().describe("What to return. Defaults to 'outline'."),
		symbol: z
			.string()
			.optional()
			.describe("For mode=extract/usages/find: the symbol to return or locate."),
		kind: z.string().optional().describe("Comma-separated declaration kinds to keep."),
		depth: looseNumber("For mode=outline/tree: maximum nesting depth."),
		address: z.string().optional().describe("For mode=print: line/range/regex address."),
		line_numbers: z
			.boolean()
			.optional()
			.describe(
				"For mode=print and mode=extract: prefix line numbers. Defaults to true. " +
					"Set false on extract to get bare source you can pass to StructSed's content.",
			),
		position: z.string().optional().describe('For mode=enclosing: line number or "line:column".'),
		with_refs: z.boolean().optional().describe("For mode=outline: annotate reference counts."),
		filter: z.string().optional().describe("For mode=calls: substring filter on the callee."),
		limit: looseNumber("For mode=refs/calls: maximum rows. Defaults to 25."),
		include_html: z.boolean().optional().describe("For mode=tree: include HTML host elements."),
	}),
	metadata: { readOnly: true },

	async execute(args, ctx): Promise<ToolResult> {
		const filePath = typeof args.file_path === "string" ? args.file_path : "";
		const mode: Mode = MODES.includes(args.mode as Mode) ? (args.mode as Mode) : "outline";

		// Repo-wide modes are the ones that answer "which file?", so requiring a file_path
		// would defeat them. Checked before the requirement rather than inside it.
		if (!filePath && !REPO_MODES.has(mode)) {
			return { output: "file_path is required.", isError: true };
		}

		const backend = getToolBackend(ctx, typeof args.device === "string" ? args.device : undefined);

		if (mode === "find") {
			return runFind(args, {
				backend,
				baseCwd: toolBaseCwd(backend, ctx.cwd),
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
		}
		const resolvedPath =
			ctx.executionTarget?.lexicalPath ??
			resolveBackendPath(backend, toolBaseCwd(backend, ctx.cwd), filePath);
		const canonicalPath = ctx.executionTarget?.canonicalPath;
		const ioPath = canonicalPath ?? resolvedPath;

		let text: string;
		let encoding = "utf-8";
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
			({ text, encoding } = decodeFileBytes(read.bytes));
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
		// regex addresses need no parser, so it must work on a log or a config file
		// exactly as it does on TypeScript.
		if (mode === "print") {
			return runPrint(filePath, text, args, truncatedRead);
		}

		// Same reasoning: landmarks are a comment convention, so they resolve without a
		// parser and stay available exactly where structural help is scarcest.
		if (mode === "landmarks") {
			return runLandmarks(filePath, text, args, truncatedRead);
		}

		const languageId = languageIdForExtension(extname(resolvedPath));
		const doc: StructDocument = {
			filePath: resolvedPath,
			text,
			languageId,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		};

		const resolved = await resolveProvider(doc);
		// `stash` is the one structural mode that must survive a missing provider: with an
		// `address` it needs no grammar at all, and refusing the call would deny the relay
		// exactly where it is most needed — a file whose language cannot be parsed is one
		// whose ranges can only be named by line.
		if (mode === "stash") {
			return runStash(filePath, text, doc, resolved, args, ctx.narratorId, encoding, []);
		}
		if (!resolved) {
			return {
				// Naming the remedy matters: without it this reads as "this file is unsupported"
				// when the actual cause is usually a grammar that was never downloaded.
				output:
					`No structure provider could handle ${filePath}. Its language grammar may not be ` +
					"installed — check Settings → Enhancements → Structural Parsing. Meanwhile " +
					"mode=print and mode=landmarks work without a parser, or use Read.",
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
			case "interface":
				return runInterface(filePath, doc, resolved, args, notes);
			case "usages":
				return runUsages(filePath, doc, resolved, args, notes, {
					backend,
					baseCwd: toolBaseCwd(backend, ctx.cwd),
					ioPath,
					signal: ctx.signal,
				});
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

// ── modes ────────────────────────────────────────────────────────────
