/**
 * Heuristic structure provider — the last resort that always answers.
 *
 * Regex + indentation over raw lines. It is wrong more often than tree-sitter and
 * makes no attempt to hide that: every result is labelled heuristic so the model
 * discounts it appropriately. What it buys is that StructView degrades instead of
 * failing — a Ruby file, a Kotlin file, or a TypeScript file whose grammar has not
 * been downloaded still yields a usable skeleton.
 *
 * Nesting comes from leading whitespace, which is a real signal in every
 * brace-and-indent language people actually format. It breaks on minified code, but
 * so does reading it.
 */

import { enclosingInOutline, locateInOutline } from "./locate";
import { flattenOutline, type RichOutlineNode } from "./outline";
import type {
	ImportExportInfo,
	LocatedNode,
	OutlineNode,
	ProviderSupport,
	StructDocument,
	StructKind,
	StructPosition,
	StructSelector,
	StructureProvider,
} from "./provider";

/** Cap on scanned lines, so a giant generated file cannot stall the scan. */
const MAX_SCAN_LINES = 200_000;
const MAX_NODES = 3000;

interface HeuristicPattern {
	regex: RegExp;
	kind: StructKind;
	/** Capture group index holding the name. */
	nameGroup: number;
}

/**
 * Ordered patterns; the first match wins.
 *
 * Deliberately cross-language rather than per-language: the whole point is to
 * produce something for files we have no grammar for, and at that point we do not
 * know which language's patterns to pick.
 */
