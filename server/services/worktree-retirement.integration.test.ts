/**
 * Recorded worktree removal through the production deletion protection: the lifecycle
 * guard's reservation over the real protection index, the running-terminal check and the
 * SQLite resource registry, on an isolated database and a real repository.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorWorktreeResources, terminals } from "../db/schema";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import type { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import { worktreeResourceId } from "./narrator-worktree-resource-store";
import { narratorWorktreeResourceRegistry } from "./narrator-worktree-resources";
import { NarratorWorktreeService, type WorktreeTarget } from "./narrator-worktree-service";
import { withWorktreeRetirement } from "./worktree-lifecycle-guard";

let temporary: string;
let source: string;
let worktree: string;
let service: NarratorWorktreeService<string>;
const narratorIds: string[] = [];
const terminalIds: string[] = [];
const resourcePaths: string[] = [];
const signal = () => new AbortController().signal;

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({ cmd: ["git", "-C", cwd, ...args], timeout: 10_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
async function exists(path: string) {
	return lstat(path).then(
		() => true,
		() => false,
	);
}
async function narrator(cwd: string) {
	const id = generateId();
	narratorIds.push(id);
	await db.insert(narrators).values({
		id,
		title: "retirement fixture",
		cwd,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	return id;
}
async function record(path: string) {
	resourcePaths.push(path);
	const now = new Date().toISOString();
	await db.insert(narratorWorktreeResources).values({
		id: worktreeResourceId("local", path),
		ownerNarratorId: null,
		deviceId: "local",
		repositoryKey: "retirement-repository",
		worktreePath: path,
		createRequestId: generateId(),
		state: "ready",
		createdAt: now,
		updatedAt: now,
	});
}
function rowFor(path: string) {
	return db
		.select({ id: narratorWorktreeResources.id })
		.from(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.worktreePath, path))
		.get();
}
async function refusal(path = worktree) {
	try {
		await service.remove("actor", "narrator", { workspaceKey: "workspace", path }, signal());
	} catch (cause) {
		return cause as AppError;
	}
	throw new Error("Expected removal to be refused");
}

beforeAll(() => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated fixture database required");
});

beforeEach(async () => {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-retirement-")));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(source, "tracked.txt"), "x\n");
	await git(["add", "tracked.txt"]);
	await git(["-c", "user.name=F", "-c", "user.email=f@example.test", "commit", "-qm", "init"]);
	await mkdir(join(source, ".worktrees"));
	await writeFile(join(source, ".git", "info", "exclude"), ".worktrees/\n");
	worktree = join(source, ".worktrees", "task");
	await git(["worktree", "add", "-q", "-b", "task", worktree]);
	await record(worktree);
	const target: WorktreeTarget = {
		workspace: {
			deviceId: "local",
			cwd: source,
			rootPath: source,
			workspaceKey: "workspace",
			repositoryKey: "retirement-repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: new LocalBackend(),
		repositoryPath: join(source, ".git"),
	};
	service = new NarratorWorktreeService<string>({
		authorize: async () => target,
		withRevision: async (_id, _revision, action) => action(),
		withRepositoryLock: async (_key, action) => action(),
		journal: new FileWorktreeJournal(join(temporary, "receipts")),
		resources: narratorWorktreeResourceRegistry,
		withRetirement: withWorktreeRetirement,
	});
});

afterEach(async () => {
	if (terminalIds.length) await db.delete(terminals).where(inArray(terminals.id, terminalIds));
	terminalIds.length = 0;
	if (resourcePaths.length)
		await db
			.delete(narratorWorktreeResources)
			.where(inArray(narratorWorktreeResources.worktreePath, resourcePaths));
	resourcePaths.length = 0;
	if (narratorIds.length) await db.delete(narrators).where(inArray(narrators.id, narratorIds));
	narratorIds.length = 0;
	await rm(temporary, { recursive: true, force: true });
});

test("its own record does not protect it; a session at the repository root does not either", async () => {
	await narrator(source);
	const listed = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
	expect(listed.entries.find((entry) => entry.path === worktree)?.recorded).toBe(true);
	const result = await service.remove(
		"actor",
		"narrator",
		{ workspaceKey: "workspace", path: worktree, deleteBranch: true },
		signal(),
	);
	expect(result).toMatchObject({ removed: true, record: "retired" });
	expect(result.branch).toMatchObject({ name: "task", deleted: true, method: "merged" });
	expect(await exists(worktree)).toBe(false);
	expect(rowFor(worktree)).toBeUndefined();
});

test("a session whose cwd is inside blocks removal", async () => {
	const id = await narrator(join(worktree, "src"));
	const refused = await refusal();
	expect(refused.code).toBe("WORKTREE_IN_USE");
	expect(refused.details).toEqual({ blockedBy: { kind: "narrator", id } });
	expect(await exists(worktree)).toBe(true);
	expect(rowFor(worktree)).toBeDefined();
});

test("a running terminal inside blocks removal; an exited one does not", async () => {
	const owner = await narrator(join(temporary, "elsewhere"));
	const terminal = generateId();
	terminalIds.push(terminal);
	await db.insert(terminals).values({
		id: terminal,
		narratorId: owner,
		name: "shell",
		cwd: worktree,
		status: "running",
		createdAt: new Date().toISOString(),
	});
	const refused = await refusal();
	expect(refused.code).toBe("WORKTREE_IN_USE");
	expect(refused.details).toEqual({ blockedBy: { kind: "terminal", id: terminal } });
	expect(await exists(worktree)).toBe(true);
	await db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, terminal));
	await service.remove(
		"actor",
		"narrator",
		{ workspaceKey: "workspace", path: worktree },
		signal(),
	);
	expect(await exists(worktree)).toBe(false);
});

test("a nested recorded worktree still protects its parent", async () => {
	const nested = join(worktree, "nested");
	await record(nested);
	const refused = await refusal();
	expect(refused.code).toBe("WORKTREE_IN_USE");
	expect(refused.details).toEqual({
		blockedBy: { kind: "registry", id: worktreeResourceId("local", nested) },
	});
	expect(await exists(worktree)).toBe(true);
});

test("a .worktrees directory without a record is refused before anything inspects it", async () => {
	const legacy = join(source, ".worktrees", "legacy-chapter");
	await git(["worktree", "add", "-q", "-b", "legacy-chapter", legacy]);
	await writeFile(join(legacy, "chapter.txt"), "kept\n");
	const refused = await refusal(legacy);
	expect(refused.code).toBe("WORKTREE_NOT_RECORDED");
	expect(await exists(join(legacy, "chapter.txt"))).toBe(true);
});
