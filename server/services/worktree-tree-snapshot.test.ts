import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { seedSqliteTestDatabase } from "../../tests/sqlite-template";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AsyncMutex } from "../lib/async-mutex";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import * as spawn from "../lib/spawn";
import { safeSpawn } from "../lib/spawn";
import {
	legacyTreeSnapshotKey,
	legacyTreeSnapshotPhysicalDir,
	snapshotPathIdentity,
	treeSnapshotKey,
	treeSnapshotPhysicalDir,
} from "./tree-snapshot-paths";
import {
	revalidateLifecycleTarget,
	withLifecycleGuardPorts,
	withProtectionReservation,
} from "./worktree-lifecycle-guard";
import {
	hasHotPathWarmupForTests,
	resetHotPathCaptureStateForTests,
	TreeSnapshotError,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const snapshotPaths: string[] = [];

/** The shadow repository backing a workspace, derived the same way the module does. */
function shadowOf(worktreePath: string): string {
	return treeSnapshotPhysicalDir(LOCAL_DEVICE_ID, worktreePath);
}

/** Private attempts are evidence, not resumable cache entries or gc candidates. */
function shadowStages(worktreePath: string): string[] {
	const final = shadowOf(worktreePath);
	const parent = dirname(final);
	if (!existsSync(parent)) return [];
	return readdirSync(parent)
		.filter((name) => name.startsWith(`.nf-shadow-stage-${basename(final)}-`))
		.map((name) => join(parent, name));
}

/** Manufacture a real v1 birth receipt without making its fingerprint follow v2 keys. */
function legacyInitMarker(dir: string, worktreePath: string): string {
	const born = lstatSync(dir);
	const parent = lstatSync(dirname(dir));
	const key = createHash("sha256")
		.update(legacyTreeSnapshotKey(LOCAL_DEVICE_ID, worktreePath))
		.digest("hex");
	return `nf-shadow-init-v1\n${key}\n${born.dev}:${born.ino}\n${parent.dev}:${parent.ino}\n`;
}

/**
 * Run git straight against a workspace's shadow repository.
 *
 * Inspection only: the module itself exposes no listing or blob reader beyond what
 * production needs, so the tests read the recorded trees the way git would.
 */
function shadowGit(worktreePath: string, args: string[], env?: Record<string, string>) {
	return safeSpawn({
		cmd: ["git", "--git-dir", shadowOf(worktreePath), ...args],
		timeout: 15_000,
		maxOutputBytes: 8 * 1024 * 1024,
		...(env && { env: { ...process.env, ...env } }),
	});
}

/** Every path a snapshot recorded, verbatim (`-z`, so non-ASCII names are not quoted). */
async function treePaths(worktreePath: string, tree: string): Promise<string[]> {
	const result = await shadowGit(worktreePath, ["ls-tree", "-r", "--name-only", "-z", tree]);
	if (result.exitCode !== 0) throw new Error(`ls-tree failed: ${result.stderr}`);
	return result.stdout.split("\0").filter(Boolean);
}

/** Whether a tree object exists in a workspace's shadow repository. */
async function hasTree(worktreePath: string, tree: string): Promise<boolean> {
	if (!existsSync(join(shadowOf(worktreePath), "HEAD"))) return false;
	const result = await shadowGit(worktreePath, ["cat-file", "-t", tree]);
	return result.exitCode === 0 && result.stdout.trim() === "tree";
}

/** The exact bytes a snapshot recorded for one path — undecoded, unlike `safeSpawn`. */
function recordedBytes(worktreePath: string, tree: string, relPath: string): Buffer {
	const result = Bun.spawnSync([
		"git",
		"--git-dir",
		shadowOf(worktreePath),
		"cat-file",
		"blob",
		`${tree}:${relPath}`,
	]);
	if (result.exitCode !== 0) throw new Error(`cat-file failed: ${result.stderr.toString()}`);
	return Buffer.from(result.stdout);
}

/** Read one file back through the production preview path. */
function preview(worktreePath: string, tree: string, relPath: string) {
	return worktreeTreeSnapshot.readFilePreviewAtTree(
		worktreePath,
		tree,
		relPath,
		LOCAL_DEVICE_ID,
		1024 * 1024,
		{ signal: new AbortController().signal, timeoutMs: 15_000 },
	);
}

/** Create a real git repository, since snapshots mirror its ignore rules. */
async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	snapshotPaths.push(normalizePathForComparison(dir));
	await safeSpawn({ cmd: ["git", "init"], cwd: dir, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: dir });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: dir });
	return dir;
}

/**
 * Create a *linked* worktree nested under `<main>/.worktrees/`.
 *
 * A linked worktree's `.git` is a file pointing at `<main>/.git/worktrees/<name>`, and
 * the repository-level `info/exclude` lives in the common dir instead. A `git init`
 * repo has none of that indirection, so it could not see whether the exclude
 * resolution worked.
 *
 * Returns the linked worktree path; the main repo is registered for cleanup too.
 */
async function createLinkedWorktree(prefix: string): Promise<{ main: string; worktree: string }> {
	const main = mkdtempSync(join(tmpdir(), `${prefix}main-`));
	tempDirs.push(main);
	await safeSpawn({ cmd: ["git", "init"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: main });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: main });
	writeFileSync(join(main, "seed.txt"), "seed\n");
	await safeSpawn({ cmd: ["git", "add", "-A"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: main, timeout: 15_000 });

	const worktree = join(main, ".worktrees", "nested");
	const added = await safeSpawn({
		cmd: ["git", "worktree", "add", worktree, "-b", "nested"],
		cwd: main,
		timeout: 15_000,
	});
	if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	tempDirs.push(worktree);
	snapshotPaths.push(normalizePathForComparison(worktree));
	return { main, worktree };
}

/** Write the repository-level exclude, which for a linked worktree is in the common dir. */
async function writeRepoExclude(mainRepo: string, contents: string): Promise<void> {
	const infoDir = join(mainRepo, ".git", "info");
	mkdirSync(infoDir, { recursive: true });
	writeFileSync(join(infoDir, "exclude"), contents);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		// Shadow repositories and failed attempts are owned only by these isolated fixtures.
		for (const stage of shadowStages(dir)) rmSync(stage, { recursive: true, force: true });
		rmSync(shadowOf(dir), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
	for (const path of snapshotPaths.splice(0)) {
		await db.delete(worktreeTreeSnapshots).where(eq(worktreeTreeSnapshots.worktreePath, path));
	}
});