const PATTERNS: HeuristicPattern[] = [
	{
		regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
		kind: "class",
		nameGroup: 1,
	},
	{ regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", nameGroup: 1 },
	{
		regex: /^\s*(?:export\s+)?(?:type|typealias)\s+([A-Za-z_$][\w$]*)/,
		kind: "type",
		nameGroup: 1,
	},
	{ regex: /^\s*(?:export\s+)?enum\s+(?:class\s+)?([A-Za-z_$][\w$]*)/, kind: "enum", nameGroup: 1 },
	{
		regex: /^\s*(?:export\s+)?(?:pub\s+)?struct\s+([A-Za-z_$][\w$]*)/,
		kind: "struct",
		nameGroup: 1,
	},
	{ regex: /^\s*(?:export\s+)?(?:pub\s+)?trait\s+([A-Za-z_$][\w$]*)/, kind: "trait", nameGroup: 1 },
	{
		regex: /^\s*(?:export\s+)?(?:pub\s+)?(?:module|mod|namespace)\s+([A-Za-z_$][\w$.]*)/,
		kind: "module",
		nameGroup: 1,
	},
	{
		regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
		kind: "function",
		nameGroup: 1,
	},
	{ regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
	{ regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
	{ regex: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
	{
		regex:
			/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
		kind: "function",
		nameGroup: 1,
	},
	{
		regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
		kind: "variable",
		nameGroup: 1,
	},
	{
		regex:
			/^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s.?]+\s+([A-Za-z_$][\w$]*)\s*\(/,
		kind: "method",
		nameGroup: 1,
	},
	// Class members: `foo(a) {`, `async foo(a): Promise<x> {`, `private foo() {`. The
	// optional `: Type` before the brace matters — without it every annotated
	// TypeScript method is invisible, which is most of them.
	{
		regex:
			/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{/,
		kind: "method",
		nameGroup: 1,
	},
];

const IMPORT_PATTERNS: RegExp[] = [
	/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/,
	/^\s*import\s+['"]([^'"]+)['"]/,
	/^\s*from\s+([\w.]+)\s+import\b/,
	/^\s*(?:const|let|var)\s+.*?=\s*require\(\s*['"]([^'"]+)['"]\s*\)/,
	/^\s*use\s+([\w:]+)/,
	/^\s*#include\s*[<"]([^>"]+)[>"]/,
];

export const heuristicProvider: StructureProvider = {
	id: "heuristic",
	label: "text heuristics",

	supports(): ProviderSupport {
		// Always available, never authoritative.
		return "degraded";
	},

	async outline(doc: StructDocument): Promise<OutlineNode[]> {
		return scan(doc).nodes;
	},

	async locate(doc: StructDocument, selector: StructSelector): Promise<LocatedNode[]> {
		return locateInOutline(scan(doc).nodes, selector);
	},

	async enclosing(doc: StructDocument, position: StructPosition): Promise<LocatedNode[]> {
		return enclosingInOutline(scan(doc).nodes, position);
	},

	async imports(doc: StructDocument): Promise<ImportExportInfo> {
		const lines = doc.text.split("\n");
		const imports: ImportExportInfo["imports"] = [];
		const limit = Math.min(lines.length, MAX_SCAN_LINES);
		for (let i = 0; i < limit; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			for (const pattern of IMPORT_PATTERNS) {
				const match = pattern.exec(line);
				if (match?.[1]) {
					imports.push({ module: match[1], line: i + 1, form: "heuristic" });
					break;
				}
			}
		}
		const exports = flattenOutline(scan(doc).nodes)
			.filter((node) => node.exported)
			.map((node) => ({ name: node.symbolPath, kind: node.kind, line: node.startLine }));
		return { imports, exports };
	},

	explainLimitation(): string {
		return "Structure was inferred from text patterns, not parsed — treat names and ranges as approximate.";
	},
};

interface ScanResult {
	nodes: RichOutlineNode[];
	truncated: boolean;
}

/**
 * Build an outline from indentation + line patterns.
 *
 * End lines are the hard part without a parser: a declaration is treated as running
 * until the next line at the same or shallower indentation. That is right for
 * well-formatted code and wrong for one-liners, which is exactly the kind of
 * imprecision `explainLimitation` warns about.
 */
function scan(doc: StructDocument): ScanResult {
	const lines = doc.text.split("\n");
	const limit = Math.min(lines.length, MAX_SCAN_LINES);

	interface Candidate {
		node: RichOutlineNode;
		indent: number;
	}
	const roots: RichOutlineNode[] = [];
	const stack: Candidate[] = [];
	let emitted = 0;
	let truncated = limit < lines.length;

	// Running UTF-16 offset so heuristic nodes carry the same index contract as
	// parsed ones; `extract` slices by index regardless of which provider answered.
	const lineStart: number[] = new Array(limit);
	let offset = 0;
	for (let i = 0; i < limit; i++) {
		lineStart[i] = offset;
		offset += (lines[i]?.length ?? 0) + 1;
	}

	for (let i = 0; i < limit; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		if (line.trim().length === 0) continue;

		const indent = countIndent(line);

		// Close every open declaration this line has dedented out of.
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (!top || indent > top.indent) break;
			top.node.endLine = Math.max(top.node.startLine, i);
			top.node.endIndex = lineStart[i] ?? top.node.endIndex;
			stack.pop();
		}

		if (emitted >= MAX_NODES) {
			truncated = true;
			break;
		}

		const match = matchDeclaration(line);
		if (!match) continue;

		const parent = stack[stack.length - 1];
		const symbolPath = parent ? `${parent.node.symbolPath}.${match.name}` : match.name;
		const node: RichOutlineNode = {
			kind: match.kind,
			name: match.name,
			symbolPath,
			startLine: i + 1,
			endLine: i + 1,
			startIndex: lineStart[i] ?? 0,
			endIndex: (lineStart[i] ?? 0) + line.length,
			depth: stack.length,
			exported: /^\s*(?:export|pub\b|public\b)/.test(line) || isConventionallyPublic(match.name),
		};
		emitted++;

		if (parent) {
			parent.node.children ??= [];
			parent.node.children.push(node);
		} else {
			roots.push(node);
		}
		stack.push({ node, indent });
	}

	// Anything still open runs to the end of the scanned region.
	const lastLine = limit;
	const endOffset = doc.text.length;
	for (const entry of stack) {
		entry.node.endLine = Math.max(entry.node.startLine, lastLine);
		entry.node.endIndex = endOffset;
	}

	return { nodes: roots, truncated };
}

function matchDeclaration(line: string): { kind: StructKind; name: string } | null {
	for (const pattern of PATTERNS) {
		const match = pattern.regex.exec(line);
		const name = match?.[pattern.nameGroup];
		if (!name) continue;
		// Filter out control-flow keywords that the loose method pattern would
		// otherwise report as methods named `if`/`for`/`while`.
		if (KEYWORD_BLOCKLIST.has(name)) continue;
		return { kind: pattern.kind, name };
	}
	return null;
}

const KEYWORD_BLOCKLIST = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"try",
	"do",
	"else",
	"return",
	"case",
	"with",
	"new",
	"delete",
	"typeof",
	"await",
	"yield",
	"throw",
]);

function countIndent(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char === " ") count += 1;
		else if (char === "\t") count += 4;
		else break;
	}
	return count;
}

/** Go/Java-ish convention: an initial capital usually means exported. */
function isConventionallyPublic(name: string): boolean {
	const first = name[0];
	return first !== undefined && /[A-Z]/.test(first);
}
