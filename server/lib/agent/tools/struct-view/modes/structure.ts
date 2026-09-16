/**
 * Structure-relationship modes: `tree` (nested elements), `interface` (what extracting a
 * range would require), and `usages` (cross-file references).
 *
 * These answer questions about how parts of a file relate to each other and to other files,
 * rather than simply listing what a file declares.
 */

import { dirname, extname, join, resolve } from "node:path";
import { resolveBackendPath } from "../../../execution/path-resolve";
import type { getToolBackend } from "../../../execution/tool-backend";
import {
	AddressError,
	analyzeExtraction,
	assembleUsages,
	CROSS_FILE_PRECISION_NOTE,
	type InterfaceSymbol,
	importMayReferTo,
	languageIdForExtension,
	parseAddress,
	parseSymbolSelector,
	type RawFileHit,
	referenceLines,
	resolveAddress,
	resolveProvider,
	type StructDocument,
	straddlingDeclarations,
	type UsageConfidence,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import { decodeFileBytes } from "../../encoding";
import { normalizeNumber } from "../../number-param";
import {
	MAX_USAGE_CANDIDATES,
	MAX_USAGE_FILE_BYTES,
	USAGE_GREP_MAX_BYTES,
	USAGE_GREP_TIMEOUT_MS,
} from "../constants";
import { countElements, flattenPublic } from "../nodes";
import {
	clampOutput,
	header,
	precisionOf,
	type Resolved,
	renderElementTree,
	unsupportedModeMessage,
	withFooter,
} from "../render";

export async function runElementTree(
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
		metadata: {
			mode: "tree",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			elements: countElements(roots),
		},
	};
}

/**
 * `interface` — what extracting a range would require.
 *
 * Accepts either an `address` (a line range) or a `symbol`, because both phrasings of the
 * same question come up: "can I pull L2177-2418 out" and "can I pull this method out".
 */
