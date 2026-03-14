import { resolve } from "node:path";
import { z } from "zod/v4";
import { ensureFileSnapshot } from "../../../services/file-snapshot-service";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText, writeFileText } from "./encoding";

// ── Replacer types & implementations ────────────────────────────
// Sourced from opencode's cascading replacer approach:
// https://github.com/cline/cline  &  https://github.com/google-gemini/gemini-cli

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

/** 1. Exact match — just yield the search string itself */
export const SimpleReplacer: Replacer = function* (_content, find) {
	yield find;
};

/** 2. Line-trimmed — compare lines after trimming, yield original text */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines.at(-1) === "") searchLines.pop();

	for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (originalLines[i + j].trim() !== searchLines[j].trim()) {
				matches = false;
				break;
			}
		}
		if (matches) {
			let start = 0;
			for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
			let end = start;
			for (let k = 0; k < searchLines.length; k++) {
				end += originalLines[i + k].length;
				if (k < searchLines.length - 1) end += 1;
			}
			yield content.substring(start, end);
		}
	}
};

// ── Levenshtein distance ────────────────────────────────────────

function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);
	const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}
	return matrix[a.length][b.length];
}

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

/** 3. Block-anchor — match first/last lines, score middle via Levenshtein */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines.length < 3) return;
	if (searchLines.at(-1) === "") searchLines.pop();

	const firstTrimmed = searchLines[0].trim();
	const lastTrimmed = searchLines.at(-1)?.trim() ?? "";
	const searchBlockSize = searchLines.length;

	const candidates: { startLine: number; endLine: number }[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (originalLines[i].trim() !== firstTrimmed) continue;
		for (let j = i + 2; j < originalLines.length; j++) {
			if (originalLines[j].trim() === lastTrimmed) {
				candidates.push({ startLine: i, endLine: j });
				break;
			}
		}
	}
	if (candidates.length === 0) return;

	function calcSimilarity(startLine: number, endLine: number): number {
		const actualBlockSize = endLine - startLine + 1;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck <= 0) return 1.0;
		let similarity = 0;
		for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
			const origLine = originalLines[startLine + j].trim();
			const searchLine = searchLines[j].trim();
			const maxLen = Math.max(origLine.length, searchLine.length);
			if (maxLen === 0) continue;
			const distance = levenshtein(origLine, searchLine);
			similarity += (1 - distance / maxLen) / linesToCheck;
		}
		return similarity;
	}

	function extractSubstring(startLine: number, endLine: number): string {
		let start = 0;
		for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1;
		let end = start;
		for (let k = startLine; k <= endLine; k++) {
			end += originalLines[k].length;
			if (k < endLine) end += 1;
		}
		return content.substring(start, end);
	}

	if (candidates.length === 1) {
		const { startLine, endLine } = candidates[0];
		if (calcSimilarity(startLine, endLine) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
			yield extractSubstring(startLine, endLine);
		}
		return;
	}

	let bestMatch: (typeof candidates)[0] | null = null;
	let maxSim = -1;
	for (const c of candidates) {
		const sim = calcSimilarity(c.startLine, c.endLine);
		if (sim > maxSim) {
			maxSim = sim;
			bestMatch = c;
		}
	}
	if (maxSim >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
		yield extractSubstring(bestMatch.startLine, bestMatch.endLine);
	}
};

/** 4. Whitespace-normalized — collapse whitespace before comparing */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
	const normalize = (t: string) => t.replace(/\s+/g, " ").trim();
	const normalizedFind = normalize(find);
	const lines = content.split("\n");

	// Single-line matches
	for (const line of lines) {
		if (normalize(line) === normalizedFind) {
			yield line;
		} else {
			const normalizedLine = normalize(line);
			if (normalizedLine.includes(normalizedFind)) {
				const words = find
					.trim()
					.split(/\s+/)
					.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
				if (words.length > 0) {
					try {
						const match = line.match(new RegExp(words.join("\\s+")));
						if (match) yield match[0];
					} catch {
						/* invalid regex, skip */
					}
				}
			}
		}
	}

	// Multi-line matches
	const findLines = find.split("\n");
	if (findLines.length > 1) {
		for (let i = 0; i <= lines.length - findLines.length; i++) {
			const block = lines.slice(i, i + findLines.length);
			if (normalize(block.join("\n")) === normalizedFind) {
				yield block.join("\n");
			}
		}
	}
};