describe("worktree tree snapshots", () => {
	test("captures a mixed-case native workspace through its canonical comparison path", async () => {
		const repo = await createRepo("Nf-Tree-Case-Identity-");
		const target = normalizePathForComparison(repo);
		writeFileSync(join(repo, "a.txt"), "case-preserving bytes\n");
		// On Windows the reservation lowercases the dispatch path, while Git
		// reports the on-disk spelling. Both must identify the same real inode.
		const tree = await worktreeTreeSnapshot.capture(target);
		const dir = treeSnapshotPhysicalDir("local", target);
		const before = lstatSync(dir);
		expect(await worktreeTreeSnapshot.capture(target)).toBe(tree);
		expect(await preview(target, tree, "a.txt")).toEqual({
			status: "available",
			content: "case-preserving bytes\n",
		});
		expect(lstatSync(dir).dev).toBe(before.dev);
		expect(lstatSync(dir).ino).toBe(before.ino);
	});

	for (const partial of ["empty", "HEAD", "objects", "complete"] as const) {
		for (const cold of [false, true]) {
			test(`failed ${partial} stage retains evidence and retries ${cold ? "in a cold process" : "in a fresh stage"}`, async () => {
				const repo = await createRepo("nf-tree-init-resume-");
				writeFileSync(join(repo, "a.txt"), "recoverable\n");
				const dir = shadowOf(repo);
				let failedStage = "";
				const evidence = Buffer.from([0, 255, 128, 13, 10]);
				const realSpawn = spawn.safeSpawn;
				const failed = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
					if (opts.cmd[1] !== "init" || !opts.cmd.includes("--bare")) return realSpawn(opts);
					const stage = opts.cmd.at(-1) as string;
					failedStage = stage;
					expect(shadowStages(repo)).toContain(stage);
					expect(dirname(stage)).toBe(dirname(dir));
					expect(existsSync(dir)).toBe(false);
					if (partial === "complete") expect((await realSpawn(opts)).exitCode).toBe(0);
					writeFileSync(join(stage, "marker.bin"), evidence);
					if (partial === "HEAD") writeFileSync(join(stage, "HEAD"), "ref: refs/heads/main\n");
					if (partial === "objects") {
						mkdirSync(join(stage, "objects"));
						writeFileSync(join(stage, "objects", "evidence.bin"), evidence);
						mkdirSync(join(stage, "refs", "nf"), { recursive: true });
						writeFileSync(join(stage, "refs", "nf", "preserved"), `${"a".repeat(40)}\n`);
					}
					return { exitCode: 1, stdout: "", stderr: "injected init failure" };
				});
				try {
					await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(
						"shadow repo init failed",
					);
				} finally {
					failed.mockRestore();
				}
				const birth = lstatSync(failedStage);
				const markerPath = join(failedStage, "nf-shadow-init");
				const marker = readFileSync(markerPath);
				const headBefore = existsSync(join(failedStage, "HEAD"))
					? readFileSync(join(failedStage, "HEAD"))
					: null;
				expect(marker.length).toBeLessThanOrEqual(256);
				expect(marker.toString()).toStartWith("nf-shadow-init-v2\n");
				expect(marker.toString()).toContain(
					createHash("sha256").update(treeSnapshotKey(LOCAL_DEVICE_ID, repo)).digest("hex"),
				);
				await worktreeTreeSnapshot.gcAll();
				expect(
					existsSync(join(failedStage, "HEAD")) ? readFileSync(join(failedStage, "HEAD")) : null,
				).toEqual(headBefore);
				expect(readFileSync(markerPath)).toEqual(marker);
				expect(readFileSync(join(failedStage, "marker.bin"))).toEqual(evidence);
				if (cold) {
					// A separate module graph and database, but the same physical shadow store.
					// Never share the parent's live DB lock or bypass instance locking.
					const coldHome = mkdtempSync(join(tmpdir(), "nf-tree-cold-home-"));
					tempDirs.push(coldHome);
					seedSqliteTestDatabase(coldHome);
					symlinkSync(join(dir, ".."), join(coldHome, "tree-snapshots"), "dir");
					const result = await realSpawn({
						cmd: [
							process.execPath,
							"--eval",
							`
							if (process.env.NARRAFORK_TEST !== "1" || !process.env.NARRAFORK_HOME)
								throw new Error("isolated test home required");
							const { worktreeTreeSnapshot } = await import(${JSON.stringify(join(import.meta.dir, "worktree-tree-snapshot.ts"))});
							const tree = await worktreeTreeSnapshot.capture(${JSON.stringify(repo)});
							console.log("RECOVERED:" + tree);
							process.exit(0);
						`,
						],
						env: { ...process.env, NARRAFORK_HOME: coldHome },
						timeout: 15_000,
						maxOutputBytes: 64 * 1024,
					});
					if (result.exitCode !== 0)
						throw new Error(`cold capture failed: ${result.stdout}\n${result.stderr}`);
					expect(result.stdout).toMatch(/RECOVERED:[0-9a-f]{40}/);
				} else {
					expect(await worktreeTreeSnapshot.capture(repo)).toMatch(/^[0-9a-f]{40}$/);
				}
				expect(lstatSync(failedStage).ino).toBe(birth.ino);
				expect(lstatSync(failedStage).dev).toBe(birth.dev);
				expect(lstatSync(dir).ino).not.toBe(birth.ino);
				expect(readFileSync(markerPath)).toEqual(marker);
				expect(readFileSync(join(failedStage, "marker.bin"))).toEqual(evidence);
				expect(existsSync(join(dir, "nf-shadow-init"))).toBe(false);
				expect(existsSync(join(dir, "marker.bin"))).toBe(false);
				if (partial === "objects") {
					expect(readFileSync(join(failedStage, "objects", "evidence.bin"))).toEqual(evidence);
					expect(readFileSync(join(failedStage, "refs", "nf", "preserved"), "utf8")).toBe(
						`${"a".repeat(40)}\n`,
					);
				}
			}, 25_000);
		}
	}

	for (const damage of [
		"missing",
		"corrupt",
		"oversized",
		"foreign-key",
		"directory",
		"marker-directory",
		"parent",
		"symlink",
	] as const) {
		test(`failed shadow birth refuses a ${damage} initialization marker without init or deletion`, async () => {
			const repo = await createRepo("nf-tree-init-refuse-");
			const dir = treeSnapshotPhysicalDir("local", repo);
			const markerPath = join(dir, "nf-shadow-init");
			mkdirSync(dir, { recursive: true });
			const marker = legacyInitMarker(dir, repo);
			writeFileSync(markerPath, marker);
			if (damage === "missing") rmSync(markerPath);
			if (damage === "corrupt") writeFileSync(markerPath, "{broken");
			if (damage === "oversized") writeFileSync(markerPath, "x".repeat(257));
			if (damage === "foreign-key")
				writeFileSync(markerPath, marker.replace(/[a-f0-9]{64}/, "0".repeat(64)));
			if (damage === "parent") {
				const lines = marker.split("\n");
				lines[3] = "0:0";
				writeFileSync(markerPath, lines.join("\n"));
			}
			if (damage === "directory") {
				const backup = join(repo, "failed-shadow");
				renameSync(dir, backup);
				mkdirSync(dir);
				writeFileSync(markerPath, marker);
				expect(lstatSync(dir).ino).not.toBe(lstatSync(backup).ino);
				expect(readFileSync(join(backup, "nf-shadow-init"), "utf8")).toBe(marker);
			}
			if (damage === "marker-directory") {
				rmSync(markerPath);
				mkdirSync(markerPath);
			}
			if (damage === "symlink") {
				const external = join(repo, "external-marker");
				writeFileSync(external, marker);
				rmSync(markerPath);
				symlinkSync(external, markerPath);
			}
			writeFileSync(join(dir, "marker.bin"), "retained evidence");
			writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
			const dispatch = spyOn(spawn, "safeSpawn");
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(TreeSnapshotError);
				expect(dispatch).toHaveBeenCalledTimes(0);
				expect(readFileSync(join(dir, "marker.bin"), "utf8")).toBe("retained evidence");
			} finally {
				dispatch.mockRestore();
			}
		});
	}

	for (const partialMarker of [false, true]) {
		test(`marker creation failure preserves ${partialMarker ? "partial marker" : "empty stage"} and permits a fresh retry`, async () => {
			const repo = await createRepo("nf-tree-init-marker-failure-");
			writeFileSync(join(repo, "a.txt"), "retry after marker failure\n");
			const dir = shadowOf(repo);
			let failedStage = "";
			const realWrite = fsPromises.writeFile;
			const writing = spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
				if (basename(String(args[0])) !== "nf-shadow-init") return realWrite(...args);
				failedStage = dirname(String(args[0]));
				if (partialMarker) writeFileSync(String(args[0]), "incomplete marker evidence");
				throw new Error("injected marker creation failure");
			});
			const dispatch = spyOn(spawn, "safeSpawn");
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("marker creation failed");
				expect(dispatch).toHaveBeenCalledTimes(0);
			} finally {
				writing.mockRestore();
				dispatch.mockRestore();
			}
			expect(shadowStages(repo)).toContain(failedStage);
			expect(existsSync(dir)).toBe(false);
			expect(existsSync(join(failedStage, "nf-shadow-init"))).toBe(partialMarker);
			const stageEntries = readdirSync(failedStage);
			const tree = await worktreeTreeSnapshot.capture(repo);
			expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
			expect(readdirSync(failedStage)).toEqual(stageEntries);
			if (partialMarker)
				expect(readFileSync(join(failedStage, "nf-shadow-init"), "utf8")).toBe(
					"incomplete marker evidence",
				);
			expect(existsSync(join(dir, "nf-shadow-init"))).toBe(false);
		});
	}

	for (const partial of ["empty", "HEAD", "objects", "complete"] as const) {
		test(`a valid v1 ${partial} final birth resumes through a private stage without losing evidence`, async () => {
			const repo = await createRepo("nf-tree-init-v1-");
			writeFileSync(join(repo, "a.txt"), "v1 retry\n");
			const dir = shadowOf(repo);
			expect(dir).toBe(legacyTreeSnapshotPhysicalDir(LOCAL_DEVICE_ID, repo));
			mkdirSync(dir, { recursive: true });
			if (partial === "complete") {
				const initialized = await safeSpawn({
					cmd: ["git", "init", "--bare", dir],
					timeout: 15_000,
				});
				expect(initialized.exitCode).toBe(0);
			}
			if (partial === "HEAD") writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
			if (partial === "objects") mkdirSync(join(dir, "objects"));
			const marker = legacyInitMarker(dir, repo);
			writeFileSync(join(dir, "nf-shadow-init"), marker);
			writeFileSync(join(dir, "preserved.bin"), "v1 evidence");
			const born = lstatSync(dir);
			const realSpawn = spawn.safeSpawn;
			const dispatch = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				if (opts.cmd[1] === "init" && opts.cmd.includes("--bare")) {
					const stage = opts.cmd.at(-1) as string;
					expect(shadowStages(repo)).toContain(stage);
					expect(existsSync(dir)).toBe(false);
					expect(lstatSync(stage).ino).toBe(born.ino);
					expect(readFileSync(join(stage, "nf-shadow-init"), "utf8")).toBe(marker);
				}
				return realSpawn(opts);
			});
			try {
				const tree = await worktreeTreeSnapshot.capture(repo);
				expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
				expect(lstatSync(dir).ino).toBe(born.ino);
				expect(lstatSync(dir).dev).toBe(born.dev);
				expect(readFileSync(join(dir, "preserved.bin"), "utf8")).toBe("v1 evidence");
				expect(existsSync(join(dir, "nf-shadow-init"))).toBe(false);
				expect(shadowStages(repo)).toHaveLength(0);
			} finally {
				dispatch.mockRestore();
			}
		});
	}

	test("v1 resume refuses a final replaced while the real private stage is being created", async () => {
		const repo = await createRepo("nf-tree-v1-stage-race-");
		const dir = shadowOf(repo);
		const backup = join(repo, "original-v1-shadow");
		mkdirSync(dir, { recursive: true });
		const marker = legacyInitMarker(dir, repo);
		writeFileSync(join(dir, "nf-shadow-init"), marker);
		writeFileSync(join(dir, "preserved.bin"), "original v1 evidence");
		const original = lstatSync(dir);
		const sentinel = Buffer.from([0, 255, 128, 13, 10]);
		let replacedIdentity = "";
		let stagesCreated = 0;
		const realMkdtemp = fsPromises.mkdtemp;
		const creating = spyOn(fsPromises, "mkdtemp").mockImplementation(async (...args) => {
			const [prefix] = args;
			const stage = await Reflect.apply(realMkdtemp, fsPromises, args);
			if (String(prefix) === join(dirname(dir), `.nf-shadow-stage-${basename(dir)}-`)) {
				stagesCreated++;
				expect(existsSync(String(stage))).toBe(true);
				renameSync(dir, backup);
				mkdirSync(dir);
				writeFileSync(join(dir, "sentinel.bin"), sentinel);
				const replacement = lstatSync(dir);
				replacedIdentity = `${replacement.dev}:${replacement.ino}`;
			}
			return stage;
		});
		const dispatch = spyOn(spawn, "safeSpawn");
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow();
			expect(stagesCreated).toBe(1);
			expect(dispatch).not.toHaveBeenCalled();
			expect(existsSync(dir)).toBe(true);
			const retained = lstatSync(dir);
			expect(`${retained.dev}:${retained.ino}`).toBe(replacedIdentity);
			expect(readdirSync(dir)).toEqual(["sentinel.bin"]);
			expect(readFileSync(join(dir, "sentinel.bin"))).toEqual(sentinel);
			expect(lstatSync(backup).dev).toBe(original.dev);
			expect(lstatSync(backup).ino).toBe(original.ino);
			expect(readFileSync(join(backup, "nf-shadow-init"), "utf8")).toBe(marker);
			expect(readFileSync(join(backup, "preserved.bin"), "utf8")).toBe("original v1 evidence");
			for (const stage of shadowStages(repo))
				expect(existsSync(join(stage, "sentinel.bin"))).toBe(false);
		} finally {
			creating.mockRestore();
			dispatch.mockRestore();
		}
	});

	test("an unmarked empty final directory recovers without adopting unknown nonempty contents", async () => {
		const repo = await createRepo("nf-tree-init-empty-final-");
		writeFileSync(join(repo, "a.txt"), "empty final recovery\n");
		const dir = shadowOf(repo);
		mkdirSync(dir, { recursive: true });
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
		expect(existsSync(join(dir, "nf-shadow-init"))).toBe(false);
	});

	test("a cold shadow does not consult unrelated local or remote lifecycle inventory", async () => {
		const repo = await createRepo("nf-tree-cold-inventory-");
		writeFileSync(join(repo, "a.txt"), "no inventory authority\n");
		const readClaims = mock(async () => {
			throw new Error("local and remote inventories are unavailable");
		});
		const tree = await withLifecycleGuardPorts(
			{ canonicalPath: async (value) => snapshotPathIdentity(value), readClaims },
			() => worktreeTreeSnapshot.capture(repo),
		);
		expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
		expect(readClaims).not.toHaveBeenCalled();
	});

	test("a cold capture leaves its enclosing checkout reservation revalidatable", async () => {
		const repo = await createRepo("nf-tree-cold-outer-context-");
		writeFileSync(join(repo, "a.txt"), "private stage identity must not escape\n");
		const dir = shadowOf(repo);
		expect(existsSync(dir)).toBe(false);
		await withLifecycleGuardPorts(
			{
				canonicalPath: async (value) => value,
				readClaims: async () => ({ complete: true, claims: [] }),
			},
			() =>
				withProtectionReservation([{ path: repo }], "enclosing checkout operation", async () => {
					expect(await revalidateLifecycleTarget(repo)).toBe(repo);
					const tree = await worktreeTreeSnapshot.capture(repo);
					expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
					expect(existsSync(join(dir, "HEAD"))).toBe(true);
					expect(shadowStages(repo)).toHaveLength(0);
					expect(await revalidateLifecycleTarget(repo)).toBe(repo);
				}),
		);
	});

	test("an existing valid shadow does not require lifecycle inventory or receipt migration", async () => {
		const repo = await createRepo("nf-tree-existing-inventory-");
		writeFileSync(join(repo, "a.txt"), "existing shadow\n");
		const tree = await worktreeTreeSnapshot.capture(repo);
		const readClaims = mock(async () => {
			throw new Error("unrelated inventory and legacy migration unavailable");
		});
		const current = await withLifecycleGuardPorts(
			{ canonicalPath: async (value) => value, readClaims },
			() => worktreeTreeSnapshot.capture(repo),
		);
		expect(current).toBe(tree);
		expect(readClaims).not.toHaveBeenCalled();
	});

	for (const phase of ["init", "validate", "ignore"] as const) {
		test(`cancellation after real ${phase} dispatch prevents every later initialization write or scan`, async () => {
			const repo = await createRepo("nf-tree-init-cancel-");
			writeFileSync(join(repo, "a.txt"), "cancelled preparation\n");
			const controller = new AbortController();
			const reason = new Error(`cancelled at ${phase}`);
			const realSpawn = spawn.safeSpawn;
			let reached = 0;
			let dispatchesAfterAbort = 0;
			const dispatch = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				if (controller.signal.aborted) dispatchesAfterAbort++;
				const result = await realSpawn(opts);
				const matches =
					phase === "init"
						? opts.cmd[1] === "init" && opts.cmd.includes("--bare")
						: phase === "validate"
							? opts.cmd.includes("--absolute-git-dir")
							: opts.cmd[1] === "config" && opts.cmd.includes("core.excludesFile");
				if (matches) {
					expect(opts.signal).toBe(controller.signal);
					reached++;
					controller.abort(reason);
				}
				return result;
			});
			try {
				await expect(
					worktreeTreeSnapshot.capture(repo, LOCAL_DEVICE_ID, { signal: controller.signal }),
				).rejects.toThrow(reason.message);
				expect(reached).toBe(1);
				expect(dispatchesAfterAbort).toBe(0);
				expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("add"))).toBe(false);
				expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("write-tree"))).toBe(false);
			} finally {
				dispatch.mockRestore();
			}
			expect(existsSync(shadowOf(repo))).toBe(false);
			const stages = shadowStages(repo);
			expect(stages).toHaveLength(1);
			const stage = stages[0] as string;
			const marker = readFileSync(join(stage, "nf-shadow-init"));
			expect(existsSync(join(stage, "info", "attributes"))).toBe(false);
			if (existsSync(join(stage, "info", "exclude")))
				expect(readFileSync(join(stage, "info", "exclude"), "utf8")).not.toContain("/.worktrees/");
			expect(
				await db.query.worktreeTreeSnapshots.findMany({
					where: eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(repo)),
				}),
			).toHaveLength(0);
			const tree = await worktreeTreeSnapshot.capture(repo);
			expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
			expect(readFileSync(join(stage, "nf-shadow-init"))).toEqual(marker);
		});
	}

	test("a canonical checkout identity does not replace the raw shadow key or stored path", async () => {
		const repo = await createRepo("nf-tree-raw-key-");
		writeFileSync(join(repo, "a.txt"), "shared checkout\n");
		const aliases = mkdtempSync(join(tmpdir(), "nf-tree-raw-key-alias-"));
		const alias = join(aliases, "checkout");
		symlinkSync(repo, alias, "dir");
		tempDirs.push(aliases, alias);
		snapshotPaths.push(normalizePathForComparison(alias));
		const dir = treeSnapshotPhysicalDir(LOCAL_DEVICE_ID, alias);
		const canonicalDir = treeSnapshotPhysicalDir(LOCAL_DEVICE_ID, repo);
		expect(dir).not.toBe(canonicalDir);
		const tree = await worktreeTreeSnapshot.capture(alias);
		expect(await hasTree(alias, tree)).toBe(true);
		expect(existsSync(join(dir, "HEAD"))).toBe(true);
		expect(existsSync(canonicalDir)).toBe(false);
		const rows = await db.query.worktreeTreeSnapshots.findMany({
			where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(alias)),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.treeHash).toBe(tree);
	});

	for (const replaced of ["final", "checkout"] as const) {
		test(`stage publication refuses a replaced ${replaced} without writing Git metadata into the replacement`, async () => {
			const repo = await createRepo("nf-tree-init-context-");
			writeFileSync(join(repo, "a.txt"), "original checkout\n");
			const dir = shadowOf(repo);
			const target = replaced === "final" ? dir : repo;
			const backup = `${target}-before-replacement`;
			if (replaced === "checkout") tempDirs.push(backup);
			let stage = "";
			const realSpawn = spawn.safeSpawn;
			const dispatch = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				const result = await realSpawn(opts);
				if (opts.cmd[1] === "init" && opts.cmd.includes("--bare")) {
					expect(result.exitCode).toBe(0);
					stage = opts.cmd.at(-1) as string;
					if (replaced === "checkout") renameSync(target, backup);
					mkdirSync(target);
					writeFileSync(join(target, "sentinel.bin"), "replacement must stay untouched");
				}
				return result;
			});
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow();
				expect(stage).not.toBe("");
				expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("add"))).toBe(false);
				expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("write-tree"))).toBe(false);
				expect(readdirSync(target)).toEqual(["sentinel.bin"]);
				expect(readFileSync(join(target, "sentinel.bin"), "utf8")).toBe(
					"replacement must stay untouched",
				);
				expect(existsSync(join(target, "HEAD"))).toBe(false);
				expect(existsSync(join(target, "config"))).toBe(false);
				expect(existsSync(join(stage, "HEAD"))).toBe(true);
				expect(existsSync(join(stage, "config"))).toBe(true);
				if (replaced === "checkout") {
					expect(existsSync(dir)).toBe(false);
					expect(existsSync(join(stage, "nf-shadow-init"))).toBe(true);
				}
				expect(
					await db.query.worktreeTreeSnapshots.findMany({
						where: eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(repo)),
					}),
				).toHaveLength(0);
			} finally {
				dispatch.mockRestore();
			}
		});
	}

	test("gcAll waits for the shadow mutex before repairing HEAD", async () => {
		const repo = await createRepo("nf-tree-gc-repair-lock-");
		writeFileSync(join(repo, "a.txt"), "retained\n");
		const tree = await worktreeTreeSnapshot.capture(repo);
		const dir = treeSnapshotPhysicalDir("local", repo);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queued = Promise.withResolvers<void>();
		const realSpawn = spawn.safeSpawn;
		const git = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			if (opts.cmd.includes("add") && opts.cmd.includes(dir)) {
				started.resolve();
				await release.promise;
				return { exitCode: 1, stdout: "", stderr: "fixture paused capture" };
			}
			return realSpawn(opts);
		});
		const capturing = worktreeTreeSnapshot.capture(repo).then(
			() => null,
			(error) => error,
		);
		try {
			await Promise.race([
				started.promise,
				capturing.then((error) => {
					throw error;
				}),
			]);
		} catch (error) {
			git.mockRestore();
			throw error;
		}
		rmSync(join(dir, "HEAD"));
		const acquire = AsyncMutex.prototype.acquire;
		const mutex = spyOn(AsyncMutex.prototype, "acquire").mockImplementation(function <T>(
			this: AsyncMutex,
			key: string,
			body: () => Promise<T>,
		): Promise<T> {
			if (key === dir) queued.resolve();
			return acquire.call(this, key, body) as Promise<T>;
		});
		const collecting = worktreeTreeSnapshot.gcAll();
		try {
			await queued.promise;
			expect(existsSync(join(dir, "HEAD"))).toBe(false);
			release.resolve();
			expect(await capturing).toBeInstanceOf(TreeSnapshotError);
			await collecting;
			expect(existsSync(join(dir, "HEAD"))).toBe(true);
			expect(await hasTree(repo, tree)).toBe(true);
		} finally {
			release.resolve();
			await capturing;
			await collecting;
			mutex.mockRestore();
			git.mockRestore();
		}
	});

	for (const corruption of [
		"non-bare",
		"invalid-config",
		"oversized-config",
		"foreign-gitdir",
		"foreign-common-dir",
	] as const) {
		test(`capture refuses an existing ${corruption} shadow without init or metadata writes`, async () => {
			const repo = await createRepo("nf-tree-existing-invalid-");
			writeFileSync(join(repo, "a.txt"), "retained\n");
			await worktreeTreeSnapshot.capture(repo);
			const dir = treeSnapshotPhysicalDir("local", repo);
			const configPath = join(dir, "config");
			if (corruption === "non-bare") {
				writeFileSync(configPath, "[core]\n\tbare = false\n");
			} else if (corruption === "invalid-config") {
				writeFileSync(configPath, "[malformed\n");
			} else if (corruption === "oversized-config") {
				writeFileSync(configPath, "#".repeat(64 * 1024 + 1));
			} else if (corruption === "foreign-common-dir") {
				writeFileSync(join(dir, "commondir"), join(repo, ".git"));
			}
			const config = readFileSync(configPath);
			const head = readFileSync(join(dir, "HEAD"));
			const realSpawn = spawn.safeSpawn;
			const git = spyOn(spawn, "safeSpawn").mockImplementation((opts) =>
				corruption === "foreign-gitdir" && opts.cmd.includes("--absolute-git-dir")
					? Promise.resolve({ exitCode: 0, stdout: `true\n${repo}\n`, stderr: "" })
					: realSpawn(opts),
			);
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(TreeSnapshotError);
				for (const [opts] of git.mock.calls) {
					expect(opts.cmd).toContain("rev-parse");
					expect(opts.cmd).not.toContain("init");
				}
				if (corruption === "oversized-config" || corruption === "foreign-common-dir") {
					expect(git).toHaveBeenCalledTimes(0);
				}
				expect(readFileSync(configPath)).toEqual(config);
				expect(readFileSync(join(dir, "HEAD"))).toEqual(head);
			} finally {
				git.mockRestore();
			}
		});
	}

	test("existing validation completion cannot authorize metadata writes into a replaced final", async () => {
		const repo = await createRepo("nf-tree-existing-validate-race-");
		writeFileSync(join(repo, "a.txt"), "original checkout\n");
		await worktreeTreeSnapshot.capture(repo);
		const dir = shadowOf(repo);
		const backup = join(repo, "original-shadow-before-validation");
		const sentinel = Buffer.from([0, 255, 128, 13, 10]);
		let replacedIdentity = "";
		let validations = 0;
		const realSpawn = spawn.safeSpawn;
		const dispatch = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			const result = await realSpawn(opts);
			if (opts.cmd.includes("--absolute-git-dir") && opts.cmd.includes(dir)) {
				expect(result.exitCode).toBe(0);
				validations++;
				// The first turn lets validateShadowRepo finish its own inode checks;
				// the second runs before ensureShadowRepo resumes metadata synchronization.
				queueMicrotask(() => {
					queueMicrotask(() => {
						renameSync(dir, backup);
						mkdirSync(join(dir, "info"), { recursive: true });
						writeFileSync(join(dir, "info", "exclude"), sentinel);
						const replacement = lstatSync(dir);
						replacedIdentity = `${replacement.dev}:${replacement.ino}`;
					});
				});
			}
			return result;
		});
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow();
			expect(validations).toBe(1);
			expect(replacedIdentity).not.toBe("");
			const retained = lstatSync(dir);
			expect(`${retained.dev}:${retained.ino}`).toBe(replacedIdentity);
			expect(readdirSync(dir)).toEqual(["info"]);
			expect(readdirSync(join(dir, "info"))).toEqual(["exclude"]);
			expect(readFileSync(join(dir, "info", "exclude"))).toEqual(sentinel);
			expect(existsSync(join(backup, "HEAD"))).toBe(true);
			expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("add"))).toBe(false);
			expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("write-tree"))).toBe(false);
		} finally {
			dispatch.mockRestore();
		}
	});

	test("existing exclude config resolution cannot overwrite a replaced final", async () => {
		const repo = await createRepo("nf-tree-existing-config-race-");
		writeFileSync(join(repo, "a.txt"), "original checkout\n");
		// Warm the final-path caches so the injected config call belongs to
		// syncExcludes itself rather than syncExcludesIfStale's initial lookup.
		await worktreeTreeSnapshot.capture(repo);
		await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, ".gitignore"), "ignored-after-warmup/\n");
		const dir = shadowOf(repo);
		const backup = join(repo, "original-shadow-before-config");
		const sentinel = Buffer.from([0, 255, 128, 13, 10]);
		let replacedIdentity = "";
		let resolutions = 0;
		const realSpawn = spawn.safeSpawn;
		const dispatch = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			const result = await realSpawn(opts);
			if (opts.cmd[1] === "config" && opts.cmd.includes("core.excludesFile")) {
				resolutions++;
				renameSync(dir, backup);
				mkdirSync(join(dir, "info"), { recursive: true });
				writeFileSync(join(dir, "info", "exclude"), sentinel);
				const replacement = lstatSync(dir);
				replacedIdentity = `${replacement.dev}:${replacement.ino}`;
			}
			return result;
		});
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow();
			expect(resolutions).toBe(1);
			expect(replacedIdentity).not.toBe("");
			const retained = lstatSync(dir);
			expect(`${retained.dev}:${retained.ino}`).toBe(replacedIdentity);
			expect(readdirSync(dir)).toEqual(["info"]);
			expect(readdirSync(join(dir, "info"))).toEqual(["exclude"]);
			expect(readFileSync(join(dir, "info", "exclude"))).toEqual(sentinel);
			expect(existsSync(join(backup, "HEAD"))).toBe(true);
			expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("add"))).toBe(false);
			expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes("write-tree"))).toBe(false);
		} finally {
			dispatch.mockRestore();
		}
	});

	test("a symlink at the final path is refused without touching its target", async () => {
		const repo = await createRepo("nf-tree-init-final-symlink-");
		const dir = shadowOf(repo);
		const external = join(repo, "foreign-shadow");
		mkdirSync(external);
		writeFileSync(join(external, "sentinel.bin"), "do not adopt");
		mkdirSync(dirname(dir), { recursive: true });
		symlinkSync(external, dir, process.platform === "win32" ? "junction" : "dir");
		const dispatch = spyOn(spawn, "safeSpawn");
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(TreeSnapshotError);
			expect(dispatch).not.toHaveBeenCalled();
			expect(lstatSync(dir).isSymbolicLink()).toBe(true);
			expect(readdirSync(external)).toEqual(["sentinel.bin"]);
			expect(readFileSync(join(external, "sentinel.bin"), "utf8")).toBe("do not adopt");
		} finally {
			dispatch.mockRestore();
		}
	});

	test.skipIf(process.platform === "win32")(
		"POSIX backslash histories stay read-only and remain previewable and diffable after a new capture",
		async () => {
			const root = await createRepo("nf-tree-legacy-backslash-");
			const literal = join(root, "back\\slash");
			const nested = join(root, "back", "slash");
			for (const workspace of [literal, nested]) {
				mkdirSync(workspace, { recursive: true });
				tempDirs.push(workspace);
				snapshotPaths.push(snapshotPathIdentity(workspace));
				const initialized = await safeSpawn({
					cmd: ["git", "init"],
					cwd: workspace,
					timeout: 15_000,
				});
				expect(initialized.exitCode).toBe(0);
			}
			writeFileSync(join(nested, "common.txt"), "old shared-cache bytes\n");
			writeFileSync(join(nested, "only-old.txt"), "old only\n");
			const oldTree = await worktreeTreeSnapshot.capture(nested);
			const legacy = legacyTreeSnapshotPhysicalDir(LOCAL_DEVICE_ID, literal);
			expect(legacy).toBe(shadowOf(nested));
			expect(shadowOf(literal)).not.toBe(legacy);
			const marker = legacyInitMarker(legacy, literal);
			writeFileSync(join(legacy, "nf-shadow-init"), marker);
			const retained = ["HEAD", "config", "index"].map((file) => ({
				file,
				bytes: readFileSync(join(legacy, file)),
			}));
			writeFileSync(join(literal, "common.txt"), "new literal-directory bytes\n");
			writeFileSync(join(literal, "only-new.txt"), "new only\n");
			expect(await preview(literal, oldTree, "common.txt")).toEqual({
				status: "available",
				content: "old shared-cache bytes\n",
			});
			expect(existsSync(shadowOf(literal))).toBe(false);
			const newTree = await worktreeTreeSnapshot.capture(literal);
			expect(newTree).not.toBe(oldTree);
			expect(await treePaths(literal, newTree)).toEqual(["common.txt", "only-new.txt"]);
			expect(await preview(literal, oldTree, "common.txt")).toEqual({
				status: "available",
				content: "old shared-cache bytes\n",
			});
			expect(await preview(literal, newTree, "common.txt")).toEqual({
				status: "available",
				content: "new literal-directory bytes\n",
			});
			expect(
				(await worktreeTreeSnapshot.diffPathStatuses(literal, oldTree, newTree)).sort((a, b) =>
					a.path.localeCompare(b.path),
				),
			).toEqual([
				{ path: "common.txt", kind: "updated" },
				{ path: "only-new.txt", kind: "added" },
				{ path: "only-old.txt", kind: "deleted" },
			]);
			for (const { file, bytes } of retained)
				expect(readFileSync(join(legacy, file))).toEqual(bytes);
			expect(readFileSync(join(legacy, "nf-shadow-init"), "utf8")).toBe(marker);
			expect(existsSync(join(shadowOf(literal), "nf-shadow-init"))).toBe(false);
			const rows = await db.query.worktreeTreeSnapshots.findMany({
				where: eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(literal)),
			});
			expect(rows.map((row) => row.treeHash)).toEqual([newTree]);
		},
	);

	test("captures a tree hash and records it once per distinct state", async () => {
		const repo = await createRepo("nf-tree-capture-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const first = await worktreeTreeSnapshot.capture(repo);
		expect(first).toMatch(/^[0-9a-f]{40}$/);

		// Identical content is content-addressed to the same hash and deduplicated.
		const again = await worktreeTreeSnapshot.capture(repo);
		expect(again).toBe(first);

		writeFileSync(join(repo, "a.txt"), "two\n");
		const changed = await worktreeTreeSnapshot.capture(repo);
		expect(changed).not.toBe(first);

		const rows = await db.query.worktreeTreeSnapshots.findMany({
			where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
		});
		expect(rows).toHaveLength(2);
	});

	test("never creates a commit or branch in the user's repository", async () => {
		const repo = await createRepo("nf-tree-nocommit-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		// The user's repo must still have no commits and a clean staging area.
		const log = await safeSpawn({ cmd: ["git", "log", "--oneline"], cwd: repo, timeout: 15_000 });
		expect(log.exitCode).not.toBe(0);
		const staged = await safeSpawn({
			cmd: ["git", "diff", "--cached", "--name-only"],
			cwd: repo,
			timeout: 15_000,
		});
		expect(staged.stdout.trim()).toBe("");
	});

	test("captures changes made outside the Write/Edit tools", async () => {
		const repo = await createRepo("nf-tree-external-");
		writeFileSync(join(repo, "a.txt"), "original\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		// Stands in for a Bash command, build script, or the user's own editor —
		// none of which produce recorded tool inputs to replay.
		writeFileSync(join(repo, "a.txt"), "changed by a shell command\n");
		writeFileSync(join(repo, "generated.txt"), "new file\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		expect(after).not.toBe(before);

		const changed = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);
		expect(changed.map((entry) => entry.path).sort()).toEqual(["a.txt", "generated.txt"]);
	});

	test("records binary files byte for byte", async () => {
		const repo = await createRepo("nf-tree-binary-");
		const blob = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x42, 0x80]);
		writeFileSync(join(repo, "blob.bin"), blob);
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		// Decoding and re-encoding these bytes would be lossy; the tree stores them raw.
		expect(Buffer.compare(recordedBytes(repo, snapshot, "blob.bin"), blob)).toBe(0);
	});

	test("records legacy-encoded text without changing its charset", async () => {
		const repo = await createRepo("nf-tree-encoding-");
		const original = "你好世界\n这是GBK编码的文件\n";
		const gbkBytes = iconv.encode(original, "gbk");
		writeFileSync(join(repo, "gbk.txt"), gbkBytes);
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		// Byte equality means the charset survived; no decode/encode step occurred.
		const recorded = recordedBytes(repo, snapshot, "gbk.txt");
		expect(Buffer.compare(recorded, gbkBytes)).toBe(0);
		expect(iconv.decode(recorded, "gbk")).toBe(original);
	});

	test("ignores paths excluded by .gitignore", async () => {
		const repo = await createRepo("nf-tree-ignore-");
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
		mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "junk\n");
		writeFileSync(join(repo, "debug.log"), "noise\n");
		writeFileSync(join(repo, "src.txt"), "tracked\n");

		const before = await worktreeTreeSnapshot.capture(repo);

		// Touching ignored paths must not change the snapshot identity.
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "different junk\n");
		writeFileSync(join(repo, "debug.log"), "more noise\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);

		writeFileSync(join(repo, "src.txt"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(repo)).not.toBe(before);
	});

	test("honours a nested .gitignore, not just the root one", async () => {
		const repo = await createRepo("nf-tree-nested-ignore-");
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		mkdirSync(join(repo, "packages", "app", "dist"), { recursive: true });
		// The shape that matters in a monorepo: the rule that hides build output lives in
		// the package, not at the root. A snapshot that missed it would capture `dist/`
		// and every rebuild would then read as a workspace change.
		writeFileSync(join(repo, "packages", "app", ".gitignore"), "dist/\n");
		writeFileSync(join(repo, "packages", "app", "dist", "bundle.js"), "built\n");
		writeFileSync(join(repo, "packages", "app", "src.ts"), "source\n");

		const before = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, before)).not.toContain("packages/app/dist/bundle.js");

		// Rebuilding must not move the snapshot identity.
		writeFileSync(join(repo, "packages", "app", "dist", "bundle.js"), "rebuilt\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);
	});

	test("rejects remote devices explicitly rather than silently using local paths", async () => {
		const repo = await createRepo("nf-tree-remote-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		await expect(worktreeTreeSnapshot.capture(repo, "remote-a")).rejects.toBeInstanceOf(
			TreeSnapshotError,
		);
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, "remote-a", { budgetMs: 30_000 }),
		).toBeNull();
		await expect(
			worktreeTreeSnapshot.diffPathStatuses(repo, "a".repeat(40), "b".repeat(40), "remote-a"),
		).rejects.toBeInstanceOf(TreeSnapshotError);
	});

	test("keeps snapshots of different worktrees isolated", async () => {
		const first = await createRepo("nf-tree-iso-a-");
		const second = await createRepo("nf-tree-iso-b-");
		writeFileSync(join(first, "a.txt"), "first\n");
		writeFileSync(join(second, "a.txt"), "second\n");

		const firstTree = await worktreeTreeSnapshot.capture(first);
		const secondTree = await worktreeTreeSnapshot.capture(second);
		expect(firstTree).not.toBe(secondTree);

		// Each shadow repo only knows its own trees.
		expect(await hasTree(first, firstTree)).toBe(true);
		expect(await hasTree(first, secondTree)).toBe(false);
		expect(await hasTree(second, firstTree)).toBe(false);
	});

	test("respects global gitignore (core.excludesFile) rules", async () => {
		const repo = await createRepo("nf-tree-global-ignore-");
		const globalIgnorePath = join(repo, ".global-gitignore");
		writeFileSync(globalIgnorePath, "*.generated\nbuild/\n");

		// Configure git in this repo to use the custom global excludesFile
		await safeSpawn({
			cmd: ["git", "config", "--local", "core.excludesFile", globalIgnorePath],
			cwd: repo,
			timeout: 15_000,
		});

		writeFileSync(join(repo, "src.txt"), "tracked\n");
		writeFileSync(join(repo, "output.generated"), "should be ignored\n");
		mkdirSync(join(repo, "build"), { recursive: true });
		writeFileSync(join(repo, "build", "app.js"), "compiled\n");

		const before = await worktreeTreeSnapshot.capture(repo);

		// Touching globally-ignored paths must not change the snapshot identity.
		writeFileSync(join(repo, "output.generated"), "changed\n");
		writeFileSync(join(repo, "build", "app.js"), "recompiled\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);

		// Touching tracked file must change it.
		writeFileSync(join(repo, "src.txt"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(repo)).not.toBe(before);
	});

	test("global gitignore gracefully degrades when file does not exist", async () => {
		const repo = await createRepo("nf-tree-global-ignore-missing-");

		// Point core.excludesFile at a non-existent path
		await safeSpawn({
			cmd: ["git", "config", "--local", "core.excludesFile", "/nonexistent/gitignore"],
			cwd: repo,
			timeout: 15_000,
		});

		writeFileSync(join(repo, "a.txt"), "content\n");

		// Should not throw — graceful degradation
		const hash = await worktreeTreeSnapshot.capture(repo);
		expect(hash).toMatch(/^[0-9a-f]{40}$/);
	});

	test("diffs non-ASCII paths verbatim, not as quoted escapes", async () => {
		const repo = await createRepo("nf-tree-cjk-paths-");
		const cjk = "中文 文件.txt";
		writeFileSync(join(repo, "ascii.txt"), "a\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, cjk), "b\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		// git's default core.quotePath would return `"\344\270\255..."`, which is not a
		// path any filesystem call can use.
		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, before, after)).toEqual([
			{ path: cjk, kind: "added" },
		]);
	});
});

