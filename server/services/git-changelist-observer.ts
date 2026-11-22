import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	type GitStagingUnit,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../shared/git-staging-lists";
import {
	createTextOwnership,
	materializeTextOwnership,
	normalizeTextOwnership,
	rebaseTextOwnership,
	type TextCommitMapping,
	type TextOwnershipSnapshot,
	updateTextOwnership,
} from "./git-changelist-ownership";
import {
	CHANGELIST_SNAPSHOT_LIMITS,
	type ChangelistRepository,
	type ChangelistStore,
	type StoredFile,
	type StoredFileMetadata,
	type WorkspaceState,
} from "./git-changelist-store";
import { GitStagingKernelError, stagingGit as runStagingGit } from "./git-staging-process";

export interface ObservationDiagnostics {
	durationMs: number;
	attempts: number;
	outcome: "reused" | "published" | "failed";
	phasesMs: Record<
		| "discovery"
		| "authorization"
		| "stat"
		| "read"
		| "canonicalize"
		| "loadOwnership"
		| "ownership"
		| "publish",
		number
	>;
	gitProcesses: number;
	readBytes: number;
	rawReadBytes: number;
	blobReadBytes: number;
	snapshotReadBytes: number;
	putFileAttempts: number;
	canonicalizedPaths: number;
	loadedSnapshots: number;
	writtenSnapshots: number;
	reusedMappings: number;
	ownershipComputations: number;
}
const observationDiagnostics = new AsyncLocalStorage<ObservationDiagnostics>();
let lastSlowObservation = 0;
function stagingGit(...args: Parameters<typeof runStagingGit>) {
	const diagnostics = observationDiagnostics.getStore();
	if (diagnostics) diagnostics.gitProcesses++;
	return runStagingGit(...args);
}
async function phase<T>(name: keyof ObservationDiagnostics["phasesMs"], work: () => Promise<T>) {
	const start = performance.now();
	try {
		return await work();
	} finally {
		const diagnostics = observationDiagnostics.getStore();
		if (diagnostics) diagnostics.phasesMs[name] += performance.now() - start;
	}
}
function readBytes(count: number) {
	const diagnostics = observationDiagnostics.getStore();
	if (diagnostics) diagnostics.readBytes += count;
}

export const OBSERVATION_LIMITS = {
	maxFileBytes: 2 * 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
	maxMergeHeadBytes: 64 * 1024,
	maxLines: 100_000,
	diffTimeoutMs: 500,
};
function assertSnapshotBudget(files: readonly StoredFileMetadata[]) {
	let contentBytes = 0;
	let ownershipBytes = 0;
	for (const file of files) {
		contentBytes += file.base_size + file.work_size;
		ownershipBytes += file.ownership_size;
		if (
			file.base_size > OBSERVATION_LIMITS.maxFileBytes ||
			file.work_size > OBSERVATION_LIMITS.maxFileBytes ||
			file.ownership_size > CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipFileBytes ||
			ownershipBytes > CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipBytes ||
			contentBytes > OBSERVATION_LIMITS.maxTotalBytes
		)
			throw fail("GIT_STAGING_LIMIT", "Observation snapshots exceed their byte budget");
	}
}
const fail = (code: string, message: string) => new GitStagingKernelError(code, message);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (e) {
		if (missing(e)) return null;
		throw e;
	}
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > maxBytes)
			throw fail("GIT_STAGING_LIMIT", "File exceeds the changelist byte budget");
		const bytes = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const result = await handle.read(bytes, used, bytes.length - used, used);
			if (!result.bytesRead) break;
			used += result.bytesRead;
		}
		const after = await handle.stat();
		if (
			used !== before.size ||
			before.ino !== after.ino ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			before.size !== after.size
		)
			throw fail("GIT_STAGING_CONCURRENT_CHANGE", "File changed while it was being observed");
		readBytes(used);
		return bytes.subarray(0, used);
	} finally {
		await handle.close();
	}
}
export async function readChangelistMergeHead(
	repo: ChangelistRepository,
	signal?: AbortSignal,
): Promise<Buffer | null> {
	signal?.throwIfAborted();
	const bytes = await readBoundedFile(
		join(repo.gitDir, "MERGE_HEAD"),
		OBSERVATION_LIMITS.maxMergeHeadBytes,
	);
	signal?.throwIfAborted();
	return bytes;
}
export function checkRelativePath(path: string) {
	if (
		!path ||
		path.length > LIMITS.maxPathChars ||
		isAbsolute(path) ||
		/[\0\ud800-\udfff]/u.test(path) ||
		(process.platform === "win32" && /[:\\]/.test(path)) ||
		path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
	)
		throw fail("GIT_STAGING_INVALID", "Invalid repository-relative path");
	return path;
}
export async function checkPathParents(repo: ChangelistRepository, path: string) {
	checkRelativePath(path);
	let parent = repo.root;
	for (const part of path.split("/").slice(0, -1)) {
		parent = join(parent, part);
		const info = await lstat(parent).catch((e) => {
			if (missing(e)) return null;
			throw e;
		});
		if (!info || (!info.isDirectory() && !info.isSymbolicLink())) return false;
		if (!info.isDirectory() || info.isSymbolicLink())
			throw fail("GIT_STAGING_INVALID", "Repository paths cannot traverse symlinks");
	}
	return true;
}
export async function currentChangelistHead(repo: ChangelistRepository, signal?: AbortSignal) {
	const headFile = (await readBoundedFile(join(repo.gitDir, "HEAD"), 8192))?.toString("utf8");
	const result = await stagingGit(repo.root, ["rev-parse", "--verify", "-q", "HEAD"], {
		allowFailure: true,
		signal,
	});
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw fail("GIT_STAGING_GIT_FAILED", "Cannot read HEAD");
	const head = result.exitCode === 0 ? result.stdout.trim() : null;
	const symbolic = await stagingGit(repo.root, ["symbolic-ref", "--quiet", "HEAD"], {
		allowFailure: true,
		signal,
	});
	if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1)
		throw fail("GIT_STAGING_GIT_FAILED", "Cannot read HEAD reference");
	const tree = (
		await stagingGit(repo.root, head ? ["rev-parse", `${head}^{tree}`] : ["mktree"], {
			input: "",
			signal,
		})
	).stdout.trim();
	return {
		head,
		tree,
		headFile,
		headTarget: symbolic.exitCode === 0 ? `ref: ${symbolic.stdout.trim()}` : null,
	};
}
interface Entry {
	mode: string;
	oid: string;
	path: string;
}
async function manifest(repo: ChangelistRepository, tree: string, signal?: AbortSignal) {
	const raw = await stagingGit(repo.root, ["ls-tree", "-r", "-z", tree], {
		maxBytes: LIMITS.maxPathBytes,
		strictUtf8: true,
		signal,
	});
	const entries = new Map<string, Entry>();
	for (const record of raw.stdout.split("\0")) {
		if (!record) continue;
		const match =
			/^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
		if (!match) throw fail("GIT_STAGING_UNSUPPORTED", "Unsupported Git tree entry");
		checkRelativePath(match[3]);
		entries.set(match[3], { mode: match[1], oid: match[2], path: match[3] });
	}
	const files = await stagingGit(
		repo.root,
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ maxBytes: LIMITS.maxPathBytes, strictUtf8: true, signal },
	);
	const changed = await stagingGit(
		repo.root,
		["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", tree, "--"],
		{ maxBytes: LIMITS.maxPathBytes, strictUtf8: true, signal },
	);
	const untracked = await stagingGit(
		repo.root,
		["ls-files", "--others", "--exclude-standard", "-z"],
		{ maxBytes: LIMITS.maxPathBytes, strictUtf8: true, signal },
	);
	const flags = await stagingGit(repo.root, ["ls-files", "-v", "-z"], {
		maxBytes: LIMITS.maxPathBytes,
		strictUtf8: true,
		signal,
	});
	const paths = new Set(
		[
			...changed.stdout.split("\0"),
			...untracked.stdout.split("\0"),
			...flags.stdout
				.split("\0")
				.filter((v) => /^[a-zS] /.test(v))
				.map((v) => v.slice(2)),
		].filter(Boolean),
	);
	for (const path of paths) checkRelativePath(path);
	return {
		entries,
		paths: [...paths].filter((path) => !path.startsWith(".narrafork/git-staging/")).sort(),
		signature: createHash("sha256")
			.update(raw.bytes)
			.update(files.bytes)
			.update(changed.bytes)
			.update(untracked.bytes)
			.update(flags.bytes)
			.digest("hex"),
	};
}