/** 5. Indentation-flexible — strip common indent before comparing */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
	const removeIndentation = (text: string) => {
		const lines = text.split("\n");
		const nonEmpty = lines.filter((l) => l.trim().length > 0);
		if (nonEmpty.length === 0) return text;
		const minIndent = Math.min(
			...nonEmpty.map((l) => {
				const m = l.match(/^(\s*)/);
				return m ? m[1].length : 0;
			}),
		);
		return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n");
	};

	const normalizedFind = removeIndentation(find);
	const contentLines = content.split("\n");
	const findLines = find.split("\n");

	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (removeIndentation(block) === normalizedFind) {
			yield block;
		}
	}
};

/** 6. Escape-normalized — handle common escape sequences */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
	const unescapeStr = (str: string): string =>
		str.replace(
			/\\(n|t|r|'|"|`|\\|\n|\$)/g,
			(match, ch: string) =>
				({
					n: "\n",
					t: "\t",
					r: "\r",
					"'": "'",
					'"': '"',
					"`": "`",
					"\\": "\\",
					"\n": "\n",
					$: "$",
				})[ch] ?? match,
		);

	const unescapedFind = unescapeStr(find);
	if (content.includes(unescapedFind)) yield unescapedFind;

	const lines = content.split("\n");
	const findLines = unescapedFind.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (unescapeStr(block) === unescapedFind) yield block;
	}
};

/** 7. Trimmed-boundary — trim the entire find string */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
	const trimmed = find.trim();
	if (trimmed === find) return; // already trimmed, nothing new to try

	if (content.includes(trimmed)) yield trimmed;

	const lines = content.split("\n");
	const findLines = find.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		if (block.trim() === trimmed) yield block;
	}
};

/** 8. Context-aware — anchor on first/last lines, require 50% middle match */
export const ContextAwareReplacer: Replacer = function* (content, find) {
	const findLines = find.split("\n");
	if (findLines.length < 3) return;
	if (findLines.at(-1) === "") findLines.pop();

	const contentLines = content.split("\n");
	const firstLine = findLines[0].trim();
	const lastLine = findLines.at(-1)?.trim() ?? "";

	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstLine) continue;
		for (let j = i + 2; j < contentLines.length; j++) {
			if (contentLines[j].trim() === lastLine) {
				const blockLines = contentLines.slice(i, j + 1);
				if (blockLines.length === findLines.length) {
					let matching = 0;
					let total = 0;
					for (let k = 1; k < blockLines.length - 1; k++) {
						const bl = blockLines[k].trim();
						const fl = findLines[k].trim();
						if (bl.length > 0 || fl.length > 0) {
							total++;
							if (bl === fl) matching++;
						}
					}
					if (total === 0 || matching / total >= 0.5) {
						yield blockLines.join("\n");
						return; // first match only
					}
				}
				break;
			}
		}
	}
};

/** 9. Multi-occurrence — yield every exact match position */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
	let idx = 0;
	while (true) {
		const pos = content.indexOf(find, idx);
		if (pos === -1) break;
		yield find;
		idx = pos + find.length;
	}
};

// ── Ordered replacer chain ──────────────────────────────────────

const REPLACERS: Replacer[] = [
	SimpleReplacer,
	LineTrimmedReplacer,
	BlockAnchorReplacer,
	WhitespaceNormalizedReplacer,
	IndentationFlexibleReplacer,
	EscapeNormalizedReplacer,
	TrimmedBoundaryReplacer,
	ContextAwareReplacer,
	MultiOccurrenceReplacer,
];

// ── Core replace function ───────────────────────────────────────

export interface ReplaceResult {
	content: string;
	/** 1-based line number where the first replacement occurred */
	startLine: number;
}

