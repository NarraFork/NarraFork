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

import { z } from "zod";
import {
	fileChangeDiagnosticMetadata,
	fileChangeDiagnosticSuffix,
} from "../../../../services/file-change-diagnostics";
import { LocalFileValidationError } from "../../../../services/file-change-local-io";
import { executeLocalFileChange } from "../../../../services/file-change-runtime";
import { toolSpecPathError } from "../../../spec-uri";
import { withDeviceParam } from "../../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../../execution/path-resolve";
import { getToolBackend } from "../../execution/tool-backend";
import {
	applyBatch,
	type BatchOperation,
	EditOpError,
	type LineRange,
} from "../../structural/edit-ops";
import {
	dropStash,
	formatStashSize,
	locateStashRange,
	peekStash,
	type StashEntry,
	type StashFailure,
} from "../../structural/stash";
import type { ToolContext, ToolDefinition, ToolResult } from "../../types";
import {
	applyLineEnding,
	decodeFileBytes,
	detectLineEnding,
	encodeFileBytes,
	normalizeLineEndings,
} from "../encoding";
import {
	applyCommand,
	changeLineStats,
	type DiffHunks,
	diffHunks,
	diffMetadata,
	previewRegion,
} from "./apply";
import { COMMANDS, MAX_BATCH_OPERATIONS, MAX_FILE_BYTES } from "./commands";
import { resolveToRange, type ValidatedSpec, validateSpec } from "./resolve";