export async function runInterface(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
): Promise<ToolResult> {
	const lines = await referenceLines(doc);
	if (!lines) {
		return {
			output: unsupportedModeMessage("interface", doc, resolved),
			isError: true,
			title: filePath,
		};
	}

	// Resolve the range from whichever form the caller used.
	let range: { startLine: number; endLine: number } | null = null;
	let label = "";
	const rawSymbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
	const rawAddress = typeof args.address === "string" ? args.address.trim() : "";
	if (rawSymbol && rawAddress) {
		return {
			output:
				"Give either `symbol` or `address`, not both — they select different ranges and guessing which one you meant could analyse the wrong block.",
			isError: true,
			title: filePath,
		};
	}

	const outline = flattenPublic(await resolved.provider.outline(doc));

	if (rawSymbol) {
		const parsed = parseSymbolSelector(rawSymbol);
		const matches = await resolved.provider.locate(doc, {
			symbol: parsed.symbol,
			...(parsed.nth != null ? { nth: parsed.nth } : {}),
		});
		const located = matches[0];
		if (!located) {
			return {
				output: `No symbol matching "${rawSymbol}" in ${filePath}. Use mode=outline to see what this file declares.`,
				isError: true,
				title: filePath,
			};
		}
		range = { startLine: located.startLine, endLine: located.endLine };
		label = `${located.kind} ${located.name}`;
	} else if (rawAddress) {
		try {
			const resolvedBlocks = resolveAddress(parseAddress(rawAddress), doc.text.split("\n"));
			const first = resolvedBlocks.blocks[0];
			const last = resolvedBlocks.blocks[resolvedBlocks.blocks.length - 1];
			if (!first || !last) {
				return {
					output: `Address "${rawAddress}" matched nothing in ${filePath}.`,
					isError: true,
					title: filePath,
				};
			}
			range = { startLine: first.startLine, endLine: last.endLine };
			label = `L${range.startLine}-${range.endLine}`;
		} catch (err) {
			return {
				output: err instanceof AddressError ? `Invalid address: ${err.message}` : String(err),
				isError: true,
				title: filePath,
			};
		}
	} else {
		return {
			output:
				'mode=interface needs a range: pass `address` for lines (e.g. "2177,2418") or `symbol` for a declaration.',
			isError: true,
			title: filePath,
		};
	}

	const straddling = straddlingDeclarations(range, outline);
	const analysis = analyzeExtraction(range, outline, lines, {
		...(normalizeNumber(args.limit, { min: 1 }) != null
			? { limit: normalizeNumber(args.limit, { min: 1 }) as number }
			: {}),
	});

	const rangeLines = range.endLine - range.startLine + 1;
	const sections: string[] = [];

	// A declaration cut in half comes first: no interface analysis makes extracting the
	// middle of a function work, so saying it up front prevents acting on the rest.
	if (straddling.length > 0) {
		sections.push(
			`⚠ RANGE SPLITS ${straddling.length} DECLARATION(S) — extracting this would cut them in half.\n` +
				straddling
					.slice(0, 10)
					.map((n) => `  L${n.startLine}-${n.endLine}  ${n.kind} ${n.name}`)
					.join("\n") +
				"\nAdjust the range to whole declarations, or use mode=enclosing to find their bounds.",
		);
	}

	const renderGroup = (
		title: string,
		entries: readonly InterfaceSymbol[],
		hint: string,
	): string => {
		if (entries.length === 0) return `${title}: none.`;
		const rows = entries
			.map((symbol) => {
				const at = symbol.declaredAt != null ? `L${symbol.declaredAt}` : "elsewhere";
				const kind = symbol.kind ? `${symbol.kind} ` : "";
				const crossings =
					symbol.outside.length > 0
						? ` · used outside at ${symbol.outside
								.slice(0, 6)
								.map((l) => `L${l}`)
								.join(", ")}${symbol.outside.length > 6 ? ` +${symbol.outside.length - 6}` : ""}`
						: ` · ${symbol.inside.length} use(s) inside`;
				return `  ${kind}${symbol.name}  (declared ${at})${crossings}${symbol.exported ? " [already exported]" : ""}`;
			})
			.join("\n");
		return `${title} (${entries.length}) — ${hint}\n${rows}`;
	};

	sections.push(
		renderGroup(
			"NEEDS INPUT",
			analysis.needsInput,
			"defined outside the range: these become parameters or imports.",
		),
	);
	sections.push(
		renderGroup(
			"NEEDS EXPORT",
			analysis.needsExport,
			"defined inside but used outside: export these or those callers break.",
		),
	);
	sections.push(
		renderGroup(
			"SELF-CONTAINED",
			analysis.selfContained,
			"defined and used only inside: they move with the block.",
		),
	);

	const verdict =
		straddling.length > 0
			? "Not extractable as given: the range splits declarations."
			: analysis.needsExport.length === 0
				? `Clean seam: nothing outside depends on this range's internals. It needs ${analysis.needsInput.length} input(s).`
				: `Extractable, but ${analysis.needsExport.length} symbol(s) must be exported and ${analysis.needsInput.length} supplied.`;

	return {
		output: withFooter(
			`${header(filePath, doc, resolved)}\nInterface for ${label} (${rangeLines} lines, ${analysis.declarationsInRange.length} whole declaration(s))`,
			`${sections.join("\n\n")}\n\n${verdict}\nName-based and single-file: same-named symbols collapse, and cross-file usage is invisible.`,
			notes,
		),
		title: filePath,
		metadata: {
			mode: "interface",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			startLine: range.startLine,
			endLine: range.endLine,
			needsInput: analysis.needsInput.length,
			needsExport: analysis.needsExport.length,
			selfContained: analysis.selfContained.length,
			straddling: straddling.length,
		},
	};
}

/**
 * `usages` — where a symbol is referenced in OTHER files.
 *
 * Two stages, because neither alone is both fast and honest: ripgrep narrows thousands of
 * files to the few whose text contains the name, then the parser confirms each hit is a
 * real identifier rather than a mention in a comment or string. See cross-file-usages.ts
 * for why the result is labelled structural rather than semantic.
 */
