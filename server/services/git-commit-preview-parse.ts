/**
 * Pure Git-output parsing for the commit preview, shared by the local Git
 * service and the remote-executor adapter so both backends answer identically.
 *
 * Every listing is `-z` (NUL-delimited): paths are then never quoted or
 * octal-escaped, and a record cut by an output budget is detectable and dropped
 * instead of surfacing as a phantom file.
 */
import {
	GIT_COMMIT_PREVIEW_MAX_FILES,
	GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES,
	GIT_COMMIT_SHA_PATTERN,
	type GitCommitDetail,
	type GitCommitFile,
	type GitCommitFileStatus,
} from "@shared/git-commit-preview";
import { AppError, GitError, ValidationError } from "../lib/errors";

/** Ten NUL-separated fields; the message body is last so it may contain anything but NUL. */
export const COMMIT_META_FORMAT =
	"--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B";
/** Metadata budget: the message cap plus headroom for the fixed fields. */
export const COMMIT_META_MAX_BYTES = GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES + 4096;

/** Options every commit-preview diff-tree invocation carries: no helpers, no colour. */
const DIFF_TREE_SAFE = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--no-relative",
	"--submodule=short",
	"--ignore-submodules=none",
	"-l1000",
];

/** Base/target revisions: first parent, or `--root` against the empty tree. */
function revisions(sha: string, base: string | null): string[] {
	return base ? [base, sha] : ["--root", sha];
}

/** `git` argv (after the executable) listing the changed files of a commit. */
export function commitListArgs(
	kind: "numstat" | "name-status",
	sha: string,
	base: string | null,
): string[] {
	return [
		"--literal-pathspecs",
		"diff-tree",
		"-r",
		"-M",
		"-z",
		"--no-commit-id",
		...DIFF_TREE_SAFE,
		`--${kind}`,
		...revisions(sha, base),
		"--",
	];
}

/** `git` argv producing the patch of exactly one file (plus its rename source). */
export function commitPatchArgs(
	sha: string,
	base: string | null,
	file: string,
	oldPath?: string,
): string[] {
	return [
		"--literal-pathspecs",
		"-c",
		"core.quotePath=false",
		"diff-tree",
		"-p",
		"-M",
		"--no-commit-id",
		...DIFF_TREE_SAFE,
		...revisions(sha, base),
		"--",
		...(oldPath && oldPath !== file ? [oldPath] : []),
		file,
	];
}

/** Drop a trailing partial record from a truncated NUL listing. */
export function rollbackToNul(output: string, truncated: boolean): string {
	if (!truncated) return output;
	const end = output.lastIndexOf("\0");
	return end === -1 ? "" : output.slice(0, end + 1);
}

export interface CommitMeta {
	sha: string;
	shortSha: string;
	parents: string[];
	authorName: string;
	authorEmail: string;
	authoredAt: string;
	committerName: string;
	committerEmail: string;
	committedAt: string;
	message: string;
	messageTruncated: boolean;
}

export function parseCommitMeta(raw: string, truncated: boolean): CommitMeta {
	const fields = raw.split("\0");
	if (fields.length < 10) throw new GitError("Git commit metadata is incomplete");
	const [sha, shortSha, parents, authorName, authorEmail, authoredAt] = fields;
	const [committerName, committerEmail, committedAt] = fields.slice(6, 9);
	const parentList = parents.trim() ? parents.trim().split(/\s+/) : [];
	if (!GIT_COMMIT_SHA_PATTERN.test(sha) || parentList.some((p) => !GIT_COMMIT_SHA_PATTERN.test(p)))
		throw new GitError("Invalid Git commit identity");
	const body = fields.slice(9).join("\0").replace(/\n+$/, "");
	const bytes = Buffer.from(body, "utf8");
	const messageTruncated = truncated || bytes.length > GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES;
	// Decode a complete UTF-8 prefix: never split a multibyte character at the cap.
	const message =
		bytes.length > GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES
			? new TextDecoder().decode(bytes.subarray(0, GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES), {
					stream: true,
				})
			: body;
	return {
		sha,
		shortSha: shortSha.trim(),
		parents: parentList,
		authorName,
		authorEmail,
		authoredAt,
		committerName,
		committerEmail,
		committedAt,
		message,
		messageTruncated,
	};
}

function statusOf(letter: string): GitCommitFileStatus {
	switch (letter[0]) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "typechange";
		case "U":
			return "unmerged";
		default:
			return "unknown";
	}
}

interface NameStatusRecord {
	status: GitCommitFileStatus;
	path: string;
	oldPath?: string;
}

export function parseNameStatusRecords(output: string): NameStatusRecord[] {
	// Always discard an unterminated field, even if the transport forgot its flag.
	const fields = output.slice(0, output.lastIndexOf("\0") + 1).split("\0");
	fields.pop();
	const records: NameStatusRecord[] = [];
	let i = 0;
	while (i < fields.length) {
		const letter = fields[i++];
		if (!letter || !/^[AMDRCTUXB][0-9]*$/.test(letter))
			throw new GitError("Invalid Git commit file record");
		const twoPaths = letter.startsWith("R") || letter.startsWith("C");
		if (i + (twoPaths ? 1 : 0) >= fields.length) break;
		const oldPath = twoPaths ? fields[i++] : undefined;
		const path = fields[i++];
		if (!path || (twoPaths && !oldPath)) throw new GitError("Invalid Git commit file path");
		records.push({ status: statusOf(letter), path, ...(oldPath ? { oldPath } : {}) });
	}
	return records;
}