/**
 * `diffPathStatuses` — the per-tool-call change feed the file tree patches from.
 *
 * Run against real git rather than a parsed fixture because the risk being covered is
 * a FORMAT assumption: `--name-status -z` emits `STATUS\0PATH\0` pairs, so its field
 * count is doubled relative to the `--name-only` form this was derived from. Mis-pairing
 * shifts every subsequent path onto the wrong status, which mislabels a delete as an add
 * and makes a tree evict the wrong directory — with no error anywhere.
 */
describe("diffPathStatuses", () => {
	test("reports added, modified and deleted paths with their own kinds", async () => {
		const repo = await createRepo("nf-tree-diffstatus-");
		writeFileSync(join(repo, "keep.txt"), "one\n");
		writeFileSync(join(repo, "gone.txt"), "bye\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "keep.txt"), "two\n");
		rmSync(join(repo, "gone.txt"));
		writeFileSync(join(repo, "fresh.txt"), "new\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);
		const byPath = new Map(statuses.map((entry) => [entry.path, entry.kind]));

		expect(byPath.get("fresh.txt")).toBe("added");
		expect(byPath.get("keep.txt")).toBe("updated");
		expect(byPath.get("gone.txt")).toBe("deleted");
		expect(statuses).toHaveLength(3);
	});

	test("handles paths containing spaces without splitting them", async () => {
		// `-z` is what makes this safe; a space-separated format would break here.
		const repo = await createRepo("nf-tree-diffstatus-space-");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "two words.txt"), "x\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);

		expect(statuses).toEqual([{ path: "two words.txt", kind: "added" }]);
	});

	test("reports a rename as a delete plus an add", async () => {
		// Rename detection is deliberately not requested, and both directories need
		// re-reading anyway, so the split form is what the tree wants.
		const repo = await createRepo("nf-tree-diffstatus-rename-");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "old.txt"), "same bytes\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		rmSync(join(repo, "src", "old.txt"));
		writeFileSync(join(repo, "src", "new.txt"), "same bytes\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);
		const byPath = new Map(statuses.map((entry) => [entry.path, entry.kind]));

		expect(byPath.get("src/old.txt")).toBe("deleted");
		expect(byPath.get("src/new.txt")).toBe("added");
	});

	test("returns nothing between identical trees", async () => {
		const repo = await createRepo("nf-tree-diffstatus-same-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const hash = await worktreeTreeSnapshot.capture(repo);

		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, hash, hash)).toEqual([]);
	});
});

