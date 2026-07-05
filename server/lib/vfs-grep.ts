/**
 * A minimal, VFS-agnostic grep over an in-memory list of files.
 *
 * This is the search engine behind grepping virtual paths (e.g. the `spec://`
 * Living Work Spec files) where there is no real filesystem for ripgrep to walk.
 * It operates on an already-materialized `{ path, uri, content }[]` list, so it
 * has no dependency on any particular VFS backend and is easy to unit test.
 *
 * Feature set is intentionally small (mirrors what the Grep tool exposes for
 * virtual paths):
 *   - JavaScript regex matching (`i` for case-insensitive, `s` for multiline)
 *   - output modes: content | files_with_matches | count
 *   - optional line numbers (content mode)
 *   - optional path-prefix filter and simple `*` / `**` glob filter
 *   - head_limit + offset pagination
 *
 * NOT supported (by design): context lines (-A/-B/-C), file-type filters, and
 * encoding detection. Those belong to the ripgrep-backed real-file path.
 */

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a path against a simple glob supporting `*` (any run of non-slash
 * characters) and `**` (any characters, including slashes). Anchored to the
 * full path. An empty/undefined pattern matches everything.
 */
export function matchesSimpleGlob(path: string, globPattern?: string): boolean {
	if (!globPattern) return true;
	const regex = new RegExp(
		`^${escapeRegex(globPattern)
			.replace(/\\\*\\\*/g, ".*")
			.replace(/\\\*/g, "[^/]*")}$`,
	);
	return regex.test(path);
}

export type VfsGrepOutputMode = "content" | "files_with_matches" | "count";

/** A single virtual file to search. `uri` is what appears in output lines. */
export interface VfsGrepFile {
	/** Path within the virtual filesystem, e.g. "notes.md" or "sub/a.md". */
	path: string;
	/** Fully-qualified URI shown in results, e.g. "spec://notes.md". */
	uri: string;
	/** File content to search. */
	content: string;
}

export interface VfsGrepOptions {
	/** JavaScript regular expression source. */
	pattern: string;
	/**
	 * Restrict to files whose path equals this prefix or lives beneath it
	 * (`prefix` or `prefix/...`). Already normalized (no scheme, no leading `/`).
	 */
	pathPrefix?: string;
	/** Simple glob filter against the file path (see matchesSimpleGlob). */
	glob?: string;
	/** Defaults to "files_with_matches". */
	outputMode?: VfsGrepOutputMode;
	/** Prefix each content-mode match with its 1-based line number. Default true. */
	showLineNumbers?: boolean;
	/** Case-insensitive matching (regex `i` flag). */
	caseInsensitive?: boolean;
	/**
	 * Treat each file as a single unit and match across newlines (regex `s`
	 * flag). A matching file yields one result line.
	 */
	multiline?: boolean;
	/** Limit the number of result lines (0 = unlimited). */
	headLimit?: number;
	/** Skip this many result lines before applying headLimit. */
	offset?: number;
}

/**
 * Result shape. Structurally compatible with the agent `ToolResult` so callers
 * can return it directly, but this module stays free of agent-layer imports.
 */
export interface VfsGrepResult {
	output: string;
	isError?: boolean;
	title: string;
	metadata: { matches: number; truncated: boolean };
}

/** Filter a file list by an optional normalized path prefix + optional glob. */
function filterFiles(files: VfsGrepFile[], pathPrefix?: string, glob?: string): VfsGrepFile[] {
	let result = files;
	if (pathPrefix) {
		result = result.filter(
			(file) => file.path === pathPrefix || file.path.startsWith(`${pathPrefix}/`),
		);
	}
	return result.filter((file) => matchesSimpleGlob(file.path, glob));
}

/** Grep an in-memory list of virtual files. Pure and synchronous. */
export function vfsGrep(files: VfsGrepFile[], options: VfsGrepOptions): VfsGrepResult {
	const {
		pattern,
		pathPrefix,
		glob,
		outputMode = "files_with_matches",
		showLineNumbers = true,
		caseInsensitive = false,
		multiline = false,
		headLimit = 0,
		offset = 0,
	} = options;

	let regex: RegExp;
	try {
		regex = new RegExp(pattern, `${caseInsensitive ? "i" : ""}${multiline ? "s" : ""}`);
	} catch (err) {
		return {
			output: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			title: pattern,
			metadata: { matches: 0, truncated: false },
		};
	}

	const candidates = filterFiles(files, pathPrefix, glob);

	const lines: string[] = [];
	for (const file of candidates) {
		if (multiline) {
			// `test` advances lastIndex on global regexes; reset so reuse is safe.
			const matched = regex.test(file.content);
			regex.lastIndex = 0;
			if (!matched) continue;
			if (outputMode === "files_with_matches") lines.push(file.uri);
			else if (outputMode === "count") lines.push(`${file.uri}:1`);
			else lines.push(`${file.uri}:1:${file.content.split("\n")[0] ?? ""}`);
			continue;
		}

		const fileLines = file.content.split(/\r?\n/);
		const matches: string[] = [];
		fileLines.forEach((line, index) => {
			const matched = regex.test(line);
			regex.lastIndex = 0;
			if (!matched) return;
			matches.push(showLineNumbers ? `${file.uri}:${index + 1}:${line}` : `${file.uri}:${line}`);
		});
		if (matches.length === 0) continue;
		if (outputMode === "files_with_matches") lines.push(file.uri);
		else if (outputMode === "count") lines.push(`${file.uri}:${matches.length}`);
		else lines.push(...matches);
	}

	let outputLines = lines;
	if (offset > 0) outputLines = outputLines.slice(offset);
	const truncated = headLimit > 0 && outputLines.length > headLimit;
	if (headLimit > 0) outputLines = outputLines.slice(0, headLimit);

	if (outputLines.length === 0) {
		return {
			output: "No matches found",
			title: pattern,
			metadata: { matches: 0, truncated: false },
		};
	}

	const suffix = truncated
		? `\n(Results limited to ${headLimit} entries. ${lines.length - offset - headLimit} more available.)`
		: "";
	return {
		output: outputLines.join("\n") + suffix,
		title: pattern,
		metadata: { matches: lines.length, truncated },
	};
}