export function replace(
	content: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): ReplaceResult {
	if (oldString === newString) {
		throw new Error("No changes to apply: old_string and new_string are identical.");
	}

	let notFound = true;

	for (const replacer of REPLACERS) {
		for (const search of replacer(content, oldString)) {
			const index = content.indexOf(search);
			if (index === -1) continue;
			notFound = false;
			const startLine = content.substring(0, index).split("\n").length;
			if (replaceAll) {
				return { content: content.replaceAll(search, newString), startLine };
			}
			const lastIndex = content.lastIndexOf(search);
			if (index !== lastIndex) continue; // not unique via this replacer, try next
			return {
				content: content.substring(0, index) + newString + content.substring(index + search.length),
				startLine,
			};
		}
	}

	if (notFound) {
		throw new Error(
			"old_string not found in the file. It must match exactly, including whitespace, indentation, and line endings.",
		);
	}
	throw new Error(
		"Found multiple matches for old_string. Provide more surrounding context to make the match unique, or use replace_all.",
	);
}

// ── Normalize CRLF ─────────────────────────────────────────────

function normalizeLineEndings(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

// ── Tool definition ─────────────────────────────────────────────

export const editTool: ToolDefinition = {
	name: "Edit",
	description:
		"Performs exact string replacements in files.\n\n" +
		"Usage:\n" +
		"- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n" +
		"- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n" +
		"- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n" +
		"- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n" +
		"- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n" +
		"- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.",
	rawJsonSchema: {
		type: "object",
		properties: {
			file_path: {
				description: "The absolute path to the file to modify",
				type: "string",
			},
			old_string: {
				description: "The text to replace",
				type: "string",
			},
			new_string: {
				description: "The text to replace it with (must be different from old_string)",
				type: "string",
			},
			replace_all: {
				description: "Replace all occurrences of old_string (default false)",
				default: false,
				type: "boolean",
			},
		},
		required: ["file_path", "old_string", "new_string"],
		additionalProperties: false,
	},
	parameters: z.object({
		file_path: z.string().describe("The absolute path to the file to modify"),
		old_string: z.string().describe("The text to replace"),
		new_string: z
			.string()
			.describe("The text to replace it with (must be different from old_string)"),
		replace_all: z
			.boolean()
			.optional()
			.describe("Replace all occurrences of old_string (default false)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { file_path, old_string, new_string, replace_all } = args as {
			file_path: string;
			old_string: string;
			new_string: string;
			replace_all?: boolean;
		};

		const resolvedPath = resolve(ctx.cwd, file_path);

		try {
			// Guard: identical strings
			if (old_string === new_string) {
				return {
					output: "No changes to apply: old_string and new_string are identical.",
					isError: true,
				};
			}

			// Record original content before editing (non-fatal)
			await ensureFileSnapshot(ctx.narratorId, file_path, async () => {
				try {
					const file = Bun.file(resolvedPath);
					if (await file.exists()) {
						return (await readFileText(resolvedPath)).text;
					}
				} catch {
					// File doesn't exist or can't be read
				}
				return null;
			});

			// Create-new-file mode: old_string is empty
			if (old_string === "") {
				await writeFileText(resolvedPath, new_string);
				return {
					output: `Created/overwritten ${file_path}`,
					title: file_path,
				};
			}

			const file = Bun.file(resolvedPath);
			const exists = await file.exists();
			if (!exists) {
				return {
					output: `File not found: ${file_path}`,
					isError: true,
				};
			}

			const { text: rawContent, encoding } = await readFileText(resolvedPath);
			const content = normalizeLineEndings(rawContent);
			const normalizedOld = normalizeLineEndings(old_string);
			const normalizedNew = normalizeLineEndings(new_string);

			const result = replace(content, normalizedOld, normalizedNew, replace_all);
			await writeFileText(resolvedPath, result.content, encoding);
			const oldLines = normalizedOld.split("\n").length;
			const newLines = normalizedNew.split("\n").length;
			return {
				output: `Edited ${file_path}`,
				title: file_path,
				metadata: {
					startLine: result.startLine,
					endLine: result.startLine + oldLines - 1,
					newEndLine: result.startLine + newLines - 1,
				},
			};
		} catch (err) {
			return {
				output: `Error editing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