/**
 * Snapshots against a *linked* worktree, where `.git` is a pointer file and the
 * repository-level `info/exclude` lives in the common dir named by `commondir`. Plain
 * `git init` cases cannot cover that indirection, and the exclude was once never
 * mirrored in exactly this shape.
 */
describe("linked worktrees", () => {
	test("captures a linked worktree without its .git pointer file", async () => {
		const { worktree } = await createLinkedWorktree("nf-tree-linked-");
		writeFileSync(join(worktree, "a.txt"), "v1\n");
		const before = await worktreeTreeSnapshot.capture(worktree);

		writeFileSync(join(worktree, "a.txt"), "v2\n");
		writeFileSync(join(worktree, "created.txt"), "new\n");
		const after = await worktreeTreeSnapshot.capture(worktree);

		expect(await worktreeTreeSnapshot.diffPathStatuses(worktree, before, after)).toEqual([
			{ path: "a.txt", kind: "updated" },
			{ path: "created.txt", kind: "added" },
		]);
		// The pointer file is git metadata, never workspace content.
		expect(await treePaths(worktree, before)).not.toContain(".git");
	});

	test("mirrors the repository-level exclude reached through commondir", async () => {
		const { main, worktree } = await createLinkedWorktree("nf-tree-linked-exclude-");
		// A linked worktree's own gitdir has no info/ at all; this is the file git
		// actually consults, and reading `<gitdir>/info/exclude` found nothing.
		await writeRepoExclude(main, "local-only/\n*.tmp\n");
		mkdirSync(join(worktree, "local-only"), { recursive: true });
		writeFileSync(join(worktree, "local-only", "scratch.txt"), "scratch\n");
		writeFileSync(join(worktree, "notes.tmp"), "temp\n");
		writeFileSync(join(worktree, "tracked.txt"), "tracked\n");

		const before = await worktreeTreeSnapshot.capture(worktree);
		const paths = await treePaths(worktree, before);
		expect(paths).toContain("tracked.txt");
		expect(paths).not.toContain("notes.tmp");
		expect(paths).not.toContain("local-only/scratch.txt");

		// Touching excluded paths must not move the snapshot identity.
		writeFileSync(join(worktree, "notes.tmp"), "changed\n");
		writeFileSync(join(worktree, "local-only", "scratch.txt"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(worktree)).toBe(before);
	});

	test("picks up a repository-level exclude edited after the first capture", async () => {
		const { main, worktree } = await createLinkedWorktree("nf-tree-linked-exclude-stale-");
		const first = await worktreeTreeSnapshot.capture(worktree);
		expect(await treePaths(worktree, first)).not.toContain("build.out");

		// The mirrored copy has to be invalidated when the source changes, or a newly
		// ignored build artefact keeps entering snapshots until the process restarts.
		// Asserted on a file created *after* the edit: git keeps an already-indexed path
		// even once it becomes ignored, so a pre-existing file could not tell the two
		// apart.
		await writeRepoExclude(main, "*.out\n");
		writeFileSync(join(worktree, "build.out"), "built\n");
		const after = await worktreeTreeSnapshot.capture(worktree);
		expect(await treePaths(worktree, after)).not.toContain("build.out");
		// The snapshot identity must not move either — a build must be invisible.
		expect(after).toBe(first);
	});
});

/**
 * A workspace that is a repository root has the repository's nested linked worktrees
 * under `<root>/.worktrees/` — other live checkouts, and legacy ones older versions
 * left on disk. Capturing them would report their writes as this workspace's changes.
 */
describe("nested linked worktrees", () => {
	test("a nested worktree never enters the repository root's snapshot", async () => {
		const { main, worktree } = await createLinkedWorktree("nf-tree-nested-capture-");
		snapshotPaths.push(normalizePathForComparison(main));
		writeFileSync(join(main, "root.txt"), "root\n");

		const tree = await worktreeTreeSnapshot.capture(main);
		const paths = await treePaths(main, tree);

		// The nested checkout enters as a `160000 commit` gitlink when not excluded,
		// which makes its whole directory a single path in the root's tree.
		expect(paths).toContain("root.txt");
		expect(paths.some((path) => path.startsWith(".worktrees"))).toBe(false);

		// Work inside the nested checkout is invisible to the root's boundaries.
		writeFileSync(join(worktree, "precious.txt"), "hours of unsaved work\n");
		writeFileSync(join(worktree, "seed.txt"), "edited in the nested checkout\n");
		expect(await worktreeTreeSnapshot.capture(main)).toBe(tree);
	});

	test("the exclusion is anchored to the workspace root", async () => {
		const repo = await createRepo("nf-tree-nested-anchor-");
		mkdirSync(join(repo, "docs", ".worktrees"), { recursive: true });
		writeFileSync(join(repo, "docs", ".worktrees", "notes.md"), "tracked elsewhere\n");

		// Only `/.worktrees/` is reserved; the same name deeper in the tree is ordinary
		// content and must still be captured.
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, tree)).toContain("docs/.worktrees/notes.md");
	});
});