const DESCRIPTION = `Change a file by STRUCTURE rather than by quoting its text.

Addresses the same way StructView reads, so a symbol you just inspected can be rewritten
without re-quoting it: \`symbol: "PaymentService.charge"\` selects that method's full body.

Prefer this over Edit when the change is a WHOLE declaration or a positional range —
replacing a 200-line method needs its name here, not its entire old body quoted back — and
over a Read-then-Write round trip, which sends the file through the conversation twice.
Prefer it over \`sed\`/\`awk\` in Bash: this runs the same addressing with a dry-run preview,
snapshot evidence and revert support. Edit is still right for a small, surgical string
replacement you can name exactly.

Commands:
- replace: swap the selected node/range's body for \`content\`
- delete: remove the selected node/range (whole lines)
- insert: put \`content\` immediately before the selection
- append: put \`content\` immediately after the selection
- substitute: regex-replace inside the selection only (\`pattern\` + \`replacement\`, flags g/i).
  Runs one line at a time, so \`^\`/\`$\` anchor per line and no pattern can span a line break.
  Refused before anything is written, with nothing changed: a pattern that matches between
  characters (\`x*\`, \`\\b\`) more than once on a line, and a \`replacement\` referencing a
  capture group the pattern does not have — JS writes such a reference through as literal
  text, or expands an unknown \`$<name>\` to nothing, neither of which reports an error.
- copy: duplicate the selection to another position in the SAME file
- move: relocate the selection to another position in the SAME file

Addressing (give exactly ONE):
- \`symbol\` — a declaration name, \`Class.method\` for a member, \`name#2\` to disambiguate.
  Needs a parsed language; run StructView first to see what is available.
- \`address\` — sed-style and grammar-free: \`42\`, \`10,20\`, \`10,$\`, \`$\`, \`/regex/\`,
  \`/from/,/to/\`. Endpoints mix, so \`/section marker/,$\` means "this landmark to EOF"
  and \`/start/,120\` / \`10,/end/\` anchor one end only. Works on any text file.

For copy/move, the destination is \`to_symbol\` or \`to_address\` (same syntax), with
\`placement: "before" | "after"\` (default "after"). Omit both to append at end of file.
A destination overlapping the source is refused. A moved block keeps its doc comment and
decorators, and is re-indented to its destination.

MOVING A RANGE TO A DIFFERENT FILE — use the stash, not a copy-paste through your context:
  1. \`StructView mode=stash file_path=src.ts address="1495,$"\` → returns a handle.
  2. \`StructSed command=append file_path=dest.ts address="1" from_stash=<handle> keep=true create_if_missing=true dry_run=false\`
  3. \`StructSed command=delete file_path=src.ts from_stash=<handle> dry_run=false\`
The text goes straight from one file to the other; it never passes through the
conversation, so nothing is retyped and no output cap applies. Works by line address as
well as by symbol.
\`keep: true\` in step 2 matters: a handle is released once written, and step 3 still needs
it. Step 3 takes its RANGE from the stash and verifies the text is still there, so it
cannot delete the wrong lines if the file shifted in between — re-typing the address is
what used to make that happen. It relocates and says so, or refuses; either way the
delete releases the handle.
Not atomic: if step 3 fails the range exists in both files, which is the safe direction
(nothing is lost). One call cannot write two files — the write pipeline freezes a single
path per tool call.

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
				'Line/regex address: "42", "10,20", "10,$", "$", "/regex/", "/from/,/to/", or a mixed ' +
				'range like "/from/,$", "/from/,120", "10,/to/". Needs no parser. Mutually exclusive with `symbol`.',
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
			description:
				"For substitute: the replacement text ($1 / $<name> for capture groups, $& for the " +
				"whole match). A reference the pattern does not declare is rejected, not guessed.",
			type: "string",
		},
		flags: {
			description:
				'For substitute: regex flags. Only "g" and "i" are supported; "m" and "s" are ' +
				"rejected because the substitution is already per-line.",
			type: "string",
		},
		dry_run: {
			description:
				"Preview instead of writing. Defaults to TRUE; pass false to actually apply the change.",
			type: "boolean",
		},
		from_stash: {
			description:
				"Stash handle from StructView mode=stash. For replace/insert/append it supplies the " +
				"CONTENT instead of `content` — the text stays server-side and never passes through " +
				"the context, which is how a range moves between files without being retyped. For " +
				"delete it supplies the RANGE instead of `address`/`symbol`, verified against the " +
				"file's current text so a shifted file cannot cause the wrong lines to be removed. " +
				"Released once written; a dry run does not consume it.",
			type: "string",
		},
		keep: {
			description:
				"Keep the `from_stash` handle after a successful write, so one stash can be used " +
				"again — needed when an append is followed by a delete that removes the original. " +
				"Defaults to false (released on use).",
			type: "boolean",
		},
		create_if_missing: {
			description:
				"Create the file when it does not exist, instead of failing. Defaults to false. " +
				"Only replace/insert/append may create a file (they carry their own content); use " +
				'address "1" to write into the new empty file.',
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

export const structSedTool: ToolDefinition = {
	name: "StructSed",
	executionRouting: {
		kind: "single",
		resolve(input) {
			const path = typeof input.file_path === "string" ? input.file_path : undefined;
			return {
				key: "primary",
				// Routing stays `write` even for a dry run: it decides path freezing and the
				// OAuth write-capability check, and taking the stricter side there costs a
				// preview nothing. Interactive approval is what should not fire for a
				// preview, and that is decided separately by `isReadOnlyCall`, which reads
				// the same `dry_run` this call carries.
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
		from_stash: z
			.string()
			.optional()
			.describe(
				"Stash handle from StructView mode=stash: the content for replace/insert/append, " +
					"or the verified range for delete. Released on use.",
			),
		keep: z
			.boolean()
			.optional()
			.describe("Keep the from_stash handle after writing. Defaults to false."),
		create_if_missing: z
			.boolean()
			.optional()
			.describe(
				"Create the file when absent instead of failing. Defaults to false. " +
					"replace/insert/append only.",
			),
		operations: z
			.array(z.record(z.string(), z.unknown()))
			.optional()
			.describe("Several operations applied to this file as one unit, or none at all."),
	}),

	async execute(args, ctx): Promise<ToolResult> {
		const specError = toolSpecPathError("StructSed", args);
		if (specError) return { output: specError, isError: true };
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

		// Resolve stash handles before anything else. For content commands the text is
		// injected as an ordinary `content`, so every downstream path — preview, batch,
		// apply, recorded input — needs no knowledge of the stash. Read with `peek`, never
		// `take`: consuming here would spend the handle on a dry run, so the first real
		// write would always fail.
		const consumedHandles: string[] = [];
		const stashRanges = new Map<number, StashEntry>();
		for (const spec of validated) {
			if (!spec.fromStash) continue;
			const found = peekStash(spec.fromStash, ctx.narratorId);
			if ("failure" in found) {
				return {
					output: stashFailureMessage(spec.fromStash, found.failure, isBatch ? spec.index : null),
					isError: true,
				};
			}
			if (spec.stashSuppliesRange) {
				// The range cannot be resolved yet: it is verified against the file's CURRENT
				// content, which has not been read at this point. Deferred to just after the read.
				stashRanges.set(spec.index, found.entry);
			} else {
				spec.content = found.entry.text;
			}
			consumedHandles.push(spec.fromStash);
		}
		// What a from_stash write is ABOUT to put in the file. The preview shows a window
		// around the edit, so on a large block its trailing edge is off-screen and the caller
		// cannot tell whether the range carried one line too many. Summarising the source
		// range and the declarations it contains answers that without echoing the content —
		// which is the whole reason the text is held server-side.
		const stashSummaries: string[] = [];
		for (const spec of validated) {
			if (!spec.fromStash) continue;
			const held = peekStash(spec.fromStash, ctx.narratorId);
			if ("failure" in held) continue;
			const { entry } = held;
			// Top-level `name`-bearing lines, by indentation: a parser is not available for
			// every language here, and a wrong list would be worse than a coarse one.
			const declared = entry.text
				.split("\n")
				.filter((line) =>
					/^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\s/.test(line),
				)
				.map(
					(line) =>
						line.replace(/^(export\s+)?(async\s+)?\w+\s+/, "").match(/^[A-Za-z_$][\w$]*/)?.[0],
				)
				.filter((name): name is string => !!name);
			const where = isBatch ? `Operation ${spec.index}: ` : "";
			stashSummaries.push(
				`${where}${spec.fromStash} ← ${entry.filePath}:${entry.startLine}-${entry.endLine} ` +
					`(${entry.lineCount} line(s), ${formatStashSize(entry.bytes)})` +
					(declared.length > 0 ? `\n  declares: ${declared.join(", ")}` : ""),
			);
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

		// Creating a file is opt-in. Default-off because a typo'd path would otherwise
		// silently produce a new file instead of reporting that the target is missing,
		// and the caller would go on believing they edited something real.
		const createIfMissing = args.create_if_missing === true;

		let originalText: string;
		try {
			const stat = await backend.statFile(ioPath);
			if (stat?.isDirectory) {
				return { output: `${filePath} is a directory.`, isError: true };
			}
			if (stat === null && createIfMissing) {
				// Only commands that supply their own complete content can build a file from
				// nothing. `delete`/`substitute`/`move` describe a transformation of existing
				// text, so on a missing file they have nothing to transform and are refused
				// rather than quietly creating an empty file.
				const offending = validated.find(
					(spec) =>
						spec.command !== "replace" && spec.command !== "insert" && spec.command !== "append",
				);
				if (offending) {
					return {
						output:
							`${filePath} does not exist. create_if_missing can only build a new file with ` +
							`replace/insert/append, which carry their own content; \`${offending.command}\` needs existing text to act on.`,
						isError: true,
					};
				}
				originalText = "";
			} else {
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
			}
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
		const relocationNotes: string[] = [];
		for (const spec of validated) {
			const stashed = stashRanges.get(spec.index);
			if (stashed) {
				// The recorded line numbers are only a hint; they are verified against the file as
				// it is NOW. Acting on a stale range would delete whatever moved into those lines.
				const located = locateStashRange(normalized, stashed);
				if (located.kind === "ambiguous") {
					return {
						output:
							`stash ${spec.fromStash} holds text that appears ${located.candidates.length} ` +
							`times in ${filePath} (lines ${located.candidates.join(", ")}), so the original ` +
							"occurrence cannot be identified. Delete by explicit `address` instead.",
						isError: true,
						title: filePath,
					};
				}
				if (located.kind === "missing") {
					return {
						output:
							`stash ${spec.fromStash} was taken from ${stashed.filePath}:` +
							`${stashed.startLine}-${stashed.endLine}, but that text is no longer in ` +
							`${filePath} — it was probably rewritten or already removed. Nothing was ` +
							"changed. Re-stash the current range, or delete by explicit `address`.",
						isError: true,
						title: filePath,
					};
				}
				if (located.kind === "relocated") {
					relocationNotes.push(
						`stash range moved: L${located.fromStartLine}-${located.fromEndLine} → ` +
							`L${located.startLine}-${located.endLine} (lines shifted since it was stashed).`,
					);
				}
				const range: LineRange = { startLine: located.startLine, endLine: located.endLine };
				resolvedOps.push({ spec, range, label: `L${range.startLine}-${range.endLine}` });
				continue;
			}
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
		// stays replayable by the same branch.
		//
		// A batch cannot: the recorded input admits only SCALAR fields (see
		// `file-change-runtime`), so an `operations` ARRAY was rejected outright — every
		// batched write failed with "File-change input must contain only JSON scalar fields",
		// which made the whole batch feature unusable outside a dry run.
		//
		// So each operation travels as ONE JSON string. Per-operation scalar columns
		// (`op1_command`, `op1_start`…) would blow the 16-field budget at five operations,
		// while this stays at `operations` + N and keeps every field's value a string.
		const recordedInput: Record<string, unknown> = isBatch
			? {
					operations: resolvedOps.length,
					...Object.fromEntries(
						resolvedOps.map((op) => [`op${op.spec.index}`, JSON.stringify(recordOne(op))]),
					),
				}
			: (recordOne(first) as Record<string, unknown>);

		// Default-on preview. The model sees the resolved range and the result before
		// anything is written, which is the check a structural address does not carry.
		const dryRun = args.dry_run !== false;
		if (dryRun) {
			// Approval preview (see `previewStructSedChange`): hand over the whole before/after
			// pair computed by THIS pipeline, so what the reviewer sees cannot drift from what
			// the approved call will write.
			(ctx as PreviewCaptureContext)[PREVIEW_CAPTURE]?.({
				filePath: ioPath,
				before: normalized,
				after: nextText,
			});
			const afterRange: LineRange =
				command === "delete"
					? { startLine: Math.max(1, range.startLine - 1), endLine: range.startLine }
					: { startLine: range.startLine, endLine: range.endLine + 4 };
			// A batch lists every operation, because the whole point of previewing one is
			// seeing all of what it will do before any of it happens.
			const plan = isBatch
				? `${resolvedOps.map((op) => `  ${op.spec.index}. ${op.spec.command} → ${op.label}`).join("\n")}\n`
				: `${addressLabel}\n`;
			// The card renders this as one diff per changed region. Computed from the two texts
			// (not the command's range) so it is correct for move/copy and batches too.
			// `dryRun: true` tells the card to mark the diff as a PREVIEW: the applied write
			// below carries the same diff WITHOUT this flag, so identical-looking diffs are
			// told apart by the banner rather than being mistaken for one another.
			return {
				output:
					`DRY RUN — nothing written. Pass dry_run: false to apply.\n\n` +
					// A silently corrected range would hide that the file shifted underneath the
					// stash, which is exactly what the caller needs to know before applying.
					(relocationNotes.length > 0 ? `${relocationNotes.join("\n")}\n\n` : "") +
					(stashSummaries.length > 0 ? `${stashSummaries.join("\n")}\n\n` : "") +
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
					...diffMetadata(normalized, nextText),
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
					// Absent under the write lock but present at read time (or vice versa) is a
					// real race, so the creation decision is re-made here rather than trusting
					// the earlier stat.
					if (before.bytes === null && !createIfMissing) {
						throw new LocalFileValidationError(`File not found: ${filePath}`);
					}
					const decoded =
						before.bytes === null
							? { text: "", encoding: "utf-8" as const }
							: decodeFileBytes(before.bytes);
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
					// A new file has no existing text to inherit from, so the written content
					// decides its own ending — matching Write, rather than forcing LF onto a
					// file whose sibling modules all use CRLF.
					const ending = detectLineEnding(before.bytes === null ? appliedText : decoded.text);
					return {
						nextBytes: encodeFileBytes(applyLineEnding(appliedText, ending), decoded.encoding),
						// Measured from the bytes under the write lock, not the earlier read:
						// the figure must describe what was actually written.
						lineStats: changeLineStats(current, appliedText),
						result: {
							output:
								`${command} applied to ${filePath} → ${addressLabel}` +
								(replacements != null ? ` (${replacements} replacement(s))` : "") +
								(relocationNotes.length > 0 ? `\n${relocationNotes.join("\n")}` : ""),
							title: filePath,
							metadata: {
								command,
								startLine: range.startLine,
								endLine: range.endLine,
								...(replacements != null ? { replacements } : {}),
								// Same diff the preview showed, so an applied edit is not a bare
								// one-line summary. Computed from the bytes observed under the write
								// lock (`current`), not the earlier read, so it reflects what was
								// actually written. No `dryRun` flag: the card shows this diff
								// without the PREVIEW banner.
								...diffMetadata(current, appliedText),
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
			// Released only now, after the bytes are actually on disk. Releasing earlier would
			// discard the only copy of the text if the write then failed. `keep: true` holds it
			// so one stash can be written to several places.
			if (args.keep !== true) {
				for (const handle of consumedHandles) dropStash(handle, ctx.narratorId);
			}
			return recorded;
		} catch (err) {
			return {
				output: `Error editing ${filePath}: ${err instanceof Error ? err.message : String(err)}${fileChangeDiagnosticSuffix(err)}`,
				isError: true,
				title: filePath,
				metadata: fileChangeDiagnosticMetadata(err),
			};
		}
	},
};

/** Full before/after text of a StructSed call, captured without writing anything. */
export interface StructSedChangePreview {
	/** Path the tool resolved and read. */
	filePath: string;
	/** LF-normalized content before the change. */
	before: string;
	/** LF-normalized content after the change. */
	after: string;
}

/**
 * Private hook through which a dry run reports its computed texts. A symbol key keeps it
 * out of every other ToolContext consumer and out of anything the model can pass.
 */
const PREVIEW_CAPTURE = Symbol("structSedPreviewCapture");
type PreviewCaptureContext = ToolContext & {
	[PREVIEW_CAPTURE]?: (preview: StructSedChangePreview) => void;
};

/**
 * What a pending StructSed call WOULD change, for the approval UI.
 *
 * Approval is only ever requested for `dry_run: false` (a dry run is classified read-only),
 * so the card has no tool output to show at that point. Re-running the SAME pipeline as a
 * dry run — stash handles are only peeked, nothing is written — yields the exact texts the
 * write would produce. Returns the tool's own error text when the call cannot be previewed
 * (address no longer resolves, remote backend, file too large, …).
 */
export async function previewStructSedChange(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<
	| {
			preview: StructSedChangePreview;
			/** Every changed region with context, or null when nothing changed. */
			diff: DiffHunks | null;
	  }
	| { error: string }
> {
	const holder: { captured: StructSedChangePreview | null } = { captured: null };
	const captureCtx: PreviewCaptureContext = {
		...ctx,
		[PREVIEW_CAPTURE]: (preview) => {
			holder.captured = preview;
		},
	};
	const result = await structSedTool.execute({ ...args, dry_run: true }, captureCtx);
	const preview = holder.captured;
	if (!preview) return { error: result.output || "StructSed preview produced no change." };
	return { preview, diff: diffHunks(preview.before, preview.after) };
}

/**
 * Why a stash handle could not be used, and what to do about it.
 *
 * Every branch names a recovery, because the text is still in the source file — stashing
 * never removed it. A bare "invalid handle" would leave the caller unsure whether their
 * code had gone somewhere.
 */
function stashFailureMessage(
	handle: string,
	failure: StashFailure,
	operationIndex: number | null,
): string {
	const where = operationIndex === null ? "" : `Operation ${operationIndex}: `;
	switch (failure) {
		case "expired":
			return (
				`${where}stash ${handle} has expired. Nothing was lost — the range is still in its ` +
				"source file. Run StructView mode=stash again to get a fresh handle."
			);
		case "wrong_narrator":
			return (
				`${where}stash ${handle} belongs to a different narrator and cannot be used here. ` +
				"Run StructView mode=stash in this session to create your own."
			);
		default:
			return (
				`${where}stash ${handle} is not held. Either it was already written (a handle is ` +
				"released on use unless keep: true), or it was evicted. The source file still has " +
				"the range — run StructView mode=stash again."
			);
	}
}
