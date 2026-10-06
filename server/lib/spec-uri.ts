/** Pure Dynamic Spec path validation. Never resolve a backend or touch the filesystem here. */
export const SPEC_URI_PREFIX = "spec://";
const MAX_SPEC_PATH_CHARS = 240;

export function isSpecUri(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(SPEC_URI_PREFIX);
}

/** Reserve scheme-shaped segments, not ordinary colon filenames such as spec:notes.txt. */
function hasSpecSchemeShape(value: string): boolean {
	return /(?:^|[\\/\s:"'`([{])spec\s*:\s*[\\/]/i.test(value);
}

function malformedSpecUri(): Error {
	return new Error(
		"Invalid spec:// URI. Use spec://path directly, without filesystem prefixes, whitespace, or backslashes; paths are not auto-corrected.",
	);
}

/** VFS compatibility: also accepts a namespace-relative filename (used by the UI/store). */
export function normalizeSpecPath(input: string): string {
	const uri = input.startsWith(SPEC_URI_PREFIX);
	if (hasSpecSchemeShape(input) && !uri) throw malformedSpecUri();
	if (uri && /[\s\\]/.test(input)) throw malformedSpecUri();
	let path = uri ? input.slice(SPEC_URI_PREFIX.length) : input.trim();
	path = path.replace(/^\/+/, "");
	try {
		path = decodeURIComponent(path);
	} catch {
		// Invalid escapes fail the segment alphabet check below.
	}
	if (uri && /[\s\\]/.test(path)) throw malformedSpecUri();
	path = path.replace(/\\/g, "/");
	if (!path) throw new Error("spec:// path must not be empty");
	if (path.length > MAX_SPEC_PATH_CHARS) {
		throw new Error(`spec:// path must be at most ${MAX_SPEC_PATH_CHARS} characters`);
	}
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error("spec:// path must not contain empty, '.', or '..' segments");
	}
	if (!parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part))) {
		throw new Error("spec:// path segments may only contain letters, numbers, '.', '_', and '-'");
	}
	return parts.join("/");
}

/** Validate the raw spelling BEFORE any path normalization, permission shortcut or IO. */
export function assertSpecPath(
	value: unknown,
	options: { supported?: boolean; allowRoot?: boolean } = {},
): void {
	if (typeof value !== "string") return;
	if (!isSpecUri(value)) {
		if (hasSpecSchemeShape(value)) throw malformedSpecUri();
		return;
	}
	if (!options.supported) {
		throw new Error(
			"This tool/path does not support spec:// virtual files. Use Read/Write/Edit/Grep.",
		);
	}
	if (options.allowRoot && value === SPEC_URI_PREFIX) return;
	normalizeSpecPath(value);
}

const SPEC_FILE_TOOLS = new Set(["Read", "Write", "Edit", "ExitPlanMode"]);

/** Only path fields are inspected; contents, regexes and shell commands may mention any URI. */
export function assertToolSpecPaths(toolName: string, input: Record<string, unknown>): void {
	if (SPEC_FILE_TOOLS.has(toolName) || toolName === "StructView" || toolName === "StructSed") {
		assertSpecPath(input.file_path, { supported: SPEC_FILE_TOOLS.has(toolName) });
	}
	if (toolName === "Grep" || toolName === "Glob") {
		assertSpecPath(input.path, { supported: toolName === "Grep", allowRoot: toolName === "Grep" });
	}
	// Glob's pattern is a path pattern too; Grep's pattern is content, not a path.
	if (toolName === "Glob") assertSpecPath(input.pattern);
}

export function toolSpecPathError(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	try {
		assertToolSpecPaths(toolName, input);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
