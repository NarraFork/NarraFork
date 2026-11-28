import {
	type GitStagingFile,
	type GitStagingFilesPage,
	type GitStagingStatsBuckets,
	type GitStagingStatsStatus,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../shared/git-staging-lists";
import { GitStagingKernelError } from "./git-staging-process";

const invalid = (message: string) => new GitStagingKernelError("GIT_STAGING_INVALID", message);
const limited = (message: string) => new GitStagingKernelError("GIT_STAGING_LIMIT", message);
const modes = "(?:000000|100644|100755|120000|160000)";
const rawHeader = new RegExp(
	`^:(${modes}) (${modes}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ACDMRTUXB])([0-9]*)$`,
);

/** One bounded CPU/deadline budget covers parsing and page projection in the Worker. */
export function stagingStatsBudget(
	signal?: AbortSignal,
	deadline = Date.now() + LIMITS.readTimeoutMs,
) {
	let operations = 0;
	return (cost = 1) => {
		operations += cost;
		if (operations > LIMITS.maxStatsOperations)
			throw limited("Staging statistics exceeded their CPU budget");
		signal?.throwIfAborted();
		if (Date.now() > deadline)
			throw new GitStagingKernelError("GIT_STAGING_TIMEOUT", "Staging statistics timed out");
	};
}

type Budget = ReturnType<typeof stagingStatsBudget>;

function checkedOutputPath(path: string) {
	if (
		!path ||
		path.length > LIMITS.maxPathChars ||
		/[\0\ud800-\udfff]/u.test(path) ||
		(process.platform === "win32" && /[:\\]/.test(path)) ||
		path
			.split("/")
			.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
	)
		throw invalid("Invalid repository-relative path in Git staging output");
	return path;
}

/** Git emits all raw records first, then all numstat records, with literal NUL paths. */
export function parseGitStagingStats(
	output: string,
	oidLength: number,
	budget: Budget = stagingStatsBudget(),
) {
	budget();
	if (Buffer.byteLength(output) > LIMITS.maxPathBytes)
		throw limited("Git staging output exceeded its budget");
	if (oidLength !== 40 && oidLength !== 64) throw invalid("Invalid staging object format");
	let position = 0;
	const token = () => {
		budget();
		const end = output.indexOf("\0", position);
		if (end < 0) throw invalid("Truncated NUL-delimited Git staging output");
		const value = output.slice(position, end);
		position = end + 1;
		return value;
	};
	const pending: Array<{ path: string; oldPath?: string; status: string; gitlink: boolean }> = [];
	const paths = new Set<string>();
	while (position < output.length && output[position] === ":") {
		const match = rawHeader.exec(token());
		if (!match) throw invalid("Invalid Git staging raw record");
		const [, oldMode, newMode, oldOid, newOid, status, score] = match;
		if (
			oldOid.length !== oidLength ||
			newOid.length !== oidLength ||
			(oldMode === "000000") !== /^0+$/.test(oldOid) ||
			(newMode === "000000") !== /^0+$/.test(newOid) ||
			(score && (!/^[0-9]{1,3}$/.test(score) || Number(score) > 100)) ||
			((status === "R" || status === "C") && !score) ||
			(score && status !== "R" && status !== "C" && status !== "M")
		)
			throw invalid("Invalid Git staging modes, object IDs or similarity score");
		const first = checkedOutputPath(token());
		const renamed = status === "R" || status === "C";
		const path = renamed ? checkedOutputPath(token()) : first;
		if (paths.has(path)) throw invalid("Duplicate Git staging raw path");
		paths.add(path);
		pending.push({
			path,
			...(renamed ? { oldPath: first } : {}),
			status: `${status}${score}`,
			gitlink: oldMode === "160000" || newMode === "160000",
		});
		if (pending.length > LIMITS.maxRowsPerList) throw limited("Staging list has too many files");
	}
	const rows: GitStagingFile[] = [];
	for (const raw of pending) {
		const record = token();
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab < 1 || secondTab < 0) throw invalid("Invalid Git staging numstat record");
		const added = record.slice(0, firstTab);
		const removed = record.slice(firstTab + 1, secondTab);
		const suffix = record.slice(secondTab + 1);
		let oldPath: string | undefined;
		let path = suffix;
		if (!suffix) {
			oldPath = checkedOutputPath(token());
			path = checkedOutputPath(token());
		}
		if (path !== raw.path || oldPath !== raw.oldPath)
			throw invalid("Git staging raw and numstat paths do not match");
		const binary = added === "-" && removed === "-";
		if (
			!binary &&
			(!/^(?:0|[1-9][0-9]*)$/.test(added) ||
				!/^(?:0|[1-9][0-9]*)$/.test(removed) ||
				!Number.isSafeInteger(Number(added)) ||
				!Number.isSafeInteger(Number(removed)))
		)
			throw invalid("Invalid Git staging line counts");
		rows.push({
			fileId: raw.path,
			unitCount: 1,
			needsReviewCount: 0,
			path: raw.path,
			...(raw.oldPath === undefined ? {} : { oldPath: raw.oldPath }),
			status: raw.status,
			stats: raw.gitlink
				? { kind: "gitlink" }
				: binary
					? { kind: "binary" }
					: { kind: "text", added: Number(added), removed: Number(removed) },
		});
	}
	if (position !== output.length) throw invalid("Unpaired Git staging raw or numstat records");
	return rows;
}