/** Resolve the entire authorization scope without reading file/blob contents. */
export async function changelistObservationPaths(
	repo: ChangelistRepository,
	store?: ChangelistStore | null,
	signal?: AbortSignal,
) {
	const head = await currentChangelistHead(repo, signal);
	const current = await manifest(repo, head.tree, signal);
	const paths = new Set(current.paths);
	for (const previous of store?.fileIds() ?? []) {
		paths.add(checkRelativePath(previous.path));
		paths.add(checkRelativePath(previous.base_path));
	}
	return [...paths].sort();
}

function authorizePaths(paths: Iterable<string>, authorized?: ReadonlySet<string>) {
	if (!authorized) return;
	for (const path of paths)
		if (!authorized.has(path))
			throw fail("GIT_STAGING_FORBIDDEN", "Observation paths changed after authorization");
}
const fileIdentity = (info: Stats | null) =>
	info
		? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`
		: "missing";
async function pathInfo(repo: ChangelistRepository, path: string) {
	if (!(await checkPathParents(repo, path))) return null;
	return lstat(join(repo.root, path)).catch((e) => {
		if (missing(e)) return null;
		throw e;
	});
}

/** Git still applies every configured clean filter and standard attributes. */
async function canonicalContext(
	repo: ChangelistRepository,
	paths: readonly string[],
	signal?: AbortSignal,
) {
	const config = await stagingGit(
		repo.root,
		[
			"config",
			"--null",
			"--get-regexp",
			"^(core\\.(filemode|autocrlf|eol|safecrlf|attributesfile|ignorecase|symlinks)|filter\\.)",
		],
		{ signal, allowFailure: true, maxBytes: LIMITS.maxPathBytes },
	);
	if (config.exitCode !== 0 && config.exitCode !== 1)
		throw fail("GIT_STAGING_GIT_FAILED", "Cannot read Git normalization configuration");
	const attrs = await stagingGit(
		repo.root,
		["check-attr", "-z", "--stdin", "filter", "working-tree-encoding", "text", "eol", "ident"],
		{
			input: paths.length ? `${paths.join("\0")}\0` : "",
			maxBytes: LIMITS.maxPathBytes * 6,
			strictUtf8: true,
			signal,
		},
	);
	const atomic = new Set<string>();
	const hashes = new Map<string, ReturnType<typeof createHash>>();
	const values = attrs.stdout.split("\0");
	for (let i = 0; i < values.length - 1; i += 3) {
		const [path, attribute, value] = values.slice(i, i + 3);
		if (!path || !attribute || value === undefined)
			throw fail("GIT_STAGING_GIT_FAILED", "Malformed Git attributes response");
		let hash = hashes.get(path);
		if (!hash) {
			hash = createHash("sha256").update(config.bytes);
			hashes.set(path, hash);
		}
		hash.update(`${attribute}\0${value}\0`);
		if (
			(attribute === "filter" || attribute === "working-tree-encoding") &&
			value !== "unspecified" &&
			value !== "unset"
		)
			atomic.add(path);
	}
	return {
		atomic,
		identities: new Map([...hashes].map(([path, hash]) => [path, hash.digest("hex")])),
		signature: createHash("sha256").update(config.bytes).update(attrs.bytes).digest("hex"),
	};
}

interface InputFile {
	path: string;
	base?: Entry;
	info: Stats | null;
	identity: string;
}
interface CanonicalFiles {
	entries: Map<string, Entry>;
	renames: Map<string, string>;
	directory: string;
}

async function canonicalFiles(
	repo: ChangelistRepository,
	tree: string,
	inputs: readonly InputFile[],
	signal?: AbortSignal,
	detectRenames = true,
	reuse: readonly StoredFileMetadata[] = [],
): Promise<CanonicalFiles> {
	for (const path of [join(repo.gitDir, "narrafork"), repo.directory]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw fail("GIT_STAGING_STORAGE_UNSAFE", "Observation storage must be a real directory");
	}
	const operations = join(repo.directory, "operations");
	await mkdir(operations, { mode: 0o700 }).catch((e) => {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	});
	const parent = await lstat(operations);
	if (!parent.isDirectory() || parent.isSymbolicLink())
		throw fail("GIT_STAGING_STORAGE_UNSAFE", "Observation storage must be a real directory");
	const directory = join(operations, `observe-${randomUUID()}`);
	await mkdir(directory, { mode: 0o700 });
	const evidence = await open(
		join(directory, "observation.json"),
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await evidence.writeFile(JSON.stringify({ tree, paths: inputs.map((input) => input.path) }));
	} finally {
		await evidence.close();
	}
	const env = { GIT_INDEX_FILE: join(directory, "index"), GIT_LITERAL_PATHSPECS: "1" };
	const git = (args: string[], options: Parameters<typeof stagingGit>[2] = {}) =>
		stagingGit(repo.root, args, { ...options, env, signal });
	await git(["read-tree", tree]);
	if (reuse.length) {
		const zero = "0".repeat(tree.length);
		await git(["update-index", "-z", "--index-info"], {
			input: reuse
				.map((file) => `${file.work_mode} ${file.work_oid ?? zero}\t${file.path}\0`)
				.join(""),
			maxBytes: LIMITS.maxPathBytes,
		});
	}
	const retained = new Set(reuse.map((file) => file.path));
	const paths = inputs
		.filter((input) => !retained.has(input.path) && (input.info || input.base))
		.map((input) => input.path);
	const diagnostics = observationDiagnostics.getStore();
	if (diagnostics) diagnostics.canonicalizedPaths += paths.length;
	if (paths.length)
		await git(["add", "--all", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], {
			input: `${paths.join("\0")}\0`,
			timeoutMs: LIMITS.writeTimeoutMs,
		});
	const listed = await git(["ls-files", "--stage", "-z"], {
		maxBytes: LIMITS.maxPathBytes,
		strictUtf8: true,
	});
	const entries = new Map<string, Entry>();
	for (const record of listed.stdout.split("\0")) {
		if (!record) continue;
		const match = /^(100644|100755|120000|160000) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(record);
		if (!match) throw fail("GIT_STAGING_UNSUPPORTED", "Unsupported canonical Git index entry");
		const path = checkRelativePath(match[3]);
		entries.set(path, { mode: match[1], oid: match[2], path });
	}
	if (!detectRenames) return { entries, renames: new Map(), directory };
	const candidateTree = (await git(["write-tree"])).stdout.trim();
	const renamed = await git(
		[
			"diff-tree",
			"--no-commit-id",
			"--raw",
			"--no-abbrev",
			"-r",
			"-z",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames=50%",
			"--rename-empty",
			"-l1000",
			tree,
			candidateTree,
		],
		{ strictUtf8: true, maxBytes: LIMITS.maxPathBytes },
	);
	const renames = new Map<string, string>();
	const records = renamed.stdout.split("\0");
	for (let i = 0; i < records.length - 1; ) {
		const header = records[i++];
		const match = /^:\d{6} \d{6} [a-f0-9]{40,64} [a-f0-9]{40,64} ([A-Z])(\d*)$/.exec(header);
		if (!match) throw fail("GIT_STAGING_GIT_FAILED", "Malformed Git rename response");
		const source = checkRelativePath(records[i++]);
		if (match[1] === "R" || match[1] === "C") {
			const destination = checkRelativePath(records[i++]);
			if (match[1] === "R") renames.set(destination, source);
		}
	}
	return { entries, renames, directory };
}

/** Size-check all objects before requesting bytes; batch framing never decodes blob data. */
async function readObjects(
	repo: ChangelistRepository,
	entries: Iterable<Entry>,
	cache: Map<string, Buffer>,
	signal?: AbortSignal,
) {
	const wanted = new Set<string>();
	for (const entry of entries) {
		if (entry.mode !== "160000" && !cache.has(entry.oid)) wanted.add(entry.oid);
	}
	if (!wanted.size) return;
	const oids = [...wanted];
	const sizes = await stagingGit(repo.root, ["cat-file", "--batch-check"], {
		input: `${oids.join("\n")}\n`,
		maxBytes: oids.length * 128,
		signal,
	});
	const records = sizes.stdout.trimEnd().split("\n");
	let total = 0;
	if (records.length !== oids.length)
		throw fail("GIT_STAGING_GIT_FAILED", "Incomplete Git object size response");
	for (let i = 0; i < oids.length; i++) {
		const parts = records[i].split(" ");
		const size = Number(parts[2]);
		if (parts[0] !== oids[i] || parts[1] !== "blob" || !Number.isSafeInteger(size) || size < 0)
			throw fail("GIT_STAGING_GIT_FAILED", "Invalid Git blob size response");
		if (size > OBSERVATION_LIMITS.maxFileBytes)
			throw fail("GIT_STAGING_LIMIT", "Git blob exceeds the changelist file byte budget");
		total += size;
		if (total > OBSERVATION_LIMITS.maxTotalBytes)
			throw fail("GIT_STAGING_LIMIT", "Git blobs exceed the observation byte budget");
	}
	const result = await stagingGit(repo.root, ["cat-file", "--batch"], {
		input: `${oids.join("\n")}\n`,
		maxBytes: total + oids.length * 128,
		signal,
	});
	let offset = 0;
	for (let i = 0; i < oids.length; i++) {
		const end = result.bytes.indexOf(10, offset);
		if (end < offset || end - offset > 127)
			throw fail("GIT_STAGING_GIT_FAILED", "Invalid Git batch framing");
		const header = result.bytes.subarray(offset, end).toString("ascii");
		if (header !== records[i])
			throw fail("GIT_STAGING_CONCURRENT_CHANGE", "Git object size changed");
		const size = Number(records[i].split(" ")[2]);
		const next = end + 1 + size;
		if (next >= result.bytes.length || result.bytes[next] !== 10)
			throw fail("GIT_STAGING_GIT_FAILED", "Incomplete Git batch blob");
		cache.set(oids[i], Buffer.from(result.bytes.subarray(end + 1, next)));
		readBytes(size);
		const diagnostics = observationDiagnostics.getStore();
		if (diagnostics) diagnostics.blobReadBytes += size;
		offset = next + 1;
	}
	if (offset !== result.bytes.length)
		throw fail("GIT_STAGING_GIT_FAILED", "Unexpected Git batch output");
}

/** Revalidate selected published sources without changing ownership or the observation. */
export async function assertChangelistSourcesCurrent(
	repo: ChangelistRepository,
	store: ChangelistStore,
	selection: { fileIds: readonly string[]; observationId?: string },
	signal?: AbortSignal,
): Promise<void> {
	const stale = () =>
		fail(
			"GIT_STAGING_STALE_VERSION",
			"Working sources changed; synchronize changelists before committing",
		);
	const expected = store.state();
	const observationId = selection.observationId ?? expected.observation_id;
	if (!observationId || observationId !== expected.observation_id || !expected.head_tree)
		throw stale();
	const fileIds = [...new Set(selection.fileIds)];
	if (!fileIds.length || fileIds.length > LIMITS.maxRowsPerList)
		throw fail("GIT_STAGING_INVALID", "Invalid source verification selection");
	const deadline = Date.now() + LIMITS.writeTimeoutMs;
	const checkpoint = () => {
		signal?.throwIfAborted();
		if (Date.now() > deadline)
			throw fail("GIT_STAGING_TIMEOUT", "Source verification exceeded its deadline");
	};
	try {
		checkpoint();
		const selected: StoredFile[] = [];
		const bases = new Map<string, Entry>();
		const paths = new Set<string>();
		let previousBytes = 0;
		for (const fileId of fileIds) {
			checkpoint();
			const file = store.loadFile(fileId, observationId);
			if (!file) throw stale();
			paths.add(checkRelativePath(file.path));
			paths.add(checkRelativePath(file.basePath));
			if (
				file.baseBytes.length > OBSERVATION_LIMITS.maxFileBytes ||
				file.workBytes.length > OBSERVATION_LIMITS.maxFileBytes
			)
				throw fail("GIT_STAGING_LIMIT", "Source snapshot exceeds the file byte budget");
			previousBytes += file.baseBytes.length + file.workBytes.length;
			if (previousBytes > OBSERVATION_LIMITS.maxTotalBytes)
				throw fail("GIT_STAGING_LIMIT", "Selected sources exceed the total byte budget");
			if (file.baseMode !== "000000" && file.baseOid)
				bases.set(file.basePath, { path: file.basePath, mode: file.baseMode, oid: file.baseOid });
			selected.push(file);
		}
		const scope = [...paths].sort();
		if (Buffer.byteLength(scope.join("\0")) + scope.length > LIMITS.maxPathBytes)
			throw fail("GIT_STAGING_LIMIT", "Selected source paths exceed the path budget");
		const before = await currentChangelistHead(repo, signal);
		if (before.head !== expected.head_oid || before.tree !== expected.head_tree) throw stale();
		const nativeBefore = await readBoundedFile(repo.index, OBSERVATION_LIMITS.maxTotalBytes);
		const inputs: InputFile[] = [];
		let rawTotal = 0;
		for (const path of scope) {
			checkpoint();
			const base = bases.get(path),
				info = await pathInfo(repo, path);
			if (
				info &&
				!info.isFile() &&
				!info.isSymbolicLink() &&
				!(info.isDirectory() && base?.mode === "160000")
			)
				throw stale();
			if (info && !info.isDirectory()) {
				if (info.size > OBSERVATION_LIMITS.maxFileBytes)
					throw fail("GIT_STAGING_LIMIT", "Working source exceeds the file byte budget");
				rawTotal += info.size;
				if (rawTotal > OBSERVATION_LIMITS.maxTotalBytes)
					throw fail("GIT_STAGING_LIMIT", "Working sources exceed the total byte budget");
				if (
					info.isFile() &&
					!(await readBoundedFile(join(repo.root, path), OBSERVATION_LIMITS.maxFileBytes))
				)
					throw stale();
			}
			inputs.push({ path, base, info, identity: fileIdentity(info) });
		}
		const context = await canonicalContext(repo, scope, signal);
		const inputsByPath = new Map(inputs.map((input) => [input.path, input]));
		for (const file of selected) {
			const previousContext = file.identity.slice(file.identity.lastIndexOf(":") + 1);
			if (previousContext !== context.identities.get(file.path)) throw stale();
			if (file.path !== file.basePath && inputsByPath.get(file.basePath)?.info) throw stale();
		}
		// Always hash current bytes, even if timestamps match the published snapshot.
		const canonical = await canonicalFiles(repo, before.tree, inputs, signal, false);
		const cache = new Map<string, Buffer>();
		for (const file of selected) {
			if (file.baseOid && file.baseMode !== "160000") cache.set(file.baseOid, file.baseBytes);
			if (file.workOid && file.workMode !== "160000") cache.set(file.workOid, file.workBytes);
		}
		const current = selected.flatMap((file) => {
			const entry = canonical.entries.get(file.path);
			return entry ? [entry] : [];
		});
		await readObjects(repo, current, cache, signal);
		let total = 0;
		for (const file of selected) {
			checkpoint();
			const entry = canonical.entries.get(file.path);
			const currentBytes = !entry
				? 0
				: entry.mode === "160000"
					? entry.oid.length
					: cache.get(entry.oid)?.length;
			if (currentBytes === undefined)
				throw fail("GIT_STAGING_GIT_FAILED", "Missing verified Git source");
			total += file.baseBytes.length + currentBytes;
			if (total > OBSERVATION_LIMITS.maxTotalBytes)
				throw fail("GIT_STAGING_LIMIT", "Canonical sources exceed the total byte budget");
			if (
				(entry?.mode ?? "000000") !== file.workMode ||
				(entry?.oid ?? null) !== file.workOid ||
				(file.path !== file.basePath && canonical.entries.has(file.basePath))
			)
				throw stale();
		}
		for (const input of inputs) {
			checkpoint();
			if (fileIdentity(await pathInfo(repo, input.path)) !== input.identity) throw stale();
		}
		const after = await currentChangelistHead(repo, signal);
		const nativeAfter = await readBoundedFile(repo.index, OBSERVATION_LIMITS.maxTotalBytes);
		const endContext = await canonicalContext(repo, scope, signal);
		if (
			before.head !== after.head ||
			before.tree !== after.tree ||
			before.headFile !== after.headFile ||
			context.signature !== endContext.signature ||
			!(nativeBefore === null ? nativeAfter === null : nativeAfter?.equals(nativeBefore))
		)
			throw stale();
		checkpoint();
		store.assertVersion(expected.generation, observationId);
		await rm(canonical.directory, { recursive: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (
			[
				"GIT_STAGING_CONCURRENT_CHANGE",
				"GIT_STAGING_INVALID",
				"GIT_STAGING_UNSUPPORTED",
				"ENOENT",
				"ELOOP",
				"ENOTDIR",
			].includes(code ?? "")
		)
			throw stale();
		throw error;
	}
}

function text(bytes: Buffer) {
	if (bytes.includes(0)) return null;
	try {
		const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return Buffer.from(value).equals(bytes) ? value : null;
	} catch {
		return null;
	}
}
export function ownershipUnits(
	snapshot: TextOwnershipSnapshot,
	path: string,
	basePath = path,
): GitStagingUnit[] {
	return snapshot.units.map((u) => ({
		id: u.id,
		fileId: snapshot.fileId,
		path,
		...(basePath !== path ? { oldPath: basePath } : {}),
		kind: "text",
		listId: u.groupId,
		baseStart: u.baseStart,
		baseEnd: u.baseEnd,
		workStart: u.workStart,
		workEnd: u.workEnd,
		added: u.insertedLines.length,
		removed: u.baseEnd - u.baseStart,
		needsReview: u.needsReview,
		...(u.reviewReason ? { reviewReason: u.reviewReason } : {}),
	}));
}
export function structuralUnit(
	fileId: string,
	path: string,
	kind: GitStagingUnit["kind"],
	listId: string,
	previous?: GitStagingUnit,
): GitStagingUnit {
	const { needsReview: _review, reviewReason: _reason, ...retained } = previous ?? {};
	return {
		...retained,
		id: previous?.id ?? randomUUID(),
		fileId,
		path,
		kind,
		listId,
		baseStart: 0,
		baseEnd: 0,
		workStart: 0,
		workEnd: 0,
		added: 0,
		removed: 0,
		needsReview: false,
	};
}
export interface CommitRebase {
	operationId: string;
	fenceToken?: string;
	mappings: Map<string, TextCommitMapping>;
	selectedUnitIds: Set<string>;
	sourceObservationId: string;
}

/* Git compares newline/64-byte spans. Keep a conservative alternate-candidate graph:
 * Git's selected pairing alone is not proof when multiple sources/destinations fit. */
function renameSpans(bytes: Buffer) {
	const spans = new Map<string, number>();
	const isText = !bytes.subarray(0, 8000).includes(0);
	const scratch = Buffer.allocUnsafe(64);
	let used = 0;
	const add = () => {
		const key = scratch.subarray(0, used).toString("base64");
		spans.set(key, (spans.get(key) ?? 0) + used);
		used = 0;
	};
	for (let offset = 0; offset < bytes.length; offset++) {
		const byte = bytes[offset];
		if (isText && byte === 13 && bytes[offset + 1] === 10) continue;
		scratch[used++] = byte;
		if (used === 64 || byte === 10) add();
	}
	if (used) add();
	return spans;
}
function possibleSimilarity(
	source: Buffer,
	destination: Buffer,
	spans: Map<Buffer, Map<string, number>>,
) {
	const size = Math.max(source.length, destination.length);
	if (!size) return true;
	if (Math.min(source.length, destination.length) * 2 < size) return false;
	let left = spans.get(source),
		right = spans.get(destination);
	if (!left) {
		left = renameSpans(source);
		spans.set(source, left);
	}
	if (!right) {
		right = renameSpans(destination);
		spans.set(destination, right);
	}
	let copied = 0;
	for (const [span, bytes] of left) copied += Math.min(bytes, right.get(span) ?? 0);
	return copied * 2 >= size;
}
function resolveRenames(
	baseEntries: Map<string, Entry>,
	canonical: CanonicalFiles,
	bytes: (entry?: Entry) => Buffer,
	previous: readonly Pick<StoredFile, "path" | "basePath" | "fileId" | "baseOid">[],
	checkpoint: () => void,
) {
	const deleted = [...baseEntries.values()].filter((entry) => !canonical.entries.has(entry.path));
	const added = [...canonical.entries.values()].filter((entry) => !baseEntries.has(entry.path));
	const candidates = new Map<string, Set<string>>();
	const destinations = new Map<string, Set<string>>();
	const spans = new Map<Buffer, Map<string, number>>();
	const review = new Set<string>();
	if (deleted.length * added.length > 20_000) {
		for (const entry of [...deleted, ...added]) review.add(entry.path);
	} else {
		for (const destination of added) {
			checkpoint();
			for (const source of deleted) {
				if (source.mode.slice(0, 3) !== destination.mode.slice(0, 3)) continue;
				if (
					source.oid !== destination.oid &&
					!possibleSimilarity(bytes(source), bytes(destination), spans)
				)
					continue;
				const sources = candidates.get(destination.path) ?? new Set<string>();
				sources.add(source.path);
				candidates.set(destination.path, sources);
				const targets = destinations.get(source.path) ?? new Set<string>();
				targets.add(destination.path);
				destinations.set(source.path, targets);
			}
		}
	}
	const paired = new Map<string, string>();
	for (const [destination, sources] of candidates) {
		if (
			sources.size > 1 ||
			[...sources].some((source) => (destinations.get(source)?.size ?? 0) > 1)
		) {
			review.add(destination);
			for (const source of sources) review.add(source);
		}
	}
	const priorPaths = new Map(previous.map((file) => [file.path, file]));
	for (const [destination, source] of canonical.renames) {
		const priorDestination = priorPaths.get(destination);
		if (
			!candidates.get(destination)?.has(source) ||
			(priorDestination &&
				priorDestination.basePath !== source &&
				priorDestination.fileId !== priorPaths.get(source)?.fileId)
		) {
			review.add(source);
			review.add(destination);
		}
		if (!review.has(source) && !review.has(destination)) paired.set(destination, source);
	}
	// Existing file identities remain valid even after later edits lower HEAD similarity.
	for (const file of previous) {
		if (
			file.path === file.basePath ||
			!canonical.entries.has(file.path) ||
			canonical.entries.has(file.basePath)
		)
			continue;
		if (baseEntries.get(file.basePath)?.oid !== file.baseOid || baseEntries.has(file.path))
			continue;
		for (const [destination, source] of paired)
			if (source === file.basePath || destination === file.path) paired.delete(destination);
		paired.set(file.path, file.basePath);
		review.delete(file.path);
		review.delete(file.basePath);
	}
	return { paired, review };
}

/** Missing old work blobs disable reuse; malformed responses and Git failures remain hard errors. */
async function previousObjectsAvailable(
	repo: ChangelistRepository,
	files: readonly StoredFileMetadata[],
	signal?: AbortSignal,
) {
	const sizes = new Map<string, number>();
	for (const file of files) {
		if (file.base_oid) sizes.set(file.base_oid, file.base_size);
		if (file.work_oid) sizes.set(file.work_oid, file.work_size);
	}
	if (!sizes.size) return true;
	const oids = [...sizes.keys()];
	const result = await stagingGit(repo.root, ["cat-file", "--batch-check"], {
		input: `${oids.join("\n")}\n`,
		maxBytes: oids.length * 128,
		signal,
	});
	const records = result.stdout.trimEnd().split("\n");
	if (records.length !== oids.length)
		throw fail("GIT_STAGING_GIT_FAILED", "Incomplete reusable Git object response");
	let available = true;
	for (const [index, oid] of oids.entries()) {
		if (records[index] === `${oid} missing`) {
			available = false;
			continue;
		}
		if (records[index] !== `${oid} blob ${sizes.get(oid)}`)
			throw fail("GIT_STAGING_GIT_FAILED", "Invalid reusable Git object response");
	}
	return available;
}

/** Diagnostics stay in the observer Worker and never contain repository content or credentials. */
export async function observeChangelists(
	repo: ChangelistRepository,
	store: ChangelistStore,
	signal?: AbortSignal,
	rebase?: CommitRebase,
	authorizedPaths?: readonly string[],
	collectDiagnostics?: (diagnostics: ObservationDiagnostics) => void,
) {
	const diagnostics: ObservationDiagnostics = {
		durationMs: 0,
		attempts: 0,
		outcome: "failed",
		phasesMs: {
			discovery: 0,
			authorization: 0,
			stat: 0,
			read: 0,
			canonicalize: 0,
			loadOwnership: 0,
			ownership: 0,
			publish: 0,
		},
		gitProcesses: 0,
		readBytes: 0,
		rawReadBytes: 0,
		blobReadBytes: 0,
		snapshotReadBytes: 0,
		putFileAttempts: 0,
		canonicalizedPaths: 0,
		loadedSnapshots: 0,
		writtenSnapshots: 0,
		reusedMappings: 0,
		ownershipComputations: 0,
	};
	const start = performance.now();
	try {
		return await observationDiagnostics.run(diagnostics, () =>
			observeWithDiagnostics(repo, store, signal, rebase, authorizedPaths),
		);
	} finally {
		diagnostics.durationMs = performance.now() - start;
		if (diagnostics.durationMs >= 2_000 && Date.now() - lastSlowObservation >= 60_000) {
			lastSlowObservation = Date.now();
			console.warn("[changelists] slow observation", JSON.stringify(diagnostics));
		}
		try {
			collectDiagnostics?.(diagnostics);
		} catch {
			console.warn("[changelists] observation diagnostics collector failed");
		}
	}
}

class WorkingFilesChanged extends GitStagingKernelError {
	constructor() {
		super("GIT_STAGING_CONCURRENT_CHANGE", "Working files changed before observation publication");
	}
}
interface ObservationRetry {
	expected: WorkspaceState;
	deadline: number;
	remaining: number;
}
async function observationBackoff(delay: number, deadline: number, signal?: AbortSignal) {
	signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason);
		};
		const timer = setTimeout(finish, Math.max(0, Math.min(delay, deadline - Date.now())));
		signal?.addEventListener("abort", abort, { once: true });
	});
}
/** A complete draft becomes visible only after files, attributes, HEAD and native index rechecks. */
async function observeWithDiagnostics(
	repo: ChangelistRepository,
	store: ChangelistStore,
	signal?: AbortSignal,
	rebase?: CommitRebase,
	authorizedPaths?: readonly string[],
	retry?: ObservationRetry,
): Promise<WorkspaceState> {
	const diagnostics = observationDiagnostics.getStore() as ObservationDiagnostics;
	diagnostics.attempts++;
	const expected = retry?.expected ?? store.state();
	if (store.pending() && !rebase)
		throw fail("GIT_STAGING_RECOVERY_REQUIRED", "A changelist commit requires recovery");
	const authorized = authorizedPaths ? new Set(authorizedPaths.map(checkRelativePath)) : undefined;
	const deadline = retry?.deadline ?? Date.now() + LIMITS.writeTimeoutMs;
	const remaining = retry?.remaining ?? (rebase ? 0 : 2);
	const checkpoint = () => {
		signal?.throwIfAborted();
		if (Date.now() > deadline)
			throw fail("GIT_STAGING_TIMEOUT", "Changelist observation exceeded its deadline");
	};
	let operationDirectory: string | undefined;
	let incremental = false;
	try {
		checkpoint();
		if (retry) store.assertState(expected);
		const before = await phase("discovery", () => currentChangelistHead(repo, signal));
		const nativeBefore = await phase("read", () =>
			readBoundedFile(repo.index, OBSERVATION_LIMITS.maxTotalBytes),
		);
		const unmerged = await stagingGit(repo.root, ["ls-files", "--unmerged", "-z"], {
			maxBytes: LIMITS.maxPathBytes,
			signal,
		});
		if (unmerged.stdout)
			throw fail(
				"GIT_STAGING_NATIVE_STAGED",
				"Resolve native index conflicts before observing changelists",
			);
		const mergeBefore = await phase("read", () => readChangelistMergeHead(repo, signal));
		if (rebase && mergeBefore !== null)
			throw fail(
				"GIT_STAGING_REPOSITORY_BUSY",
				"Finish the Git merge before projecting a changelist commit",
			);
		const externalHead = !rebase && !!expected.observation_id && expected.head_oid !== before.head;
		const ordinaryGroupId =
			mergeBefore !== null ? GIT_STAGING_UNASSIGNED_LIST_ID : expected.active_list_id;
		const start = await phase("discovery", () => manifest(repo, before.tree, signal));
		const previousIds = store.fileIds(rebase?.sourceObservationId ?? expected.observation_id);
		const authorizationAt = performance.now();
		authorizePaths(
			[...start.paths, ...previousIds.flatMap((file) => [file.path, file.base_path])],
			authorized,
		);
		diagnostics.phasesMs.authorization += performance.now() - authorizationAt;
		if (start.paths.length > LIMITS.maxRowsPerList * 2)
			throw fail("GIT_STAGING_LIMIT", "Too many changed paths in one observation");
		const inputs = new Map<string, InputFile>();
		let rawTotal = 0;
		const statAt = performance.now();
		for (const path of start.paths) {
			checkpoint();
			const base = start.entries.get(path);
			const info = await pathInfo(repo, path);
			if (info && !info.isFile() && !info.isSymbolicLink() && !(info.isDirectory() && base))
				throw fail("GIT_STAGING_UNSUPPORTED", `Unsupported working file type: ${path}`);
			if (info && !info.isDirectory()) {
				if (info.size > OBSERVATION_LIMITS.maxFileBytes)
					throw fail("GIT_STAGING_LIMIT", "File exceeds the changelist byte budget");
				rawTotal += info.size;
				if (rawTotal > OBSERVATION_LIMITS.maxTotalBytes)
					throw fail("GIT_STAGING_LIMIT", "Working files exceed the observation byte budget");
			}
			inputs.set(path, { path, base, info, identity: fileIdentity(info) });
		}
		diagnostics.phasesMs.stat += performance.now() - statAt;
		const previousPaths = previousIds.flatMap((file) => [file.path, file.base_path]);
		const contextPaths = [...new Set([...start.paths, ...previousPaths])].sort();
		const context = await phase("canonicalize", () => canonicalContext(repo, contextPaths, signal));
		for (const input of inputs.values())
			input.identity += `:${context.identities.get(input.path) ?? ""}`;
		assertSnapshotBudget(previousIds);
		if (previousIds.length > LIMITS.maxRowsPerList)
			throw fail("GIT_STAGING_LIMIT", "Too many previous changelist files");
		const legacyFiles = rebase
			? new Set<string>()
			: await store.legacyReviewFileIds(expected.observation_id, { signal, checkpoint, deadline });
		const previousByPath = new Map(previousIds.map((file) => [file.path, file]));
		const loaded = new Map<string, StoredFile>();
		const load = (file: StoredFileMetadata | undefined) => {
			if (!file) return undefined;
			let result = loaded.get(file.file_id);
			if (!result) {
				checkpoint();
				const at = performance.now();
				result =
					store.loadFile(file.file_id, rebase?.sourceObservationId ?? expected.observation_id) ??
					undefined;
				diagnostics.phasesMs.loadOwnership += performance.now() - at;
				if (!result) throw fail("GIT_STAGING_STORAGE_CORRUPT", "Missing previous file snapshot");
				diagnostics.loadedSnapshots++;
				const size = file.base_size + file.work_size + file.ownership_size;
				readBytes(size);
				diagnostics.snapshotReadBytes += size;
				loaded.set(file.file_id, result);
			}
			return result;
		};
		const covered = new Set(previousIds.flatMap((file) => [file.path, file.base_path]));
		incremental =
			!rebase &&
			expected.state === "ready" &&
			!!expected.observation_id &&
			expected.head_oid === before.head &&
			expected.head_tree === before.tree &&
			context.atomic.size === 0 &&
			previousIds.every(
				(file) =>
					file.path === file.base_path &&
					!!file.has_ownership &&
					file.identity.slice(file.identity.lastIndexOf(":") + 1) ===
						context.identities.get(file.path) &&
					(start.entries.get(file.base_path)?.oid ?? null) === file.base_oid &&
					(start.entries.get(file.base_path)?.mode ?? "000000") === file.base_mode,
			);
		const reusable = new Map(
			(incremental ? previousIds : [])
				.filter(
					(file) =>
						!legacyFiles.has(file.file_id) && inputs.get(file.path)?.identity === file.identity,
				)
				.map((file) => [file.path, file]),
		);
		const unchanged =
			incremental &&
			start.paths.every((path) => covered.has(path)) &&
			reusable.size === previousIds.length;
		const retained = new Set<string>();
		const observed: StoredFile[] = [];
		let prepareUnassigned = false;
		if (unchanged) for (const file of previousIds) retained.add(file.file_id);
		else {
			// Unchanged observations only need the saved snapshot. Validate Git objects
			// when they will actually be reused to construct a private candidate index.
			if (
				reusable.size &&
				!(await phase("read", () => previousObjectsAvailable(repo, [...reusable.values()], signal)))
			)
				reusable.clear();
			// Preflight bounded raw reads only for paths Git will normalize. Native index stays untouched.
			await phase("read", async () => {
				for (const input of inputs.values()) {
					checkpoint();
					if (!reusable.has(input.path) && input.info?.isFile()) {
						const raw = await readBoundedFile(
							join(repo.root, input.path),
							OBSERVATION_LIMITS.maxFileBytes,
						);
						diagnostics.rawReadBytes += raw?.length ?? 0;
					}
				}
			});
			const canonical = await phase("canonicalize", () =>
				canonicalFiles(repo, before.tree, [...inputs.values()], signal, true, [
					...reusable.values(),
				]),
			);
			operationDirectory = canonical.directory;
			const cache = new Map<string, Buffer>();
			const needed: Entry[] = [];
			const deleted = [...start.entries.values()].filter(
				(entry) => !canonical.entries.has(entry.path),
			);
			const added = [...canonical.entries.values()].filter(
				(entry) => !start.entries.has(entry.path),
			);
			if (deleted.length && added.length && deleted.length * added.length <= 20_000)
				needed.push(...deleted, ...added);
			for (const path of start.paths) {
				const base = start.entries.get(path),
					work = canonical.entries.get(path);
				if (reusable.has(path) || (base?.oid === work?.oid && base?.mode === work?.mode)) continue;
				if (base) needed.push(base);
				if (work) needed.push(work);
			}
			await phase("read", () => readObjects(repo, needed, cache, signal));
			const bytes = (entry?: Entry): Buffer => {
				if (!entry) return Buffer.alloc(0);
				if (entry.mode === "160000") return Buffer.from(entry.oid);
				const result = cache.get(entry.oid);
				if (!result) throw fail("GIT_STAGING_GIT_FAILED", "Missing bounded Git blob");
				return result;
			};
			const renames = resolveRenames(
				start.entries,
				canonical,
				bytes,
				previousIds.map((file) => ({
					path: file.path,
					basePath: file.base_path,
					fileId: file.file_id,
					baseOid: file.base_oid,
				})),
				checkpoint,
			);
			const sources = new Set(renames.paired.values());
			let total = 0;
			for (const input of inputs.values()) {
				checkpoint();
				const { path, identity } = input;
				if (sources.has(path)) continue;
				const basePath = renames.paired.get(path) ?? path;
				const base = start.entries.get(basePath),
					work = canonical.entries.get(path);
				if (basePath === path && base?.oid === work?.oid && base?.mode === work?.mode) continue;
				if (!base && !work) continue;
				const workMode = work?.mode ?? "000000";
				const priorDestination = previousByPath.get(path);
				const priorMetadata =
					basePath === path
						? priorDestination
						: priorDestination?.base_path === basePath
							? priorDestination
							: previousByPath.get(basePath);
				if (
					!rebase &&
					!!priorMetadata &&
					!legacyFiles.has(priorMetadata.file_id) &&
					priorMetadata.path === path &&
					priorMetadata.base_path === basePath &&
					priorMetadata.base_oid === (base?.oid ?? null) &&
					priorMetadata.work_oid === (work?.oid ?? null) &&
					priorMetadata.base_mode === (base?.mode ?? "000000") &&
					priorMetadata.work_mode === workMode &&
					priorMetadata.identity === identity &&
					!renames.review.has(path)
				) {
					total += priorMetadata.base_size + priorMetadata.work_size;
					if (total > OBSERVATION_LIMITS.maxTotalBytes)
						throw fail("GIT_STAGING_LIMIT", "Observation exceeds its total byte budget");
					retained.add(priorMetadata.file_id);
					continue;
				}
				// Rename review may invalidate a stat-reusable path, so fetch its exact blobs lazily.
				await phase("read", () =>
					readObjects(
						repo,
						[base, work].filter((entry): entry is Entry => !!entry),
						cache,
						signal,
					),
				);
				const baseBytes = bytes(base),
					workBytes = bytes(work);
				total += baseBytes.length + workBytes.length;
				if (total > OBSERVATION_LIMITS.maxTotalBytes)
					throw fail("GIT_STAGING_LIMIT", "Observation exceeds its total byte budget");
				const prior = load(priorMetadata);
				const fileId = prior?.fileId ?? randomUUID();
				let ownership: TextOwnershipSnapshot | null = null;
				let headRebuilt = false;
				const unchangedFileBase =
					prior?.baseBytes.equals(baseBytes) &&
					prior.baseMode === (base?.mode ?? "000000") &&
					prior.basePath === basePath;
				const fileTargetGroupId =
					mergeBefore !== null || (externalHead && !unchangedFileBase)
						? GIT_STAGING_UNASSIGNED_LIST_ID
						: expected.active_list_id;
				const structuralOwner = (kind: GitStagingUnit["kind"], old?: GitStagingUnit) => {
					if (!old || !prior) return fileTargetGroupId;
					if (rebase) return old.listId;
					const unchanged =
						kind === "mode"
							? prior.baseMode === (base?.mode ?? "000000") && prior.workMode === workMode
							: kind === "rename"
								? prior.basePath === basePath && prior.path === path
								: kind === "create" || kind === "delete"
									? true
									: prior.baseBytes.equals(baseBytes) &&
										prior.workBytes.equals(workBytes) &&
										prior.baseMode.slice(0, 3) === (base?.mode ?? "000000").slice(0, 3) &&
										prior.workMode.slice(0, 3) === workMode.slice(0, 3);
					return unchanged ? old.listId : fileTargetGroupId;
				};
				const units: GitStagingUnit[] = [];
				const baseText = text(baseBytes),
					workText = text(workBytes);
				const ordinary = (!base || /^100/.test(base.mode)) && (!work || /^100/.test(work.mode));
				const oldUnit = (kind: GitStagingUnit["kind"]) =>
					prior?.units.find((unit) => unit.kind === kind && !rebase?.selectedUnitIds.has(unit.id));
				if (ordinary && !context.atomic.has(path) && baseText !== null && workText !== null) {
					const ownershipAt = performance.now();
					diagnostics.ownershipComputations++;
					if (prior?.ownership) {
						if (prior.baseBytes.equals(baseBytes))
							ownership = updateTextOwnership(prior.ownership, {
								workText,
								activeGroupId: ordinaryGroupId,
								mode: rebase ? "commit" : "observe",
							});
						else {
							const result = rebaseTextOwnership(prior.ownership, {
								baseText,
								workText,
								activeGroupId: expected.active_list_id,
								mode: rebase ? "commit" : "observe",
								...(!rebase && expected.head_oid !== before.head
									? { headConflictGroupId: GIT_STAGING_UNASSIGNED_LIST_ID }
									: {}),
								...(rebase?.mappings.has(fileId)
									? { commitMapping: rebase.mappings.get(fileId) }
									: {}),
							});
							if (result.status !== "ok")
								throw fail(
									"GIT_STAGING_HEAD_CONFLICT",
									`HEAD overlaps existing ownership in ${path}`,
								);
							ownership = result.snapshot;
							headRebuilt = result.headRebuilt === true;
						}
					} else
						ownership = createTextOwnership({
							fileId,
							baseText,
							workText,
							activeGroupId: fileTargetGroupId,
						});
					ownership = normalizeTextOwnership(ownership);
					if (materializeTextOwnership(ownership) !== workText)
						throw fail(
							"GIT_STAGING_INVALID",
							"Ownership materialization did not match the working file",
						);
					diagnostics.phasesMs.ownership += performance.now() - ownershipAt;
					units.push(...ownershipUnits(ownership, path, basePath));
				} else {
					if (prior?.ownership && new Set(prior.units.map((unit) => unit.listId)).size > 1)
						throw fail("GIT_STAGING_LIMIT", `Cannot collapse split ownership for ${path}`);
					const kind =
						workMode === "160000" || base?.mode === "160000"
							? "gitlink"
							: workMode === "120000" || base?.mode === "120000"
								? "symlink"
								: "binary";
					if (
						!baseBytes.equals(workBytes) ||
						(base?.mode ?? "000000").slice(0, 3) !== workMode.slice(0, 3)
					) {
						const old = oldUnit(kind);
						units.push(structuralUnit(fileId, path, kind, structuralOwner(kind, old), old));
					}
				}
				for (const kind of [
					!base ? "create" : !work ? "delete" : null,
					base && work && base.mode !== work.mode && base.mode.slice(0, 3) === work.mode.slice(0, 3)
						? "mode"
						: null,
				] as const) {
					if (!kind) continue;
					const old = oldUnit(kind);
					units.push(structuralUnit(fileId, path, kind, structuralOwner(kind, old), old));
				}
				if (basePath !== path) {
					const old = oldUnit("rename");
					units.push({
						...structuralUnit(fileId, path, "rename", structuralOwner("rename", old), old),
						oldPath: basePath,
					});
				}
				if (headRebuilt) for (const unit of units) unit.listId = GIT_STAGING_UNASSIGNED_LIST_ID;
				if (units.some((unit) => unit.listId === GIT_STAGING_UNASSIGNED_LIST_ID))
					prepareUnassigned = true;
				observed.push({
					versionId: randomUUID(),
					fileId,
					path,
					basePath,
					baseMode: base?.mode ?? "000000",
					workMode,
					baseOid: base?.oid ?? null,
					workOid: work?.oid ?? null,
					baseBytes,
					workBytes,
					identity,
					ownership,
					units,
				});
				if (observed.length + retained.size > LIMITS.maxRowsPerList)
					throw fail("GIT_STAGING_LIMIT", "Too many changed files in one observation");
			}
		}
		const sameVersions =
			!rebase &&
			expected.state === "ready" &&
			expected.head_oid === before.head &&
			expected.head_tree === before.tree &&
			observed.length === 0 &&
			retained.size === previousIds.length;
		let draft: string | undefined;
		if (!sameVersions) {
			await phase("publish", async () => {
				draft = await store.draft(before.head, before.tree, { unassigned: prepareUnassigned });
				if (expected.observation_id && retained.size) {
					diagnostics.reusedMappings = await store.copyFiles(
						draft,
						rebase?.sourceObservationId ?? expected.observation_id,
						previousIds.filter((file) => !retained.has(file.file_id)).map((file) => file.file_id),
					);
				}
				diagnostics.putFileAttempts += observed.length;
				await store.putFiles(draft, observed, { signal, checkpoint });
				diagnostics.writtenSnapshots += observed.length;
			});
		}
		// Draft writes can yield; all source checks must follow the last draft write.
		const recheckAt = performance.now();
		for (const input of inputs.values()) {
			checkpoint();
			const now = fileIdentity(await pathInfo(repo, input.path));
			if (`${now}:${context.identities.get(input.path) ?? ""}` !== input.identity)
				throw new WorkingFilesChanged();
		}
		diagnostics.phasesMs.stat += performance.now() - recheckAt;
		const after = await phase("discovery", () => currentChangelistHead(repo, signal));
		const nativeAfter = await phase("read", () =>
			readBoundedFile(repo.index, OBSERVATION_LIMITS.maxTotalBytes),
		);
		const end = await phase("discovery", () => manifest(repo, after.tree, signal));
		authorizePaths(end.paths, authorized);
		const endContext = await phase("canonicalize", () =>
			canonicalContext(repo, [...new Set([...end.paths, ...previousPaths])].sort(), signal),
		);
		if (
			before.head !== after.head ||
			before.headFile !== after.headFile ||
			start.signature !== end.signature ||
			context.signature !== endContext.signature ||
			!(nativeBefore === null ? nativeAfter === null : nativeAfter?.equals(nativeBefore))
		)
			throw fail(
				"GIT_STAGING_CONCURRENT_CHANGE",
				"HEAD, native index, attributes or path manifest changed during observation",
			);
		const mergeAfter = await phase("read", () => readChangelistMergeHead(repo, signal));
		if (!(mergeBefore === null ? mergeAfter === null : mergeAfter?.equals(mergeBefore)))
			throw fail("GIT_STAGING_CONCURRENT_CHANGE", "Git merge state changed during observation");
		checkpoint();
		if (sameVersions) {
			const state = store.reuse(expected);
			diagnostics.outcome = "reused";
			if (operationDirectory) await rm(operationDirectory, { recursive: true });
			return state;
		}
		if (!draft) throw fail("GIT_STAGING_INVALID", "Missing complete observation draft");
		assertSnapshotBudget(store.fileIds(draft));
		await phase("publish", () =>
			store.publish(
				draft as string,
				expected,
				before.head,
				before.tree,
				rebase?.operationId,
				rebase?.fenceToken,
			),
		);
		diagnostics.outcome = "published";
		if (operationDirectory) await rm(operationDirectory, { recursive: true });
		return store.state();
	} catch (e) {
		const code = (e as GitStagingKernelError).code;
		if (!rebase && code === "GIT_STAGING_CONCURRENT_CHANGE" && remaining === 0)
			Object.defineProperty(e, "observationRetriesExhausted", { value: true });
		const fence = rebase?.fenceToken
			? { operationId: rebase.operationId, fenceToken: rebase.fenceToken }
			: undefined;
		const markFailure = (error: unknown, source: WorkspaceState) => {
			const failureCode = (error as GitStagingKernelError).code;
			const state =
				failureCode === "GIT_STAGING_HEAD_CONFLICT" || failureCode === "GIT_STAGING_NATIVE_STAGED"
					? "conflict"
					: "incomplete";
			return rebase
				? store.mark(state, (error as Error).message, fence)
				: store.mark(state, (error as Error).message, undefined, source);
		};
		const canRetry = !rebase && code === "GIT_STAGING_CONCURRENT_CHANGE" && remaining > 0;
		// Only this attempt's identity failure can retain a validated ready source.
		// Other concurrent failures first expose incomplete and rebuild conservatively.
		const retainReady =
			canRetry &&
			e instanceof WorkingFilesChanged &&
			incremental &&
			store.completeObservation(expected);
		let nextExpected = expected;
		if ((!rebase || fence) && !retainReady) {
			const marked = await markFailure(e, expected);
			if (!marked) throw e;
			nextExpected = marked;
		}
		if (!canRetry) throw e;
		try {
			checkpoint();
			store.assertState(nextExpected);
			await observationBackoff(50 * 2 ** (2 - remaining), deadline, signal);
			checkpoint();
			store.assertState(nextExpected);
		} catch (retryError) {
			// A producer's same-version status change is not ours to overwrite.
			if (
				retryError instanceof GitStagingKernelError &&
				retryError.code === "GIT_STAGING_STALE_VERSION"
			)
				throw e;
			await markFailure(retryError, nextExpected);
			throw retryError;
		}
		return observeWithDiagnostics(repo, store, signal, rebase, authorizedPaths, {
			expected: nextExpected,
			deadline,
			remaining: remaining - 1,
		});
	}
}
