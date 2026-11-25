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
import { PRIVATE_REFS_PAGE, setGitVersionForTests } from "../team-git-write";
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
	setMergeDeadlineForTests,
	setMergeStepHookForTests,
	settleMergeJobs,
} from "../team-merge";
import { claimMerging, isMerging, releaseMerging, resetMergingForTests } from "../team-merge-guard";
import { resetOverlapStateForTests, runChangedPathsPass } from "../team-overlap";
import {
	cancelWorkItem,
	markReady,
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
async function readyItem(name: string, file = `${name}.txt`, text = `${name}\n`, from = "main") {
	const id = `mg-${name}-${generateId().slice(0, 6)}`;
	const branch = `team/${name}`;
	const worktree = join(repo, ".worktrees", name);
	await git(["worktree", "add", "-q", "-b", branch, worktree, from]);
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

/** `git replace` `commit` with a copy that also lists `parent` as a parent. */
async function replaceWithExtraParent(commit: string, parent: string) {
	const body = await git(["cat-file", "commit", commit]);
	const fake = body.replace(/^(tree [0-9a-f]+)$/m, `$1\nparent ${parent}`);
	const path = join(temporary, `fake-${commit}`);
	await writeFile(path, `${fake}\n`);
	const replacement = await git(["hash-object", "-t", "commit", "-w", "--", path]);
	await git(["replace", commit, replacement]);
}

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
		expect(view.fastForward?.command?.sh).toBe(
			`[ "$(git --no-replace-objects -C ${repo} symbolic-ref --quiet HEAD)" = refs/heads/main ] && git --no-replace-objects -C ${repo} merge --ff-only --no-autostash --no-overwrite-ignore ${outcome.mergeCommit}`,
		);
		expect(view.fastForward?.command?.powershell).toContain(outcome.mergeCommit);

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
		// A failed fast-forward keeps the prepared merge, carrying its failure (review 11).
		const fastForward = async () => {
			requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER });
			await settleMergeJobs();
			const outcome = readMergeOutcome(a.id);
			expect(outcome?.kind).toBe("prepared");
			return outcome?.kind === "prepared" ? outcome.fastForwardFailure : undefined;
		};
		const old = await git(["rev-parse", "main"]);

		// A merge in progress in that checkout.
		await writeFile(join(repo, ".git", "MERGE_HEAD"), `${a.head}\n`);
		expect(await fastForward()).toMatchObject({
			code: "TEAM_MERGE_CHECKOUT_BLOCKED",
			blocker: "operation_in_progress",
		});
		await rm(join(repo, ".git", "MERGE_HEAD"));
		// Still prepared: it can be tried again at once.
		expect(requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER }).job).toBe(
			"fast_forward",
		);
		await settleMergeJobs();
		expect(item(a.id)?.state).toBe("merged");
		sqlite.run("UPDATE team_work_items SET state = 'ready', head_sha = ? WHERE id = ?", [
			a.head,
			a.id,
		]);
		await git(["reset", "-q", "--hard", old]);

		// Prepare again; a filter of the checkout's own configuration.
		merge(a.id);
		await settleMergeJobs();
		await git(["config", "filter.local.smudge", "cat"]);
		expect(await fastForward()).toMatchObject({
			code: "TEAM_MERGE_CHECKOUT_BLOCKED",
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
		expect(await fastForward()).toMatchObject({
			code: "TEAM_MERGE_CHECKOUT_BLOCKED",
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
		// The files git named stay on the prepared merge, with its command (review 11).
		expect(await fastForward()).toMatchObject({
			code: "TEAM_MERGE_FAST_FORWARD_REFUSED",
			files: ["delta.txt"],
		});
		const refusedRow = item(a.id);
		if (!refusedRow) throw new Error("missing item");
		const refusedView = await mergeViewOf({
			item: refusedRow,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(refusedView.outcome).toBe("prepared");
		expect(refusedView.fastForward?.command?.sh).toContain("merge --ff-only");
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

	test("a replacement ref claiming the base holds the item never makes it merged unintegrated (Devin 4)", async () => {
		const a = await readyItem("replaced");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		await replaceWithExtraParent(old, a.head);
		// The repository's own git (replacements honoured) now calls the item part of main.
		await git(["merge-base", "--is-ancestor", a.head, "main"]);
		// Ancestry detection is not fooled: the item stays ready.
		await runChangedPathsPass({ sweep: true });
		expect(item(a.id)?.state).toBe("ready");
		expect(events(a.id, "work.merged")).toHaveLength(0);
		// The merge integrates it for real: main is a merge commit of the true base and the head.
		merge(a.id);
		await settleMergeJobs();
		const now = await git(["--no-replace-objects", "rev-parse", "main"]);
		expect(now).not.toBe(old);
		expect(await git(["--no-replace-objects", "log", "-1", "--format=%P", "main"])).toBe(
			`${old} ${a.head}`,
		);
		await git(["--no-replace-objects", "merge-base", "--is-ancestor", a.head, "main"]);
		expect(item(a.id)?.state).toBe("merged");
		const merged = events(a.id, "work.merged")[0]?.detail;
		expect(merged).toMatchObject({ detectedBy: "local_merge", mergeCommit: now });
		expect(merged?.alreadyInBase).toBeUndefined();
	});

	test("a shallow repository or a graft file is refused: nothing merged, the base untouched (Devin 4)", async () => {
		for (const altered of ["shallow", "grafts"] as const) {
			const a = await readyItem(`altered-${altered}`);
			await git(["checkout", "-q", "--detach"]);
			const old = await git(["rev-parse", "main"]);
			const file =
				altered === "shallow"
					? join(repo, ".git", "shallow")
					: join(repo, ".git", "info", "grafts");
			await mkdir(join(repo, ".git", "info"), { recursive: true });
			await writeFile(file, altered === "shallow" ? `${old}\n` : `${old} ${a.head}\n`);
			try {
				await runChangedPathsPass({ sweep: true });
				expect(item(a.id)?.state).toBe("ready");
				merge(a.id);
				await settleMergeJobs();
				expect(await git(["rev-parse", "main"])).toBe(old);
				expect(item(a.id)?.state).toBe("ready");
				expect(events(a.id, "work.merged")).toHaveLength(0);
				expect(readMergeOutcome(a.id)).toMatchObject({
					kind: "failed",
					code: "TEAM_GIT_HISTORY_ALTERED",
				});
			} finally {
				await rm(file, { force: true });
			}
		}
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

	test("past its deadline a job stops at a safe point and only then gives the item back (review 10)", async () => {
		const a = await readyItem("omicron");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		// Reading origin's hosting takes longer than the whole deadline.
		setHostingSourceForTests(async () => {
			await Bun.sleep(300);
			return null;
		});
		setMergeDeadlineForTests(30);
		try {
			merge(a.id);
			await Bun.sleep(120);
			// Past the deadline, but the job has not stopped yet: the item is still held.
			expect(isMerging(a.id)).toBe(true);
			await settleMergeJobs();
		} finally {
			setMergeDeadlineForTests(null);
		}
		expect(isMerging(a.id)).toBe(false);
		expect(readMergeOutcome(a.id)).toMatchObject({ kind: "failed", code: "TEAM_MERGE_TIMEOUT" });
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
		expect(item(a.id)?.state).toBe("ready");
	});

	test("an unreadable origin disables merging and never falls back to a local merge (review 8)", async () => {
		const a = await readyItem("pi");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		setHostingSourceForTests(async () => {
			throw new Error("git could not read origin");
		});
		await hostingOf(repo);
		const summary = mergeSummaryOf({
			item: { id: a.id, state: "ready", baseRef: "main", projectId: PROJECT },
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(summary).toMatchObject({
			mode: "checking",
			canMerge: false,
			disabledReason: "checking",
		});
		merge(a.id);
		await settleMergeJobs();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_MERGE_HOSTING_UNKNOWN" });
		expect(await git(["rev-parse", "main"])).toBe(old);
	});

	test("pruning goes through more private refs than one listing holds", async () => {
		const head = await git(["rev-parse", "main"]);
		const lines = Array.from(
			{ length: PRIVATE_REFS_PAGE * 2 + 5 },
			(_, index) => `create refs/narrafork/team-merges/gone-${index} ${head}\n`,
		).join("");
		const stdin = join(temporary, `refs-${Date.now()}.txt`);
		await writeFile(stdin, lines);
		await safeSpawn({
			cmd: ["sh", "-c", `git -C '${repo}' update-ref --stdin < '${stdin}'`],
			timeout: 30_000,
			maxOutputBytes: 4096,
		});
		expect(await pruneProjectMergeRefs(PROJECT)).toBe(PRIVATE_REFS_PAGE * 2 + 5);
		expect(await git(["for-each-ref", "refs/narrafork/"])).toBe("");
	});

	test("a merge that takes the item during review, ready or sync's reads refuses them (review 9)", async () => {
		const a = await readyItem("rho");
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, created_at, updated_at)
			VALUES ('mg-rho-worker', 'subagent', 'w', 'idle', ?, ?, ?)`,
			[LEAD, NOW, NOW],
		);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = 'mg-rho-worker' WHERE id = ?", [
			a.id,
		]);
		const actor = { kind: "agent" as const, id: LEAD };
		const calls = [
			() =>
				recordReview({
					coordinatorId: LEAD,
					itemId: a.id,
					verdict: "clear",
					findings: 0,
					reviewer: null,
					actor,
				}),
			() => markReady({ coordinatorId: LEAD, itemId: a.id, actor }),
			() => syncWorkItem({ coordinatorId: LEAD, itemId: a.id, actor }),
		];
		for (const call of calls) {
			// Passes the first check, then a merge takes the item while it awaits git.
			const pending = call();
			expect(claimMerging(a.id)).toBe(true);
			await expect(pending).rejects.toMatchObject({ code: "TEAM_WORK_ITEM_MERGING" });
			releaseMerging(a.id);
		}
		expect(item(a.id)).toMatchObject({ state: "ready", reviewRounds: 1 });
		expect(events(a.id, "work.sync")).toHaveLength(0);
	});

	test("a worker commit after the first check is never closed by the merge (Devin 6)", async () => {
		// Before the base moves: nothing moves.
		const a = await readyItem("sigma");
		await git(["checkout", "-q", "--detach"]);
		const old = await git(["rev-parse", "main"]);
		let calls = 0;
		setMergeStepHookForTests(async () => {
			if (++calls === 1) await commitFile(a.worktree, "late.txt", "late\n", "late commit");
		});
		try {
			merge(a.id);
			await settleMergeJobs();
		} finally {
			setMergeStepHookForTests(null);
		}
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_WORK_ITEM_HEAD_MOVED" });
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(item(a.id)?.state).toBe("ready");

		// After the base moved, before the merge is recorded: the item is not closed.
		const b = await readyItem("tau");
		calls = 0;
		setMergeStepHookForTests(async () => {
			if (++calls === 2) await commitFile(b.worktree, "later.txt", "later\n", "later commit");
		});
		try {
			merge(b.id);
			await settleMergeJobs();
		} finally {
			setMergeStepHookForTests(null);
		}
		expect(readMergeOutcome(b.id)).toMatchObject({ code: "TEAM_WORK_ITEM_HEAD_MOVED" });
		expect(item(b.id)?.state).toBe("ready");
		// The ancestry pass does not close it either: the branch's new commit is not in the base.
		await runChangedPathsPass({ sweep: true });
		expect(item(b.id)?.state).toBe("ready");
	});

	test("a worker commit during the fast-forward's checks stops it before the checkout changes (Devin 6)", async () => {
		const a = await readyItem("upsilon");
		merge(a.id);
		await settleMergeJobs();
		expect(readMergeOutcome(a.id)?.kind).toBe("prepared");
		const old = await git(["rev-parse", "main"]);
		setMergeStepHookForTests(async () => {
			await commitFile(a.worktree, "late.txt", "late\n", "late commit");
			setMergeStepHookForTests(null);
		});
		try {
			requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER });
			await settleMergeJobs();
		} finally {
			setMergeStepHookForTests(null);
		}
		const outcome = readMergeOutcome(a.id);
		expect(outcome?.kind === "prepared" && outcome.fastForwardFailure?.code).toBe(
			"TEAM_WORK_ITEM_HEAD_MOVED",
		);
		expect(await git(["rev-parse", "main"])).toBe(old);
		expect(item(a.id)?.state).toBe("ready");
	});

	test("a running session among hundreds of idle ones in the checkout blocks the fast-forward (Devin 7)", async () => {
		const a = await readyItem("phi");
		merge(a.id);
		await settleMergeJobs();
		const values = Array.from({ length: 250 }, (_, index) => [
			`mg-idle-${String(index).padStart(3, "0")}`,
			join(repo, "src", String(index)),
		]);
		for (const [id, cwd] of values)
			sqlite.run(
				`INSERT INTO narrators (id, type, title, status, cwd, created_at, updated_at)
				VALUES (?, 'primary', 'Idle', 'idle', ?, ?, ?)`,
				[id ?? "", cwd ?? "", NOW, NOW],
			);
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, cwd, created_at, updated_at)
			VALUES ('mg-zz-running', 'primary', 'Running', 'working', ?, ?, ?)`,
			[join(repo, "src", "last"), NOW, NOW],
		);
		const row = item(a.id);
		if (!row) throw new Error("missing item");
		const view = await mergeViewOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(view.fastForward).toMatchObject({
			available: false,
			blocker: "sessions_running",
			runningSessions: 1,
		});
		const old = await git(["rev-parse", "main"]);
		requestFastForward({ teamId: LEAD, itemId: a.id, userId: USER });
		await settleMergeJobs();
		const outcome = readMergeOutcome(a.id);
		expect(outcome?.kind === "prepared" && outcome.fastForwardFailure?.code).toBe(
			"TEAM_MERGE_CHECKOUT_BUSY",
		);
		expect(await git(["rev-parse", "main"])).toBe(old);
	});

	test("the confirmation lists what the fast-forward writes, upstream files included; off the base no command (Devin 8, 2)", async () => {
		// The item started from a commit main does not have yet (as from origin/main).
		await git(["branch", "upstream", "main"]);
		await git(["checkout", "-q", "upstream"]);
		await commitFile(repo, "upstream.txt", "up\n", "upstream work");
		await git(["checkout", "-q", "main"]);
		const a = await readyItem("chi", "chi.txt", "chi\n", "upstream");
		merge(a.id);
		await settleMergeJobs();
		const prepared = readMergeOutcome(a.id);
		if (prepared?.kind !== "prepared") throw new Error("expected a prepared merge");
		const row = item(a.id);
		if (!row) throw new Error("missing item");
		const view = await mergeViewOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(view.fastForward?.files).toEqual(["chi.txt", "upstream.txt"]);
		expect(view.fastForward?.filesMore).toBe(false);
		expect(view.fastForward?.command?.sh).toContain(prepared.mergeCommit);
		// Off the base, the blocker shows and no command is offered.
		resetMergeJobsForTests();
		await git(["checkout", "-q", "-b", "elsewhere"]);
		const off = await mergeViewOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
		});
		expect(off.fastForward).toMatchObject({ blocker: "not_on_base", command: null });
	});
});
