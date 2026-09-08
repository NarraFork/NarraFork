import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parentPort } from "node:worker_threads";
import type { FileChangeBlobRef, FileChangeState } from "../../shared/file-change-protocol";
import { FileChangeBlobStore } from "./file-change-blob-store";
import { localDirectoryIdentity, localObjectIdentity } from "./file-change-local-io";

/** Display budgets only. Exceeding one returns unknown, never partial hashes. */
export const CURRENT_DIFF_FILE_BYTES = 4 * 1024 * 1024;
export const CURRENT_DIFF_TOTAL_BYTES = 64 * 1024 * 1024;
export const CURRENT_DIFF_PATHS = 200;
const GIT_METADATA_BYTES = 512 * 1024;

export interface GitObjectVersion {
	oid: string;
	mode: string;
}
export interface CurrentFileBaseline {
	filePath: string;
	canonicalPath: string;
	status: string;
	head: GitObjectVersion | null;
	index: GitObjectVersion | null;
	indexState: FileChangeState;
	worktreeState: FileChangeState;
	/** Live descriptor identity/ctime/mtime, separate from semantic content identity. */
	worktreeVersion: string | null;
}
export interface CurrentGitBaseline {
	canonicalRoot: string;
	rootIdentity: string;
	sourceInstanceId: string | null;
	sourceVersion: string | null;
	headSha: string | null;
	/** Includes all status records and requested stage blobs, not a timestamp. */
	gitVersion: string;
	version: string;
	clean: boolean;
	pathsTruncated: boolean;
	files: CurrentFileBaseline[];
}
export type CurrentBaselineRequest =
	| { action: "snapshot"; workspacePath: string; filePaths?: string[]; privateRoot: string }
	| { action: "verify_blobs"; privateRoot: string; refs: FileChangeBlobRef[] };
export type CurrentBaselineResponse = CurrentGitBaseline | string[];

const port = parentPort;
if (port) {
	const controller = new AbortController();
	port.on("message", async (message: CurrentBaselineRequest | { action: "cancel" }) => {
		if (message.action === "cancel") {
			controller.abort();
			return;
		}
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
		try {
			const value =
				message.action === "snapshot"
					? await snapshot(message, signal)
					: await verifyBlobs(message, signal);
			port.postMessage({ value });
		} catch (error) {
			port.postMessage({
				error: signal.aborted
					? "cancelled"
					: error instanceof Error
						? error.message.slice(0, 100)
						: "unavailable",
			});
		}
	});
}

async function canonicalPath(path: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	// Match backend semantics for Bun's POSIX backslash realpath bug without loading
	// the backend/settings dependency graph in every ordinary fingerprint worker.
	if (process.platform !== "win32" && path.includes("\\")) {
		const { localBackend } = await import("../lib/agent/execution/local-backend");
		return (await localBackend.resolvePathIdentity(path, { signal })).canonicalPath;
	}
	return realpath(path);
}

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
function unknown(
	reason: "unsupported_object" | "budget_exceeded" | "unreadable" = "unreadable",
): FileChangeState {
	return { kind: "unknown", reason };
}

/** Byte-oriented Git reads. Kill this direct child at the input/timeout boundary. */
async function git(
	cwd: string,
	args: string[],
	signal: AbortSignal,
	maximum = GIT_METADATA_BYTES,
): Promise<{ code: number; bytes: Buffer }> {
	signal.throwIfAborted();
	const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			HOME: process.env.HOME,
			USERPROFILE: process.env.USERPROFILE,
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			GIT_NO_REPLACE_OBJECTS: "1",
			LC_ALL: "C",
		},
	});
	let failure: string | undefined;
	const stop = (reason: string) => {
		failure ??= reason;
		try {
			child.kill("SIGKILL");
		} catch {}
	};
	const abort = () => stop("cancelled");
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timer = setTimeout(() => stop("git_timeout"), 3000);
	async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of stream) {
			if (chunk.byteLength > limit - bytes) {
				stop("budget_exceeded");
				continue;
			}
			if (!failure) {
				chunks.push(chunk);
				bytes += chunk.byteLength;
			}
		}
		return Buffer.concat(chunks, bytes);
	}
	try {
		const [bytes, , code] = await Promise.all([
			collect(child.stdout, maximum),
			collect(child.stderr, 8192),
			child.exited,
		]);
		if (failure) throw new Error(failure);
		return { code, bytes };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

function parseStatus(bytes: Buffer): Map<string, string> {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text && !text.endsWith("\0")) throw new Error("invalid_git_status");
	const records = text.split("\0");
	const rows = new Map<string, string>();
	for (let i = 0; i < records.length - 1; i++) {
		const record = records[i];
		if (record.length < 4 || record[2] !== " ") throw new Error("invalid_git_status");
		const status = record.slice(0, 2);
		rows.set(record.slice(3), status);
		if (/[RC]/.test(status)) i++;
	}
	return rows;
}
function parseObjects(bytes: Buffer, stage: boolean): Map<string, GitObjectVersion> {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text && !text.endsWith("\0")) throw new Error("invalid_git_objects");
	const result = new Map<string, GitObjectVersion>();
	for (const record of text.split("\0").slice(0, -1)) {
		const tab = record.indexOf("\t");
		const parts = record.slice(0, tab).split(" ");
		const mode = parts[0];
		const oid = parts[stage ? 1 : 2];
		if (tab < 0 || !/^[0-7]{6}$/.test(mode) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
			throw new Error("invalid_git_objects");
		const path = record.slice(tab + 1);
		// An unmerged index has multiple stages, none of which is a stage-0 target.
		if (stage && parts[2] !== "0") result.set(path, { mode: "unmerged", oid });
		else if (result.get(path)?.mode !== "unmerged") result.set(path, { mode, oid });
	}
	return result;
}