/**
 * Whether a candidate file imports `name` from the file that declares it.
 *
 * Any failure resolves to `unverified`, never to "not a usage": a language with no import
 * support, a dynamic import or a path alias this heuristic cannot follow all leave a
 * genuine reference that must still be reported. The label describes what could be PROVEN,
 * not what exists.
 *
 * Barrels are followed ONE hop. Most of a codebase imports through an `index.ts` rather
 * than naming the defining file, so without this the common case — the normal, encouraged
 * import style — was reported as unverifiable, which made the whole distinction close to
 * useless. A second hop is not followed: it needs another file read per candidate, the cost
 * grows with the repo, and barrel chains deeper than one level are rare. Two hops stay
 * `unverified`, and the caveat says so rather than implying full resolution.
 */
async function classifyImport(
	candidateDoc: StructDocument,
	name: string,
	definingPath: string,
	io: {
		backend: ReturnType<typeof getToolBackend>;
		baseCwd: string;
		signal?: AbortSignal;
	},
): Promise<{ confidence: UsageConfidence; alias?: string; viaBarrel?: string }> {
	try {
		const resolved = await resolveProvider(candidateDoc);
		if (!resolved?.provider.imports) return { confidence: "unverified" };
		const info = await resolved.provider.imports(candidateDoc);

		const barrelCandidates: string[] = [];
		for (const entry of info.imports) {
			if (!entry.names?.length) continue;
			const direct = importMayReferTo(entry.module, definingPath);
			for (const imported of entry.names) {
				if (imported.local !== name && imported.original !== name) continue;
				if (direct) {
					// Renamed on import: the local name is what appears at the use sites.
					if (imported.original === name && imported.local !== name) {
						return { confidence: "aliased", alias: imported.local };
					}
					return { confidence: "confirmed" };
				}
				// Right name, wrong module — the module may be a barrel that forwards it.
				barrelCandidates.push(entry.module);
			}
		}

		for (const specifier of barrelCandidates) {
			const forwarded = await barrelForwards(specifier, name, definingPath, candidateDoc, io);
			if (forwarded) return { confidence: "confirmed", viaBarrel: specifier };
		}
		return { confidence: "unverified" };
	} catch {
		return { confidence: "unverified" };
	}
}

/**
 * Does `specifier`, resolved relative to the importing file, re-export `name` from the
 * module that declares it?
 *
 * Only the shapes a barrel actually takes are accepted: `export { name } from "./def"`, a
 * renamed forward of it, or `export * from "./def"`. A star export is credited without
 * reading the far module — it forwards everything by definition, so if it points at the
 * defining file it necessarily forwards the symbol.
 */
