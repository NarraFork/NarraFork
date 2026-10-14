import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const LEGACY_LINKED_WORKTREE_LIMITS = Object.freeze({
	fileBytes: 256 * 1024,
	totalBytes: 1024 * 1024,
	inventoryBytes: 64 * 1024,
	inventoryEntries: 128,
	objectEntries: 4096,
	evidenceBytes: 16 * 1024,
	timeoutMs: 4000,
	concurrency: 2,
	guardEntries: 128,
	guardMs: 10,
	guardMaxAgeMs: 1000,
});
export interface LegacyLinkedWorktreeInput {
	/** Caller has already established local/private ownership and chapter inventory membership. */
	projectRoot: string;
	worktreePath: string;
	expectedBranch: string;
	signal?: AbortSignal;
}
export interface LegacyLinkedMetadataIdentity {
	path: string;
	kind: "directory" | "file" | "absent";
	dev?: string;
	ino?: string;
	size?: string;
	mtimeNs?: string;
	ctimeNs?: string;
	contentDigest?: string;
}
export interface LegacyLinkedWorktreeEvidence {
	version: 1;
	projectRoot: string;
	top: string;
	common: string;
	adminDir: string;
	gitfile: string;
	branch: string;
	head: string;
	registration: { id: string; worktree: string; branch: string; head: string };
	backpointer: string;
	/** Critical root/workspace/common/admin dev+ino and bounded file digests; ancestors are in manifest digest. */
	metadata: LegacyLinkedMetadataIdentity[];
	inventoryDigest: string;
	/** Hash of the full bounded, twice-sampled metadata identity manifest (including absences). */
	metadataManifestDigest: string;
	digest: string;
}
export class LegacyLinkedWorktreeProbeError extends Error {
	constructor(
		public readonly code: "unsafe" | "changed" | "budget" | "busy",
		message: string,
	) {
		super(message);
		this.name = "LegacyLinkedWorktreeProbeError";
	}
}
let active = 0;
const liveGuards = new WeakMap<
	LegacyLinkedWorktreeEvidence,
	{
		createdAt: number;
		serialized: string;
		facts: LegacyLinkedMetadataIdentity[];
	}