/**
 * The module's central promise is that a snapshot is the bytes on disk. git's content
 * filters break it in the worst possible way for change detection: the recorded blob
 * differs from the file, and a change confined to what the filter normalises produces
 * the *same* tree, so the boundary pair reports nothing happened.
 */
describe("byte exactness against git content filters", () => {
	test("CRLF and LF files are recorded exactly under '* text=auto'", async () => {
		const repo = await createRepo("nf-tree-crlf-");
		// The user's own `.gitattributes` applies to shadow-repo commands, because they
		// run with `--work-tree` pointed at this directory.
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const crlf = Buffer.from("first\r\nsecond\r\n", "binary");
		const lf = Buffer.from("first\nsecond\n", "binary");
		writeFileSync(join(repo, "crlf.txt"), crlf);
		writeFileSync(join(repo, "lf.txt"), lf);

		const before = await worktreeTreeSnapshot.capture(repo);
		// Compared as bytes, deliberately. A text comparison passes even when every line
		// ending was rewritten, which is the whole failure mode.
		expect(recordedBytes(repo, before, "crlf.txt").equals(crlf)).toBe(true);
		expect(recordedBytes(repo, before, "lf.txt").equals(lf)).toBe(true);

		// A line-ending-only rewrite is a real change and must move the boundary.
		writeFileSync(join(repo, "crlf.txt"), lf);
		const after = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, before, after)).toEqual([
			{ path: "crlf.txt", kind: "updated" },
		]);
	});

	test("the ident attribute cannot rewrite recorded contents", async () => {
		const repo = await createRepo("nf-tree-ident-");
		// `ident` needs no config to take effect, which makes it the cheapest proof that
		// the worktree's own `.gitattributes` is being overridden rather than obeyed. A
		// `filter=` attribute is the same mechanism with a config dependency attached.
		writeFileSync(join(repo, ".gitattributes"), "* ident\n");
		const expanded = Buffer.from(`ver: $Id: ${"a".repeat(40)} $\n`);
		writeFileSync(join(repo, "f.txt"), expanded);

		// Without the override the recorded blob reads `ver: $Id$` — content that was
		// never on disk.
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(recordedBytes(repo, tree, "f.txt").equals(expanded)).toBe(true);
	});

	test("a working-tree-encoding attribute does not fail the capture", async () => {
		const repo = await createRepo("nf-tree-wt-encoding-");
		// The dangerous shape is a file git cannot transcode: `add -A` then exits 128 and
		// the capture fails outright, so the attribute did not corrupt snapshots — it made
		// them impossible for the whole workspace, silently, via the hot path's null.
		// A UTF-8 BOM under a UTF-16LE declaration is exactly that case.
		writeFileSync(join(repo, ".gitattributes"), "*.txt working-tree-encoding=UTF-16LE\n");
		const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n")]);
		writeFileSync(join(repo, "bom.txt"), bom);

		const before = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, before)).toContain("bom.txt");
		expect(recordedBytes(repo, before, "bom.txt").equals(bom)).toBe(true);
	});
});

