/**
 * The work item lifecycle end to end at the service level (P3), against the migrated test
 * database and real git repositories.
 *
 * Creation is a fixture of the creation path (`git worktree add` + the resource row the worktree
 * registry writes); removal goes through the real PR #493 sequence (`NarratorWorktreeService`
 * `planRemoval` / `remove`, its loss measurement and confirmed-loss check) with fixture
 * retirement ports that drop the resource row like production.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeDependent } from "@shared/narrator-worktrees";
import { TEAM_ISOLATED_WORK_KIND } from "@shared/project-teams";
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkEvents, teamWorkItems } from "../../../db/schema";
import { LocalBackend } from "../../../lib/agent/execution/local-backend";
import { generateId } from "../../../lib/id";
import { safeSpawn } from "../../../lib/spawn";
import {
	NarratorWorktreeService,
	WORKTREE_MAX_OUTPUT_BYTES,
	type WorktreeTarget,
} from "../../narrator-worktree-service";
import { type LifecycleGuardPorts, withLifecycleGuardPorts } from "../../worktree-lifecycle-guard";
import { teamWorktreePathsForNarrator } from "../team-membership";
import {
	attachWorker,
	cancelWorkItem,
	cleanupWorkItem,
	createWorkItem,
	markReady,
	overlappingPaths,
	recordDecision,
	recordReview,
	settleIsolatedWorkItem,
	setWorkItemPortsForTests,
	syncWorkItem,
	updateBrief,
	type WorkActor,
	type WorkItemWorktreePorts,
	worktreePathOf,
} from "../work-items";

const LEAD = "p3-lead";
const PROJECT = "p3-project";
const USER = "p3-user";
const agent: WorkActor = { kind: "agent", id: LEAD };
const principal = { userId: USER, isAdmin: false };
const signal = () => new AbortController().signal;
const NOW = "2026-11-17T00:00:00.000Z";

let temporary: string;
let source: string;
let dependents: WorktreeDependent[];
let runningWorkers: Set<string>;
let held: string[][];

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		timeout: 10_000,
		maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
const commitAll = (cwd: string, message: string) =>
	git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-qam", message], cwd);
async function commitFile(cwd: string, file: string, text: string, message: string) {
	await writeFile(join(cwd, file), text);
	await git(["add", "--", file], cwd);
	await commitAll(cwd, message);
}

const guardPorts: LifecycleGuardPorts = {
	readClaims: async () => ({ complete: true, claims: [] }),
	canonicalPath: async (path) => path,
	pathIdentity: async (path) => {
		const node = await lstat(path).catch(() => null);
		return node ? `${node.dev}:${node.ino}` : null;
	},
};

function removalService(): NarratorWorktreeService<string> {
	const target: WorktreeTarget = {
		workspace: {
			deviceId: "local",
			cwd: source,
			rootPath: source,
			workspaceKey: "workspace",
			repositoryKey: "repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: new LocalBackend(),
		repositoryPath: join(source, ".git"),
	};
	const registrationAt = (path: string) =>
		db
			.select()
			.from(narratorWorktreeResources)
			.where(
				and(
					eq(narratorWorktreeResources.deviceId, "local"),
					eq(narratorWorktreeResources.worktreePath, path),
				),
			)
			.get();
	return new NarratorWorktreeService<string>({
		authorize: async () => target,
		withRevision: async (_id, _expected, action) => action(),
		withRepositoryLock: async (_key, action) => action(),
		journal: {
			read: async () => null,
			claim: async () => {
				throw new Error("removal never claims a creation receipt");
			},
			save: async () => undefined,
		},
		// No runGit seam: removal runs git exactly as production does (hardened spawn).
		retirement: {
			inspect: async ({ worktreePath }) => {
				const row = registrationAt(worktreePath);
				return {
					registration: row ? { id: row.id, state: row.state } : null,
					dependents,
					inventory: {
						backgroundTasks: 0,
						browserSessions: 0,
						terminals: 0,
						containers: 0,
						volumeSnapshots: 0,
						treeSnapshots: 0,
					},
					truncated: false,
					revision: 3,
				};
			},
			relocate: async () => ({ relocated: true }),
			stopRuntime: async () => ({ cancelledTasks: 0, closedBrowsers: 0 }),
			archiveSubagent: async () => {},
			releaseAttachments: async () => ({ closedTerminals: 0 }),
			releaseRegistration: async ({ registrationId }) => {
				const row = db
					.select()
					.from(narratorWorktreeResources)
					.where(eq(narratorWorktreeResources.id, registrationId))
					.get();
				if (!row) return null;
				db.delete(narratorWorktreeResources)
					.where(eq(narratorWorktreeResources.id, registrationId))
					.run();
				return {
					id: row.id,
					ownerNarratorId: row.ownerNarratorId,
					deviceId: row.deviceId,
					repositoryKey: row.repositoryKey,
					worktreePath: row.worktreePath,
					createRequestId: row.createRequestId,
					scopeKind: row.scopeKind,
					scopeProjectId: row.scopeProjectId,
					scopeOwnerUserId: row.scopeOwnerUserId,
					ownershipRevision: row.ownershipRevision,
					state: row.state,
					containerConfig: row.containerConfig ?? null,
					createdAt: row.createdAt,
				};
			},
			restoreRegistration: async (snapshot) => {
				db.insert(narratorWorktreeResources).values(snapshot).onConflictDoNothing().run();
			},
			releasePathRows: async () => 0,
		},
	});
}

function fixturePorts(): WorkItemWorktreePorts {
	const service = removalService();
	return {
		async createWorktree({ requestId, branchName, baseRef }) {
			const path = join(source, ".worktrees", requestId);
			await git(["worktree", "add", "-q", "-b", branchName, "--", path, baseRef]);
			db.insert(narratorWorktreeResources)
				.values({
					id: generateId(),
					ownerNarratorId: LEAD,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: path,
					state: "ready",
					createRequestId: requestId,
				})
				.run();
			return { path };
		},
		planRemoval: ({ path, signal }) =>
			withLifecycleGuardPorts(guardPorts, () =>
				service.planRemoval("actor", LEAD, { workspaceKey: "workspace", path }, signal),
			),
		removeWorktree: ({ path, expectedRevision, force, confirmedLoss, signal }) =>
			withLifecycleGuardPorts(guardPorts, () =>
				service.remove(
					"actor",
					LEAD,
					{
						workspaceKey: "workspace",
						path,
						expectedRevision,
						...(force ? { force, confirmedLoss } : {}),
					},
					signal,
				),
			),
		holdSessions: async (ids, fn) => {
			held.push([...ids]);
			const busy = ids.find((id) => runningWorkers.has(id));
			return busy ? { held: false, busy } : { held: true, value: await fn() };
		},
		principalOf: async (userId) => ({ userId, isAdmin: false }),
		gitIdentity: async () => ({
			GIT_AUTHOR_NAME: "Team",
			GIT_AUTHOR_EMAIL: "team@e.test",
			GIT_COMMITTER_NAME: "Team",
			GIT_COMMITTER_EMAIL: "team@e.test",
		}),
	};
}

function seedTeam() {
	sqlite.run(
		`INSERT INTO users (id, username, password_hash, role, created_at)
		VALUES (?, ?, 'x', 'user', ?)`,
		[USER, USER, NOW],
	);
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES (?, 'p', ?, ?, ?)",
		[PROJECT, source, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, cwd, created_at, updated_at)
		VALUES (?, 'primary', 'Lead', '["team"]', ?, ?, ?)`,
		[LEAD, source, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES (?, ?, 'main', ?, ?)`,
		[LEAD, PROJECT, NOW, NOW],
	);
}

function seedWorker(id: string, parent = LEAD, status = "idle") {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, status, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
		VALUES (?, 'subagent', ?, ?, ?, ?, ?, ?)`,
		[id, id, status, parent, LEAD, NOW, NOW],
	);
}

function events(itemId: string | null) {
	return (
		db
			.select({
				kind: teamWorkEvents.kind,
				actorKind: teamWorkEvents.actorKind,
				actorId: teamWorkEvents.actorId,
				detail: teamWorkEvents.detailJson,
			})
			.from(teamWorkEvents)
			.where(itemId ? eq(teamWorkEvents.workItemId, itemId) : eq(teamWorkEvents.teamId, LEAD))
			// Insertion order: events written in the same millisecond share a timestamp.
			.orderBy(sql`rowid`)
			.all()
	);
}

const create = (title: string, kind?: string) =>
	createWorkItem({ coordinatorId: LEAD, title, kind, actor: agent, principal, signal: signal() });

beforeAll(() => {
	setWorkItemPortsForTests(null);
});
afterAll(() => {
	setWorkItemPortsForTests(null);
});

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-work-"));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(source, ".gitignore"), ".worktrees/\n");
	await writeFile(join(source, "tracked.txt"), "base\n");
	await git(["add", "."]);
	await commitAll(source, "initial");
	await mkdir(join(source, ".worktrees"));
	dependents = [];
	runningWorkers = new Set();
	held = [];
	seedTeam();
	setWorkItemPortsForTests(fixturePorts());
});

afterEach(async () => {
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'p3-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	await rm(temporary, { recursive: true, force: true });
});

describe("work item lifecycle", () => {
	test("create → the worker commits → blocker round → clear round → ready", async () => {
		const item = await create("Add the export button");
		expect(item.state).toBe("queued");
		expect(item.branchName).toMatch(/^team\/add-the-export-button-[a-f0-9]{8}$/);
		const path = worktreePathOf(item);
		expect(path && existsSync(path)).toBe(true);
		expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], path ?? "")).toBe(
			item.branchName ?? "",
		);

		seedWorker("p3-worker");
		attachWorker(LEAD, item.id, "p3-worker", agent);
		// The worktree is the team's for the coordinator, its worker and the worker's helpers.
		seedWorker("p3-helper", "p3-worker");
		for (const id of [LEAD, "p3-worker", "p3-helper"])
			expect(teamWorktreePathsForNarrator(id)).toEqual([path ?? ""]);
		expect(teamWorktreePathsForNarrator("p3-nobody")).toEqual([]);
		// Another worker's item is not this worker's: only the coordinator sees both.
		const other = await create("Someone else's");
		seedWorker("p3-other-worker");
		attachWorker(LEAD, other.id, "p3-other-worker", agent);
		const otherPath = worktreePathOf(other) ?? "";
		expect(teamWorktreePathsForNarrator(LEAD).sort()).toEqual([path ?? "", otherPath].sort());
		expect(teamWorktreePathsForNarrator("p3-worker")).toEqual([path ?? ""]);
		expect(teamWorktreePathsForNarrator("p3-helper")).toEqual([path ?? ""]);
		expect(teamWorktreePathsForNarrator("p3-other-worker")).toEqual([otherPath]);
		cancelWorkItem({ coordinatorId: LEAD, itemId: other.id, actor: agent });
		await commitFile(path ?? "", "export.ts", "export const x = 1;\n", "export button");

		// Ready before any review is refused.
		await expect(markReady({ coordinatorId: LEAD, itemId: item.id, actor: agent })).rejects.toThrow(
			"no review yet",
		);
		const first = await recordReview({
			coordinatorId: LEAD,
			itemId: item.id,
			verdict: "blocker",
			findings: 2,
			reviewer: "p3-reviewer-1",
			actor: agent,
		});
		expect(first.round).toBe(1);
		expect(first.item.state).toBe("in_progress");
		expect(first.item.workerNarratorId).toBe("p3-worker");
		await expect(markReady({ coordinatorId: LEAD, itemId: item.id, actor: agent })).rejects.toThrow(
			"found blockers",
		);
		// The author fixes it (Send back to the worker), then a fresh reviewer clears it.
		await commitFile(path ?? "", "export.ts", "export const x = 2;\n", "fix review");
		const second = await recordReview({
			coordinatorId: LEAD,
			itemId: item.id,
			verdict: "clear",
			findings: 0,
			reviewer: "p3-reviewer-2",
			actor: agent,
		});
		expect(second.round).toBe(2);
		expect(second.item.state).toBe("in_review");
		const ready = await markReady({ coordinatorId: LEAD, itemId: item.id, actor: agent });
		expect(ready.item.state).toBe("ready");
		expect(ready.commitsSinceReview).toBe(0);
		expect(ready.item.headSha).toBe(await git(["rev-parse", "HEAD"], path ?? ""));

		const log = events(item.id);
		expect(log.map((event) => event.kind)).toEqual([
			"work.created",
			"work.started",
			"work.review",
			"work.review",
			"work.ready",
		]);
		for (const event of log) expect([event.actorKind, event.actorId]).toEqual(["agent", LEAD]);
		expect(log[2]?.detail).toMatchObject({ round: 1, verdict: "blocker", findings: 2 });
		expect(log[3]?.detail).toMatchObject({ round: 2, verdict: "clear", reviewer: "p3-reviewer-2" });
	});

	test("an isolated item whose run made nothing is cleaned and cancelled; its branch stays", async () => {
		const item = await create("Try an idea", TEAM_ISOLATED_WORK_KIND);
		expect(item.state).toBe("in_progress");
		seedWorker("p3-iso");
		attachWorker(LEAD, item.id, "p3-iso", agent);
		const path = worktreePathOf(item) ?? "";
		// The worker lived in the worktree: the removal channel retires it like any dependent.
		dependents = [{ id: "p3-iso", title: "iso", status: "idle", kind: "subagent", running: false }];
		expect(await settleIsolatedWorkItem("p3-iso", { retry: false })).toBe("cleaned");
		expect(existsSync(path)).toBe(false);
		expect(await git(["branch", "--list", item.branchName ?? ""])).toContain(item.branchName ?? "");
		const after = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get();
		expect(after?.state).toBe("cancelled");
		expect(after?.worktreeResourceId).toBeNull();
		const log = events(item.id);
		// One transaction, one timestamp: compare the pair without its order.
		expect(
			log
				.slice(-2)
				.map((event) => event.kind)
				.sort(),
		).toEqual(["work.cancelled", "work.cleanup"]);
		expect(log.find((event) => event.kind === "work.cancelled")?.detail).toMatchObject({
			reason: "no_changes",
			auto: true,
		});
		expect(log.find((event) => event.kind === "work.cleanup")?.detail).toMatchObject({
			outcome: "removed",
			branchKept: true,
		});
	});

	test("an isolated item with a commit or an uncommitted change stays in progress", async () => {
		const committed = await create("Commit something", TEAM_ISOLATED_WORK_KIND);
		seedWorker("p3-iso-a");
		attachWorker(LEAD, committed.id, "p3-iso-a", agent);
		await commitFile(worktreePathOf(committed) ?? "", "a.txt", "a\n", "work");
		expect(await settleIsolatedWorkItem("p3-iso-a", { retry: false })).toBe("kept");

		const dirty = await create("Leave a change", TEAM_ISOLATED_WORK_KIND);
		seedWorker("p3-iso-b");
		attachWorker(LEAD, dirty.id, "p3-iso-b", agent);
		await writeFile(join(worktreePathOf(dirty) ?? "", "draft.txt"), "draft\n");
		expect(await settleIsolatedWorkItem("p3-iso-b", { retry: false })).toBe("kept");

		for (const id of [committed.id, dirty.id]) {
			const row = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get();
			expect(row?.state).toBe("in_progress");
			expect(existsSync(worktreePathOf(row ?? { worktreeResourceId: null }) ?? "")).toBe(true);
		}
		// A default-kind item is never cleaned on its own.
		const plain = await create("Plain item");
		seedWorker("p3-plain");
		attachWorker(LEAD, plain.id, "p3-plain", agent);
		expect(await settleIsolatedWorkItem("p3-plain", { retry: false })).toBe("none");
	});
});

describe("base sync", () => {
	test("no conflict risk: merged on the server with a merge commit", async () => {
		const item = await create("Sync me");
		const path = worktreePathOf(item) ?? "";
		await commitFile(path, "mine.txt", "mine\n", "item work");
		await commitFile(source, "theirs.txt", "theirs\n", "base moved");
		const before = await git(["rev-parse", "HEAD"], path);
		const outcome = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(outcome.outcome).toBe("merged");
		const head = await git(["rev-parse", "HEAD"], path);
		expect(head).not.toBe(before);
		expect((await git(["rev-list", "--parents", "-n", "1", "HEAD"], path)).split(" ")).toHaveLength(
			3,
		);
		expect(existsSync(join(path, "theirs.txt"))).toBe(true);
		expect(await git(["log", "-1", "--format=%an"], path)).toBe("Team");
		const row = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get();
		expect(row?.headSha).toBe(head);
		expect(events(item.id).at(-1)).toMatchObject({
			kind: "work.sync",
			actorKind: "agent",
			detail: { outcome: "merged" },
		});
		// Nothing left to bring in.
		expect(
			(await syncWorkItem({ coordinatorId: LEAD, itemId: item.id, actor: agent, userId: USER }))
				.outcome,
		).toBe("up_to_date");
	});

	test("conflict risk: handed to the item's worker, branch untouched", async () => {
		const item = await create("Conflicting");
		seedWorker("p3-conflict");
		attachWorker(LEAD, item.id, "p3-conflict", agent);
		const path = worktreePathOf(item) ?? "";
		await writeFile(join(path, "tracked.txt"), "item side\n");
		await commitAll(path, "item edits tracked");
		await writeFile(join(source, "tracked.txt"), "base side\n");
		await commitAll(source, "base edits tracked");
		const before = await git(["rev-parse", "HEAD"], path);
		const outcome = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(outcome).toMatchObject({
			outcome: "handed_off",
			reason: "overlap",
			paths: ["tracked.txt"],
			worker: "p3-conflict",
		});
		expect(await git(["rev-parse", "HEAD"], path)).toBe(before);
		expect(await git(["status", "--porcelain"], path)).toBe("");
		expect(existsSync(join(path, ".git"))).toBe(true);

		// A running worker is never merged under, even without overlap.
		await commitFile(source, "other.txt", "x\n", "unrelated base change");
		runningWorkers.add("p3-conflict");
		const busy = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(busy).toMatchObject({ outcome: "handed_off", reason: "worker_running" });
		expect(await git(["rev-parse", "HEAD"], path)).toBe(before);
	});

	test("the worker and its live helpers are held through the merge; a running helper is busy", async () => {
		const item = await create("Held");
		seedWorker("p3-held");
		attachWorker(LEAD, item.id, "p3-held", agent);
		seedWorker("p3-held-helper", "p3-held");
		seedWorker("p3-held-gone", "p3-held", "archived");
		const path = worktreePathOf(item) ?? "";
		await commitFile(path, "mine.txt", "mine\n", "item work");
		await commitFile(source, "theirs.txt", "theirs\n", "base moved");
		const before = await git(["rev-parse", "HEAD"], path);
		runningWorkers.add("p3-held-helper");
		const busy = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(busy).toMatchObject({ outcome: "handed_off", reason: "worker_running" });
		expect(held.at(-1)?.sort()).toEqual(["p3-held", "p3-held-helper"]);
		expect(await git(["rev-parse", "HEAD"], path)).toBe(before);
		runningWorkers.clear();
		const merged = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(merged.outcome).toBe("merged");
	});

	test("commits a sync brings in from the base do not count as commits since the review", async () => {
		const item = await create("Reviewed then synced");
		const path = worktreePathOf(item) ?? "";
		await commitFile(path, "mine.txt", "mine\n", "item work");
		await recordReview({
			coordinatorId: LEAD,
			itemId: item.id,
			verdict: "clear",
			findings: 0,
			reviewer: null,
			actor: agent,
		});
		await commitFile(source, "theirs.txt", "theirs\n", "base moved");
		await commitFile(source, "theirs2.txt", "theirs\n", "base moved again");
		const synced = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(synced.outcome).toBe("merged");
		expect(
			(await markReady({ coordinatorId: LEAD, itemId: item.id, actor: agent })).commitsSinceReview,
		).toBe(
			1, // the merge commit itself; the two base commits are not counted
		);
	});

	test("overlap covers the same path and file-versus-directory collisions", () => {
		expect(overlappingPaths(["a/b.txt", "c.txt"], ["a/b.txt"])).toEqual(["a/b.txt"]);
		expect(overlappingPaths(["a"], ["a/b.txt"])).toEqual(["a"]);
		expect(overlappingPaths(["a/b.txt"], ["a"])).toEqual(["a/b.txt"]);
		expect(overlappingPaths(["a/b.txt"], ["a/c.txt", "ab"])).toEqual([]);
	});
});

describe("cleanup", () => {
	test("only finished items; a loss needs force with the exact confirmed loss; branch kept", async () => {
		const item = await create("Abandoned");
		const path = worktreePathOf(item) ?? "";
		await writeFile(join(path, "tracked.txt"), "uncommitted\n");
		const cleanup = (extra: Partial<Parameters<typeof cleanupWorkItem>[0]> = {}) =>
			cleanupWorkItem({
				coordinatorId: LEAD,
				itemId: item.id,
				principal,
				actor: agent,
				signal: signal(),
				...extra,
			});
		await expect(cleanup()).rejects.toThrow("only a merged or cancelled item");
		cancelWorkItem({ coordinatorId: LEAD, itemId: item.id, reason: "superseded", actor: agent });

		const refused = await cleanup();
		expect(refused).toMatchObject({ outcome: "refused", code: "WORKTREE_REMOVAL_FORCE_REQUIRED" });
		if (refused.outcome !== "refused" || !refused.loss) throw new Error("expected a loss report");
		expect(refused.loss.dirtyFileCount).toBe(1);
		expect(existsSync(path)).toBe(true);

		await expect(cleanup({ force: true })).rejects.toThrow("confirmed loss");
		const wrong = await cleanup({
			force: true,
			confirmedLoss: { ...refused.loss, dirtyFileCount: 0 },
		});
		expect(wrong).toMatchObject({ outcome: "refused", code: "WORKTREE_REMOVAL_CHANGED" });
		expect(existsSync(path)).toBe(true);

		const removed = await cleanup({ force: true, confirmedLoss: refused.loss });
		expect(removed).toMatchObject({ outcome: "removed", branch: item.branchName });
		expect(teamWorktreePathsForNarrator(LEAD)).toEqual([]);
		expect(existsSync(path)).toBe(false);
		expect(await git(["branch", "--list", item.branchName ?? ""])).toContain(item.branchName ?? "");
		const log = events(item.id);
		expect(
			log.filter((event) => event.kind === "work.cleanup").map((e) => e.detail?.outcome),
		).toEqual(["refused", "refused", "removed"]);
		expect(log.at(-1)?.detail).toMatchObject({ forced: true, branchKept: true });
		expect(log.find((event) => event.kind === "work.cancelled")).toMatchObject({
			actorKind: "agent",
			detail: { reason: "superseded", from: "queued" },
		});
	});
});

describe("team records", () => {
	test("brief and decisions are events with their actor", () => {
		const person: WorkActor = { kind: "person", id: USER };
		expect(
			updateBrief({ coordinatorId: LEAD, text: "Run bun test --isolate.", actor: agent }),
		).toEqual({ bytes: 23, changed: true });
		expect(
			updateBrief({ coordinatorId: LEAD, text: "Run bun test --isolate.", actor: agent }),
		).toEqual({ bytes: 23, changed: false });
		expect(() =>
			updateBrief({ coordinatorId: LEAD, text: "é".repeat(2049), actor: agent }),
		).toThrow("at most 4096 bytes");
		recordDecision({ coordinatorId: LEAD, text: "Kept the old API name.", actor: agent });
		recordDecision({ coordinatorId: LEAD, text: "A person chose option B.", actor: person });
		const team = events(null);
		expect(team.map((event) => [event.kind, event.actorKind])).toEqual([
			["team.brief", "agent"],
			["team.decision", "agent"],
			["team.decision", "person"],
		]);
		expect(team[1]?.detail).toEqual({ summary: "Kept the old API name." });
		// Another session is no coordinator.
		expect(() => recordDecision({ coordinatorId: "p3-nobody", text: "x", actor: agent })).toThrow(
			"Only a team coordinator",
		);
	});
});

describe("no repository code runs on the server", () => {
	/** A hook, an fsmonitor and filter drivers that each leave a mark when git runs them. */
	async function plant(path: string, marker: string, options: { filters?: boolean } = {}) {
		// Husky ≥ 5: a relative hooksPath whose directory ignores itself.
		await git(["config", "core.hooksPath", ".husky/_"]);
		const hooks = join(path, ".husky", "_");
		await mkdir(hooks, { recursive: true });
		await writeFile(join(hooks, ".gitignore"), "*\n");
		for (const hook of ["pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-merge"]) {
			await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`);
			await chmod(join(hooks, hook), 0o755);
		}
		const fsmonitor = join(temporary, "fsmonitor.sh");
		await writeFile(fsmonitor, `#!/bin/sh\necho fsmonitor >> ${marker}\nexit 1\n`);
		await chmod(fsmonitor, 0o755);
		await git(["config", "core.fsmonitor", fsmonitor]);
		if (options.filters) {
			await git(["config", "filter.probe.clean", `sh -c 'echo clean >> ${marker}; cat'`]);
			await git(["config", "filter.probe.smudge", `sh -c 'echo smudge >> ${marker}; cat'`]);
			await git(["config", "merge.probe.driver", `sh -c 'echo driver >> ${marker}; exit 1'`]);
		}
	}

	test("sync merges with hooks and fsmonitor disabled; an ignored executable hook never runs", async () => {
		const item = await create("Hooked");
		const path = worktreePathOf(item) ?? "";
		const marker = join(temporary, "marker");
		await commitFile(path, "mine.txt", "mine\n", "item work");
		await commitFile(source, "theirs.txt", "theirs\n", "base moved");
		await plant(path, marker);
		expect(await git(["status", "--porcelain", "--untracked-files=all"], path)).toBe("");
		await rm(marker, { force: true });
		const outcome = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(outcome.outcome).toBe("merged");
		expect(existsSync(marker)).toBe(false);
	});

	test("filter or merge drivers in the config: sync hands off, queries never run them", async () => {
		const item = await create("Filtered");
		const path = worktreePathOf(item) ?? "";
		const marker = join(temporary, "marker");
		await writeFile(join(path, ".gitattributes"), "*.t filter=probe merge=probe\n");
		await writeFile(join(path, "a.t"), "a\n");
		await git(["add", "."], path);
		await commitAll(path, "attributes");
		await commitFile(source, "theirs.txt", "theirs\n", "base moved");
		await plant(path, marker, { filters: true });
		await rm(marker, { force: true });
		// Racily clean: status would have to run the clean filter to compare.
		await writeFile(join(path, "a.t"), "a\n");
		const outcome = await syncWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			actor: agent,
			userId: USER,
		});
		expect(outcome).toMatchObject({ outcome: "handed_off", reason: "custom_drivers" });
		// The removal channel's own git (status for the loss, worktree remove) is hardened too.
		cancelWorkItem({ coordinatorId: LEAD, itemId: item.id, actor: agent });
		const cleaned = await cleanupWorkItem({
			coordinatorId: LEAD,
			itemId: item.id,
			principal,
			actor: agent,
			signal: signal(),
		});
		expect(cleaned.outcome).toBe("removed");
		expect(existsSync(marker)).toBe(false);
	});
});