>();
function fail(message: string, code: LegacyLinkedWorktreeProbeError["code"] = "unsafe"): never {
	throw new LegacyLinkedWorktreeProbeError(code, message);
}
async function digest(bytes: Uint8Array): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");
}
function cleanPath(path: string): string {
	if (!isAbsolute(path) || /[\0\r\n]/.test(path) || resolve(path) !== path)
		fail("Expected an absolute normalized path");
	return path;
}
class Probe {
	readonly facts = new Map<string, LegacyLinkedMetadataIdentity>();
	bytes = 0;
	constructor(
		readonly signal: AbortSignal,
		readonly deadline: number,
	) {}
	check() {
		this.signal.throwIfAborted();
		if (Date.now() >= this.deadline) fail("Probe deadline exceeded", "budget");
	}
	async identity(path: string): Promise<LegacyLinkedMetadataIdentity> {
		this.check();
		const stat = await lstat(path, { bigint: true }).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		this.check();
		if (!stat) return { path, kind: "absent" };
		if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
			fail(`Nonordinary metadata: ${path}`);
		return {
			path,
			kind: stat.isDirectory() ? "directory" : "file",
			dev: String(stat.dev),
			ino: String(stat.ino),
			size: String(stat.size),
			mtimeNs: String(stat.mtimeNs),
			ctimeNs: String(stat.ctimeNs),
		};
	}
	record(fact: LegacyLinkedMetadataIdentity) {
		const previous = this.facts.get(fact.path);
		if (previous && JSON.stringify(previous) !== JSON.stringify(fact))
			fail(`Metadata changed: ${fact.path}`, "changed");
		this.facts.set(fact.path, fact);
	}
	async directory(path: string, ancestor = false) {
		const fact = await this.identity(path);
		if (fact.kind !== "directory" || (await realpath(path)) !== path)
			fail(`Noncanonical directory: ${path}`);
		// Ancestor directory contents are unrelated to repository identity (e.g. shared /tmp).
		this.record(ancestor ? { path, kind: fact.kind, dev: fact.dev, ino: fact.ino } : fact);
	}
	async ancestors(path: string) {
		const chain: string[] = [];
		for (let cursor = path; ; cursor = dirname(cursor)) {
			chain.push(cursor);
			if (dirname(cursor) === cursor) break;
		}
		for (const entry of chain.reverse()) await this.directory(entry, true);
	}
	async file(path: string, optional = false): Promise<string | null> {
		const before = await this.identity(path);
		if (before.kind === "absent" && optional) {
			this.record(before);
			return null;
		}
		if (before.kind !== "file") fail(`Expected ordinary file: ${path}`);
		const size = Number(before.size);
		if (
			size > LEGACY_LINKED_WORKTREE_LIMITS.fileBytes ||
			this.bytes + size > LEGACY_LINKED_WORKTREE_LIMITS.totalBytes
		)
			fail("Metadata read budget exceeded", "budget");
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat({ bigint: true });
			if (
				!stat.isFile() ||
				String(stat.dev) !== before.dev ||
				String(stat.ino) !== before.ino ||
				String(stat.size) !== before.size
			)
				fail("Metadata replaced during open", "changed");
			const bytes = Buffer.alloc(size + 1);
			let offset = 0;
			while (offset < bytes.length) {
				this.check();
				const read = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!read.bytesRead) break;
				offset += read.bytesRead;
			}
			if (offset !== size) fail("Metadata changed during read", "changed");
			const after = await this.identity(path);
			const handleAfter = await file.stat({ bigint: true });
			if (
				JSON.stringify(before) !== JSON.stringify(after) ||
				handleAfter.mtimeNs !== stat.mtimeNs ||
				handleAfter.ctimeNs !== stat.ctimeNs
			)
				fail("Metadata changed during read", "changed");
			this.bytes += size;
			const content = bytes.subarray(0, size);
			this.record({ ...before, contentDigest: await digest(content) });
			this.check();
			// index is binary: callers only interpret text for known text metadata.
			return content.toString("utf8");
		} finally {
			await file.close();
		}
	}
	async absent(path: string) {
		const fact = await this.identity(path);
		if (fact.kind !== "absent") fail(`Unsupported active/escaping metadata: ${path}`);
		this.record(fact);
	}
	async tree(path: string, budget: { count: number }) {
		await this.directory(path);
		const directory = await opendir(path);
		try {
			while (true) {
				this.check();
				const item = await directory.read();
				if (!item) break;
				if (++budget.count > LEGACY_LINKED_WORKTREE_LIMITS.objectEntries)
					fail("Object namespace budget exceeded", "budget");
				const child = join(path, item.name);
				const fact = await this.identity(child);
				if (fact.kind === "directory") await this.tree(child, budget);
				else if (fact.kind !== "file") fail("Object namespace changed", "changed");
				// Do not read/hash potentially huge pack/object files. Namespace identities suffice.
			}
		} finally {
			await directory.close();
		}
	}
	async git(cwd: string, args: string[]): Promise<string> {
		this.check();
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
		);
		Object.assign(env, {
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
			LANG: "C",
		});
		return new Promise((accept, reject) => {
			const child = spawn("git", ["--no-optional-locks", "-C", cwd, ...args], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const chunks: Buffer[] = [];
			let bytes = 0;
			let failure: unknown;
			const stop = (error: unknown) => {
				failure ??= error;
				child.kill("SIGKILL");
			};
			const abort = () => stop(this.signal.reason ?? new Error("Aborted"));
			const timer = setTimeout(
				() => stop(new LegacyLinkedWorktreeProbeError("budget", "Git timeout")),
				Math.max(1, this.deadline - Date.now()),
			);
			this.signal.addEventListener("abort", abort, { once: true });
			const receive = (chunk: Buffer, stdout: boolean) => {
				bytes += chunk.length;
				if (bytes > LEGACY_LINKED_WORKTREE_LIMITS.inventoryBytes)
					stop(new LegacyLinkedWorktreeProbeError("budget", "Git output limit exceeded"));
				else if (stdout) chunks.push(chunk);
			};
			child.stdout.on("data", (chunk) => receive(chunk, true));
			child.stderr.on("data", (chunk) => receive(chunk, false));
			child.on("error", (error) => {
				failure ??= error;
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				this.signal.removeEventListener("abort", abort);
				if (failure) reject(failure);
				else if (code !== 0)
					reject(new LegacyLinkedWorktreeProbeError("unsafe", "Read-only Git probe failed"));
				else accept(Buffer.concat(chunks).toString("utf8"));
			});
			if (this.signal.aborted) abort();
		});
	}
	async resample() {
		// A second full bounded sample catches replacement, content edits and absent->present transitions.
		const first = [...this.facts.values()];
		for (const fact of first) {
			if (fact.contentDigest) await this.file(fact.path);
			else if (fact.kind === "directory" && !fact.mtimeNs) await this.directory(fact.path, true);
			else this.record(await this.identity(fact.path));
		}
	}
}
const ACTIVE_METADATA = [
	"MERGE_HEAD",
	"MERGE_MSG",
	"MERGE_MODE",
	"AUTO_MERGE",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"REBASE_HEAD",
	"rebase-merge",
	"rebase-apply",
	"sequencer",
	"BISECT_LOG",
	"BISECT_START",
	"index.lock",
	"HEAD.lock",
	"config.lock",
	"packed-refs.lock",
	"shallow",
	"info/grafts",
];
function oneLine(value: string | null): string {
	if (value === null) fail("Missing required metadata");
	const result = value.replace(/\r?\n$/, "");
	if (!result || /[\0\r\n\uFFFD]/.test(result)) fail("Ambiguous metadata line");
	return result;
}
async function inspect(
	input: LegacyLinkedWorktreeInput,
	probe: Probe,
): Promise<Omit<LegacyLinkedWorktreeEvidence, "digest">> {
	const projectRoot = cleanPath(input.projectRoot);
	const top = cleanPath(input.worktreePath);
	if (projectRoot === top) fail("Expected a linked worktree, not main checkout");
	if (!input.expectedBranch || /[\0\r\n]/.test(input.expectedBranch))
		fail("Invalid chapter branch");
	const branch = input.expectedBranch.startsWith("refs/heads/")
		? input.expectedBranch
		: `refs/heads/${input.expectedBranch}`;
	const common = join(projectRoot, ".git");
	const gitfile = join(top, ".git");
	await probe.ancestors(projectRoot);
	await probe.ancestors(top);
	await probe.directory(common);
	await probe.directory(join(common, "worktrees"));
	const gitline = oneLine(await probe.file(gitfile));
	if (!gitline.startsWith("gitdir: ")) fail("Invalid linked worktree gitfile");
	// First subset accepts canonical absolute gitfiles, as emitted by local Git worktree add.
	// Do not let lexical '..' normalization hide a symlink hop before Git reads configuration.
	const adminDir = cleanPath(gitline.slice(8));
	if (dirname(adminDir) !== join(common, "worktrees"))
		fail("Admin must be a direct authorized worktrees child");
	await probe.directory(adminDir);
	const backpointer = oneLine(await probe.file(join(adminDir, "gitdir")));
	if (!isAbsolute(backpointer) || backpointer !== gitfile)
		fail("Registration backpointer mismatch");
	const commonPointer = oneLine(await probe.file(join(adminDir, "commondir")));
	if (
		(commonPointer !== "../.." && commonPointer !== common) ||
		resolve(adminDir, commonPointer) !== common ||
		(await realpath(commonPointer === common ? commonPointer : `${adminDir}/../..`)) !== common
	)
		fail("Common directory closure mismatch");
	const headLine = oneLine(await probe.file(join(adminDir, "HEAD")));
	if (headLine !== `ref: ${branch}`) fail("Chapter branch mismatch or detached HEAD");
	// No unconstrained traversal via a branch name supplied by stale chapter inventory.
	const branchFile = resolve(common, branch);
	if (!branchFile.startsWith(`${join(common, "refs", "heads")}/`)) fail("Invalid branch ref path");
	const refParent = dirname(branchFile);
	// Parent may be absent when packed; existing parents must still be ordinary directories.
	for (let cursor = refParent; cursor !== common; cursor = dirname(cursor)) {
		const fact = await probe.identity(cursor);
		if (fact.kind === "absent") probe.record(fact);
		else await probe.directory(cursor);
	}
	await probe.file(branchFile, true);
	for (const root of [common, adminDir]) {
		for (const name of ACTIVE_METADATA) await probe.absent(join(root, name));
		for (const name of ["HEAD", "config", "config.worktree", "packed-refs", "index"])
			await probe.file(join(root, name), true);
	}
	await probe.absent(`${branchFile}.lock`);
	await probe.absent(join(common, "objects", "info", "alternates"));
	await probe.absent(join(common, "objects", "info", "http-alternates"));
	await probe.absent(join(adminDir, "objects"));
	// This deliberately conservative first subset declines oversized namespaces and all metadata
	// symlinks, instead of following them or loading objects/packfiles on the HTTP thread.
	await probe.tree(common, { count: 0 });
	const inventoryDirectory = await opendir(join(common, "worktrees"));
	let entries = 0;
	try {
		while (true) {
			probe.check();
			const item = await inventoryDirectory.read();
			if (!item) break;
			if (++entries > LEGACY_LINKED_WORKTREE_LIMITS.inventoryEntries || !item.isDirectory())
				fail("Linked worktree inventory limit/type", "budget");
			const admin = join(common, "worktrees", item.name);
			await probe.directory(admin);
			const pointer = oneLine(await probe.file(join(admin, "gitdir")));
			if (!isAbsolute(pointer) || basename(pointer) !== ".git")
				fail("Invalid inventory registration");
		}
	} finally {
		await inventoryDirectory.close();
	}
	// --file with --no-includes parses ONLY this already-sampled file; do not initialize a
	// repository with an unvalidated include/core.worktree configuration first.
	for (const root of [common, adminDir]) {
		for (const name of ["config", "config.worktree"]) {
			const configPath = join(root, name);
			if (probe.facts.get(configPath)?.kind !== "file") continue;
			const config = await probe.git(dirname(projectRoot), [
				"config",
				"--file",
				configPath,
				"--no-includes",
				"--null",
				"--list",
			]);
			for (const entry of config.split("\0").filter(Boolean)) {
				const key = entry.split("\n", 1)[0]?.toLowerCase() ?? "";
				if (
					key.startsWith("include.") ||
					key.startsWith("includeif.") ||
					key === "core.worktree" ||
					(key === "core.bare" && entry.split("\n")[1] !== "false") ||
					key === "extensions.partialclone" ||
					key === "extensions.refstorage"
				)
					fail("Unsupported escaping repository configuration");
			}
		}
	}
	const revArgs = [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
		"--git-common-dir",
		"--absolute-git-dir",
	];
	const rootRev = (await probe.git(projectRoot, revArgs)).trimEnd().split("\n");
	if (rootRev.join("\n") !== [projectRoot, common, common].join("\n"))
		fail("Project is not authorized main checkout");
	const wtRev = (await probe.git(top, revArgs)).trimEnd().split("\n");
	if (wtRev.join("\n") !== [top, common, adminDir].join("\n"))
		fail("Git disagrees with closed linked identity");
	const head = oneLine(await probe.git(top, ["rev-parse", "--verify", "HEAD"]));
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) fail("Invalid HEAD object ID");
	if (oneLine(await probe.git(top, ["symbolic-ref", "--quiet", "HEAD"])) !== branch)
		fail("Branch changed", "changed");
	const inventory = await probe.git(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
	const records: string[][] = [];
	let record: string[] = [];
	for (const token of inventory.split("\0")) {
		if (!token) {
			if (record.length) records.push(record);
			record = [];
		} else record.push(token);
	}
	if (record.length) records.push(record);
	if (records.length > LEGACY_LINKED_WORKTREE_LIMITS.inventoryEntries + 1)
		fail("Inventory budget", "budget");
	const matching = records.filter((r) => r[0] === `worktree ${top}`);
	if (
		matching.length !== 1 ||
		!matching[0]?.includes(`HEAD ${head}`) ||
		!matching[0]?.includes(`branch ${branch}`) ||
		matching[0]?.some((r) => r === "detached" || r.startsWith("prunable"))
	)
		fail("Missing, prunable or mismatched linked registration");
	if (
		(await probe.git(projectRoot, ["worktree", "list", "--porcelain", "-z"])) !== inventory ||
		oneLine(await probe.git(top, ["rev-parse", "--verify", "HEAD"])) !== head
	)
		fail("Git identity changed during probe", "changed");
	await probe.resample();
	probe.check();
	const manifest = [...probe.facts.values()].sort((a, b) => a.path.localeCompare(b.path));
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	if (manifestBytes.length > LEGACY_LINKED_WORKTREE_LIMITS.totalBytes)
		fail("Metadata identity manifest budget exceeded", "budget");
	const critical = new Set([
		projectRoot,
		top,
		common,
		adminDir,
		gitfile,
		branchFile,
		join(common, "worktrees"),
		join(adminDir, "gitdir"),
		join(adminDir, "commondir"),
	]);
	for (const root of [common, adminDir]) {
		for (const name of ["HEAD", "config", "config.worktree", "packed-refs", "index"])
			critical.add(join(root, name));
	}
	return {
		version: 1,
		projectRoot,
		top,
		common,
		adminDir,
		gitfile,
		branch,
		head,
		registration: { id: basename(adminDir), worktree: top, branch, head },
		backpointer,
		metadata: manifest.filter((fact) => critical.has(fact.path)),
		metadataManifestDigest: await digest(manifestBytes),
		inventoryDigest: await digest(Buffer.from(inventory)),
	};
}
/** Strictly read-only. Throws rather than returning incomplete/ambiguous evidence. No DB or ACL access. */
export async function prepareLegacyLinkedWorktreeIdentity(
	input: LegacyLinkedWorktreeInput,
): Promise<LegacyLinkedWorktreeEvidence> {
	input.signal?.throwIfAborted();
	if (active >= LEGACY_LINKED_WORKTREE_LIMITS.concurrency) fail("Probe concurrency limit", "busy");
	active++;
	const deadline = Date.now() + LEGACY_LINKED_WORKTREE_LIMITS.timeoutMs;
	const timeout = AbortSignal.timeout(LEGACY_LINKED_WORKTREE_LIMITS.timeoutMs);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	try {
		const probe = new Probe(signal, deadline);
		const evidence = await inspect(input, probe);
		const result = { ...evidence, digest: await digest(Buffer.from(JSON.stringify(evidence))) };
		if (Buffer.byteLength(JSON.stringify(result)) > LEGACY_LINKED_WORKTREE_LIMITS.evidenceBytes)
			fail("Evidence budget exceeded", "budget");
		signal.throwIfAborted();
		const critical = new Set(result.metadata.map((fact) => fact.path));
		const registryRoot = join(result.common, "worktrees");
		const refFile = resolve(result.common, result.branch);
		liveGuards.set(result, {
			createdAt: Date.now(),
			serialized: JSON.stringify(result),
			facts: [...probe.facts.values()].filter(
				(fact) =>
					critical.has(fact.path) ||
					fact.kind === "absent" ||
					(fact.kind === "directory" && !fact.mtimeNs) ||
					refFile.startsWith(`${fact.path}/`) ||
					(dirname(fact.path) === registryRoot && fact.kind === "directory") ||
					(dirname(dirname(fact.path)) === registryRoot && basename(fact.path) === "gitdir"),
			),
		});
		return result;
	} finally {
		active--;
	}
}
export const probeLegacyLinkedWorktreeIdentity = prepareLegacyLinkedWorktreeIdentity;

