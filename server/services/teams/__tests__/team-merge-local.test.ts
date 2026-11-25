/**
 * The local merge of a ready work item end to end (M), against the migrated test database and
 * real repositories: a merge that lands (base not checked out), a merge prepared because the base
 * is checked out — with that person's checkout byte-for-byte untouched — and its explicit
 * fast-forward with every precondition, conflicts, two merges at once, a worker commit racing the
 * merge, the "merging" guard, GitHub refused, and a crash healed by ancestry.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkEvents, teamWorkItems } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { safeSpawn } from "../../../lib/spawn";
import { setGitVersionForTests } from "../team-git-write";
import { hostingOf, setHostingSourceForTests } from "../team-hosting";
import {
	mergeJobOf,
	mergeSummaryOf,
	mergeViewOf,
	pruneProjectMergeRefs,
	readMergeOutcome,
	requestFastForward,
	requestMerge,
	resetMergeJobsForTests,
	settleMergeJobs,
} from "../team-merge";
import { isMerging, resetMergingForTests } from "../team-merge-guard";
import { resetOverlapStateForTests, runChangedPathsPass } from "../team-overlap";
import {
	cancelWorkItem,
	recordReview,
	returnWorkItem,
	setMergeNoteDeliveryForTests,
	syncWorkItem,
} from "../work-items";

const LEAD = "mg-lead";
const PROJECT = "mg-project";
const USER = "mg-user";
const NOW = "2026-11-25T00:00:00.000Z";

let temporary: string;
let repo: string;
let globalConfig: string;
const notes: string[] = [];
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

async function git(args: string[], cwd = repo) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		env: { ...process.env },
		timeout: 20_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

async function commitFile(cwd: string, file: string, text: string, message: string) {
	await writeFile(join(cwd, file), text);
	await git(["add", "--", file], cwd);
	await git(["commit", "-qm", message], cwd);
	return git(["rev-parse", "HEAD"], cwd);
}

/** A ready item: its branch from main with one commit in its own worktree, recorded as ready. */
async function readyItem(name: string, file = `${name}.txt`, text = `${name}\n`) {
	const id = `mg-${name}-${generateId().slice(0, 6)}`;
	const branch = `team/${name}`;
	const worktree = join(repo, ".worktrees", name);
	await git(["worktree", "add", "-q", "-b", branch, worktree, "main"]);
	const head = await commitFile(worktree, file, text, `work ${name}`);
	const mergeBase = await git(["merge-base", "main", head]);
	const resourceId = generateId();
	db.insert(narratorWorktreeResources)
		.values({
			id: resourceId,
			ownerNarratorId: LEAD,
			deviceId: "local",
			repositoryKey: "repository",
			worktreePath: worktree,
			state: "ready",
			createRequestId: `team-${id}`,
		})
		.run();
	db.insert(teamWorkItems)
		.values({
			id,
			teamId: LEAD,
			projectId: PROJECT,
			title: `Item ${name}`,
			state: "ready",
			branchName: branch,
			baseRef: "main",
			worktreeResourceId: resourceId,
			headSha: head,
			reviewRounds: 1,
			lastReview: "clear",
			changedPathsJson: [file],
			changedPathsAtSha: head,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(teamWorkEvents)
		.values({
			id: generateId(),
			teamId: LEAD,
			workItemId: id,
			kind: "work.ready",
			actorKind: "agent",
			actorId: LEAD,
			detailJson: { head, changedPathCount: 1, mergeBase },
			createdAt: NOW,
		})
		.run();
	return { id, branch, worktree, head };
}

const item = (id: string) => db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get();
function events(itemId: string, kind?: string) {
	return db
		.select({
			kind: teamWorkEvents.kind,
			actorKind: teamWorkEvents.actorKind,
			actorId: teamWorkEvents.actorId,
			detail: teamWorkEvents.detailJson,
		})
		.from(teamWorkEvents)
		.where(
			kind
				? and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, kind))
				: eq(teamWorkEvents.workItemId, itemId),
		)
		.orderBy(sql`rowid`)
		.all();
}

/** Everything a person's checkout shows: status, HEAD, index bytes, the working tree files. */
async function checkoutFingerprint(dir: string) {
	const index = await readFile(join(dir, ".git", "index"));
	return {
		status: await git(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], dir),
		head: await git(["rev-parse", "HEAD"], dir),
		symbolic: await git(["symbolic-ref", "HEAD"], dir),
		index: createHash("sha256").update(index).digest("hex"),
		dirty: await readFile(join(dir, "tracked.txt"), "utf8"),
		staged: await git(["diff", "--cached", "--name-only"], dir),
	};
}

