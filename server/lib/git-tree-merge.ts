import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { AppError, catalogError } from "./errors";
import { GitMergeLimiter } from "./git-merge-limiter";
import { type ParsedTreeMergeResult, parseMergeTreeOutput } from "./git-tree-merge-output";
import { logger } from "./logger";
import { DEV_NULL } from "./platform";
import { type SafeSpawnOptions, type SafeSpawnResult, safeSpawn } from "./spawn";

/** -h must be the SOLE argument so Git can print usage outside a repository. */
export const MERGE_TREE_PROBE_ARGV: readonly string[] = ["git", "merge-tree", "-h"];
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_ATTRIBUTE_BYTES = 64 * 1024;
// Input and result budgets, NOT an OS disk quota. No user code may expand content
// during the fallback: filters are disabled and external merge drivers refused.
const MAX_FALLBACK_TREE_BYTES = 512 * 1024 * 1024;
const MAX_FALLBACK_ENTRIES = 50_000;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const fallbackSlots = new GitMergeLimiter(2, 16);
const RAW_ATTRIBUTES = "\n* -text -filter -working-tree-encoding -ident\n";

type GitConfig = ReadonlyArray<readonly [string, string]>;
interface MergeTreeCapabilities {
	writeTree: boolean;
	mergeBase: boolean;
}
let capabilities: Promise<MergeTreeCapabilities> | null = null;

async function getCapabilities(): Promise<MergeTreeCapabilities> {
	capabilities ??= (async () => {
		try {
			const result = await safeSpawn({
				cmd: [...MERGE_TREE_PROBE_ARGV],
				cwd: tmpdir(),
				timeout: 15_000,
				maxOutputBytes: 8192,
			});
			if (result.stdoutTruncated || result.stderrTruncated) throw new Error("Truncated Git help");
			const help = `${result.stdout}${result.stderr}`;
			return {
				writeTree: /--(?:\[no-\])?write-tree\b/.test(help),
				mergeBase: /--(?:\[no-\])?merge-base\b/.test(help),
			};
		} catch {
			return { writeTree: false, mergeBase: false };
		}
	})();
	return capabilities;
}

/** Native capabilities; old Git may still merge via the bounded compatibility path. */
export async function supportsMergeTree(explicitBase = false): Promise<boolean> {
	const support = await getCapabilities();
	// --write-tree appeared in 2.38, --merge-base in 2.40. New help may spell the
	// latter --[no-]merge-base; looking for only --merge-base wrongly chose fallback.
	return support.writeTree && (!explicitBase || support.mergeBase);
}

export function resetMergeTreeSupportCacheForTests(): void {
	capabilities = null;
}

export interface GitTreeMergeOptions {
	worktreePath: string;
	gitDir?: string;
	base: string | null;
	ours: string;
	theirs: string;
	/** -c works on Git versions predating GIT_CONFIG_COUNT. */
	config?: GitConfig;
	signal?: AbortSignal;
	/** Internal callers/tests may use a smaller total budget; queue time is included. */
	timeoutMs?: number;
}

export interface GitTreeMergeResult
	extends Omit<ParsedTreeMergeResult, "tree" | "markerCheckAllowed"> {
	/** Old Git conflicts deliberately have no applicable result tree. */
	tree: string | null;
}

/** Must run BEFORE filtering paths for a scoped operation. Unknown scope poisons the plan. */
export function requireCompleteMergeTree(result: GitTreeMergeResult): string {
	if (result.conflictsComplete !== true || !result.tree) {
		throw catalogError("GIT_TREE_MERGE_CONFLICTS_UNLISTED");
	}
	return result.tree;
}

/** Marker-only resolution cannot prove that a binary, mode or directory conflict is resolved. */
export function requireMarkerResolvableTree(result: GitTreeMergeResult): string {
	const tree = requireCompleteMergeTree(result);
	if (result.hasConflicts && result.conflictMarkersComplete !== true) {
		throw catalogError("GIT_TREE_MERGE_CONFLICTS_UNLISTED");
	}
	return tree;
}