async function sourceIdentity(
	privateRoot: string,
): Promise<{ id: string; version: string } | null> {
	try {
		const path = join(privateRoot, "file-change-source.json");
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat({ bigint: true });
			if (
				!stat.isFile() ||
				stat.nlink !== 1n ||
				stat.size > 512n ||
				(process.platform !== "win32" &&
					((stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.geteuid?.() ?? -1)))
			)
				return null;
			const bytes = Buffer.alloc(513);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const final = await lstat(path, { bigint: true });
			if (
				bytesRead > 512 ||
				stat.size !== BigInt(bytesRead) ||
				fileVersion(stat) !== fileVersion(final)
			)
				return null;
			const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
			if (value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id))
				return null;
			return {
				id: value.id,
				version: `${fileVersion(final)}:${hash(bytes.subarray(0, bytesRead))}`,
			};
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
function fileVersion(
	stat: Awaited<ReturnType<typeof lstat>> | import("node:fs").BigIntStats,
): string {
	if (!("mtimeNs" in stat)) throw new Error("missing_nanosecond_stat");
	return `${localObjectIdentity(stat)}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function fingerprintFile(
	path: string,
	budget: { remaining: number },
	signal: AbortSignal,
): Promise<{ state: FileChangeState; version: string | null }> {
	let observedEntry = false;
	try {
		signal.throwIfAborted();
		const entry = await lstat(path, { bigint: true });
		observedEntry = true;
		const version = fileVersion(entry);
		if (!entry.isFile() || entry.nlink !== 1n)
			return { state: unknown("unsupported_object"), version };
		if (entry.size > BigInt(Math.min(CURRENT_DIFF_FILE_BYTES, budget.remaining)))
			return { state: unknown("budget_exceeded"), version };
		if (resolve(await canonicalPath(path, signal)) !== resolve(path))
			return { state: unknown("unsupported_object"), version };
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			if (fileVersion(await file.stat({ bigint: true })) !== version) throw new Error("stale");
			const digest = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let offset = 0;
			while (offset < Number(entry.size)) {
				signal.throwIfAborted();
				const read = await file.read(
					buffer,
					0,
					Math.min(buffer.length, Number(entry.size) - offset),
					offset,
				);
				if (!read.bytesRead) throw new Error("stale");
				digest.update(buffer.subarray(0, read.bytesRead));
				offset += read.bytesRead;
			}
			if (
				fileVersion(await file.stat({ bigint: true })) !== version ||
				fileVersion(await lstat(path, { bigint: true })) !== version
			)
				throw new Error("stale");
			budget.remaining -= offset;
			return {
				state: {
					kind: "regular",
					mode: Number(entry.mode & 0o7777n),
					blob: { algorithm: "sha256", digest: digest.digest("hex"), sizeBytes: offset },
				},
				version,
			};
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			if (observedEntry) throw new Error("stale");
			return { state: { kind: "absent" }, version: null };
		}
		if (error instanceof Error && error.message === "stale") throw error;
		signal.throwIfAborted();
		return { state: unknown(), version: null };
	}
}

async function snapshot(
	input: Extract<CurrentBaselineRequest, { action: "snapshot" }>,
	signal: AbortSignal,
): Promise<CurrentGitBaseline> {
	const canonicalRoot = await canonicalPath(input.workspacePath, signal);
	const rootIdentity = await localDirectoryIdentity(canonicalRoot);
	const top = await git(canonicalRoot, ["rev-parse", "--show-toplevel"], signal, 8192);
	if (top.code !== 0) throw new Error("unsupported_repository");
	const repo = await canonicalPath(top.bytes.toString("utf8").replace(/\r?\n$/, ""), signal);
	const [head, statusResult, source] = await Promise.all([
		git(repo, ["rev-parse", "--verify", "HEAD"], signal, 1024),
		git(
			repo,
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
			signal,
		),
		sourceIdentity(input.privateRoot),
	]);
	if (statusResult.code !== 0) throw new Error("git_status_failed");
	const headSha = head.code === 0 ? head.bytes.toString("ascii").trim() : null;
	if (headSha !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha))
		throw new Error("invalid_head");
	const statuses = parseStatus(statusResult.bytes);
	const relativeGit = (path: string) => {
		const p = relative(repo, path);
		return process.platform === "win32" ? p.replaceAll("\\", "/") : p;
	};
	const candidates =
		input.filePaths ??
		[...statuses.keys()].map((path) => relative(canonicalRoot, resolve(repo, path)));
	const requested = [...new Set(candidates)].slice(0, CURRENT_DIFF_PATHS);
	const targets = requested.map((filePath) => {
		if (
			!filePath ||
			filePath.includes("\0") ||
			Buffer.byteLength(filePath) > 8192 ||
			isAbsolute(filePath)
		)
			throw new Error("invalid_path");
		const canonicalPath = resolve(canonicalRoot, filePath);
		if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) throw new Error("invalid_path");
		return { filePath, canonicalPath, gitPath: relativeGit(canonicalPath) };
	});
	const literals = targets.map((target) => `:(literal)${target.gitPath}`);
	const [indexResult, headResult] = literals.length
		? await Promise.all([
				git(repo, ["ls-files", "--stage", "-z", "--", ...literals], signal),
				headSha
					? git(repo, ["ls-tree", "-z", headSha, "--", ...literals], signal)
					: Promise.resolve({ code: 0, bytes: Buffer.alloc(0) }),
			])
		: [
				{ code: 0, bytes: Buffer.alloc(0) },
				{ code: 0, bytes: Buffer.alloc(0) },
			];
	if (indexResult.code !== 0 || headResult.code !== 0) throw new Error("git_index_failed");
	const indexed = parseObjects(indexResult.bytes, true);
	const committed = parseObjects(headResult.bytes, false);
	const budget = { remaining: CURRENT_DIFF_TOTAL_BYTES };
	const blobStates = new Map<string, FileChangeState>();
	const files: CurrentFileBaseline[] = [];
	for (const target of targets) {
		signal.throwIfAborted();
		const status = statuses.get(target.gitPath) ?? "  ";
		const index = indexed.get(target.gitPath) ?? null;
		let indexState: FileChangeState = { kind: "absent" };
		if (index) {
			indexState = unknown("unsupported_object");
			if (["100644", "100755"].includes(index.mode) && status[0] !== " " && status[0] !== "?") {
				indexState = blobStates.get(index.oid) ?? unknown("budget_exceeded");
				if (!blobStates.has(index.oid) && budget.remaining > 0) {
					try {
						const blob = await git(
							repo,
							["cat-file", "blob", index.oid],
							signal,
							Math.min(CURRENT_DIFF_FILE_BYTES, budget.remaining),
						);
						if (blob.code !== 0) throw new Error("missing_git_blob");
						budget.remaining -= blob.bytes.length;
						indexState = {
							kind: "regular",
							mode: index.mode === "100755" ? 0o755 : 0o644,
							blob: { algorithm: "sha256", digest: hash(blob.bytes), sizeBytes: blob.bytes.length },
						};
						blobStates.set(index.oid, indexState);
					} catch {
						signal.throwIfAborted();
					}
				}
				if (indexState.kind === "regular")
					indexState = { ...indexState, mode: index.mode === "100755" ? 0o755 : 0o644 };
			}
		}
		const worktree = await fingerprintFile(target.canonicalPath, budget, signal);
		files.push({
			filePath: target.filePath,
			canonicalPath: target.canonicalPath,
			status,
			head: committed.get(target.gitPath) ?? null,
			index,
			indexState,
			worktreeState: worktree.state,
			worktreeVersion: worktree.version,
		});
	}
	if (
		(await canonicalPath(input.workspacePath, signal)) !== canonicalRoot ||
		(await localDirectoryIdentity(canonicalRoot)) !== rootIdentity
	)
		throw new Error("stale");
	const gitVersion = hash(
		JSON.stringify([
			headSha,
			statusResult.bytes.toString("base64"),
			indexResult.bytes.toString("base64"),
			headResult.bytes.toString("base64"),
		]),
	);
	const value = {
		canonicalRoot,
		rootIdentity,
		sourceInstanceId: source?.id ?? null,
		sourceVersion: source?.version ?? null,
		headSha,
		gitVersion,
		clean: statuses.size === 0,
		pathsTruncated: candidates.length > CURRENT_DIFF_PATHS,
		files,
	};
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("budget_exceeded");
	return { ...value, version: hash(serialized) };
}

async function verifyBlobs(
	input: Extract<CurrentBaselineRequest, { action: "verify_blobs" }>,
	signal: AbortSignal,
): Promise<string[]> {
	const refs = [...new Map(input.refs.map((ref) => [ref.digest, ref])).values()];
	if (refs.length > CURRENT_DIFF_PATHS * 3) throw new Error("budget_exceeded");
	const store = new FileChangeBlobStore({ root: join(input.privateRoot, "file-change-blobs") });
	let remaining = CURRENT_DIFF_TOTAL_BYTES;
	const verified: string[] = [];
	for (const ref of refs) {
		signal.throwIfAborted();
		if (ref.sizeBytes > CURRENT_DIFF_FILE_BYTES || ref.sizeBytes > remaining) continue;
		remaining -= ref.sizeBytes;
		try {
			await store.readBytes(ref, { signal, maxBytes: CURRENT_DIFF_FILE_BYTES, timeoutMs: 2000 });
			verified.push(ref.digest);
		} catch {
			signal.throwIfAborted();
		}
	}
	return verified;
}