const merge = (itemId: string) => requestMerge({ teamId: LEAD, itemId, userId: USER });

beforeAll(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-merge-"));
	globalConfig = join(temporary, "gitconfig");
	await writeFile(
		globalConfig,
		"[user]\n\tname = Host\n\temail = host@e.test\n[commit]\n\tgpgsign = false\n",
	);
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	setMergeNoteDeliveryForTests(async ({ text }) => {
		notes.push(text);
		return true;
	});
});

afterAll(async () => {
	setMergeNoteDeliveryForTests(null);
	setHostingSourceForTests(null);
	setGitVersionForTests("real");
	if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
	if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
	notes.length = 0;
	setHostingSourceForTests(async () => null);
	repo = await realpath(await mkdtemp(join(temporary, "repo-")));
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(repo, ".gitignore"), ".worktrees/\n");
	await writeFile(join(repo, "tracked.txt"), "base\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "initial"]);
	await mkdir(join(repo, ".worktrees"));
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, 'alice', 'x', 'user', ?)",
		[USER, NOW],
	);
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES (?, 'p', ?, ?, ?)",
		[PROJECT, repo, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, cwd, created_at, updated_at)
		VALUES (?, 'primary', 'Lead', '["team"]', ?, ?, ?)`,
		[LEAD, repo, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES (?, ?, 'main', ?, ?)`,
		[LEAD, PROJECT, NOW, NOW],
	);
});

afterEach(async () => {
	await settleMergeJobs();
	resetMergeJobsForTests();
	resetMergingForTests();
	resetOverlapStateForTests();
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'mg-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	await rm(repo, { recursive: true, force: true });
});