function requireSuccess(result: SafeSpawnResult, operation: string): string {
	if (result.exitCode !== 0) {
		throw new Error(
			`${operation}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
		);
	}
	return result.stdout.trim();
}

/** Remove only the output terminator: a real directory name may end in whitespace. */
function requirePath(result: SafeSpawnResult, operation: string): string {
	requireSuccess(result, operation);
	const path = result.stdout.replace(/\r?\n$/, "");
	if (!path || path.includes("\0")) throw new Error(`Invalid path from ${operation}`);
	return path;
}

function requireObjectId(value: string): string {
	if (!OBJECT_ID.test(value)) throw new Error("Git returned an invalid tree/object id");
	return value;
}

/** Small config/attribute files only; do not read an arbitrary file before checking its size. */
async function readOptionalAttributes(path: string): Promise<Buffer | null> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_ATTRIBUTE_BYTES)
			throw new Error("Git attributes exceed the compatibility merge size limit");
		const buffer = Buffer.alloc(MAX_ATTRIBUTE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) return buffer.subarray(0, length);
			length += bytesRead;
		}
		throw new Error("Git attributes exceed the compatibility merge size limit");
	} finally {
		await file.close();
	}
}

/** Merge in object space. Only a clean, verified result may be applied automatically. */
export async function mergeGitTrees(options: GitTreeMergeOptions): Promise<GitTreeMergeResult> {
	const startedAt = Date.now();
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.min(TIMEOUT_MS, Math.max(1, options.timeoutMs as number))
		: TIMEOUT_MS;
	const deadline = startedAt + timeoutMs;
	const native = await supportsMergeTree(options.base !== null);
	let config: GitConfig = options.config ?? [];
	let env: Record<string, string | undefined> = {
		...process.env,
		GIT_DIR: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_OBJECT_DIRECTORY: undefined,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
		GIT_PREFIX: undefined,
		LC_ALL: "C",
		GIT_TERMINAL_PROMPT: "0",
	};
	let scratch: string | undefined;
	let gitDir = options.gitDir;
	let worktree = options.worktreePath;
	let release: (() => void) | undefined;
	const remaining = () => {
		if (options.signal?.aborted) throw new Error("Git tree merge was cancelled");
		const ms = deadline - Date.now();
		if (ms <= 0) throw new Error("Git tree merge exceeded its total time limit");
		return ms;
	};
	const exec = async (opts: SafeSpawnOptions): Promise<SafeSpawnResult> => {
		const result = await safeSpawn({
			...opts,
			timeout: remaining(),
			signal: options.signal,
			killProcessTree: true,
		});
		if (result.stdoutTruncated || result.stderrTruncated)
			throw new Error("Git tree merge output exceeded the size limit");
		remaining();
		return result;
	};
	const run = (args: string[], maxOutputBytes = MAX_OUTPUT_BYTES) =>
		exec({
			cmd: [
				"git",
				...config.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
				...(gitDir ? ["--git-dir", gitDir, "--work-tree", worktree] : []),
				"--literal-pathspecs",
				...args,
			],
			cwd: worktree,
			env,
			maxOutputBytes,
		});
	// Extra I/O only for small native text-conflict candidates, never clean merges.
	// The parser cannot distinguish a mode conflict/custom driver from plain contents.
	const verifyContentMarkers = async (result: GitTreeMergeResult): Promise<boolean> => {
		const paths = result.conflicts;
		if (
			!result.tree ||
			!paths.length ||
			paths.length > 32 ||
			paths.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0) > 16 * 1024
		)
			return false;
		const drivers = await run(
			["config", "--get-regexp", "^merge\\..+\\.driver$"],
			MAX_CONFIG_BYTES,
		);
		if (drivers.exitCode === 0) return false;
		if (drivers.exitCode !== 1) requireSuccess(drivers, "verify merge drivers");
		const sides: Map<string, { mode: string; object: string; bytes: number }>[] = [];
		for (const tree of [options.ours, options.theirs, result.tree]) {
			const listing = await run(["ls-tree", "-l", "-z", tree, "--", ...paths]);
			requireSuccess(listing, "verify conflict file modes");
			const entries = new Map<string, { mode: string; object: string; bytes: number }>();
			for (const record of listing.stdout.split("\0").filter(Boolean)) {
				const tab = record.indexOf("\t");
				const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
				if (tab < 0 || type !== "blob" || !mode || !["100644", "100755"].includes(mode) || !object)
					return false;
				entries.set(record.slice(tab + 1), {
					mode,
					object: requireObjectId(object),
					bytes: Number(size),
				});
			}
			if (entries.size !== paths.length) return false;
			sides.push(entries);
		}
		let totalBytes = 0;
		for (const path of paths) {
			const output = sides[2]?.get(path);
			if (
				!output ||
				sides[0]?.get(path)?.mode !== output.mode ||
				sides[1]?.get(path)?.mode !== output.mode
			)
				return false;
			if (!Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > 2 * 1024 * 1024)
				return false;
			totalBytes += output.bytes;
		}
		if (totalBytes > 8 * 1024 * 1024) return false;
		for (const path of paths) {
			const output = sides[2]?.get(path);
			if (!output) return false;
			const blob = await run(["cat-file", "blob", output.object], 2 * 1024 * 1024);
			requireSuccess(blob, "verify conflict markers");
			if (
				blob.stdout.includes("\0") ||
				!/^<<<<<<< .+/m.test(blob.stdout) ||
				!/^>>>>>>> .+/m.test(blob.stdout)
			)
				return false;
		}
		return true;
	};
	try {
		for (const ref of [
			options.ours,
			options.theirs,
			...(options.base === null ? [] : [options.base]),
		]) {
			if (!ref || ref.startsWith("-") || ref.includes("\0")) throw new Error("Invalid merge ref");
		}
		if (native) {
			const result = await run([
				"merge-tree",
				"--write-tree",
				"--name-only",
				"--messages",
				"-z",
				...(options.base === null ? [] : [`--merge-base=${options.base}`]),
				options.ours,
				options.theirs,
			]);
			if (result.exitCode !== 0 && result.exitCode !== 1) requireSuccess(result, "merge-tree");
			const { markerCheckAllowed, ...parsed } = parseMergeTreeOutput(
				result.stdout,
				result.exitCode,
			);
			if (markerCheckAllowed) parsed.conflictMarkersComplete = await verifyContentMarkers(parsed);
			return parsed;
		}

		release = await fallbackSlots.acquire(deadline, options.signal);
		const refs: string[] = [];
		for (const ref of [
			options.ours,
			options.theirs,
			...(options.base === null ? [] : [options.base]),
		]) {
			refs.push(
				requireObjectId(
					requireSuccess(await run(["rev-parse", "--verify", ref]), "resolve merge ref"),
				),
			);
		}
		const [ours, theirs, base] = refs as [string, string, string | undefined];

		// One bounded metadata pass per input, plus one result pass on success. Never
		// recursively stat the temporary filesystem on the JS thread/per Git command.
		const checked = new Set<string>();
		let inputBytes = 0,
			inputEntries = 0;
		const checkTree = async (ref: string, input: boolean) => {
			if (checked.has(ref)) return;
			const listing = await run(["ls-tree", "-r", "-l", "-z", ref], MAX_LISTING_BYTES);
			requireSuccess(listing, "inspect compatibility tree size");
			let bytes = 0,
				entries = 0;
			for (const record of listing.stdout.split("\0")) {
				if (!record) continue;
				const tab = record.indexOf("\t");
				const fields = record.slice(0, tab).trim().split(/\s+/);
				if (tab < 0 || fields.length !== 4) throw new Error("Invalid tree size listing");
				if (fields[1] === "blob") {
					const size = Number(fields[3]);
					if (!Number.isSafeInteger(size) || size < 0) throw new Error("Unknown blob size");
					bytes += size;
				}
				entries++;
				if (
					entries + (input ? inputEntries : 0) > MAX_FALLBACK_ENTRIES ||
					bytes + (input ? inputBytes : 0) > MAX_FALLBACK_TREE_BYTES
				) {
					throw new Error(
						"Compatibility merge exceeds its 512 MiB / 50000 tree-entry safety limit",
					);
				}
			}
			if (input) {
				inputBytes += bytes;
				inputEntries += entries;
			}
			checked.add(ref);
		};
		for (const ref of refs) await checkTree(ref, true);

		// Only bounded, merge-relevant effective config is copied. No user executable
		// may run in scratch: a custom driver or renormalization needs manual handling,
		// NOT a silent substitution of different merge semantics.
		const settings = await run(
			[
				"config",
				"--null",
				"--get-regexp",
				"^(merge\\.|diff\\.(renamelimit|algorithm)$|core\\.(ignorecase|attributesfile)$)",
			],
			MAX_CONFIG_BYTES,
		);
		if (settings.exitCode !== 0 && settings.exitCode !== 1)
			requireSuccess(settings, "read merge configuration");
		const inherited: [string, string][] = [];
		let hasAttributesFile = false;
		for (const record of settings.stdout.split("\0").filter(Boolean)) {
			const split = record.indexOf("\n");
			if (split < 0) throw new Error("Invalid merge configuration record");
			const key = record.slice(0, split),
				value = record.slice(split + 1);
			if (/^merge\..+\.driver$/i.test(key))
				throw new Error(
					"Compatibility merge cannot safely run configured external merge drivers; use manual merge or a newer Git",
				);
			if (key === "merge.renormalize" && !/^(false|no|off|0)$/i.test(value))
				throw new Error(
					"Compatibility merge cannot safely run merge.renormalize content conversions",
				);
			if (key === "core.attributesfile") hasAttributesFile = true;
			else inherited.push([key, value]);
			if (inherited.length > 128) throw new Error("Too many merge configuration entries");
		}
		const objects = resolve(
			options.worktreePath,
			requirePath(await run(["rev-parse", "--git-path", "objects"]), "locate object store"),
		);
		const attributesPath = resolve(
			options.worktreePath,
			requirePath(
				await run(["rev-parse", "--git-path", "info/attributes"]),
				"locate repository attributes",
			),
		);
		const attributes = await readOptionalAttributes(attributesPath);
		const globalPath = hasAttributesFile
			? resolve(
					options.worktreePath,
					requirePath(
						await run(["config", "--path", "--get", "core.attributesFile"]),
						"locate global attributes",
					),
				)
			: resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "git/attributes");
		const globalAttributes = await readOptionalAttributes(globalPath);
		remaining();
		scratch = await mkdtemp(resolve(tmpdir(), "nf-git-merge-"));
		const scratchGit = resolve(scratch, "repo");
		worktree = resolve(scratch, "worktree");
		await mkdir(worktree);
		// GIT_CONFIG_COUNT/PARAMETERS and old Git's HOME config must not sneak user
		// drivers/filters back in after inspection. Preserve system *attributes* (data)
		// but not system config (which can define executable drivers).
		for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG")) delete env[key];
		env = {
			...env,
			HOME: resolve(scratch, "home"),
			USERPROFILE: resolve(scratch, "home"),
			XDG_CONFIG_HOME: resolve(scratch, "home/.config"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: DEV_NULL,
			GIT_CONFIG_SYSTEM: DEV_NULL,
			GIT_ATTR_SOURCE: undefined,
			GIT_DEFAULT_HASH: ours.length === 64 ? "sha256" : "sha1",
		};
		requireSuccess(
			await exec({
				cmd: [
					"git",
					"init",
					"--bare",
					"--quiet",
					"--template=",
					...(ours.length === 64 ? ["--object-format=sha256"] : []),
					scratchGit,
				],
				cwd: scratch,
				env,
				maxOutputBytes: MAX_OUTPUT_BYTES,
			}),
			"initialize isolated merge repository",
		);
		await mkdir(resolve(scratchGit, "info"), { recursive: true });
		await writeFile(
			resolve(scratchGit, "info/attributes"),
			Buffer.concat([attributes ?? Buffer.alloc(0), Buffer.from(RAW_ATTRIBUTES)]),
		);
		await writeFile(resolve(scratch, "global-attributes"), globalAttributes ?? Buffer.alloc(0));
		gitDir = scratchGit;
		env.GIT_INDEX_FILE = resolve(scratch, "index");
		// Objects are shared, not cloned; only harmless new objects are written back.
		// No source refs, index, config, hooks or LFS cache can be touched by checkout.
		env.GIT_OBJECT_DIRECTORY = objects;
		config = [
			...inherited,
			...(options.config ?? []),
			["core.bare", "false"],
			["core.autocrlf", "false"],
			["core.eol", "lf"],
			["core.safecrlf", "false"],
			["core.symlinks", "true"],
			["core.fileMode", "true"],
			["core.sparseCheckout", "false"],
			["core.splitIndex", "false"],
			["core.fsmonitor", ""],
			["core.untrackedCache", "false"],
			["core.hooksPath", resolve(scratch, "disabled-hooks")],
			["core.attributesFile", resolve(scratch, "global-attributes")],
			["submodule.recurse", "false"],
			["gc.auto", "0"],
			["maintenance.auto", "false"],
		];
		requireSuccess(await run(["read-tree", "--reset", "-u", ours]), "prepare compatibility merge");
		const merged = await run(["merge-recursive", ...(base ? [base] : []), "--", ours, theirs]);
		if (merged.exitCode !== 0 && merged.exitCode !== 1) requireSuccess(merged, "merge-recursive");
		if (merged.exitCode === 1) {
			const unmerged = await run(["ls-files", "--unmerged", "-z"]);
			requireSuccess(unmerged, "read compatibility conflicts");
			const paths = new Set<string>();
			for (const record of unmerged.stdout.split("\0").filter(Boolean)) {
				const tab = record.indexOf("\t");
				if (tab < 0) throw new Error("Invalid unmerged index record");
				paths.add(record.slice(tab + 1));
			}
			const displaced = await run(["ls-files", "--others", "-z"]);
			requireSuccess(displaced, "read displaced conflict files");
			for (const path of displaced.stdout.split("\0").filter(Boolean)) paths.add(path);
			// Even NONEMPTY stages can omit directory conflicts. No human-log parsing,
			// no partial tree construction, and no marker-only automatic completion.
			return {
				tree: null,
				conflicts: [...paths],
				hasConflicts: true,
				conflictsComplete: false,
				conflictMarkersComplete: false,
			};
		}
		// write-tree itself rejects any surviving unmerged entries on a claimed clean merge.
		const tree = requireObjectId(
			requireSuccess(await run(["write-tree"]), "write compatibility tree"),
		);
		await checkTree(tree, false);
		return {
			tree,
			conflicts: [],
			hasConflicts: false,
			conflictsComplete: true,
			conflictMarkersComplete: true,
		};
	} catch (error) {
		if (error instanceof AppError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		logger.warn("Git tree merge failed", { native, error: detail.slice(0, 2000) });
		if (native) throw catalogError("GIT_TREE_MERGE_FAILED", { detail });
		let version = "unknown";
		if (!options.signal?.aborted && Date.now() < deadline) {
			try {
				const result = await safeSpawn({
					cmd: ["git", "--version"],
					cwd: tmpdir(),
					timeout: Math.max(1, Math.min(2000, deadline - Date.now())),
					maxOutputBytes: 1024,
				});
				if (result.exitCode === 0) version = result.stdout.trim().replace(/^git version\s+/, "");
			} catch {
				/* An unavailable Git installation is part of the diagnostic. */
			}
		}
		const support = await getCapabilities();
		throw catalogError("GIT_TREE_MERGE_FALLBACK_FAILED", {
			version,
			feature: support.writeTree
				? "merge-tree --merge-base (Git 2.40+)"
				: "merge-tree --write-tree (Git 2.38+)",
			detail,
		});
	} finally {
		try {
			if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 2 });
		} catch (error) {
			logger.warn("Could not clean temporary Git merge directory", {
				scratch,
				error: String(error),
			});
		} finally {
			release?.();
		}
		if (Date.now() - startedAt > 2000)
			logger.warn("Slow Git tree merge", { native, elapsedMs: Date.now() - startedAt });
	}
}
