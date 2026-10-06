/**
 * Counting and summarising modes: `refs` (per-declaration reference counts and positions),
 * `calls` (call/element frequency), and `report` (the one-call file analysis).
 *
 * All three read the same cached parse, which is what makes `report` cheaper than the
 * separate calls it replaces rather than the sum of them.
 */

import {
	type OutlineNode,
	referenceCounts,
	referenceLines,
	type StructDocument,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import { normalizeNumber } from "../../number-param";
import { MAX_RANKED_ROWS, MAX_REF_POSITIONS, MAX_REPORT_LINES } from "../constants";
import {
	annotateRefs,
	flattenPublic,
	isIntentionallyKept,
	limitDepth,
	refLinesForNode,
	refsForNode,
	unusedBindings,
} from "../nodes";
import {
	clampOutput,
	header,
	headerWithDominant,
	precisionOf,
	type Resolved,
	renderElementTree,
	renderOutline,
	unsupportedModeMessage,
	withFooter,
} from "../render";

export async function runRefs(
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
	// Positions, not just counts: "7 references" cannot tell you whether they all sit
	// inside the range you mean to extract, and without them the only way to find out is
	// to leave these tools and grep.
	const lines = await referenceLines(doc);
	const body = shown
		.map((row) => {
			const base = `${String(row.refs).padStart(4)}  L${String(row.node.startLine).padEnd(6)} ${row.node.kind} ${row.node.name}`;
			const at = refLinesForNode(row.node, lines);
			if (!at || at.length === 0) return base;
			// The definition's own line is dropped: it is already the row's L-number, and
			// repeating it makes a one-reference symbol look like it has a use somewhere.
			const uses = at.filter((line) => line !== row.node.startLine);
			if (uses.length === 0) return base;
			const head = uses.slice(0, MAX_REF_POSITIONS).map((line) => `L${line}`);
			const rest = uses.length - head.length;
			return `${base}  · ${head.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
		})
		.join("\n");

	const summary =
		`${unused.length} of ${rows.length} declarations appear only once (defined, never used in this file).` +
		(unused.length > 0
			? " A symbol used only from OTHER files also looks like this — check mode=usages before deleting."
			: "");

	// The count and the current cap, not just "raise limit": knowing 30 of 177 are shown is
	// what tells a caller whether raising it is worth another call.
	const truncated =
		rows.length > shown.length
			? `\n…  ${shown.length} of ${rows.length} shown (limit=${shown.length}); pass a higher \`limit\` for the rest`
			: "";

	return {
		output: withFooter(
			`${header(filePath, doc, resolved)}\nrefs  line     declaration`,
			`${body}${truncated}\n\n${summary}`,
			notes,
		),
		title: filePath,
		metadata: {
			mode: "refs",
			provider: resolved.provider.id,
			precision: precisionOf(resolved),
			declarations: rows.length,
			singleReference: unused.length,
		},
	};
}

export async function runCalls(
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
	const matching = filter
		? stats.calls.filter((c) => c.name.toLowerCase().includes(filter))
		: stats.calls;
	const calls = matching.slice(0, limit);

	// Ranked output is frequency-ordered, so a silent cut hides exactly the low-frequency
	// callees a reader may be looking for (a single clearTimeout matters as much as the 70th
	// useRef). Say how many were held back rather than letting the list look complete.
	const omitted = (total: number, shown: number): string =>
		total > shown ? `\n…  ${shown} of ${total} shown; pass a higher \`limit\` for the rest` : "";

	const sections: string[] = [];
	if (calls.length > 0) {
		sections.push(
			`Calls${filter ? ` matching "${filter}"` : ""}:\n${calls
				.map((c) => `${String(c.count).padStart(5)}  ${c.name}`)
				.join("\n")}${omitted(matching.length, calls.length)}`,
		);
	} else {
		sections.push(filter ? `No calls matching "${filter}".` : "No calls found.");
	}

	if (!filter && stats.elements.length > 0) {
		const elements = stats.elements.slice(0, limit);
		sections.push(
			`Elements rendered:\n${elements
				.map((e) => `${String(e.count).padStart(5)}  ${e.name}`)
				.join("\n")}${omitted(stats.elements.length, elements.length)}`,
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
			precision: precisionOf(resolved),
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
export async function runReport(
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
		const singleRef = flat
			.filter((node) => node.kind !== "call")
			.map((node) => ({ node, refs: refsForNode(node, counts) }))
			.filter((row) => row.refs === 1);

		// An exported symbol's callers are, by definition, in other files. Listing it as a
		// dead-code candidate is a category error, not merely noise: `export function
		// NarratorPanel` appeared on this list while being the component's only entry point.
		const single = singleRef.filter((row) => !row.node.exported);
		// An underscore prefix is a convention meaning "kept on purpose", and a convention is
		// not a fact — `_foo` can equally be a leftover. So these are separated rather than
		// dropped: the signal stays visible without diluting the main list.
		const intentional = single.filter((row) => isIntentionallyKept(row.node.name));
		const candidates = single.filter((row) => !isIntentionallyKept(row.node.name));
		const exportedCount = singleRef.length - single.length;
		const orphanBindings = unusedBindings(flat, counts);

		const parts: string[] = [];
		if (candidates.length > 0) {
			parts.push(
				`SINGLE-REFERENCE SYMBOLS (${candidates.length}) — defined but never used in this file.\n` +
					`Cross-file usage is invisible here; confirm with Grep before deleting.\n${candidates
						.slice(0, 30)
						.map((row) => `  L${row.node.startLine}  ${row.node.kind} ${row.node.name}`)
						.join("\n")}` +
					(candidates.length > 30 ? `\n  … ${candidates.length - 30} more` : ""),
			);
		} else {
			parts.push(
				"SINGLE-REFERENCE SYMBOLS: none — every non-exported declaration is used at least twice here.",
			);
		}
		if (intentional.length > 0) {
			parts.push(
				`INTENTIONALLY KEPT (${intentional.length}) — underscore-prefixed, so the author marked them as deliberate.\n` +
					`Listed separately because the prefix states intent, not proof; verify before removing.\n${intentional
						.slice(0, 20)
						.map((row) => `  L${row.node.startLine}  ${row.node.kind} ${row.node.name}`)
						.join("\n")}` +
					(intentional.length > 20 ? `\n  … ${intentional.length - 20} more` : ""),
			);
		}
		if (exportedCount > 0) {
			parts.push(
				`${exportedCount} exported symbol(s) referenced once here were excluded: their callers live in other files by design.`,
			);
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
			"Call counts and reference counts need an installed parser for this language and were omitted.",
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
			precision: precisionOf(resolved),
			declarations: flat.length,
			hasStatistics: stats != null,
			hasRenderTree: (elements?.length ?? 0) > 0,
		},
	};
}