/**
 * A file the real repository tracks despite an ignore rule (`git add -f .env`) was
 * absent from every snapshot. Both boundary hashes then came out identical, the call
 * read as "changed nothing", and the modification went unrecorded with no warning
 * anywhere.
 */
describe("tracked-but-ignored files", () => {
	/** Track a file the ignore rules cover — the shape `git add -f` produces. */
	async function forceTrack(repo: string, relPath: string): Promise<void> {
		const added = await safeSpawn({
			cmd: ["git", "add", "-f", relPath],
			cwd: repo,
			timeout: 15_000,
		});
		if (added.exitCode !== 0) throw new Error(`git add -f failed: ${added.stderr}`);
		await safeSpawn({ cmd: ["git", "commit", "-m", "track"], cwd: repo, timeout: 15_000 });
	}

	test("captures a file git tracks despite an ignore rule", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-");
		writeFileSync(join(repo, ".gitignore"), ".env\nbuild/\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		mkdirSync(join(repo, "build"), { recursive: true });
		writeFileSync(join(repo, "build", "out.o"), "artifact\n");
		await forceTrack(repo, ".env");

		const tree = await worktreeTreeSnapshot.capture(repo);
		const paths = await treePaths(repo, tree);
		expect(paths).toContain(".env");
		// The rest of the ignore rules must still hold, or this fix would be the older
		// bug where build output entered snapshots.
		expect(paths.some((path) => path.startsWith("build/"))).toBe(false);
	});

	test("a change to a tracked-but-ignored file moves the boundary", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-change-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=original\n");
		await forceTrack(repo, ".env");

		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, ".env"), "SECRET=overwritten\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		// The precise failure: identical hashes made the call read as a no-op.
		expect(after).not.toBe(before);
		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, before, after)).toEqual([
			{ path: ".env", kind: "updated" },
		]);
	});

	test("a file force-tracked after the first capture is still picked up", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-cache-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: repo, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: repo, timeout: 15_000 });
		// First capture memoizes "no tracked-but-ignored paths" — the state the cache has
		// to be able to leave behind when the user changes their mind.
		await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, ".env"), "SECRET=late\n");
		await forceTrack(repo, ".env");

		// `git add -f` rewrites the real index, which is what the cache keys on, so the
		// memo must invalidate rather than pin the earlier empty answer forever.
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, tree)).toContain(".env");
	});

	test("deleting a tracked-but-ignored file is recorded", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-delete-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		await forceTrack(repo, ".env");

		const before = await worktreeTreeSnapshot.capture(repo);
		rmSync(join(repo, ".env"));
		const after = await worktreeTreeSnapshot.capture(repo);
		// The force-add only introduces the index entry; once present, a plain `add -A`
		// records its removal, which is why no extra handling is needed for deletions.
		expect(await treePaths(repo, after)).not.toContain(".env");
		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, before, after)).toEqual([
			{ path: ".env", kind: "deleted" },
		]);
	});
});

/**
 * git only removes its own `index.lock` for signals it can handle. After a `SIGKILL`
 * or an OOM kill the lock survives, every later `add -A` in that shadow repo exits
 * 128, and the hot path swallows it into null — so the workspace silently and
 * permanently loses every boundary.
 */