describe("local merge", () => {
	test("base not checked out: the base fast-forwards to a merge commit; merged by local_merge", async () => {
		const a = await readyItem("alpha");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		const accepted = merge(a.id);
		expect(accepted).toEqual({ itemId: a.id, job: "merge", phase: "queued" });
		expect(isMerging(a.id)).toBe(true);
		expect(mergeJobOf(a.id)?.job).toBe("merge");
		await settleMergeJobs();
		expect(isMerging(a.id)).toBe(false);
		const base = await git(["rev-parse", "main"]);
		// alice has no NarraFork git identity: the host's identity commits.
		expect(await git(["log", "-1", "--format=%P|%an|%s", "main"])).toBe(
			`${old} ${a.head}|Host|Merge team work item: Item alpha (team/alpha)`,
		);
		expect(item(a.id)?.state).toBe("merged");
		const merged = events(a.id, "work.merged");
		expect(merged).toHaveLength(1);
		expect(merged[0]?.actorKind).toBe("person");
		expect(merged[0]?.actorId).toBe(USER);
		expect(merged[0]?.detail).toMatchObject({
			detectedBy: "local_merge",
			mergeCommit: base,
			head: a.head,
		});
		expect(events(a.id, "work.merge_requested")).toHaveLength(1);
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('"Item alpha" was merged into main');
		expect(notes[0]).toContain("alice merged");
	});

	test("an item whose head is already in the base is merged as it is", async () => {
		const a = await readyItem("beta");
		await git(["merge", "-q", "--ff-only", a.branch]);
		merge(a.id);
		await settleMergeJobs();
		expect(item(a.id)?.state).toBe("merged");
		expect(events(a.id, "work.merged")[0]?.detail).toMatchObject({
			detectedBy: "local_merge",
			mergeCommit: null,
			alreadyInBase: true,
		});
	});

	test("base checked out: the merge is prepared and the person's checkout is byte-for-byte untouched", async () => {
		const a = await readyItem("gamma");
		// The person is in the middle of their own work: an unstaged change and a staged file.
		await writeFile(join(repo, "tracked.txt"), "my unsaved edit\n");
		await writeFile(join(repo, "staged.txt"), "staged\n");
		await git(["add", "staged.txt"]);
		const before = await checkoutFingerprint(repo);
		const old = await git(["rev-parse", "main"]);
		merge(a.id);
		await settleMergeJobs();
		expect(await checkoutFingerprint(repo)).toEqual(before);
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(item(a.id)?.state).toBe("ready");
		const outcome = readMergeOutcome(a.id);
		expect(outcome).toMatchObject({ kind: "prepared", baseSha: old, checkedOutAt: repo });
		if (outcome?.kind !== "prepared") return;
		expect(await git(["rev-parse", `refs/narrafork/team-merges/${a.id}`])).toBe(
			outcome.mergeCommit,
		);
		expect(await git(["log", "-1", "--format=%P", outcome.mergeCommit])).toBe(`${old} ${a.head}`);
		expect(notes).toHaveLength(0);
		// The drawer offers the fast-forward and the command.
		const row = item(a.id);
		if (!row) throw new Error("missing item");
		const view = await mergeViewOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(view.outcome).toBe("prepared");
		expect(view.canMerge).toBe(true);
		expect(view.fastForward).toMatchObject({ available: true, blocker: null });
		expect(view.fastForward?.command).toBe(
			`git -C ${repo} merge --ff-only refs/narrafork/team-merges/${a.id}`,
		);

		// 「在该目录中快进」: only now does that checkout change, keeping the person's own edits.
		expect(requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER }).job).toBe(
			"fast_forward",
		);
		await settleMergeJobs();
		expect(await git(["rev-parse", "main"])).toBe(outcome.mergeCommit);
		expect(await readFile(join(repo, "gamma.txt"), "utf8")).toBe("gamma\n");
		expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("my unsaved edit\n");
		expect(await git(["diff", "--cached", "--name-only"])).toBe("staged.txt");
		expect(item(a.id)?.state).toBe("merged");
		expect(events(a.id, "work.merged")[0]?.detail).toMatchObject({
			detectedBy: "local_merge",
			fastForwarded: "checkout",
			checkedOutAt: repo,
		});
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
	});

	test("the fast-forward's preconditions refuse and change nothing", async () => {
		const a = await readyItem("delta");
		merge(a.id);
		await settleMergeJobs();
		const prepared = readMergeOutcome(a.id);
		if (prepared?.kind !== "prepared") throw new Error("expected a prepared merge");
		const fastForward = async () => {
			requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER });
			await settleMergeJobs();
			return readMergeOutcome(a.id);
		};
		const old = await git(["rev-parse", "main"]);

		// A merge in progress in that checkout.
		await writeFile(join(repo, ".git", "MERGE_HEAD"), `${a.head}\n`);
		expect(await fastForward()).toMatchObject({
			kind: "failed",
			code: "TEAM_MERGE_CHECKOUT_BLOCKED",
		});
		expect(events(a.id, "work.merge_failed").at(-1)?.detail).toMatchObject({
			blocker: "operation_in_progress",
		});
		await rm(join(repo, ".git", "MERGE_HEAD"));
		// No prepared merge any more (the outcome is a failure now): refused at once.
		expect(() => requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER })).toThrow(
			"no prepared merge",
		);

		// Prepare again; a filter of the checkout's own configuration.
		merge(a.id);
		await settleMergeJobs();
		await git(["config", "filter.local.smudge", "cat"]);
		expect(await fastForward()).toMatchObject({ code: "TEAM_MERGE_CHECKOUT_BLOCKED" });
		expect(events(a.id, "work.merge_failed").at(-1)?.detail).toMatchObject({
			blocker: "local_config",
		});
		await git(["config", "--unset", "filter.local.smudge"]);

		// A session running in that checkout.
		merge(a.id);
		await settleMergeJobs();
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, cwd, created_at, updated_at)
			VALUES ('mg-busy', 'primary', 'Busy', 'working', ?, ?, ?)`,
			[join(repo, "src"), NOW, NOW],
		);
		expect(await fastForward()).toMatchObject({ code: "TEAM_MERGE_CHECKOUT_BUSY" });
		// A session in the repository's own .worktrees/ does not count.
		sqlite.run("UPDATE narrators SET cwd = ? WHERE id = 'mg-busy'", [a.worktree]);
		merge(a.id);
		await settleMergeJobs();
		const row = item(a.id);
		if (!row) throw new Error("missing item");
		const view = await mergeViewOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(view.fastForward).toMatchObject({ available: true, runningSessions: 0 });

		// HEAD on another branch.
		await git(["checkout", "-q", "-b", "elsewhere"]);
		expect(await fastForward()).toMatchObject({ code: "TEAM_MERGE_CHECKOUT_BLOCKED" });
		expect(events(a.id, "work.merge_failed").at(-1)?.detail).toMatchObject({
			blocker: "not_on_base",
		});
		await git(["checkout", "-q", "main"]);

		// The base moved since the merge was prepared: stale, prepare again.
		merge(a.id);
		await settleMergeJobs();
		await commitFile(repo, "other.txt", "other\n", "main moves");
		expect(await fastForward()).toMatchObject({ code: "TEAM_MERGE_STALE" });
		expect(await git(["rev-parse", "main"])).not.toBe(old);
		expect(item(a.id)?.state).toBe("ready");

		// git refuses: the merge would overwrite a local change. Nothing changes.
		merge(a.id);
		await settleMergeJobs();
		await writeFile(join(repo, "delta.txt"), "mine\n");
		const before = await git(["rev-parse", "main"]);
		expect(await fastForward()).toMatchObject({ code: "TEAM_MERGE_FAST_FORWARD_REFUSED" });
		expect(await git(["rev-parse", "main"])).toBe(before);
		expect(await readFile(join(repo, "delta.txt"), "utf8")).toBe("mine\n");
	});

	test("the person ran the command themselves: the next fast-forward just records the merge", async () => {
		const a = await readyItem("epsilon");
		merge(a.id);
		await settleMergeJobs();
		const prepared = readMergeOutcome(a.id);
		if (prepared?.kind !== "prepared") throw new Error("expected a prepared merge");
		await git(["merge", "-q", "--ff-only", `refs/narrafork/team-merges/${a.id}`]);
		requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER });
		await settleMergeJobs();
		expect(item(a.id)?.state).toBe("merged");
		expect(events(a.id, "work.merged")[0]?.detail).toMatchObject({ fastForwarded: "outside" });
	});

	test("conflicts: listed, nothing changed, the coordinator told; 退回 is open again", async () => {
		const a = await readyItem("zeta", "tracked.txt", "theirs\n");
		await commitFile(repo, "tracked.txt", "ours\n", "main edits the same line");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		merge(a.id);
		await settleMergeJobs();
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(item(a.id)?.state).toBe("ready");
		expect(readMergeOutcome(a.id)).toMatchObject({
			kind: "failed",
			code: "conflict",
			conflicts: ["tracked.txt"],
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("it conflicts");
		expect(notes[0]).toContain("tracked.txt");
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
		const summary = mergeSummaryOf({
			item: { id: a.id, state: "ready", baseRef: "main", projectId: PROJECT },
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(summary).toMatchObject({ outcome: "conflict", canMerge: true, phase: null });
	});

	test("two merges at once are serialized: both land, each on top of the other", async () => {
		const a = await readyItem("eta");
		const b = await readyItem("theta");
		await git(["checkout", "-q", "--detach"]);
		merge(a.id);
		merge(b.id);
		await settleMergeJobs();
		expect(item(a.id)?.state).toBe("merged");
		expect(item(b.id)?.state).toBe("merged");
		const base = await git(["rev-parse", "main"]);
		await git(["merge-base", "--is-ancestor", a.head, base]);
		await git(["merge-base", "--is-ancestor", b.head, base]);
		const first = events(a.id, "work.merged")[0]?.detail?.mergeCommit;
		expect(await git(["log", "-1", "--format=%P", base])).toBe(`${first} ${b.head}`);
	});

	test("a worker commit after ready makes the merge refuse; the base stays", async () => {
		const a = await readyItem("iota");
		await commitFile(a.worktree, "late.txt", "late\n", "worker commits after ready");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		merge(a.id);
		await settleMergeJobs();
		expect(readMergeOutcome(a.id)).toMatchObject({
			kind: "failed",
			code: "TEAM_WORK_ITEM_HEAD_MOVED",
		});
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(item(a.id)?.state).toBe("ready");
	});

	test("while merging, 退回, review, sync, cancel and a second merge get 409 MERGING", async () => {
		const a = await readyItem("kappa");
		await git(["checkout", "-q", "--detach"]);
		merge(a.id);
		const code = { code: "TEAM_WORK_ITEM_MERGING" };
		expect(() => merge(a.id)).toThrow(expect.objectContaining(code));
		await expect(
			returnWorkItem({
				teamId: LEAD,
				itemId: a.id,
				reason: "no",
				actor: { kind: "person", id: USER },
				actorName: "alice",
				locale: "en",
			}),
		).rejects.toMatchObject(code);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = NULL WHERE id = ?", [a.id]);
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, created_at, updated_at)
			VALUES ('mg-worker', 'subagent', 'w', 'idle', ?, ?, ?)`,
			[LEAD, NOW, NOW],
		);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = 'mg-worker' WHERE id = ?", [a.id]);
		await expect(
			recordReview({
				coordinatorId: LEAD,
				itemId: a.id,
				verdict: "blocker",
				findings: 1,
				reviewer: null,
				actor: { kind: "agent", id: LEAD },
			}),
		).rejects.toMatchObject(code);
		await expect(
			syncWorkItem({ coordinatorId: LEAD, itemId: a.id, actor: { kind: "agent", id: LEAD } }),
		).rejects.toMatchObject(code);
		expect(() =>
			cancelWorkItem({ coordinatorId: LEAD, itemId: a.id, actor: { kind: "agent", id: LEAD } }),
		).toThrow(expect.objectContaining(code));
		await settleMergeJobs();
		expect(isMerging(a.id)).toBe(false);
	});

	test("a running worker, an item not ready, and a GitHub origin are refused up front", async () => {
		const a = await readyItem("lambda");
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, created_at, updated_at)
			VALUES ('mg-running', 'subagent', 'w', 'working', ?, ?, ?)`,
			[LEAD, NOW, NOW],
		);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = 'mg-running' WHERE id = ?", [a.id]);
		expect(() => merge(a.id)).toThrow(
			expect.objectContaining({ code: "TEAM_WORK_ITEM_WORKER_RUNNING" }),
		);
		sqlite.run("UPDATE narrators SET status = 'idle' WHERE id = 'mg-running'");
		setHostingSourceForTests(async () => "git@github.com:acme/app.git");
		await hostingOf(repo);
		const summary = mergeSummaryOf({
			item: { id: a.id, state: "ready", baseRef: "main", projectId: PROJECT },
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(summary).toMatchObject({
			mode: "github",
			canMerge: false,
			disabledReason: "github_pending",
		});
		expect(() => merge(a.id)).toThrow(
			expect.objectContaining({ code: "TEAM_MERGE_GITHUB_PENDING" }),
		);
		sqlite.run("UPDATE team_work_items SET state = 'in_review' WHERE id = ?", [a.id]);
		expect(() => merge(a.id)).toThrow(
			expect.objectContaining({ code: "TEAM_WORK_ITEM_NOT_READY" }),
		);
	});

	test("git older than 2.38 disables the merge", async () => {
		const a = await readyItem("mu");
		setGitVersionForTests([2, 37, 1]);
		await hostingOf(repo);
		try {
			const summary = mergeSummaryOf({
				item: { id: a.id, state: "ready", baseRef: "main", projectId: PROJECT },
				baseBranch: "main",
				teamActive: true,
				workerRunning: false,
				member: true,
			});
			expect(summary.disabledReason).toBe("git_too_old");
			await git(["checkout", "-q", "--detach"]);
			merge(a.id);
			await settleMergeJobs();
			expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_MERGE_GIT_TOO_OLD" });
		} finally {
			setGitVersionForTests("real");
		}
	});

	test("a crash after the base moved heals by ancestry; the stale private ref is pruned", async () => {
		const a = await readyItem("nu");
		await git(["checkout", "-q", "--detach"]);
		// What a job did before the process died: the merge commit, its private ref, the base moved.
		const old = await git(["rev-parse", "main"]);
		const tree = (await git(["merge-tree", "--write-tree", old, a.head])).split("\n")[0] ?? "";
		const commit = await git(["commit-tree", tree, "-p", old, "-p", a.head, "-m", "merge"]);
		await git(["update-ref", `refs/narrafork/team-merges/${a.id}`, commit, ""]);
		await git(["update-ref", "refs/heads/main", commit, old]);
		await runChangedPathsPass({ sweep: true });
		expect(item(a.id)?.state).toBe("merged");
		expect(events(a.id, "work.merged")[0]?.detail).toMatchObject({ detectedBy: "ancestry" });
		expect(await pruneProjectMergeRefs(PROJECT)).toBe(1);
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
	});

	test("pruning keeps the private ref of an item still ready", async () => {
		const a = await readyItem("xi");
		merge(a.id);
		await settleMergeJobs();
		expect(readMergeOutcome(a.id)?.kind).toBe("prepared");
		expect(await pruneProjectMergeRefs(PROJECT)).toBe(0);
		expect(await git(["for-each-ref", "--format=%(refname)", "refs/narrafork/"])).toBe(
			`refs/narrafork/team-merges/${a.id}`,
		);
		sqlite.run("UPDATE team_work_items SET state = 'in_progress' WHERE id = ?", [a.id]);
		expect(await pruneProjectMergeRefs(PROJECT)).toBe(1);
	});
});