/** Confirm an exact changed entry before producing any (possibly truncated) patch. */
export function requireCommitFile(
	output: string,
	truncated: boolean,
	file: string,
	oldPath?: string,
): NameStatusRecord {
	const record = parseNameStatusRecords(output).find((entry) => entry.path === file);
	if (!record) {
		if (truncated)
			throw new AppError(
				"Commit file list exceeds the preview budget",
				413,
				"GIT_COMMIT_PREVIEW_TOO_LARGE",
			);
		throw new AppError(
			`File is not part of this commit: ${file}`,
			404,
			"GIT_COMMIT_FILE_NOT_FOUND",
		);
	}
	if (oldPath !== undefined && oldPath !== record.oldPath)
		throw new ValidationError("Commit preview source path does not match the selected file");
	return record;
}

interface NumstatRecord {
	added: number | null;
	removed: number | null;
	binary: boolean;
}

/** `a\tr\tpath\0` or `a\tr\t\0old\0new\0`, keyed by the new path. */
export function parseNumstatRecords(output: string): Map<string, NumstatRecord> {
	const stats = new Map<string, NumstatRecord>();
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf("\0", offset);
		if (end === -1) break;
		const record = output.slice(offset, end);
		offset = end + 1;
		const first = record.indexOf("\t");
		const second = record.indexOf("\t", first + 1);
		if (first === -1 || second === -1) continue;
		const a = record.slice(0, first);
		const r = record.slice(first + 1, second);
		const binary = a === "-" && r === "-";
		const value = {
			added: binary ? null : Number.parseInt(a, 10),
			removed: binary ? null : Number.parseInt(r, 10),
			binary,
		};
		if (!binary && (Number.isNaN(value.added) || Number.isNaN(value.removed))) continue;
		let path = record.slice(second + 1);
		if (!path) {
			const oldEnd = output.indexOf("\0", offset);
			if (oldEnd === -1) break;
			const newEnd = output.indexOf("\0", oldEnd + 1);
			if (newEnd === -1) break;
			path = output.slice(oldEnd + 1, newEnd);
			offset = newEnd + 1;
		}
		if (path) stats.set(path, value);
	}
	return stats;
}

export interface RawCommitLists {
	numstat: string;
	numstatTruncated: boolean;
	nameStatus: string;
	nameStatusTruncated: boolean;
}

/** name-status is the authoritative file list; numstat only contributes counts. */
export function parseCommitFiles(raw: RawCommitLists): {
	files: GitCommitFile[];
	filesTruncated: boolean;
} {
	const records = parseNameStatusRecords(rollbackToNul(raw.nameStatus, raw.nameStatusTruncated));
	const stats = parseNumstatRecords(rollbackToNul(raw.numstat, raw.numstatTruncated));
	const filesTruncated = raw.nameStatusTruncated || records.length > GIT_COMMIT_PREVIEW_MAX_FILES;
	const files = records.slice(0, GIT_COMMIT_PREVIEW_MAX_FILES).map((record) => {
		const stat = stats.get(record.path);
		return {
			path: record.path,
			...(record.oldPath ? { oldPath: record.oldPath } : {}),
			status: record.status,
			linesAdded: stat?.added ?? null,
			linesRemoved: stat?.removed ?? null,
			binary: stat?.binary ?? false,
		};
	});
	return { files, filesTruncated };
}

export function buildCommitDetail(meta: CommitMeta, lists: RawCommitLists): GitCommitDetail {
	return {
		...meta,
		comparedTo: meta.parents[0] ?? null,
		...parseCommitFiles(lists),
	};
}

export function commitNotFound(sha: string): AppError {
	return new AppError(`Git commit not found: ${sha}`, 404, "GIT_COMMIT_NOT_FOUND");
}

/**
 * The pathspec must resolve to exactly one file of this commit. Empty output means
 * the path is not part of it. Only a verified scoped typechange entry permits
 * two headers: Git renders a file-type transition as deletion plus addition.
 * Content lines are always prefixed (`+`, `-`, ` `), so a header can only appear
 * at the start of a line.
 */
export function assertSingleFilePatch(
	diff: string,
	file: string,
	verifiedEntry?: NameStatusRecord,
): void {
	const headers = diff.match(/^diff --git /gm)?.length ?? 0;
	if (headers === 0)
		throw new AppError(
			`File is not part of this commit: ${file}`,
			404,
			"GIT_COMMIT_FILE_NOT_FOUND",
		);
	const maxHeaders =
		verifiedEntry?.status === "typechange" &&
		verifiedEntry.path === file &&
		verifiedEntry.oldPath === undefined
			? 2
			: 1;
	if (headers > maxHeaders)
		throw new ValidationError("Commit preview path must name a single file");
}