describe("stale index.lock recovery", () => {
	test("reclaims a lock left behind by a killed git process", async () => {
		const repo = await createRepo("nf-tree-stale-lock-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		// Backdated past the reclaim threshold: age is what distinguishes an abandoned
		// lock from one a live git is legitimately still holding.
		const lockPath = join(shadowOf(repo), "index.lock");
		writeFileSync(lockPath, "");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, longAgo, longAgo);

		writeFileSync(join(repo, "a.txt"), "two\n");
		const recovered = await worktreeTreeSnapshot.capture(repo);
		expect(recovered).toMatch(/^[0-9a-f]{40}$/);
		expect(existsSync(lockPath)).toBe(false);
	});

	test("leaves a fresh lock alone, so a live git is never corrupted", async () => {
		const repo = await createRepo("nf-tree-fresh-lock-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		const lockPath = join(shadowOf(repo), "index.lock");
		writeFileSync(lockPath, "");
		try {
			writeFileSync(join(repo, "a.txt"), "two\n");
			// Failing is the correct outcome here: the boundary is recorded as absent and
			// the next capture retries, whereas deleting a live lock destroys an index write.
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("snapshot add failed");
			expect(
				await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 30_000 }),
			).toBeNull();
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			rmSync(lockPath, { force: true });
		}
	});
});

/** Unknown paths must never become absent entries in a recorded snapshot. */
describe("incomplete captures", () => {
	const cannotEnforceUnreadable = process.platform === "win32" || process.getuid?.() === 0;

	test.skipIf(cannotEnforceUnreadable)(
		"an unreadable file fails the capture instead of being recorded as absent",
		async () => {
			const repo = await createRepo("nf-tree-unreadable-");
			writeFileSync(join(repo, "readable.txt"), "kept\n");
			writeFileSync(join(repo, "locked.txt"), "must survive\n");
			chmodSync(join(repo, "locked.txt"), 0o000);
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("snapshot add failed");
				expect(
					await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 30_000 }),
				).toBeNull();
				const rows = await db.query.worktreeTreeSnapshots.findMany({
					where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
				});
				expect(rows).toEqual([]);
			} finally {
				chmodSync(join(repo, "locked.txt"), 0o600);
			}

			// No cache reset: the first usable boundary must include the now-readable
			// file. The old --ignore-errors fallback had published an earlier tree
			// without it, so the next boundary pair reported the file as newly created.
			const complete = await worktreeTreeSnapshot.capture(repo);
			expect(await treePaths(repo, complete)).toContain("locked.txt");
			expect(readFileSync(join(repo, "locked.txt"), "utf8")).toBe("must survive\n");
		},
	);

	test.skipIf(cannotEnforceUnreadable)(
		"a directory skipped with git exit zero still fails the capture",
		async () => {
			const repo = await createRepo("nf-tree-unreadable-directory-");
			writeFileSync(join(repo, "a.txt"), "baseline\n");
			const baseline = await worktreeTreeSnapshot.capture(repo);
			writeFileSync(join(repo, "a.txt"), "preserve current\n");
			const locked = join(repo, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "secret.txt"), "preserve unseen\n");
			chmodSync(locked, 0o000);
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("coverage is incomplete");
				const rows = await db.query.worktreeTreeSnapshots.findMany({
					where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
				});
				expect(rows.map((row) => row.treeHash)).toEqual([baseline]);
			} finally {
				chmodSync(locked, 0o700);
			}
			expect(readFileSync(join(locked, "secret.txt"), "utf8")).toBe("preserve unseen\n");
		},
	);

	test("force-add failure is fatal and its tentative memo cannot hide a later retry", async () => {
		const repo = await createRepo("nf-tree-force-failure-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=preserve\n");
		await safeSpawn({ cmd: ["git", "add", "-f", ".env"], cwd: repo, timeout: 15_000 });
		const realSpawn = spawn.safeSpawn;
		const failed = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
			if (opts.cmd.includes(repo) && opts.cmd.includes("--force")) {
				return Promise.resolve({ stdout: "", stderr: "unreadable forced path", exitCode: 1 });
			}
			return realSpawn(opts);
		});
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("snapshot add failed");
		} finally {
			failed.mockRestore();
		}
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, tree)).toContain(".env");
		expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=preserve\n");
	});

	for (const flag of ["stdoutTruncated", "stderrTruncated"] as const) {
		test(`${flag} cannot turn a capture into a complete success`, async () => {
			const repo = await createRepo("nf-tree-output-limit-");
			writeFileSync(join(repo, "a.txt"), "baseline\n");
			const baseline = await worktreeTreeSnapshot.capture(repo);
			writeFileSync(join(repo, "a.txt"), "preserve current\n");
			writeFileSync(join(repo, "new.txt"), "preserve new\n");
			const realSpawn = spawn.safeSpawn;
			const truncated = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				const result = await realSpawn(opts);
				return opts.cmd.includes(repo) && opts.cmd.includes("add")
					? { ...result, [flag]: true }
					: result;
			});
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("size limit");
			} finally {
				truncated.mockRestore();
			}
			const rows = await db.query.worktreeTreeSnapshots.findMany({
				where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
			});
			expect(rows.map((row) => row.treeHash)).toEqual([baseline]);
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("preserve current\n");
			expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("preserve new\n");
		});
	}

	for (const failure of [
		"query",
		"warning",
		"stdoutTruncated",
		"stderrTruncated",
		"pathCount",
	] as const) {
		test(`tracked-ignored ${failure} failure cannot publish an incomplete tree`, async () => {
			const repo = await createRepo("nf-tree-listing-failure-");
			writeFileSync(join(repo, "a.txt"), "preserve\n");
			const realSpawn = spawn.safeSpawn;
			const failed = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
				if (opts.cwd === repo && opts.cmd.includes("ls-files")) {
					return Promise.resolve({
						stdout: failure === "pathCount" ? "ignored.txt\0".repeat(5_001) : "ignored.txt\0",
						stderr: failure === "query" || failure === "warning" ? "incomplete listing" : "",
						exitCode: failure === "query" ? 1 : 0,
						stdoutTruncated: failure === "stdoutTruncated",
						stderrTruncated: failure === "stderrTruncated",
					});
				}
				return realSpawn(opts);
			});
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(TreeSnapshotError);
			} finally {
				failed.mockRestore();
			}
			const rows = await db.query.worktreeTreeSnapshots.findMany({
				where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
			});
			expect(rows).toEqual([]);
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("preserve\n");
		});
	}
});

/**
 * The hot-path capture budget. Tool-boundary captures run *inside* the narrator's
 * event consumer, so on a worktree whose full scan exceeds the budget (a huge
 * tree on a slow filesystem — the Windows + modpack-directory failure this came
 * from) the capture must step aside: null for the tool, a background warm-up for
 * the index, and a cooldown instead of a scan loop when the warm-up fails.
 */