async function barrelForwards(
	specifier: string,
	name: string,
	definingPath: string,
	importingDoc: StructDocument,
	io: {
		backend: ReturnType<typeof getToolBackend>;
		baseCwd: string;
		signal?: AbortSignal;
	},
): Promise<boolean> {
	const barrelPath = await resolveModuleFile(specifier, importingDoc.filePath, io);
	if (!barrelPath) return false;
	try {
		const read = await io.backend.readFileBytes(barrelPath, {
			maxBytes: MAX_USAGE_FILE_BYTES,
			...(io.signal ? { signal: io.signal } : {}),
		});
		if (read.truncated) return false;
		const { text } = decodeFileBytes(read.bytes);
		const doc: StructDocument = {
			filePath: barrelPath,
			text,
			languageId: languageIdForExtension(extname(barrelPath)),
			...(io.signal ? { signal: io.signal } : {}),
		};
		const resolved = await resolveProvider(doc);
		if (!resolved?.provider.imports) return false;
		const info = await resolved.provider.imports(doc);
		for (const entry of info.exports) {
			// `from` is what marks a pass-through; a declaration in the barrel is a different
			// symbol that merely shares the name.
			if (!entry.from) continue;
			if (!importMayReferTo(entry.from, definingPath)) continue;
			if (entry.name === "*" || entry.name === name) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Resolve a relative module specifier to a real file.
 *
 * Only relative specifiers are attempted. A bare or aliased specifier needs the build
 * system's own resolution (tsconfig paths, package exports), and guessing at it would
 * produce confident wrong answers — the thing the precision labelling exists to prevent.
 */
async function resolveModuleFile(
	specifier: string,
	importingFile: string,
	io: { backend: ReturnType<typeof getToolBackend>; signal?: AbortSignal },
): Promise<string | null> {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(importingFile), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		`${base}.mts`,
		`${base}.cts`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
		join(base, "index.js"),
	];
	for (const candidate of candidates) {
		if (io.signal?.aborted) return null;
		try {
			const stat = await io.backend.statFile(candidate);
			if (stat && !stat.isDirectory) return candidate;
		} catch {
			// Try the next spelling.
		}
	}
	return null;
}

export async function runUsages(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	args: Record<string, unknown>,
	notes: string[],
	io: {
		backend: ReturnType<typeof getToolBackend>;
		baseCwd: string;
		ioPath: string;
		signal?: AbortSignal;
	},
): Promise<ToolResult> {
	// Resolve the name being traced. A symbol is taken verbatim; an address resolves to the
	// declaration whose name we then search for.
	const rawSymbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
	let name = "";
	if (rawSymbol) {
		const parsed = parseSymbolSelector(rawSymbol);
		const matches = await resolved.provider.locate(doc, {
			symbol: parsed.symbol,
			...(parsed.nth != null ? { nth: parsed.nth } : {}),
		});
		const located = matches[0];
		// The bare final segment: `Class.method` is searched as `method`, since that is the
		// identifier that appears at call sites.
		name = located ? located.name : (parsed.symbol.split(".").pop() ?? parsed.symbol);
	} else {
		return {
			output:
				'mode=usages needs a `symbol` to trace across files (e.g. symbol: "resolveSelectionOverlayBlockId").',
			isError: true,
			title: filePath,
		};
	}

	if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
		return {
			output: `"${name}" is not a plain identifier, so a cross-file name search would be unreliable. Trace a named declaration instead.`,
			isError: true,
			title: filePath,
		};
	}

	// Stage 1: ripgrep prefilter. `\bNAME\b` keeps the candidate set to files that mention
	// the name at all; the parser does the real work in stage 2.
	let candidatePaths: string[];
	let candidatesCapped = false;
	try {
		const grepResult = await io.backend.grep({
			pattern: `\\b${name}\\b`,
			searchPath: io.baseCwd,
			cwd: io.baseCwd,
			outputMode: "files_with_matches",
			showLineNumbers: false,
			maxBytes: USAGE_GREP_MAX_BYTES,
			timeoutMs: USAGE_GREP_TIMEOUT_MS,
			...(io.signal ? { signal: io.signal } : {}),
		});
		if (grepResult.unavailable) {
			return {
				output:
					"No search backend (ripgrep/grep) is available, so cross-file usages cannot be found.",
				isError: true,
				title: filePath,
			};
		}
		const decoded = new TextDecoder().decode(grepResult.stdoutBytes).trim();
		const all = decoded.length > 0 ? decoded.split(/\r?\n/) : [];
		// Drop the file being inspected: this mode answers "who ELSE uses it".
		const others = all.filter((p) => {
			const abs = resolveBackendPath(io.backend, io.baseCwd, p);
			return abs !== io.ioPath && p !== filePath;
		});
		candidatesCapped = grepResult.truncatedByBytes === true || others.length > MAX_USAGE_CANDIDATES;
		candidatePaths = others.slice(0, MAX_USAGE_CANDIDATES);
	} catch (err) {
		return {
			output: `Cross-file search failed: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			title: filePath,
		};
	}

	// Stage 2: parse each candidate and keep only real identifier lines.
	const hits: RawFileHit[] = [];
	let skipped = 0;
	for (const relPath of candidatePaths) {
		if (io.signal?.aborted) break;
		try {
			const abs = resolveBackendPath(io.backend, io.baseCwd, relPath);
			const read = await io.backend.readFileBytes(abs, {
				maxBytes: MAX_USAGE_FILE_BYTES,
				...(io.signal ? { signal: io.signal } : {}),
			});
			if (read.truncated) {
				skipped++;
				continue;
			}
			const { text: candidateText } = decodeFileBytes(read.bytes);
			const candidateDoc: StructDocument = {
				filePath: abs,
				text: candidateText,
				languageId: languageIdForExtension(extname(abs)),
				...(io.signal ? { signal: io.signal } : {}),
			};
			const lines = await referenceLines(candidateDoc);
			if (!lines) {
				// No parser for this language: fall back to reporting it as a text match, so a
				// hit in an unsupported file is not silently dropped.
				hits.push({ path: relPath, lines: [] });
				skipped++;
				continue;
			}
			// Import check: does this file actually pull the name from the defining module?
			// Cheap (the parse is already done and cached) and it is what separates "uses the
			// symbol" from "happens to contain a same-named identifier".
			const verdict = await classifyImport(candidateDoc, name, io.ioPath, io);
			const own = lines.get(name) ?? [];
			// An alias means the local name differs, so the original name's lines are not the
			// usages — the alias's are.
			const effective = verdict.alias ? (lines.get(verdict.alias) ?? own) : own;
			hits.push({
				path: relPath,
				lines: effective,
				confidence: verdict.confidence,
				...(verdict.alias ? { alias: verdict.alias } : {}),
				...(verdict.viaBarrel ? { viaBarrel: verdict.viaBarrel } : {}),
			});
		} catch {
			skipped++;
		}
	}

	const result = assembleUsages(hits, { candidatesCapped, skipped });

	if (result.files.length === 0) {
		const why =
			result.textOnlyFiles > 0
				? ` The name appears in ${result.textOnlyFiles} other file(s) but only in comments or strings.`
				: "";
		return {
			output: withFooter(
				`${header(filePath, doc, resolved)}\nusages of ${name}`,
				`No cross-file identifier usages found.${why}\n\n${CROSS_FILE_PRECISION_NOTE}`,
				notes,
			),
			title: filePath,
			metadata: { mode: "usages", provider: resolved.provider.id, files: 0 },
		};
	}

	const totalRefs = result.files.reduce((n, f) => n + f.lines.length, 0);
	const row = (file: (typeof result.files)[number]): string => {
		const shown = file.lines.map((l) => `L${l}`).join(", ");
		const alias = file.alias ? `  [imported as ${file.alias}]` : "";
		// Naming the barrel matters for a rename: the edit may belong in the barrel, not here.
		const via = file.viaBarrel ? `  [via ${file.viaBarrel}]` : "";
		return `  ${file.path}  (${file.lines.length})  ${shown}${alias}${via}`;
	};
	// Two groups, because the difference is actionable: a rename must update the confirmed
	// files, while an unverified one has to be read first. A single flat list forced that
	// judgement onto the reader with nothing to base it on.
	const confirmed = result.files.filter((f) => f.confidence !== "unverified");
	const unverified = result.files.filter((f) => f.confidence === "unverified");
	const sections: string[] = [];
	if (confirmed.length > 0) {
		sections.push(
			`confirmed — imports ${name} from this module:\n${confirmed.map(row).join("\n")}`,
		);
	}
	if (unverified.length > 0) {
		sections.push(
			`unverified — same name, no visible import from this module:\n${unverified.map(row).join("\n")}`,
		);
	}
	const body = sections.join("\n\n");

	const caveats: string[] = [];
	if (result.candidatesCapped) {
		caveats.push(
			`Candidate files were capped at ${MAX_USAGE_CANDIDATES}; narrow with a more specific name if results look incomplete.`,
		);
	}
	if (result.skipped > 0) {
		caveats.push(`${result.skipped} candidate(s) skipped (too large, unreadable, or no parser).`);
	}
	if (result.textOnlyFiles > 0) {
		caveats.push(
			`${result.textOnlyFiles} file(s) matched only in comments/strings and were excluded.`,
		);
	}

	return {
		output: withFooter(
			`${header(filePath, doc, resolved)}\n${result.files.length} file(s) reference ${name} (${totalRefs} identifier occurrence(s))`,
			`${body}\n\n${CROSS_FILE_PRECISION_NOTE}${caveats.length > 0 ? `\n${caveats.join("\n")}` : ""}`,
			notes,
		),
		title: filePath,
		metadata: {
			mode: "usages",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			files: result.files.length,
			occurrences: totalRefs,
			textOnlyFiles: result.textOnlyFiles,
			...(result.candidatesCapped ? { candidatesCapped: true } : {}),
		},
	};
}