function accumulate(buckets: GitStagingStatsBuckets, row: GitStagingFile) {
	const status = row.status[0] as GitStagingStatsStatus;
	let total = buckets[status];
	if (!total) {
		total = { files: 0, added: 0, removed: 0, binaryFiles: 0, gitlinkFiles: 0 };
		buckets[status] = total;
	}
	total.files++;
	if (row.stats.kind === "text") {
		total.added += row.stats.added;
		total.removed += row.stats.removed;
		if (!Number.isSafeInteger(total.added) || !Number.isSafeInteger(total.removed))
			throw invalid("Git staging aggregate line counts exceed safe integers");
	} else if (row.stats.kind === "binary") total.binaryFiles++;
	else total.gitlinkFiles++;
}

interface DirectoryNode {
	children: Map<string, DirectoryNode>;
	entry?: { path: string; byStatus: GitStagingStatsBuckets };
}

interface PageOptions {
	workspaceKey: string;
	listId: string;
	snapshotVersion: string;
	generation: number;
	observationId: string | null;
	cursorVersion?: string;
	offset: number;
	limit: number;
}

/** Full aggregates, but a bounded projection of only the page's ancestor directories. */
export function projectGitStagingPage(
	rows: GitStagingFile[],
	options: PageOptions,
	budget: Budget = stagingStatsBudget(),
): GitStagingFilesPage {
	const { workspaceKey, listId, snapshotVersion, generation, observationId, offset, limit } =
		options;
	const cursorVersion = options.cursorVersion ?? snapshotVersion;
	budget();
	if (offset > rows.length || offset < 0 || !Number.isSafeInteger(offset))
		throw invalid("Invalid staging file cursor");
	if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxPageRows)
		throw invalid("Invalid staging page size");
	const trie: DirectoryNode = { children: new Map() };
	const directories = new Map<string, { path: string; byStatus: GitStagingStatsBuckets }>();
	const candidates: Array<{ row: GitStagingFile; parents: string[] }> = [];
	let prefixChars = 0;
	for (const row of rows.slice(offset, offset + limit)) {
		const parents: string[] = [];
		let extraChars = 0;
		let extraCount = 0;
		for (let end = row.path.indexOf("/"); end >= 0; end = row.path.indexOf("/", end + 1)) {
			budget(end + 1);
			const path = row.path.slice(0, end);
			parents.push(path);
			if (!directories.has(path)) {
				extraChars += path.length;
				extraCount++;
			}
			if (
				directories.size + extraCount > LIMITS.maxDirectoryPrefixes ||
				prefixChars + extraChars > LIMITS.maxDirectoryPrefixChars
			)
				break;
		}
		if (
			directories.size + extraCount > LIMITS.maxDirectoryPrefixes ||
			prefixChars + extraChars > LIMITS.maxDirectoryPrefixChars
		) {
			if (!candidates.length) throw limited("A staging path exceeds the directory-prefix budget");
			break;
		}
		prefixChars += extraChars;
		let node = trie;
		let start = 0;
		for (const path of parents) {
			budget();
			const component = row.path.slice(start, path.length);
			let child = node.children.get(component);
			if (!child) {
				child = { children: new Map(), entry: { path, byStatus: {} } };
				node.children.set(component, child);
				directories.set(path, child.entry as NonNullable<DirectoryNode["entry"]>);
			}
			node = child;
			start = path.length + 1;
		}
		candidates.push({ row, parents });
	}
	const total: GitStagingStatsBuckets = {};
	for (const row of rows) {
		budget();
		accumulate(total, row);
		let node = trie;
		let start = 0;
		for (let end = row.path.indexOf("/"); end >= 0; end = row.path.indexOf("/", start)) {
			budget();
			const child = node.children.get(row.path.slice(start, end));
			if (!child) break;
			if (child.entry) accumulate(child.entry.byStatus, row);
			node = child;
			start = end + 1;
		}
	}
	const page = (files: GitStagingFile[], paths: Set<string>): GitStagingFilesPage => {
		const complete = offset + files.length >= rows.length;
		return {
			workspaceKey,
			listId,
			files,
			snapshotVersion,
			generation,
			observationId,
			complete,
			nextCursor: complete
				? null
				: Buffer.from(JSON.stringify([cursorVersion, offset + files.length])).toString("base64url"),
			stats: {
				complete: true,
				total,
				directories: [...paths].map(
					(path) => directories.get(path) as NonNullable<DirectoryNode["entry"]>,
				),
			},
		};
	};
	const files: GitStagingFile[] = [];
	const paths = new Set<string>();
	const directoryBytes = new Map<string, number>();
	for (const [path, entry] of directories) {
		budget();
		directoryBytes.set(path, Buffer.byteLength(JSON.stringify(entry)));
	}
	let fileBytes = 0;
	let statsBytes = 0;
	for (const candidate of candidates) {
		budget();
		const addedPaths = candidate.parents.filter((path) => !paths.has(path));
		const addedBytes = addedPaths.reduce(
			(bytes, path) => bytes + (directoryBytes.get(path) ?? 0),
			0,
		);
		const rowBytes = Buffer.byteLength(JSON.stringify(candidate.row));
		const count = files.length + 1;
		const pathCount = paths.size + addedPaths.length;
		// Empty arrays already account for brackets. Cursor size depends on this candidate count.
		const envelope = page([], new Set());
		envelope.complete = offset + count >= rows.length;
		envelope.nextCursor = envelope.complete
			? null
			: Buffer.from(JSON.stringify([cursorVersion, offset + count])).toString("base64url");
		const bytes =
			Buffer.byteLength(JSON.stringify(envelope)) +
			fileBytes +
			rowBytes +
			count -
			1 +
			statsBytes +
			addedBytes +
			Math.max(0, pathCount - 1);
		if (bytes > LIMITS.maxPageBytes) break;
		files.push(candidate.row);
		fileBytes += rowBytes;
		statsBytes += addedBytes;
		for (const path of addedPaths) paths.add(path);
	}
	if (!files.length && offset < rows.length)
		throw limited("A staging file and its statistics exceed the page budget");
	const result = page(files, paths);
	if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.maxPageBytes)
		throw limited("Staging statistics exceed the page budget");
	budget();
	return result;
}