describe("hot-path capture budget", () => {
	test("captures within the budget exactly like capture", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-fast-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const tree = await worktreeTreeSnapshot.tryCaptureHot(repo);
		expect(tree).toMatch(/^[0-9a-f]{40}$/);
		expect(tree).toBe(await worktreeTreeSnapshot.capture(repo));
	});

	test("an over-budget capture returns null, then finishes warming in the background", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-warmup-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		// A zero budget expires before the first git process can possibly exit, so
		// the tool path gets its null and moves on...
		await promoteToWarmup(repo);

		// ...while the capture keeps running as the warm-up. A later call shares that
		// scan instead of queueing a second one, and resolves with its hash.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
		expect(warmed).toBe(await worktreeTreeSnapshot.capture(repo));
	});

	test("a fresh boundary never shares an existing observation even with a permissive timestamp", async () => {
		const repo = await createRepo("nf-tree-hot-require-fresh-");
		writeFileSync(join(repo, "a.txt"), "before human\n");
		const oldTree = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "a.txt"), "after human\n");
		const realCapture = worktreeTreeSnapshot.capture.bind(worktreeTreeSnapshot);
		let release: ((tree: string) => void) | undefined;
		const oldObservation = new Promise<string>((resolve) => {
			release = resolve;
		});
		const capture = spyOn(worktreeTreeSnapshot, "capture")
			.mockImplementationOnce(() => oldObservation)
			.mockImplementation(realCapture);
		try {
			expect(
				await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
			).toBeNull();
			// Millisecond timestamps cannot distinguish calls in the same clock tick.
			// requireFresh must reject sharing independently of the cutoff comparison.
			const fresh = worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 5_000,
				minStartedAt: 0,
				requireFresh: true,
			});
			release?.(oldTree);
			const tree = await fresh;
			expect(tree).not.toBe(oldTree);
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(capture).toHaveBeenCalledTimes(2);
		} finally {
			release?.(oldTree);
			capture.mockRestore();
		}
	});

	test("concurrent over-budget calls share one warm-up", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-shared-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		// Warm only the disk-space probe (its result is cached per path), then return to an EMPTY
		// warm-up slot. Without this, the zero budget can expire on the probe and no call would
		// ever reach the slot, so "they share one warm-up" would be vacuous on a loaded runner.
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 30_000 }),
		).toMatch(/^[0-9a-f]{40}$/);
		resetHotPathCaptureStateForTests();
		writeFileSync(join(repo, "a.txt"), "two\n");

		// Three concurrent calls race for the empty slot: exactly one real scan may start.
		const capture = spyOn(worktreeTreeSnapshot, "capture");
		let results: (string | null)[];
		try {
			results = await Promise.all([
				worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
				worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
				worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
			]);
			expect(capture).toHaveBeenCalledTimes(1);
		} finally {
			capture.mockRestore();
		}
		expect(results).toEqual([null, null, null]);

		// One warm-up completed underneath them all.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a failed warm-up pauses hot-path captures until the cooldown expires", async () => {
		resetHotPathCaptureStateForTests();
		// A missing worktree fails every capture. The failure only starts the
		// cooldown because it outlived the budget, i.e. it ran as the warm-up.
		const dir = join(tmpdir(), `nf-tree-hot-cooldown-${Date.now()}`);
		tempDirs.push(dir);
		snapshotPaths.push(normalizePathForComparison(dir));

		await promoteToWarmup(dir, 1_000);
		// Sharing the warm-up to its conclusion guarantees the cooldown has engaged
		// by the time this resolves (the cooldown window came from the first call).
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, { budgetMs: 30_000 }),
		).toBeNull();

		// The workspace is now perfectly capturable, yet the cooldown must suppress
		// even attempting a scan: null, without trying.
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.txt"), "one\n");
		expect(await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID)).toBeNull();

		// Once the window passes, the next call captures normally again.
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
		const recovered = await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(recovered).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a fast failure keeps the retry-next-time behaviour (no cooldown)", async () => {
		resetHotPathCaptureStateForTests();
		const dir = join(tmpdir(), `nf-tree-hot-fastfail-${Date.now()}`);
		tempDirs.push(dir);
		snapshotPaths.push(normalizePathForComparison(dir));

		// The capture fails *within* a generous budget (a vanished worktree), which
		// is a transient shape — the dormant/wake cycle produces it — so no cooldown
		// is recorded and the next call retries immediately.
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				cooldownMs: 60_000,
			}),
		).toBeNull();

		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.txt"), "one\n");
		const retried = await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(retried).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a caller with a cutoff does not share a scan that started before it", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-cutoff-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		// Promote a capture to the background warm-up.
		await promoteToWarmup(repo);

		// A boundary measured *now* must not come from that older scan (its window
		// may straddle the writes being measured): the call waits for the stale scan
		// to settle, then re-captures — observable as exactly one more capture call.
		const spy = spyOn(worktreeTreeSnapshot, "capture");
		try {
			const tree = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				minStartedAt: Date.now(),
			});
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("a caller with a cutoff in the past shares the in-flight scan", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-share-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		await promoteToWarmup(repo);

		// The in-flight scan started after the cutoff, so its result is valid for the
		// caller and no second scan is started.
		const spy = spyOn(worktreeTreeSnapshot, "capture");
		try {
			const tree = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				minStartedAt: 1,
			});
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	/** A warm-up capture whose scan never finishes on its own, abortable via its signal. */
	function mockHungCapture() {
		const state = { capturedSignal: undefined as AbortSignal | undefined };
		const spy = spyOn(worktreeTreeSnapshot, "capture").mockImplementation(
			(_worktreePath, _deviceId, opts) =>
				new Promise<string>((_resolve, reject) => {
					state.capturedSignal = opts?.signal;
					const timer = setTimeout(() => reject(new Error("warm-up outlived the test")), 60_000);
					opts?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("preempted"));
						},
						{ once: true },
					);
				}),
		);
		return { spy, state };
	}

	/**
	 * Promote a capture to the background warm-up slot and PROVE it got there.
	 *
	 * `budgetMs: 0` alone is not enough: the same zero budget also races the async disk-space
	 * probe that runs before any capture starts. On a loaded runner that probe loses, the call
	 * returns null without registering a warm-up, and every later assertion about "the
	 * in-flight warm-up" silently tests nothing. Retry the zero-budget call until a warm-up is
	 * really registered (the disk probe result is cached after its first completion, so this
	 * converges in a few attempts), then hand control back to the test.
	 */
	async function promoteToWarmup(repo: string, cooldownMs?: number): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			expect(
				await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
					budgetMs: 0,
					...(cooldownMs === undefined ? {} : { cooldownMs }),
				}),
			).toBeNull();
			if (hasHotPathWarmupForTests(repo)) return;
			await Bun.sleep(5);
		}
		throw new Error("no warm-up was registered for the zero-budget capture");
	}

	test("a direct capture preempts an in-flight warm-up instead of queueing behind it", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-preempt-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { spy, state } = mockHungCapture();
		// Promote the hung capture to the warm-up slot.
		await promoteToWarmup(repo);

		// The direct capture must kill the warm-up's scan rather than queue behind
		// it for the full warm-up timeout.
		spy.mockRestore();
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(tree).toMatch(/^[0-9a-f]{40}$/);
		expect(state.capturedSignal?.aborted).toBe(true);

		// Preemption is not a warm-up *failure*: no cooldown, the next hot call captures.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
	});

	test("gcAll preempts an in-flight warm-up instead of queueing behind it", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-gc-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		// A real shadow repository, so the maintenance sweep visits this workspace.
		const tree = await worktreeTreeSnapshot.capture(repo);

		const { spy, state } = mockHungCapture();
		await promoteToWarmup(repo);
		spy.mockRestore();

		await worktreeTreeSnapshot.gcAll();
		expect(state.capturedSignal?.aborted).toBe(true);
		expect(await hasTree(repo, tree)).toBe(true);

		// Preemption is not a warm-up *failure*: no cooldown, the next hot call captures.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toBe(tree);
	});
	test("gcAll preempts a real cold warm-up before its final shadow directory exists", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-gc-cold-");
		writeFileSync(join(repo, "a.txt"), "cold stage warm-up\n");
		const started = Promise.withResolvers<void>();
		let capturedSignal: AbortSignal | undefined;
		const realSpawn = spawn.safeSpawn;
		const dispatch = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
			if (opts.cmd[1] !== "init" || !opts.cmd.includes("--bare")) return realSpawn(opts);
			capturedSignal = opts.signal;
			started.resolve();
			return new Promise<Awaited<ReturnType<typeof safeSpawn>>>((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
			});
		});
		try {
			await promoteToWarmup(repo);
			await started.promise;
			expect(hasHotPathWarmupForTests(repo)).toBe(true);
			expect(existsSync(shadowOf(repo))).toBe(false);
			expect(shadowStages(repo)).toHaveLength(1);
			await worktreeTreeSnapshot.gcAll();
			expect(capturedSignal?.aborted).toBe(true);
			expect(hasHotPathWarmupForTests(repo)).toBe(false);
			expect(existsSync(shadowOf(repo))).toBe(false);
		} finally {
			dispatch.mockRestore();
			resetHotPathCaptureStateForTests();
		}
		const stages = shadowStages(repo);
		expect(stages).toHaveLength(1);
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await treePaths(repo, tree)).toEqual(["a.txt"]);
		expect(shadowStages(repo)).toEqual(stages);
	});
});

/**
 * Maintenance never deletes a shadow repository. Snapshot trees are unreachable by
 * construction (no ref points at them), while the database keeps referring to them,
 * and repositories written by older versions also carry lineage refs under `refs/nf/`.
 */
describe("gcAll maintenance", () => {
	test("complete private stages without markers are never repaired or repacked", async () => {
		const repo = await createRepo("nf-tree-gc-private-stage-");
		writeFileSync(join(repo, "a.txt"), "published snapshot\n");
		const tree = await worktreeTreeSnapshot.capture(repo);
		const final = shadowOf(repo);
		const stage = join(dirname(final), `.nf-shadow-stage-${basename(final)}-unpublished`);
		const initialized = await safeSpawn({
			cmd: ["git", "init", "--bare", stage],
			timeout: 15_000,
		});
		expect(initialized.exitCode).toBe(0);
		writeFileSync(join(stage, "sentinel.bin"), "private evidence without marker");
		const head = readFileSync(join(stage, "HEAD"));
		const config = readFileSync(join(stage, "config"));
		const dispatch = spyOn(spawn, "safeSpawn");
		try {
			await worktreeTreeSnapshot.gcAll();
			expect(dispatch.mock.calls.some(([opts]) => opts.cmd.includes(stage))).toBe(false);
			expect(readFileSync(join(stage, "HEAD"))).toEqual(head);
			expect(readFileSync(join(stage, "config"))).toEqual(config);
			expect(readFileSync(join(stage, "sentinel.bin"), "utf8")).toBe(
				"private evidence without marker",
			);
			expect(await hasTree(repo, tree)).toBe(true);
		} finally {
			dispatch.mockRestore();
		}
	});

	test("a captured tree and a legacy lineage ref both survive a repack", async () => {
		const repo = await createRepo("nf-tree-gc-keep-");
		writeFileSync(join(repo, "a.txt"), "worth keeping\n");
		const tree = await worktreeTreeSnapshot.capture(repo);

		// The shape an older version left behind: a snapshot commit anchored at refs/nf/head.
		const legacy = await shadowGit(repo, ["commit-tree", tree, "-m", "legacy snapshot"], {
			GIT_AUTHOR_NAME: "NarraFork Snapshot",
			GIT_AUTHOR_EMAIL: "snapshot@narrafork.local",
			GIT_COMMITTER_NAME: "NarraFork Snapshot",
			GIT_COMMITTER_EMAIL: "snapshot@narrafork.local",
		});
		expect(legacy.exitCode).toBe(0);
		const commit = legacy.stdout.trim();
		expect((await shadowGit(repo, ["update-ref", "refs/nf/head", commit])).exitCode).toBe(0);

		// Unreferenced by any ref, as every capture is.
		writeFileSync(join(repo, "a.txt"), "loose\n");
		const loose = await worktreeTreeSnapshot.capture(repo);

		await worktreeTreeSnapshot.gcAll();

		expect(await hasTree(repo, tree)).toBe(true);
		expect(await hasTree(repo, loose)).toBe(true);
		const head = await shadowGit(repo, ["rev-parse", "--verify", "refs/nf/head"]);
		expect(head.stdout.trim()).toBe(commit);
		expect(await preview(repo, loose, "a.txt")).toEqual({
			status: "available",
			content: "loose\n",
		});
	});

	test("restores a missing HEAD instead of deleting the objects beside it", async () => {
		const repo = await createRepo("nf-tree-gc-repair-head-");
		writeFileSync(join(repo, "a.txt"), "work worth keeping\n");
		const tree = await worktreeTreeSnapshot.capture(repo);

		const dir = shadowOf(repo);
		rmSync(join(dir, "HEAD"), { force: true });
		await worktreeTreeSnapshot.gcAll();

		expect(existsSync(join(dir, "HEAD"))).toBe(true);
		// The point of the repair: the recorded trees are still readable afterwards.
		expect(await hasTree(repo, tree)).toBe(true);
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(tree);
	});

	test("retains an incomplete directory and unknown marker even without objects or refs", async () => {
		const empty = getNarraforkPath(
			"tree-snapshots",
			createHash("sha256").update(generateId()).digest("hex").slice(0, 32),
		);
		mkdirSync(join(empty, "objects", "pack"), { recursive: true });
		mkdirSync(join(empty, "refs"), { recursive: true });
		const marker = Buffer.from([0, 128, 255, 13, 10]);
		writeFileSync(join(empty, "marker.bin"), marker);
		try {
			await worktreeTreeSnapshot.gcAll();
			expect(existsSync(empty)).toBe(true);
			expect(readFileSync(join(empty, "marker.bin"))).toEqual(marker);
			expect(existsSync(join(empty, "HEAD"))).toBe(false);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
