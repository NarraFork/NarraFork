/**
 * The "what is in this file" modes: `outline`, `api`, `extract`, `enclosing` and `imports`.
 *
 * All five are projections of the same provider outline/locate calls, which is why they live
 * together: `api` is the exports-only view, `extract` returns one body, `enclosing` walks the
 * containment chain, and `imports` reads the module edges.
 */

import {
	parsePosition,
	parseSymbolSelector,
	referenceCounts,
	type StructDocument,
	type StructKind,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import { normalizeNumber } from "../../number-param";
import { DEFAULT_DEPTH } from "../constants";
import {
	annotateRefs,
	countNodes,
	filterKinds,
	keepExported,
	limitDepth,
	suggestSymbols,
} from "../nodes";
import {
	clampOutput,
	header,
	headerWithDominant,
	numberLines,
	precisionOf,
	type Resolved,
	renderEmpty,
	renderOutline,
	withFooter,
} from "../render";

export async function runOutline(
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
				"Reference counts need an installed parser for this language, so they were omitted.",
			);
		}
	}

	const limited = limitDepth(annotated, depth);
	const filtered = kinds ? filterKinds(limited, kinds) : limited;

	if (filtered.length === 0) {
		return {
			output: renderEmpty(filePath, doc, resolved, notes, "No declarations found."),
			title: filePath,
			metadata: {
				mode: "outline",
				provider: resolved.provider.id,
				precision: precisionOf(resolved),
				declarations: 0,
			},
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
			precision: precisionOf(resolved),
			support: resolved.support,
			languageId: doc.languageId,
			declarations: countNodes(filtered),
		},
	};
}

export async function runApi(
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
			metadata: {
				mode: "api",
				provider: resolved.provider.id,
				precision: precisionOf(resolved),
				exports: 0,
			},
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
			precision: precisionOf(resolved),
			support: resolved.support,
			exports: countNodes(filtered),
		},
	};
}

export async function runExtract(
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
	// `line_numbers: false` yields the bare source, so an extracted symbol can be
	// handed straight to StructSed's `content` when moving it to another file.
	// Numbered output is still the default: when reading, the numbers are what make
	// a later address possible.
	const raw = args.line_numbers === false;
	const body = raw ? snippet : numberLines(snippet.split("\n"), node.startLine);

	return {
		output: withFooter(
			`${filePath}  ${node.kind} ${node.symbolPath}  (L${node.startLine}-${node.endLine})`,
			clampOutput(body),
			notes,
		),
		title: `${filePath} → ${node.symbolPath}`,
		metadata: {
			mode: "extract",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			support: resolved.support,
			symbolPath: node.symbolPath,
			kind: node.kind,
			startLine: node.startLine,
			endLine: node.endLine,
			exported: node.exported,
			lineNumbers: !raw,
		},
	};
}

export async function runEnclosing(
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
			metadata: {
				mode: "enclosing",
				provider: resolved.provider.id,
				precision: precisionOf(resolved),
				depth: 0,
			},
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
			precision: precisionOf(resolved),
			support: resolved.support,
			symbolPath: innermost.symbolPath,
			kind: innermost.kind,
			startLine: innermost.startLine,
			endLine: innermost.endLine,
			chain: chain.map((n) => n.symbolPath),
		},
	};
}

export async function runImports(
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
		// A re-export has no declaration here, so the provider leaves its kind `unknown` —
		// printing that raw read as an error state for what is a perfectly normal barrel
		// entry. Say what it actually is, and name the module it forwards to: that is the
		// file a reader has to open next, and `from` was already being collected.
		const describe = (exp: (typeof info.exports)[number]): string =>
			exp.from ? `re-export ${exp.name} from "${exp.from}"` : `${exp.kind} ${exp.name}`;
		sections.push(
			`Exports (${info.exports.length}):\n` +
				info.exports.map((exp) => `  L${exp.line}  ${describe(exp)}`).join("\n"),
		);
	}
	if (sections.length === 0) sections.push("No imports or exports detected.");

	return {
		output: withFooter(header(filePath, doc, resolved), clampOutput(sections.join("\n\n")), notes),
		title: filePath,
		metadata: {
			mode: "imports",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			imports: info.imports.length,
			exports: info.exports.length,
		},
	};
}
