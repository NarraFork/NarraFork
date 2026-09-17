import {
	type FileReference,
	type FileReferenceCandidate,
	type FileReferenceEditorSelection,
	type FileSelection,
	fileTargetKey,
	MAX_FILE_REFERENCE_COUNT,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_QUERY_CHARS,
	MAX_FILE_REFERENCE_SEARCH_RESULTS,
} from "@shared/file-reference";

export interface FileReferenceInput {
	text: string;
	fileReferences: FileReference[];
}

export interface FileReferenceQuery {
	start: number;
	end: number;
	q: string;
	search: string;
	selection?: FileSelection;
	error?: "invalidRange" | "queryTooLong";
}

const BOUNDARY = /[\s([,{:;!?，。！？、（【「《]/u;
const encoder = new TextEncoder();

function inCode(value: string): boolean {
	let fence: { char: string; length: number } | null = null;
	let inline = 0;
	for (const rawLine of value.split("\n")) {
		const line = rawLine.replace(/^ {0,3}(?:> ?)+/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker && !inline) {
			if (!fence) fence = { char: marker[1][0], length: marker[1].length };
			else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
				fence = null;
			continue;
		}
		if (fence) continue;
		for (const match of line.matchAll(/`+/g)) {
			if (match.index > 0 && line[match.index - 1] === "\\") continue;
			if (!inline) inline = match[0].length;
			else if (inline === match[0].length) inline = 0;
		}
	}
	return fence !== null || inline !== 0;
}

/** Only a fresh boundary token is a query. Hand-typed #file labels never register metadata. */
export function getFileReferenceQuery(
	value: string,
	caret: number,
	references: readonly FileReference[] = [],
): FileReferenceQuery | null {
	if (caret <= 0 || caret > value.length) return null;
	const start = value.lastIndexOf("#", caret - 1);
	if (start < 0 || (start > 0 && !BOUNDARY.test(value[start - 1]))) return null;
	if (
		references.some(
			(ref) => ref.inputRange && start >= ref.inputRange[0] && start < ref.inputRange[1],
		)
	)
		return null;
	const q = value.slice(start + 1, caret);
	if (/^[\s#]|[\r\n#`]|\s@/u.test(q) || q.startsWith("file:")) return null;
	// Exclude URL fragments, markdown local anchors, and fenced/inline code.
	const wordStart = value.slice(0, start).search(/\S*$/u);
	const prefix = value.slice(wordStart, start);
	if (/(?:[a-z][a-z\d+.-]*:|\]\()$/iu.test(prefix) || prefix.includes("://")) return null;
	if (inCode(value.slice(0, start))) return null;
	const result: FileReferenceQuery = { start, end: caret, q, search: q };
	if (q.length > MAX_FILE_REFERENCE_QUERY_CHARS) return { ...result, error: "queryTooLong" };
	const lines = /:(\d+)(?:-(\d*))?$/.exec(q);
	if (!lines) return result;
	const first = Number(lines[1]);
	const last = lines[2] === undefined ? first : Number(lines[2]);
	if (
		!Number.isSafeInteger(first) ||
		!Number.isSafeInteger(last + 1) ||
		first < 1 ||
		last < first
	) {
		return { ...result, error: "invalidRange" };
	}
	return {
		...result,
		search: q.slice(0, lines.index),
		selection: { startLineNumber: first, startColumn: 1, endLineNumber: last + 1, endColumn: 1 },
	};
}

function boundedString(value: unknown): value is string {
	if (typeof value !== "string" || !value.length || value.length > MAX_FILE_REFERENCE_PATH_CHARS)
		return false;
	// Paths/labels must be one visible token, never control characters or a multiline label.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	return true;
}

function readSelection(value: unknown): FileSelection {
	if (!value || typeof value !== "object") throw new Error("Invalid file selection");
	const item = value as FileSelection;
	const { startLineNumber, startColumn, endLineNumber, endColumn } = item;
	if (
		![startLineNumber, startColumn, endLineNumber, endColumn].every(
			(n) => Number.isSafeInteger(n) && n >= 1,
		) ||
		endLineNumber < startLineNumber ||
		(endLineNumber === startLineNumber && endColumn < startColumn)
	)
		throw new Error("Invalid file selection");
	return { startLineNumber, startColumn, endLineNumber, endColumn };
}

export function fileReferenceToken(reference: FileReference): string {
	const selection = reference.selection;
	if (!selection) return `#file:${reference.label}`;
	const endLine =
		selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
			? selection.endLineNumber - 1
			: selection.endLineNumber;
	return `#file:${reference.label}:${selection.startLineNumber}-${endLine}`;
}

/** Copy the allowlisted client metadata only. Reject budgets rather than silently taking a prefix. */
export function copyFileReferences(value: unknown, text?: string): FileReference[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_FILE_REFERENCE_COUNT)
		throw new Error("Too many file references");
	const ids = new Set<string>();
	const references = value.map((item: unknown): FileReference => {
		if (!item || typeof item !== "object") throw new Error("Invalid file reference");
		const ref = item as FileReference;
		if (
			!boundedString(ref.id) ||
			!boundedString(ref.deviceId) ||
			!boundedString(ref.path) ||
			!boundedString(ref.label) ||
			ids.has(ref.id)
		)
			throw new Error("Invalid file reference metadata");
		ids.add(ref.id);
		const copy: FileReference = {
			id: ref.id,
			deviceId: ref.deviceId,
			path: ref.path,
			label: ref.label,
		};
		if (ref.selection !== undefined) copy.selection = readSelection(ref.selection);
		if (ref.expectedHash !== undefined) {
			if (!boundedString(ref.expectedHash)) throw new Error("Invalid saved-file hash");
			copy.expectedHash = ref.expectedHash;
		}
		if (ref.inputRange !== undefined) {
			if (!Array.isArray(ref.inputRange) || ref.inputRange.length !== 2)
				throw new Error("Invalid input range");
			const [start, end] = ref.inputRange;
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end <= start ||
				(text !== undefined &&
					(end > text.length || text.slice(start, end) !== fileReferenceToken(copy)))
			)
				throw new Error("Invalid input range");
			copy.inputRange = [start, end];
		}
		return copy;
	});
	if (encoder.encode(JSON.stringify(references)).byteLength > MAX_FILE_REFERENCE_METADATA_BYTES)
		throw new Error("File reference metadata exceeds the limit");
	return references;
}

/** Legacy/corrupt persisted metadata must not crash hydration or turn arbitrary text into a file. */
export function readFileReferences(value: unknown, text?: string): FileReference[] {
	try {
		return copyFileReferences(value, text);
	} catch {
		return [];
	}
}

export function sameFileReferenceInput(a: FileReferenceInput, b: FileReferenceInput): boolean {
	return a.text === b.text && JSON.stringify(a.fileReferences) === JSON.stringify(b.fileReferences);
}

/** A single browser edit moves disjoint tokens and invalidates every touched occurrence. */
export function editFileReferenceInput(
	input: FileReferenceInput,
	text: string,
	selection?: { start: number; end: number },
): FileReferenceInput {
	if (text === input.text) return input;
	let start = 0;
	let end = input.text.length;
	let nextEnd = text.length;
	// Use the actual selection for identical/repeated text, where a text diff alone is ambiguous.
	const insertedLength = selection
		? text.length - input.text.length + selection.end - selection.start
		: -1;
	if (
		selection &&
		insertedLength >= 0 &&
		input.text.slice(0, selection.start) === text.slice(0, selection.start) &&
		input.text.slice(selection.end) === text.slice(selection.start + insertedLength)
	) {
		start = selection.start;
		end = selection.end;
		nextEnd = start + insertedLength;
	} else {
		while (start < end && start < nextEnd && input.text[start] === text[start]) start++;
		while (end > start && nextEnd > start && input.text[end - 1] === text[nextEnd - 1]) {
			end--;
			nextEnd--;
		}
	}
	const delta = nextEnd - end;
	const fileReferences = input.fileReferences.flatMap((ref): FileReference[] => {
		if (!ref.inputRange) return [ref];
		const [a, b] = ref.inputRange;
		if (end <= a) return [{ ...ref, inputRange: [a + delta, b + delta] }];
		if (start >= b) return [ref];
		return [];
	});
	return { text, fileReferences };
}

/** Trim the two edges separately: a single broad diff could swallow otherwise intact tokens. */
export function trimFileReferenceInput(input: FileReferenceInput): FileReferenceInput {
	const leftTrimmed = editFileReferenceInput(input, input.text.trimStart());
	return editFileReferenceInput(leftTrimmed, leftTrimmed.text.trimEnd());
}

export function createFileReferenceId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `file-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

export function insertFileReference(
	input: FileReferenceInput,
	reference: FileReference,
	range: [number, number] = [input.text.length, input.text.length],
): FileReferenceInput & { caret: number } {
	const [start, end] = range;
	if (start < 0 || end < start || end > input.text.length)
		throw new Error("Invalid insertion range");
	const ref = copyFileReferences([{ ...reference, inputRange: undefined }])[0];
	if (input.fileReferences.some((item) => item.id === ref.id)) ref.id = createFileReferenceId();
	const leading = start > 0 && !/\s/u.test(input.text[start - 1]) ? " " : "";
	const token = fileReferenceToken(ref);
	const insert = `${leading}${token} `;
	const next = editFileReferenceInput(
		input,
		input.text.slice(0, start) + insert + input.text.slice(end),
		{ start, end },
	);
	ref.inputRange = [start + leading.length, start + leading.length + token.length];
	return {
		...next,
		fileReferences: copyFileReferences([...next.fileReferences, ref], next.text),
		caret: start + insert.length,
	};
}

export function savedSelectionReference(
	selection: FileReferenceEditorSelection | null | undefined,
): FileReference | null {
	if (!selection || selection.dirty || !selection.expectedHash || !selection.target.selection)
		return null;
	const range = selection.target.selection;
	if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn)
		return null;
	return (
		readFileReferences([
			{
				...selection.target,
				id: createFileReferenceId(),
				label: selection.label,
				expectedHash: selection.expectedHash,
			},
		])[0] ?? null
	);
}

export type FileReferenceKeyAction = "next" | "previous" | "select" | "close";
export function fileReferenceKeyAction(
	event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode" | "shiftKey">,
): FileReferenceKeyAction | null {
	if (event.isComposing || event.keyCode === 229) return null;
	if (event.key === "ArrowDown") return "next";
	if (event.key === "ArrowUp") return "previous";
	if (event.key === "Escape") return "close";
	if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") return "select";
	return null;
}

/** Process-local, globally bounded cache. Scope includes user, narrator, device AND cwd. No bodies. */
const recentFiles = new Map<string, FileReferenceCandidate[]>();
const MAX_RECENT_SCOPES = 8;
export function rememberFileReference(scope: string, reference: FileReference): void {
	const clean = copyFileReferences([reference])[0];
	const candidate: FileReferenceCandidate = {
		deviceId: clean.deviceId,
		path: clean.path,
		name: clean.path.split(/[\\/]/).pop() ?? clean.label,
		relativePath: clean.label,
		isDirectory: false,
	};
	const list = [
		candidate,
		...(recentFiles.get(scope) ?? []).filter(
			(item) => fileTargetKey(item) !== fileTargetKey(candidate),
		),
	].slice(0, MAX_FILE_REFERENCE_SEARCH_RESULTS);
	while (encoder.encode(JSON.stringify(list)).byteLength > MAX_FILE_REFERENCE_METADATA_BYTES)
		list.pop();
	recentFiles.delete(scope);
	recentFiles.set(scope, list);
	while (recentFiles.size > MAX_RECENT_SCOPES) {
		const oldest = recentFiles.keys().next().value;
		if (oldest !== undefined) recentFiles.delete(oldest);
	}
}

export function recentFileReferences(scope: string): FileReferenceCandidate[] {
	return (recentFiles.get(scope) ?? []).map((item) => ({ ...item }));
}
