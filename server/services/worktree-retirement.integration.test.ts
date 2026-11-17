/**
 * Recorded worktree removal through the production deletion protection: the lifecycle
 * guard's reservation over the real protection index, the running-terminal check and the
 * SQLite resource registry, on an isolated database and a real repository.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { narrators, narratorWorktreeResources, terminals } from "../db/schema";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import type { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import { worktreeResourceId } from "./narrator-worktree-resource-store";
import { narratorWorktreeResourceRegistry } from "./narrator-worktree-resources";
import { NarratorWorktreeService, type WorktreeTarget } from "./narrator-worktree-service";
import { maintainProtectionIndex } from "./resource-protection-index";
import {
	inspect,
	type ResourceClaim,
	withLifecycleGuardPorts,
	withWorktreeRetirement,
} from "./worktree-lifecycle-guard";

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
/** The owner is null: as after its session was deleted (`ON DELETE SET NULL`). */
async function record(path: string, createRequestId = generateId()) {
	resourcePaths.push(path);
	const now = new Date().toISOString();
	await db.insert(narratorWorktreeResources).values({
		id: worktreeResourceId("local", path),
		ownerNarratorId: null,
		deviceId: "local",
		repositoryKey: "retirement-repository",
		worktreePath: path,
		createRequestId,
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
	expect(refused.code).toBe("WORKTREE_RESOURCE_PROTECTED");
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

test("only the retired row and its own creation receipt are waived", async () => {
	const path = "/fixture/repo/.worktrees/task";
	const recorded = new Map<string, { requestId: string; destination: string } | null>([
		["/journal/own.json", { requestId: "create-own", destination: path }],
		["/journal/other.json", { requestId: "create-other", destination: path }],
		["/journal/elsewhere.json", { requestId: "create-own", destination: "/fixture/other" }],
		["/journal/unreadable.json", null],
	]);
	const verdict = (claims: ResourceClaim[]) =>
		withLifecycleGuardPorts(
			{
				canonicalPath: async (value) => value,
				readClaims: async () => ({ complete: true, claims }),
				receiptRequest: async (id) => recorded.get(id) ?? null,
			},
			async () =>
				(
					await inspect(
						[
							{
								deviceId: "local",
								path,
								retiringRegistryId: "row",
								retiringCreateRequestId: "create-own",
							},
						],
						"worktree remove",
					)
				).status,
		);
	const row: ResourceClaim = { kind: "registry", id: "row", deviceId: "local", path };
	const receipt = (name: string): ResourceClaim => ({
		kind: "receipt",
		id: `/journal/${name}.json`,
		deviceId: "local",
		path,
		repositoryKey: "r",
	});
	// Matched by what the receipt records, so it holds whoever owned it.
	expect(await verdict([row, receipt("own")])).toBe("clear");
	expect(await verdict([row, receipt("other")])).toBe("protected");
	expect(await verdict([row, receipt("elsewhere")])).toBe("protected");
	expect(await verdict([row, receipt("unreadable")])).toBe("protected");
	expect(await verdict([{ ...row, id: "other-row" }])).toBe("protected");
});

describe("a creation receipt on disk, after the owner session was deleted", () => {
	const receipts: string[] = [];
	async function legacyReceipt(requestId: string) {
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		const file = join(directory, `${createHash("sha256").update(generateId()).digest("hex")}.json`);
		receipts.push(file);
		await writeFile(
			file,
			JSON.stringify({
				proposalHash: "fixture",
				request: { requestId, destinationPath: worktree },
				repositoryKey: "retirement-repository",
				deviceId: "local",
				destination: worktree,
				expectedHead: "",
				dispatchState: "started",
			}),
		);
		// Re-import the legacy namespace so the index holds this file as a claim.
		sqlite.exec(`UPDATE resource_protection_sources SET complete = 0, cursor = NULL
			WHERE source = 'receipt' AND source_id = ''`);
		for (let batch = 0; batch < 8; batch++) {
			await maintainProtectionIndex(performance.now() + 5000);
			const state = sqlite
				.query<{ complete: number }, []>(
					"SELECT complete FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ''",
				)
				.get();
			if (state?.complete) return;
		}
		throw new Error("Receipt import did not complete");
	}
	afterEach(async () => {
		for (const file of receipts.splice(0)) await rm(file, { force: true });
		sqlite.exec(`DELETE FROM resource_protection_paths WHERE source = 'receipt';
			DELETE FROM resource_protection_sources WHERE source = 'receipt' AND source_id != ''`);
	});

	test("its own receipt does not make the record unremovable", async () => {
		const row = rowFor(worktree);
		const createRequestId = db
			.select({ id: narratorWorktreeResources.createRequestId })
			.from(narratorWorktreeResources)
			.where(eq(narratorWorktreeResources.id, row?.id ?? ""))
			.get()?.id;
		if (!createRequestId) throw new Error("Missing fixture record");
		await legacyReceipt(createRequestId);
		const result = await service.remove(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktree },
			signal(),
		);
		expect(result).toMatchObject({ removed: true, record: "retired" });
		expect(await exists(worktree)).toBe(false);
	});

	test("another request's receipt at the path refuses with its own honest code", async () => {
		await legacyReceipt("some-other-request");
		const refused = await refusal();
		expect(refused.code).toBe("WORKTREE_RECEIPT_PROTECTED");
		expect(refused.details).toEqual({ blockedBy: { kind: "receipt" } });
		expect(await exists(worktree)).toBe(true);
	});
});
