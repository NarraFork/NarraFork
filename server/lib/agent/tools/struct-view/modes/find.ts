/**
 * `find` — where in the repository is a symbol DECLARED.
 *
 * The mode exists because every other StructView mode needs a `file_path` first, so
 * the question that precedes all of them — "which file holds this?" — had to be
 * answered with grep. Grep answers a different question: it reports every line where
 * the characters appear, mixing the declaration in with its call sites, its mentions
 * in comments, and unrelated symbols that happen to share the name. On a common name
 * that is dozens of lines to read and the declaration is not marked among them.
 *
 * Two stages, the same shape `usages` already uses:
 *
 *   1. ripgrep narrows the repo to files that mention the name at all.
 *   2. each candidate is PARSED and only real declarations are kept.
 *
 * Stage 2 is what separates this from grep: a hit inside a comment or a string has no
 * declaration node, and a call site is not a declaration, so both drop out. What
 * survives is "this file declares that name", with its kind and line.
 */

import { extname } from "node:path";
import { resolveBackendPath } from "../../../execution/path-resolve";
import type { getToolBackend } from "../../../execution/tool-backend";
import {
	languageIdForExtension,
	type OutlineNode,
	resolveProvider,
	type StructDocument,
	type StructKind,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import { decodeFileBytes } from "../../encoding";
import {
	MAX_FIND_ROWS,
	MAX_USAGE_CANDIDATES,
	MAX_USAGE_FILE_BYTES,
	USAGE_GREP_MAX_BYTES,
	USAGE_GREP_TIMEOUT_MS,
} from "../constants";
import { clampOutput, withFooter } from "../render";

/**
 * Kind ordering for the result list.
 *
 * A type and a variable of the same name usually both exist (`const Foo` beside
 * `interface Foo`); the declaration the caller is looking for is almost always the
 * structural one, so those sort first rather than being buried under bindings.
 */
const KIND_RANK: Record<string, number> = {
	class: 0,
	interface: 1,
	struct: 1,
	type: 2,
	enum: 2,
	function: 3,
	method: 4,
	constructor: 4,
	namespace: 5,
	module: 5,
	property: 6,
	field: 6,
	variable: 7,
	constant: 7,
};

function rankOf(kind: StructKind | string): number {
	return KIND_RANK[kind] ?? 8;
}

interface Declaration {
	path: string;
	line: number;
	endLine: number;
	kind: StructKind;
	symbolPath: string;
	exported: boolean;
}

/**
 * The note that keeps this honest.
 *
 * Declaration matching is far more reliable than the name matching `usages` does —
 * these are real parsed declarations, not text hits — but it is still keyed on a NAME
 * within one repository, with no type resolution. Two unrelated `charge` declarations
 * are both correct answers to "what is declared as charge" and both get listed.
 */
const FIND_PRECISION_NOTE =
	"Matches are real parsed declarations, not text hits, so comments, strings and call " +
	"sites are excluded. Still name-based though: unrelated declarations sharing the name " +
	"are listed too, and a symbol produced by a macro or a dynamic re-export has no " +
	"declaration node to find.";

export async function runFind(
	args: Record<string, unknown>,
	io: {
		backend: ReturnType<typeof getToolBackend>;
		baseCwd: string;
		signal?: AbortSignal;
	},
): Promise<ToolResult> {
	const name = typeof args.symbol === "string" ? args.symbol.trim() : "";
	if (!name) {
		return {
			output:
				'mode=find needs a `symbol` — the name to locate (e.g. symbol: "resolveProvider"). ' +
				"It searches the whole repository, so no file_path is required.",
			isError: true,
		};
	}
	// A dotted path cannot be located this way: only the final segment is an identifier
	// that a declaration node carries, and silently searching for that would report a
	// match for `method` when the caller asked about `Class.method`.
	if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
		return {
			output:
				`"${name}" is not a plain identifier. mode=find locates a declaration by its own ` +
				"name, so pass the bare name (for `Class.method`, find the class, then run " +
				"mode=outline on the file it lives in).",
			isError: true,
		};
	}

	// Stage 1: narrow the repo to files that mention the name at all.
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
					"No search backend (ripgrep/grep) is available, so a repository-wide search cannot run.",
				isError: true,
			};
		}
		const decoded = new TextDecoder().decode(grepResult.stdoutBytes).trim();
		const all = decoded.length > 0 ? decoded.split(/\r?\n/) : [];
		candidatesCapped = grepResult.truncatedByBytes === true || all.length > MAX_USAGE_CANDIDATES;
		candidatePaths = all.slice(0, MAX_USAGE_CANDIDATES);
	} catch (err) {
		return {
			output: `Repository search failed: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}

	// Stage 2: parse each candidate, keep only declarations of that exact name.
	const declarations: Declaration[] = [];
	let unparsed = 0;
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
			const { text } = decodeFileBytes(read.bytes);
			const doc: StructDocument = {
				filePath: abs,
				text,
				languageId: languageIdForExtension(extname(abs)),
				...(io.signal ? { signal: io.signal } : {}),
			};
			const resolved = await resolveProvider(doc);
			if (!resolved) {
				unparsed++;
				continue;
			}
			// The path is built from nesting rather than read off the node: `symbolPath`
			// exists on the tree-sitter provider's richer node type, not on the OutlineNode
			// contract every provider implements, so relying on it would make the heuristic
			// provider's hits print as `undefined`.
			for (const found of collectMatches(await resolved.provider.outline(doc), name, [])) {
				declarations.push({ path: relPath, ...found });
			}
		} catch {
			skipped++;
		}
	}

	const notes: string[] = [FIND_PRECISION_NOTE];
	if (candidatesCapped) {
		notes.push(
			`Only the first ${MAX_USAGE_CANDIDATES} candidate files were parsed, so this list is a lower bound.`,
		);
	}
	if (unparsed > 0) {
		notes.push(
			`${unparsed} file(s) mention the name in a language with no installed grammar; declarations there cannot be seen.`,
		);
	}
	if (skipped > 0) {
		notes.push(`${skipped} file(s) could not be read or were too large.`);
	}

	if (declarations.length === 0) {
		return {
			output: withFooter(
				`find ${name}`,
				`No declaration of "${name}" found in ${candidatePaths.length} candidate file(s).\n` +
					"The name may only appear at call sites or in comments — mode=usages traces those.",
				notes,
			),
			title: `find ${name}`,
			metadata: { mode: "find", symbol: name, declarations: 0, precision: "structural" },
		};
	}

	// Exported declarations first, then structural kinds, then by path: the definition a
	// caller wants is nearly always the exported one.
	declarations.sort((a, b) => {
		if (a.exported !== b.exported) return a.exported ? -1 : 1;
		const rank = rankOf(a.kind) - rankOf(b.kind);
		if (rank !== 0) return rank;
		return a.path.localeCompare(b.path) || a.line - b.line;
	});

	const shown = declarations.slice(0, MAX_FIND_ROWS);
	const rows = shown.map((d) => {
		const scope = d.exported ? "exported " : "";
		const span = d.endLine > d.line ? `-${d.endLine}` : "";
		return `${displayPath(d.path, io.baseCwd)}:${d.line}${span}  ${scope}${d.kind} ${d.symbolPath}`;
	});
	if (declarations.length > shown.length) {
		rows.push(`… ${declarations.length - shown.length} more declaration(s) not shown.`);
	}

	const summary =
		declarations.length === 1
			? `1 declaration of ${name}`
			: `${declarations.length} declarations of ${name}`;

	return {
		output: withFooter(`find ${name}`, clampOutput(`${summary}\n\n${rows.join("\n")}`), notes),
		title: `find ${name}`,
		metadata: {
			mode: "find",
			symbol: name,
			declarations: declarations.length,
			files: new Set(declarations.map((d) => d.path)).size,
			candidates: candidatePaths.length,
			precision: "structural",
			...(candidatesCapped ? { candidatesCapped: true } : {}),
		},
	};
}

/**
 * Workspace-relative path when the file sits under the search root.
 *
 * The grep backend reports absolute paths. Printing 40 of them wastes most of each
 * row on a prefix the caller already knows, and a relative path is what a follow-up
 * call can paste straight into `file_path`. Anything outside the root keeps its
 * absolute form rather than growing a chain of `../`.
 */
function displayPath(path: string, baseCwd: string): string {
	const normalizedBase = baseCwd.replace(/[\\/]+$/, "");
	if (!normalizedBase) return path;
	const withSep = `${normalizedBase}/`;
	const withBackslash = `${normalizedBase}\\`;
	if (path.startsWith(withSep)) return path.slice(withSep.length);
	if (path.startsWith(withBackslash)) return path.slice(withBackslash.length);
	return path;
}

/**
 * Every declaration of `name` in the tree, with a dotted path built from nesting.
 *
 * Descends into children even after a match: a method may share its class's name, and
 * both are declarations worth reporting.
 */
function collectMatches(
	nodes: readonly OutlineNode[],
	name: string,
	ancestors: readonly string[],
): Omit<Declaration, "path">[] {
	const out: Omit<Declaration, "path">[] = [];
	for (const node of nodes) {
		const path = node.name ? [...ancestors, node.name] : ancestors;
		if (node.name === name) {
			out.push({
				line: node.startLine,
				endLine: node.endLine,
				kind: node.kind,
				symbolPath: path.join("."),
				exported: node.exported === true,
			});
		}
		if (node.children?.length) out.push(...collectMatches(node.children, name, path));
	}
	return out;
}
