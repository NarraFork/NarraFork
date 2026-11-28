import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitStagingAction, GitStagingActionResult } from "../../shared/git-staging-lists";
import {
	assertChangelistSourcesCurrent,
	currentChangelistHead,
	observeChangelists,
	readBoundedFile,
	readChangelistMergeHead,
} from "./git-changelist-observer";
import { prepareTextCommit, type TextCommitMapping } from "./git-changelist-ownership";
import type {
	ChangelistRepository,
	ChangelistStore,
	CommitOperation,
	StoredFile,
} from "./git-changelist-store";
import { GitStagingKernelError, gitStagingEnvironment, stagingGit } from "./git-staging-process";

const fail = (code: string, message: string) => new GitStagingKernelError(code, message);
interface Evidence {
	directory: string;
	candidate: string;
	nativeCandidate: string;
	nativeBefore: string | null;
	nativeBeforeHash: string | null;
	mappingFile: string;
	mappingHash: string | null;
	headFile?: string;
	headTarget: string | null;
	mappings: [string, TextCommitMapping][];
	selectedUnitIds: string[];
	nativeInstalled: boolean;
	lockIdentity?: string;
	leaseUntil: number;
	fenceToken: string;
	nativeMode: number | null;
}
type CommitAction = Extract<GitStagingAction, { action: "commit" }>;
const evidenceJson = (evidence: Evidence) => JSON.stringify({ ...evidence, mappings: [] });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function readSyncBounded(
	path: string,
	limit: number,
): { bytes: Buffer; mode: number; identity: string } | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (e) {
		if (missing(e)) return null;
		throw e;
	}
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > limit)
			throw fail("GIT_STAGING_LIMIT", "Commit fence file exceeds its byte budget");
		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) break;
			offset += count;
		}
		const after = fstatSync(fd),
			named = lstatSync(path);
		if (
			offset !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			named.dev !== before.dev ||
			named.ino !== before.ino ||
			named.isSymbolicLink()
		)
			throw fail(
				"GIT_STAGING_CONCURRENT_CHANGE",
				"A protected Git file changed while being checked",
			);
		return { bytes, mode: before.mode & 0o7777, identity: `${before.dev}:${before.ino}` };
	} finally {
		closeSync(fd);
	}
}
function assertHeadSync(
	repo: ChangelistRepository,
	head: string | null,
	headFile: string | undefined,
	headTarget: string | null,
) {
	const raw = readSyncBounded(join(repo.gitDir, "HEAD"), 8192)?.bytes.toString("utf8");
	if (raw !== headFile)
		throw fail("GIT_STAGING_CONCURRENT_CHANGE", "HEAD identity changed before index publication");
	const read = (args: string[]) => {
		const result = spawnSync("git", ["--no-optional-locks", ...args], {
			cwd: repo.root,
			env: gitStagingEnvironment(),
			timeout: 2_000,
			maxBuffer: 8192,
			encoding: "utf8",
			windowsHide: true,
		});
		if (result.error || (result.status !== 0 && result.status !== 1))
			throw fail("GIT_STAGING_GIT_FAILED", "Cannot validate the protected HEAD reference");
		return result.status === 0 ? result.stdout.trim() : null;
	};
	const currentHead = read(["rev-parse", "--verify", "-q", "HEAD"]);
	const symbolic = read(["symbolic-ref", "--quiet", "HEAD"]);
	if (currentHead !== head || (symbolic === null ? null : `ref: ${symbolic}`) !== headTarget)
		throw fail("GIT_STAGING_CONCURRENT_CHANGE", "HEAD changed before index publication");
}
function lockInfoSync(path: string) {
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink())
			throw fail("GIT_STAGING_LOCKED", "The native index lock is not a regular file");
		return `${info.dev}:${info.ino}`;
	} catch (e) {
		if (missing(e)) return null;
		throw e;
	}
}
function assertOwnedLockSync(repo: ChangelistRepository, evidence: Evidence) {
	if (!evidence.lockIdentity || lockInfoSync(`${repo.index}.lock`) !== evidence.lockIdentity)
		throw fail("GIT_STAGING_LOCKED", "The native lock is not owned by this operation");
}
async function prepareNativeInstall(evidence: Evidence, bytes: Buffer, candidate: string) {
	const mode = evidence.nativeMode ?? (await lstat(candidate)).mode & 0o7777;
	evidence.nativeMode = mode;
	const path = join(evidence.directory, `install-${evidence.fenceToken}-${randomUUID()}.index`);
	await writeEvidence(path, bytes);
	const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
	try {
		await handle.chmod(mode);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return path;
}
/** The SQLite write lock covers token verification and synchronous publication as one fence. */
async function installNativeIndex(
	repo: ChangelistRepository,
	store: ChangelistStore,
	operationId: string,
	evidence: Evidence,
	installed: Buffer,
	prepared: string,
	original: Buffer | null,
	head: { head: string | null; headFile: string | undefined; headTarget: string | null },
) {
	await store.transaction(() => {
		store.assertOperationFence(operationId, evidence.fenceToken);
		assertHeadSync(repo, head.head, head.headFile, head.headTarget);
		const current = readSyncBounded(repo.index, 64 * 1024 * 1024),
			alreadyInstalled = !!current?.bytes.equals(installed) && current.mode === evidence.nativeMode;
		let lockIdentity = lockInfoSync(`${repo.index}.lock`);
		if (lockIdentity && lockIdentity !== evidence.lockIdentity)
			throw fail("GIT_STAGING_LOCKED", "A different writer owns the native index lock");
		if (!alreadyInstalled) {
			if (
				!(original === null ? current === null : current?.bytes.equals(original)) ||
				(current && current.mode !== evidence.nativeMode)
			)
				throw fail(
					"GIT_STAGING_CONCURRENT_CHANGE",
					"The native index bytes or permissions changed after the commit",
				);
			if (!lockIdentity) {
				const fd = openSync(
					`${repo.index}.lock`,
					constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					const info = fstatSync(fd);
					lockIdentity = `${info.dev}:${info.ino}`;
					evidence.lockIdentity = lockIdentity;
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			}
			const candidate = readSyncBounded(prepared, 64 * 1024 * 1024);
			if (!candidate?.bytes.equals(installed) || candidate.mode !== evidence.nativeMode)
				throw fail("GIT_STAGING_COMMIT_UNKNOWN", "The prepared index evidence changed");
			renameSync(prepared, repo.index);
		}
		if (lockIdentity) {
			assertOwnedLockSync(repo, evidence);
			unlinkSync(`${repo.index}.lock`);
		}
		if (process.platform !== "win32") {
			const directory = openSync(
				dirname(repo.index),
				constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
			);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		}
		evidence.nativeInstalled = true;
		store.db
			.query(
				"UPDATE commit_operations SET status='committed',evidence_json=? WHERE id=? AND fence_token=?",
			)
			.run(evidenceJson(evidence), operationId, evidence.fenceToken);
	});
}
async function releaseNativeLock(
	repo: ChangelistRepository,
	store: ChangelistStore,
	operationId: string,
	evidence: Evidence,
) {
	await store.transaction(() => {
		store.assertOperationFence(operationId, evidence.fenceToken);
		if (evidence.lockIdentity && lockInfoSync(`${repo.index}.lock`) === evidence.lockIdentity)
			unlinkSync(`${repo.index}.lock`);
	});
}
async function writeEvidence(path: string, bytes: Buffer | string) {
	const handle = await open(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function readMappings(evidence: Evidence) {
	if (evidence.mappings.length || !evidence.mappingHash) return;
	const raw = await readBoundedFile(evidence.mappingFile, 256 * 1024 * 1024);
	if (!raw || createHash("sha256").update(raw).digest("hex") !== evidence.mappingHash)
		throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Commit source mapping evidence changed");
	evidence.mappings = JSON.parse(raw.toString()) as Evidence["mappings"];
}
const git = (
	repo: ChangelistRepository,
	args: string[],
	index?: string,
	options: Parameters<typeof stagingGit>[2] = {},
) =>
	stagingGit(repo.root, args, {
		...options,
		env: { ...options.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
	});
function result(
	store: ChangelistStore,
	operation: CommitOperation,
	outcome: "applied" | "partial",
	reason?: string,
): GitStagingActionResult {
	const state = store.state();
	return {
		outcome,
		generation: state.generation,
		observationId: state.observation_id,
		listId: operation.list_id,
		affectedListIds: [operation.list_id],
		operationId: operation.id,
		...(operation.commit_oid ? { commitOid: operation.commit_oid } : {}),
		...(reason ? { reason } : {}),
	};
}
async function updateOperation(
	store: ChangelistStore,
	id: string,
	fields: { status?: string; tree?: string; commit?: string; evidence: Evidence },
) {
	await store.transaction(() => {
		const row = store.assertOperationFence(id, fields.evidence.fenceToken);
		if (row.status === "finished" && fields.status !== "finished") return;
		store.db
			.query(
				"UPDATE commit_operations SET status=?,expected_tree=?,commit_oid=?,evidence_json=? WHERE id=?",
			)
			.run(
				fields.status ?? row.status,
				fields.tree ?? row.expected_tree,
				fields.commit ?? row.commit_oid,
				fields.evidence ? evidenceJson(fields.evidence) : row.evidence_json,
				id,
			);
	});
}
async function receipt(evidence: Evidence, commitOid: string, expectedTree: string) {
	const path = join(evidence.directory, `receipt-${randomUUID()}.json`);
	const handle = await open(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await handle.writeFile(
			JSON.stringify({ commitOid, expectedTree, evidence: JSON.parse(evidenceJson(evidence)) }),
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(path, join(evidence.directory, `commit-${evidence.fenceToken}.receipt.json`));
	if (process.platform !== "win32") {
		const directory = await open(
			evidence.directory,
			constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}
interface ProjectedFile {
	fileId: string;
	path: string;
	basePath: string;
	baseMode: string;
	mode: string;
	bytes: Buffer;
}
function candidateFile(file: StoredFile, listId: string, evidence: Evidence): ProjectedFile | null {
	const selected = file.units.filter((u) => u.listId === listId);
	if (!selected.length) return null;
	evidence.selectedUnitIds.push(...selected.map((u) => u.id));
	const kinds = new Set(selected.map((u) => u.kind));
	let bytes = file.baseBytes,
		mode = file.baseMode,
		path = file.basePath;
	if (kinds.has("rename")) path = file.path;
	if (kinds.has("delete")) {
		if (file.units.some((u) => u.listId !== listId))
			throw fail(
				"GIT_STAGING_PATH_DEPENDENCY",
				"A path deletion cannot discard changes owned by another list",
			);
		return {
			fileId: file.fileId,
			path: file.basePath,
			basePath: file.basePath,
			baseMode: file.baseMode,
			mode: "000000",
			bytes: Buffer.alloc(0),
		};
	}
	const atomic = file.units.filter(
		(unit) => unit.kind === "binary" || unit.kind === "symlink" || unit.kind === "gitlink",
	);
	if (
		atomic.length &&
		(file.baseMode === "000000" || file.workMode === "000000") &&
		file.units.some((unit) => unit.listId !== listId)
	)
		throw fail(
			"GIT_STAGING_PATH_DEPENDENCY",
			"Keep path creation or deletion with its indivisible content before committing",
		);
	if (kinds.has("binary") || kinds.has("symlink") || kinds.has("gitlink")) {
		bytes = file.workBytes;
		if (file.baseMode.slice(0, 3) !== file.workMode.slice(0, 3)) mode = file.workMode;
	} else if (file.ownership) {
		const prepared = prepareTextCommit(file.ownership, { groupIds: [listId] });
		bytes = Buffer.from(prepared.text);
		evidence.mappings.push([file.fileId, prepared.mapping]);
	}
	if (kinds.has("create") || kinds.has("mode")) mode = file.workMode;
	if (mode === "000000")
		throw fail(
			"GIT_STAGING_PATH_DEPENDENCY",
			"Move file creation and its content into the same list before committing",
		);
	return {
		fileId: file.fileId,
		path,
		basePath: file.basePath,
		baseMode: file.baseMode,
		mode,
		bytes,
	};
}
async function cleanupCompletedCommit(
	repo: ChangelistRepository,
	operation: CommitOperation,
	evidence: Evidence,
	signal?: AbortSignal,
) {
	try {
		await git(
			repo,
			["update-ref", "-d", `refs/narrafork/changelist-operations/${repo.key}/${operation.id}`],
			undefined,
			{ signal },
		);
		const parent = join(repo.directory, "operations");
		if (
			!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation.id) ||
			evidence.directory !== join(parent, operation.id)
		)
			throw fail("GIT_STAGING_STORAGE_UNSAFE", "Invalid completed operation directory");
		const info = await lstat(parent);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw fail("GIT_STAGING_STORAGE_UNSAFE", "Operation storage must be a real directory");
		await rm(evidence.directory, { recursive: true, force: true });
	} catch {
		return "Commit and changelist projection are complete; private operation cleanup needs retry";
	}
}
async function finish(
	repo: ChangelistRepository,
	store: ChangelistStore,
	operation: CommitOperation,
	evidence: Evidence,
	signal?: AbortSignal,
	authorizedPaths?: readonly string[],
) {
	store.assertOperationFence(operation.id, evidence.fenceToken);
	if (!operation.commit_oid)
		throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Commit identity is not confirmed");
	const head = await currentChangelistHead(repo, signal);
	if (head.head !== operation.commit_oid || head.tree !== operation.expected_tree)
		throw fail("GIT_STAGING_COMMIT_UNKNOWN", "HEAD differs from the confirmed changelist commit");
	if (!evidence.nativeInstalled)
		throw fail("GIT_STAGING_COMMIT_UNKNOWN", "The native index still needs protected recovery");
	await readMappings(evidence);
	await observeChangelists(
		repo,
		store,
		signal,
		{
			operationId: operation.id,
			fenceToken: evidence.fenceToken,
			mappings: new Map(evidence.mappings),
			selectedUnitIds: new Set(evidence.selectedUnitIds),
			sourceObservationId: operation.observation_id,
		},
		authorizedPaths,
	);
	const cleanupReason = await cleanupCompletedCommit(repo, operation, evidence, signal);
	return result(store, { ...operation, status: "finished" }, "applied", cleanupReason);
}
export async function commitChangelist(
	repo: ChangelistRepository,
	store: ChangelistStore,
	action: CommitAction,
	signal?: AbortSignal,
	authorizedPaths?: readonly string[],
): Promise<GitStagingActionResult> {
	if (
		!action.message?.trim() ||
		Buffer.byteLength(action.message) > 65536 ||
		action.message.includes("\0")
	)
		throw fail("GIT_STAGING_INVALID", "Invalid commit message");
	if (
		action.identity &&
		(!action.identity.name.trim() ||
			!action.identity.email.trim() ||
			/[\0\r\n<>]/.test(action.identity.name + action.identity.email))
	)
		throw fail("GIT_STAGING_INVALID", "Invalid commit identity");
	for (const name of [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
	]) {
		const info = await lstat(join(repo.gitDir, name)).catch((e) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
		if (info)
			throw fail(
				"GIT_STAGING_REPOSITORY_BUSY",
				"Finish the current native Git operation before committing",
			);
	}
	const state = store.assertVersion(action.expectedGeneration, action.observationId);
	if (state.state !== "ready")
		throw fail(
			"GIT_STAGING_INCOMPLETE",
			"A complete current observation is required before committing",
		);
	const legacyFiles = await store.legacyReviewFileIds(state.observation_id, { signal });
	store.assertState(state);
	if (legacyFiles.size)
		throw fail(
			"GIT_STAGING_STALE_VERSION",
			"Synchronize changelists to upgrade the stored ownership before committing",
		);
	const before = await currentChangelistHead(repo, signal);
	if (before.head !== state.head_oid || before.tree !== state.head_tree)
		throw fail(
			"GIT_STAGING_STALE_VERSION",
			"HEAD changed; synchronize changelists before committing",
		);
	const nativeBeforeSnapshot = readSyncBounded(repo.index, 64 * 1024 * 1024);
	const nativeBefore = nativeBeforeSnapshot?.bytes ?? null;
	const staged = await git(
		repo,
		[
			"diff",
			"--cached",
			"--quiet",
			"--no-ext-diff",
			"--no-textconv",
			"--ignore-submodules=none",
			"--ita-visible-in-index",
			before.tree,
			"--",
		],
		repo.index,
		{ allowFailure: true, signal },
	);
	if (staged.exitCode !== 0)
		throw fail(
			"GIT_STAGING_NATIVE_STAGED",
			"Handle ordinary staged files, intent-to-add entries and conflicts before committing a list",
		);
	const files = store
		.fileIds()
		.map((f) => store.loadFile(f.file_id) as StoredFile)
		.filter((f) => f.units.some((u) => u.listId === action.listId));
	if (!files.length) throw fail("GIT_STAGING_EMPTY", "The changelist has no changes to commit");
	const selectedFileIds = files.map((file) => file.fileId);
	await assertChangelistSourcesCurrent(
		repo,
		store,
		{ fileIds: selectedFileIds, observationId: state.observation_id as string },
		signal,
	);
	const id = randomUUID(),
		directory = join(repo.directory, "operations", id);
	await mkdir(join(repo.directory, "operations"), { recursive: true, mode: 0o700 });
	const parent = await lstat(join(repo.directory, "operations"));
	if (!parent.isDirectory() || parent.isSymbolicLink())
		throw fail("GIT_STAGING_STORAGE_UNSAFE", "Operation storage must be a real directory");
	await mkdir(directory, { mode: 0o700 });
	const evidence: Evidence = {
		directory,
		candidate: join(directory, "candidate.index"),
		nativeCandidate: join(directory, "native.index"),
		nativeBefore: nativeBefore ? join(directory, "native-before.index") : null,
		nativeBeforeHash: nativeBefore ? createHash("sha256").update(nativeBefore).digest("hex") : null,
		mappingFile: join(directory, "mappings.json"),
		mappingHash: null,
		headFile: before.headFile,
		headTarget: before.headTarget,
		mappings: [],
		selectedUnitIds: [],
		nativeInstalled: false,
		leaseUntil: Date.now() + 5 * 60_000,
		fenceToken: randomUUID(),
		nativeMode: nativeBeforeSnapshot?.mode ?? null,
	};
	if (nativeBefore && evidence.nativeBefore)
		await writeEvidence(evidence.nativeBefore, nativeBefore);
	await store.transaction(() => {
		store.assertState(state);
		if (store.pending())
			throw fail(
				"GIT_STAGING_RECOVERY_REQUIRED",
				"Recover the pending commit before committing again",
			);
		store.db
			.query("INSERT INTO commit_operations VALUES(?,?,?,?,?,?,NULL,NULL,'reserved',?,?,?)")
			.run(
				id,
				action.listId,
				state.generation,
				state.observation_id,
				before.head,
				before.tree,
				evidenceJson(evidence),
				Date.now(),
				evidence.fenceToken,
			);
		store.db.query("UPDATE workspace_state SET state='recovering' WHERE id=1").run();
	});
	let nativeLock: Awaited<ReturnType<typeof open>> | undefined;
	let invoked = false,
		confirmed = false;
	let confirmedOid: string | undefined;
	let expectedTree: string | undefined;
	const lockPath = `${repo.index}.lock`;
	try {
		await git(repo, ["read-tree", before.tree], evidence.candidate, { signal });
		const projected = files
			.map((file) => candidateFile(file, action.listId, evidence))
			.filter((file): file is ProjectedFile => file !== null);
		const mappingBytes = Buffer.from(JSON.stringify(evidence.mappings));
		await writeEvidence(evidence.mappingFile, mappingBytes);
		evidence.mappingHash = createHash("sha256").update(mappingBytes).digest("hex");
		const blobs = projected.filter((file) => file.mode !== "000000" && file.mode !== "160000");
		const blobDirectory = join(directory, "blobs");
		await mkdir(blobDirectory, { mode: 0o700 });
		const blobPaths: string[] = [];
		let totalBytes = 0;
		for (const file of blobs) {
			signal?.throwIfAborted();
			totalBytes += file.bytes.length;
			if (totalBytes > 64 * 1024 * 1024)
				throw fail("GIT_STAGING_LIMIT", "Commit projections exceed the total byte budget");
			const path = join(blobDirectory, randomUUID());
			const handle = await open(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				await handle.writeFile(file.bytes);
			} finally {
				await handle.close();
			}
			blobPaths.push(path);
		}
		const quote = (path: string) =>
			`"${[...Buffer.from(path)].map((byte) => (byte >= 32 && byte < 127 && byte !== 34 && byte !== 92 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`)).join("")}"`;
		const oids = blobPaths.length
			? (
					await git(repo, ["hash-object", "-w", "--stdin-paths"], undefined, {
						input: `${blobPaths.map(quote).join("\n")}\n`,
						maxBytes: 8 * 1024 * 1024,
						signal,
					})
				).stdout
					.trim()
					.split("\n")
			: [];
		if (
			oids.length !== blobs.length ||
			oids.some((oid) => !new RegExp(`^[a-f0-9]{${before.tree.length}}$`).test(oid))
		)
			throw fail("GIT_STAGING_INVALID", "Git returned an invalid projected blob list");
		const blobOids = new Map(blobs.map((file, index) => [file.fileId, oids[index]]));
		const zero = "0".repeat(before.tree.length);
		let input = "";
		for (const file of projected) {
			if (file.mode === "000000") {
				input += `0 ${zero}\t${file.path}\0`;
				continue;
			}
			const oid = file.mode === "160000" ? file.bytes.toString() : blobOids.get(file.fileId);
			if (!oid || !new RegExp(`^[a-f0-9]{${before.tree.length}}$`).test(oid))
				throw fail("GIT_STAGING_INVALID", "Invalid projected object identity");
			if (file.path !== file.basePath && file.baseMode !== "000000")
				input += `0 ${zero}\t${file.basePath}\0`;
			input += `${file.mode} ${oid}\t${file.path}\0`;
		}
		await git(repo, ["update-index", "-z", "--index-info"], evidence.candidate, { input, signal });
		expectedTree = (await git(repo, ["write-tree"], evidence.candidate, { signal })).stdout.trim();
		if (expectedTree === before.tree)
			throw fail("GIT_STAGING_EMPTY", "The selected units produce no commit");
		await git(
			repo,
			["update-ref", `refs/narrafork/changelist-operations/${repo.key}/${id}`, expectedTree],
			undefined,
			{ signal },
		);
		const privateLock = join(directory, "native.lock");
		nativeLock = await open(
			privateLock,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		await nativeLock.sync();
		const lockInfo = await nativeLock.stat();
		evidence.lockIdentity = `${lockInfo.dev}:${lockInfo.ino}`;
		await updateOperation(store, id, { status: "prepared", tree: expectedTree, evidence });
		try {
			await store.transaction(() => {
				store.assertOperationFence(id, evidence.fenceToken);
				linkSync(privateLock, lockPath);
			});
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST")
				throw fail("GIT_STAGING_LOCKED", "The native index is locked");
			throw e;
		}
		const nativeNow = await readBoundedFile(repo.index, 64 * 1024 * 1024),
			headNow = await currentChangelistHead(repo, signal);
		if (
			!(nativeBefore === null ? nativeNow === null : nativeNow?.equals(nativeBefore)) ||
			headNow.head !== before.head ||
			headNow.headFile !== before.headFile
		)
			throw fail(
				"GIT_STAGING_CONCURRENT_CHANGE",
				"HEAD or the native index changed before committing",
			);
		await assertChangelistSourcesCurrent(
			repo,
			store,
			{ fileIds: selectedFileIds, observationId: state.observation_id as string },
			signal,
		);
		const started = await store.transaction(() => {
			store.assertOperationFence(id, evidence.fenceToken);
			assertOwnedLockSync(repo, evidence);
			assertHeadSync(repo, before.head, before.headFile, before.headTarget);
			const native = readSyncBounded(repo.index, 64 * 1024 * 1024);
			if (
				!(nativeBefore === null ? native === null : native?.bytes.equals(nativeBefore)) ||
				(native && native.mode !== evidence.nativeMode)
			)
				throw fail(
					"GIT_STAGING_CONCURRENT_CHANGE",
					"The native index changed before Git commit invocation",
				);
			signal?.throwIfAborted();
			store.db
				.query(
					"UPDATE commit_operations SET status='invoked',evidence_json=? WHERE id=? AND fence_token=?",
				)
				.run(evidenceJson(evidence), id, evidence.fenceToken);
			invoked = true;
			// stagingGit spawns synchronously before its first await; the fence covers invocation.
			return {
				task: git(repo, ["commit", "--file=-"], evidence.candidate, {
					input: action.message,
					allowFailure: true,
					signal,
					timeoutMs: 120000,
					env: action.identity
						? {
								GIT_AUTHOR_NAME: action.identity.name,
								GIT_AUTHOR_EMAIL: action.identity.email,
								GIT_COMMITTER_NAME: action.identity.name,
								GIT_COMMITTER_EMAIL: action.identity.email,
							}
						: {},
				}),
			};
		}, signal);
		const committed = await started.task;
		const after = await currentChangelistHead(repo, signal);
		if (committed.exitCode !== 0) {
			if (after.head !== before.head || after.headTarget !== before.headTarget)
				throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Git returned an error after HEAD changed");
			invoked = false;
			throw fail(
				"GIT_STAGING_COMMIT_REJECTED",
				committed.stderr.trim() || "Git commit was rejected",
			);
		}
		if (
			!after.head ||
			after.head === before.head ||
			after.headTarget !== before.headTarget ||
			after.tree !== expectedTree
		)
			throw fail(
				"GIT_STAGING_COMMIT_UNKNOWN",
				"Commit result or hook-modified tree needs inspection",
			);
		const parents = (
			await git(repo, ["rev-list", "--parents", "-n", "1", after.head], undefined, { signal })
		).stdout
			.trim()
			.split(" ")
			.slice(1);
		if (parents.join() !== (before.head ?? ""))
			throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Commit parents changed concurrently");
		confirmed = true;
		confirmedOid = after.head;
		await receipt(evidence, after.head, expectedTree);
		await updateOperation(store, id, { status: "committed", commit: after.head, evidence });
		if (nativeBefore) {
			const copy = await open(
				evidence.nativeCandidate,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				await copy.writeFile(nativeBefore);
				await copy.sync();
			} finally {
				await copy.close();
			}
			await git(
				repo,
				["read-tree", "-m", "-i", before.tree, after.tree],
				evidence.nativeCandidate,
				{ signal },
			);
		} else await git(repo, ["read-tree", after.tree], evidence.nativeCandidate, { signal });
		const installed = await readBoundedFile(evidence.nativeCandidate, 64 * 1024 * 1024);
		if (!installed) throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Committed native index is missing");
		const finalHead = await currentChangelistHead(repo, signal);
		if (finalHead.head !== after.head || finalHead.headTarget !== after.headTarget)
			throw fail("GIT_STAGING_COMMIT_UNKNOWN", "HEAD changed before native index installation");
		const prepared = await prepareNativeInstall(evidence, installed, evidence.nativeCandidate);
		await installNativeIndex(
			repo,
			store,
			id,
			evidence,
			installed,
			prepared,
			nativeBefore,
			finalHead,
		);
		await nativeLock.close();
		nativeLock = undefined;
		const operation = store.db
			.query("SELECT * FROM commit_operations WHERE id=?")
			.get(id) as CommitOperation;
		return await finish(repo, store, operation, evidence, signal, authorizedPaths);
	} catch (e) {
		const current = store.db
			.query("SELECT * FROM commit_operations WHERE id=?")
			.get(id) as CommitOperation;
		if (current.fence_token !== evidence.fenceToken) {
			if (current.status === "finished") return result(store, current, "applied");
			throw fail(
				"GIT_STAGING_FENCED",
				`Operation ${id} was fenced by recovery; do not repeat the commit`,
			);
		}
		if (confirmed) {
			evidence.leaseUntil = 0;
			await updateOperation(store, id, {
				status: "recoverable",
				commit: confirmedOid,
				evidence,
			}).catch(() => {});
			if (confirmedOid && expectedTree)
				await receipt(evidence, confirmedOid, expectedTree).catch(() => {});
			const operation = store.db
				.query("SELECT * FROM commit_operations WHERE id=?")
				.get(id) as CommitOperation;
			return result(
				store,
				{ ...operation, commit_oid: confirmedOid ?? operation.commit_oid },
				"partial",
				`Commit was created; recover operation ${id} to finish. Do not commit again. ${(e as Error).message}`,
			);
		}
		if (invoked) {
			evidence.leaseUntil = 0;
			await updateOperation(store, id, { status: "unknown", evidence });
			throw fail(
				"GIT_STAGING_COMMIT_UNKNOWN",
				`Commit result needs inspection; preserve operation ${id} and do not repeat commit. ${(e as Error).message}`,
			);
		}
		await updateOperation(store, id, { status: "rejected", evidence });
		await store.mark(
			(e as GitStagingKernelError).code === "GIT_STAGING_STALE_VERSION" ? "stale" : "ready",
			(e as Error).message,
			{ operationId: id, fenceToken: evidence.fenceToken },
		);
		throw e;
	} finally {
		if (nativeLock) {
			await nativeLock.close();
			if (!invoked && !confirmed)
				await releaseNativeLock(repo, store, id, evidence).catch(() => {});
		}
	}
}
export async function recoverChangelistCommit(
	repo: ChangelistRepository,
	store: ChangelistStore,
	operationId: string,
	signal?: AbortSignal,
	authorizedPaths?: readonly string[],
) {
	let operation = store.db
		.query("SELECT * FROM commit_operations WHERE id=?")
		.get(operationId) as CommitOperation | null;
	if (!operation) throw fail("GIT_STAGING_NOT_FOUND", "Commit recovery operation does not exist");
	let evidence = JSON.parse(operation.evidence_json) as Evidence;
	if (operation.status === "finished")
		return result(
			store,
			operation,
			"applied",
			await cleanupCompletedCommit(repo, operation, evidence, signal),
		);
	if (operation.status === "rejected")
		throw fail("GIT_STAGING_COMMIT_REJECTED", "This operation did not create a commit");
	if (!evidence.fenceToken || evidence.fenceToken !== operation.fence_token)
		throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Operation fencing evidence does not match SQLite");
	if (evidence.leaseUntil > Date.now())
		throw fail("GIT_STAGING_LOCKED", "The commit producer still owns this operation");
	if (await readChangelistMergeHead(repo, signal))
		throw fail(
			"GIT_STAGING_REPOSITORY_BUSY",
			"Finish the current native merge before recovering the changelist commit",
		);
	const head = await currentChangelistHead(repo, signal);
	const receiptBytes = await readBoundedFile(
		join(evidence.directory, `commit-${evidence.fenceToken}.receipt.json`),
		100 * 1024 * 1024,
	);
	if (
		(operation.status === "reserved" || operation.status === "prepared") &&
		!operation.commit_oid &&
		!receiptBytes &&
		head.head === operation.head_oid &&
		head.tree === operation.head_tree &&
		head.headTarget === evidence.headTarget
	) {
		const previousFence = operation.fence_token;
		await store.transaction(() => {
			const current = store.assertOperationFence(operationId, previousFence);
			const saved = JSON.parse(current.evidence_json) as Evidence;
			if (
				(current.status !== "reserved" && current.status !== "prepared") ||
				saved.leaseUntil > Date.now()
			)
				throw fail("GIT_STAGING_LOCKED", "Another producer owns this operation");
			assertHeadSync(repo, head.head, head.headFile, head.headTarget);
			if (saved.lockIdentity && lockInfoSync(`${repo.index}.lock`)) {
				assertOwnedLockSync(repo, saved);
				unlinkSync(`${repo.index}.lock`);
			}
			evidence = { ...saved, fenceToken: randomUUID(), leaseUntil: 0 };
			store.db
				.query(
					"UPDATE commit_operations SET status='rejected',evidence_json=?,fence_token=? WHERE id=?",
				)
				.run(evidenceJson(evidence), evidence.fenceToken, operationId);
			store.db.query("UPDATE workspace_state SET state='stale',reason=NULL WHERE id=1").run();
		});
		return result(
			store,
			operation,
			"applied",
			"The interrupted preparation was cancelled without creating a commit; synchronize before writing",
		);
	}
	if (receiptBytes) {
		const saved = JSON.parse(receiptBytes.toString()) as {
			commitOid: string;
			expectedTree: string;
			evidence: Evidence;
		};
		if (saved.expectedTree !== operation.expected_tree)
			throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Commit receipt does not match the reserved tree");
		operation = { ...operation, commit_oid: saved.commitOid };
	}
	if (
		!operation.expected_tree ||
		!head.head ||
		head.head === operation.head_oid ||
		head.tree !== operation.expected_tree ||
		head.headTarget !== evidence.headTarget ||
		(operation.commit_oid && head.head !== operation.commit_oid)
	)
		throw fail(
			"GIT_STAGING_COMMIT_UNKNOWN",
			"Current HEAD does not prove the reserved commit result",
		);
	const parents = (
		await git(repo, ["rev-list", "--parents", "-n", "1", head.head], undefined, { signal })
	).stdout
		.trim()
		.split(" ")
		.slice(1);
	if (parents.join() !== (operation.head_oid ?? ""))
		throw fail(
			"GIT_STAGING_COMMIT_UNKNOWN",
			"Commit recovery parents do not match the reservation",
		);
	const previousFence = operation.fence_token,
		newFence = randomUUID();
	await store.transaction(() => {
		const current = store.assertOperationFence(operationId, previousFence);
		if (current.status === "finished" || current.status === "rejected")
			throw fail("GIT_STAGING_STALE_VERSION", "The recovery result already changed");
		const old = JSON.parse(current.evidence_json) as Evidence;
		if (old.leaseUntil > Date.now())
			throw fail("GIT_STAGING_LOCKED", "Another producer owns recovery");
		assertHeadSync(repo, head.head, head.headFile, head.headTarget);
		evidence = { ...old, fenceToken: newFence, leaseUntil: Date.now() + 5 * 60_000 };
		operation = { ...current, commit_oid: head.head, status: "recovering", fence_token: newFence };
		store.db
			.query(
				"UPDATE commit_operations SET status='recovering',commit_oid=?,evidence_json=?,fence_token=? WHERE id=? AND fence_token=?",
			)
			.run(head.head, evidenceJson(evidence), newFence, operationId, previousFence);
	});
	try {
		if (!evidence.nativeInstalled) {
			const original =
				evidence.nativeBefore === null
					? null
					: await readBoundedFile(evidence.nativeBefore, 64 * 1024 * 1024);
			if (
				evidence.nativeBefore &&
				(!original ||
					createHash("sha256").update(original).digest("hex") !== evidence.nativeBeforeHash)
			)
				throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Native index backup evidence changed");
			const candidate = join(evidence.directory, `recovery-${randomUUID()}.index`);
			if (original) {
				const copy = await open(
					candidate,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					await copy.writeFile(original);
					await copy.sync();
				} finally {
					await copy.close();
				}
				await git(repo, ["read-tree", "-m", "-i", operation.head_tree, head.tree], candidate, {
					signal,
				});
			} else await git(repo, ["read-tree", head.tree], candidate, { signal });
			const installed = await readBoundedFile(candidate, 64 * 1024 * 1024);
			if (!installed) throw fail("GIT_STAGING_COMMIT_UNKNOWN", "Recovery index is missing");
			const prepared = await prepareNativeInstall(evidence, installed, candidate);
			await installNativeIndex(
				repo,
				store,
				operationId,
				evidence,
				installed,
				prepared,
				original,
				head,
			);
			await receipt(evidence, head.head, head.tree);
			await updateOperation(store, operationId, {
				status: "committed",
				commit: head.head,
				evidence,
			});
		}
		return await finish(repo, store, operation, evidence, signal, authorizedPaths);
	} catch (e) {
		evidence.leaseUntil = 0;
		await updateOperation(store, operationId, { status: "recoverable", evidence }).catch(() => {});
		throw e;
	}
}