/** Narrow, stat-only commit CAS guard. Accepts ONLY a live fresh object returned by this module,
 * not JSON/deserialized evidence. No file-content reads/hashing/Git/DB. Call with no intervening
 * await inside caller's synchronous claim+SQLite transaction after a full asynchronous re-probe.
 * Does not re-scan objects; not a filesystem lock nor cross-filesystem/DB atomicity guarantee.
 * At most 128 paths, 10ms checked between syscalls; an individual OS syscall cannot be preempted. */
export function assertLegacyLinkedWorktreeIdentityUnchangedSync(
	evidence: LegacyLinkedWorktreeEvidence,
): void {
	const guard = liveGuards.get(evidence);
	if (!guard || guard.serialized !== JSON.stringify(evidence))
		fail("Commit guard requires untampered in-process evidence", "changed");
	if (Date.now() - guard.createdAt > LEGACY_LINKED_WORKTREE_LIMITS.guardMaxAgeMs)
		fail("Commit guard evidence expired; re-probe required", "changed");
	if (guard.facts.length > LEGACY_LINKED_WORKTREE_LIMITS.guardEntries)
		fail("Commit guard path budget exceeded", "budget");
	const started = performance.now();
	for (const fact of guard.facts) {
		if (performance.now() - started > LEGACY_LINKED_WORKTREE_LIMITS.guardMs)
			fail("Commit guard time budget exceeded", "budget");
		const stat = (() => {
			try {
				return lstatSync(fact.path, { bigint: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		})();
		if (fact.kind === "absent") {
			if (stat) fail("Commit guard metadata appeared", "changed");
			continue;
		}
		if (
			!stat ||
			stat.isSymbolicLink() ||
			(fact.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
			String(stat.dev) !== fact.dev ||
			String(stat.ino) !== fact.ino ||
			(fact.size !== undefined && String(stat.size) !== fact.size) ||
			(fact.mtimeNs !== undefined && String(stat.mtimeNs) !== fact.mtimeNs) ||
			(fact.ctimeNs !== undefined && String(stat.ctimeNs) !== fact.ctimeNs)
		)
			fail("Commit guard metadata changed", "changed");
		if (fact.kind === "file") {
			const fd = openSync(
				fact.path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const opened = fstatSync(fd, { bigint: true });
				const after = lstatSync(fact.path, { bigint: true });
				if (
					!opened.isFile() ||
					after.isSymbolicLink() ||
					opened.dev !== stat.dev ||
					opened.ino !== stat.ino ||
					opened.size !== stat.size ||
					opened.mtimeNs !== stat.mtimeNs ||
					opened.ctimeNs !== stat.ctimeNs ||
					after.dev !== stat.dev ||
					after.ino !== stat.ino ||
					after.mtimeNs !== stat.mtimeNs ||
					after.ctimeNs !== stat.ctimeNs
				)
					fail("Commit guard metadata replaced", "changed");
			} finally {
				closeSync(fd);
			}
		}
	}
	if (performance.now() - started > LEGACY_LINKED_WORKTREE_LIMITS.guardMs)
		fail("Commit guard time budget exceeded", "budget");
}

/** Caller may compare immediately before its own claim/DB CAS. This is NOT a filesystem lock or
 * an atomic filesystem+DB transaction. Caller still owns permissions, claim exclusion and DB CAS.
 * Never persist a stale evidence as proof of current identity without re-probing. */
export async function revalidateLegacyLinkedWorktreeIdentity(
	input: LegacyLinkedWorktreeInput,
	expected: LegacyLinkedWorktreeEvidence,
): Promise<LegacyLinkedWorktreeEvidence> {
	if (expected.version !== 1) fail("Unsupported evidence version");
	const fresh = await prepareLegacyLinkedWorktreeIdentity(input);
	if (fresh.digest !== expected.digest) fail("Linked identity evidence changed", "changed");
	return fresh;
}
