/**
 * The pull request flow of a ready work item end to end (G), against the migrated test database,
 * real repositories and a fake gh on PATH. A local repository cannot pose as github.com (`git
 * remote get-url` expands `insteadOf`), so the hosting is read through its test seam as
 * `https://github.com/acme/app.git`, and the host's own `insteadOf` sends that URL to a bare
 * repository standing in for GitHub: the push is real.
 *
 * Covered: 「发起 PR」 (push, then create with `--head`/`--base` and the body on stdin), reuse of an
 * open pull request, one merged already, the branch moving after ready, a rejected push, 「合并 PR」
 * with `--match-head-commit` (a squash recorded with GitHub's commit, `origin/<base>` fetched,
 * nothing local touched), every merge-state refusal, conflicts listed from a local merge, a merge
 * queue, a hand merge found by the background pass, transitions recorded once, the body
 * neutralised and capped, and gh never run inside the repository or with the server's stray
 * variables.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkEvents, teamWorkItems } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { safeSpawn } from "../../../lib/spawn";
import { ghWorkDir } from "../team-gh";
import { setPinnedGithubTarget } from "../team-github-pin";
import { hostingOf, setHostingSourceForTests } from "../team-hosting";
import {
	mergeSummaryOf,
	readMergeOutcome,
	requestMerge,
	requestPrMerge,
	resetMergeJobsForTests,
	settleMergeJobs,
} from "../team-merge";
import { resetMergingForTests } from "../team-merge-guard";
import {
	conflictLookupsForTests,
	conflictRunsForTests,
	inlineCode,
	neutralizeForGithub,
	PR_BODY_MAX_BYTES,
	pullRequestBody,
	pullRequestTitle,
	refreshPullRequest,
	requestPrRefresh,
	resetPullRequestWorkForTests,
	runPrPollPass,
	settlePullRequestWork,
	startTeamPrPoller,
	withReadSlotForTests,
} from "../team-merge-pr";
import { aboutPullRequest, peekPrStatus, resetPrStatusForTests } from "../team-pr-state";
import { setUnblockDeliveryForTests } from "../work-item-dependencies";
import { setMergeNoteDeliveryForTests } from "../work-items";
import { type FakeGh, type FakeGhPlan, installFakeGh, usableGh } from "./fake-gh.fixture";

const LEAD = "gp-lead";
const PROJECT = "gp-project";
const USER = "gp-user";
const NOW = "2026-11-25T00:00:00.000Z";
const GITHUB_URL = "https://github.com/acme/app.git";
const PR_URL = "https://github.com/acme/app/pull/7";
/** Pull request 7 of the repository origin stands for. */
const PR_7 = { host: "github.com", owner: "acme", repo: "app", number: 7 };
const ACME = { host: "github.com", owner: "acme", repo: "app" };

let temporary: string;
let repo: string;
let origin: string;
let globalConfig: string;
let fake: FakeGh;
let pushUrl: string | null = GITHUB_URL;
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

/** A ready item: its branch from main with one commit in its own worktree, review rounds, ready. */
async function readyItem(name: string, file = `${name}.txt`, text = `${name}\n`) {
	const id = `gp-${name}-${generateId().slice(0, 6)}`;
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
	const event = (kind: string, detail: Record<string, unknown>, at: string) =>
		db
			.insert(teamWorkEvents)
			.values({
				id: generateId(),
				teamId: LEAD,
				workItemId: id,
				kind,
				actorKind: "agent",
				actorId: LEAD,
				detailJson: detail,
				createdAt: at,
			})
			.run();
	event(
		"work.review",
		{ round: 1, verdict: "clear", findings: 2, summary: "Checked the parser.", reviewer: "rev" },
		"2026-11-24T23:00:00.000Z",
	);
	event(
		"work.ready",
		{
			head,
			changedPathCount: 1,
			mergeBase,
			diffStat: { added: 1, removed: 0, files: 1, binaryFiles: 0, truncated: false },
		},
		NOW,
	);
	return { id, branch, worktree, head };
}

const item = (id: string) => db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get();
function events(itemId: string, kind?: string) {
	return db
		.select({
			kind: teamWorkEvents.kind,
			actorKind: teamWorkEvents.actorKind,
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

/** `gh pr view --json …` of #7 at `head`. */
function prView(head: string, over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		number: 7,
		url: PR_URL,
		state: "OPEN",
		isDraft: false,
		headRefOid: head,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: null,
		mergedAt: null,
		mergeCommit: null,
		autoMergeRequest: null,
		baseRefName: "main",
		...over,
	});
}

/** A usable gh with nothing open yet: list empty, create #7, view and checks as given. */
function plan(head: string, extra: FakeGhPlan = {}): FakeGhPlan {
	return {
		...usableGh(),
		"pr list": { stdout: "[]" },
		"pr create": { stdout: `${PR_URL}\n` },
		"pr view": { stdout: prView(head) },
		"pr checks": { stdout: "[]" },
		...extra,
	};
}

const open = (itemId: string) => requestMerge({ teamId: LEAD, itemId, userId: USER });
const mergePr = (itemId: string, method?: "merge" | "squash" | "rebase") =>
	requestPrMerge({ teamId: LEAD, itemId, userId: USER, method });
async function settle() {
	await settleMergeJobs();
	await settlePullRequestWork();
}
const ghCalls = async (what: string) =>
	(await fake.calls()).filter((call) => call.args.slice(0, 2).join(" ") === what);

/** Push a commit onto origin's `branch` from a clone (GitHub moving on). */
async function commitOnOrigin(branch: string, file: string, text: string) {
	const clone = await mkdtemp(join(temporary, "clone-"));
	await git(["clone", "-q", "-b", branch, origin, clone], temporary);
	const sha = await commitFile(clone, file, text, `upstream ${file}`);
	await git(["push", "-q", "origin", `HEAD:${branch}`], clone);
	return sha;
}

async function summary(itemId: string) {
	const row = item(itemId);
	if (!row) throw new Error("no item");
	return mergeSummaryOf({
		item: row,
		baseBranch: "main",
		teamActive: true,
		workerRunning: false,
		member: true,
	});
}

beforeAll(async () => {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-team-merge-pr-")));
	fake = await installFakeGh(temporary);
	globalConfig = join(temporary, "gitconfig");
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	setMergeNoteDeliveryForTests(async ({ text }) => {
		notes.push(text);
		return true;
	});
	setUnblockDeliveryForTests(async ({ text }) => {
		notes.push(text);
		return true;
	});
});

afterAll(async () => {
	fake.restore();
	setMergeNoteDeliveryForTests(null);
	setUnblockDeliveryForTests(null);
	setHostingSourceForTests(null);
	if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
	if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
	notes.length = 0;
	pushUrl = GITHUB_URL;
	fake.activate();
	await fake.clearCalls();
	repo = await realpath(await mkdtemp(join(temporary, "repo-")));
	origin = join(temporary, `origin-${generateId().slice(0, 8)}.git`);
	// The host's own rewrite sends "GitHub" to the bare repository standing in for it.
	await writeFile(
		globalConfig,
		`[user]\n\tname = Host\n\temail = host@e.test\n[commit]\n\tgpgsign = false\n[url "${origin}"]\n\tinsteadOf = ${GITHUB_URL}\n`,
	);
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(repo, ".gitignore"), ".worktrees/\n");
	await writeFile(join(repo, "shared.txt"), "base\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "initial"]);
	await mkdir(join(repo, ".worktrees"));
	await git(["init", "-q", "--bare", "-b", "main", origin], temporary);
	await git(["remote", "add", "origin", GITHUB_URL]);
	await git(["push", "-q", "origin", "main"]);
	await git(["fetch", "-q", "origin"]);
	setHostingSourceForTests(async () => pushUrl);
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
	await settle();
	resetMergeJobsForTests();
	resetMergingForTests();
	resetPrStatusForTests();
	resetPullRequestWorkForTests();
	fake.restore();
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'gp-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	await rm(repo, { recursive: true, force: true });
	await rm(origin, { recursive: true, force: true });
});

/**
 * Read the hosting (gh probed through the fake) so requests see GitHub, and confirm the repository
 * as a project manager would (`pin: false` leaves it unconfirmed).
 */
async function github(head: string, extra: FakeGhPlan = {}, pin = true) {
	await fake.setPlan(plan(head, extra));
	const hosting = await hostingOf(repo);
	expect(hosting).toMatchObject({ kind: "github", gh: { ok: true } });
	if (pin) setPinnedGithubTarget(PROJECT, ACME, USER);
	await fake.clearCalls();
}

describe.skipIf(process.platform === "win32")("the pull request flow", () => {
	test("发起 PR: the pinned head is pushed, the pull request opened with --head and --base, the body on stdin", async () => {
		const a = await readyItem("alpha");
		await github(a.head);
		const before = await git(["for-each-ref"]);
		expect(open(a.id)).toEqual({ itemId: a.id, job: "pull_request", phase: "queued" });
		await settle();
		expect(await git(["rev-parse", "refs/heads/team/alpha"], origin)).toBe(a.head);
		// No local ref moved, nothing checked out changed.
		expect(await git(["for-each-ref"])).toBe(before);
		expect(item(a.id)?.state).toBe("ready");
		expect(events(a.id, "work.merge_failed")).toEqual([]);
		expect(events(a.id, "work.merge_requested")[0]?.detail).toMatchObject({
			job: "pull_request",
			mode: "github",
		});
		expect(events(a.id, "work.pr_pushed")[0]?.detail).toMatchObject({
			head: a.head,
			branch: "team/alpha",
			repository: "github.com/acme/app",
		});
		expect(events(a.id, "work.pr_opened")[0]?.detail).toMatchObject({
			pr: 7,
			url: PR_URL,
			repository: "github.com/acme/app",
			base: "main",
			head: a.head,
			created: true,
		});
		const [list] = await ghCalls("pr list");
		expect(list?.args).toEqual([
			"pr",
			"list",
			"-R",
			"github.com/acme/app",
			"--head=team/alpha",
			"--state=all",
			"--limit=5",
			"--json",
			"number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository",
		]);
		const [create] = await ghCalls("pr create");
		expect(create?.args).toEqual([
			"pr",
			"create",
			"-R",
			"github.com/acme/app",
			"--head=team/alpha",
			"--base=main",
			"--title=Item alpha",
			"--body-file=-",
		]);
		expect(create?.stdin).toContain("Opened by NarraFork user `alice`.");
		expect(create?.stdin).toContain("**Size:** +1 −0 in 1 file(s)");
		expect(create?.stdin).toContain("Checked the parser.");
		// gh never runs in the repository: its own directory, no repository reachable from it.
		for (const call of await fake.calls()) {
			expect(await realpath(call.cwd)).toBe(await realpath(ghWorkDir()));
			expect(call.cwd.startsWith(repo)).toBe(false);
			for (let at = call.cwd; dirname(at) !== at; at = dirname(at))
				expect({ at, git: existsSync(join(at, ".git")) }).toEqual({ at, git: false });
			expect(existsSync(call.env.GIT_DIR ?? "")).toBe(false);
			expect(call.env.GH_PROMPT_DISABLED).toBe("1");
			for (const flag of ["--draft", "--delete-branch", "--admin", "--web"])
				expect(call.args).not.toContain(flag);
		}
		// Read right after: the card shows 「查看 PR #7」 and offers 「合并 PR」.
		expect((await summary(a.id)).pr).toMatchObject({
			number: 7,
			state: "OPEN",
			headMatches: true,
			mergeState: "CLEAN",
			methods: ["squash", "merge"],
			canMergePr: true,
			mergeBlocker: null,
		});
	});

	test("an open pull request is reused, pushing again changes nothing; one merged at this head marks the item merged", async () => {
		const a = await readyItem("reuse");
		const listed = (state: string, number: number, head: string) =>
			JSON.stringify([
				{
					number,
					url: `https://github.com/acme/app/pull/${number}`,
					state,
					headRefOid: head,
					headRefName: "team/reuse",
					baseRefName: "main",
					isCrossRepository: false,
				},
				// A fork's branch of the same name is never taken for it.
				{
					number: 99,
					url: "https://github.com/acme/app/pull/99",
					state: "OPEN",
					headRefOid: head,
					headRefName: "team/reuse",
					baseRefName: "main",
					isCrossRepository: true,
				},
			]);
		await github(a.head, {
			"pr list": { stdout: listed("OPEN", 5, a.head) },
			"pr view": {
				stdout: prView(a.head, { number: 5, url: "https://github.com/acme/app/pull/5" }),
			},
		});
		open(a.id);
		await settle();
		expect(await ghCalls("pr create")).toEqual([]);
		expect(events(a.id, "work.pr_opened").map((event) => event.detail)).toEqual([
			expect.objectContaining({ pr: 5, created: false }),
		]);
		open(a.id);
		await settle();
		expect(events(a.id, "work.pr_opened")).toHaveLength(1);
		expect(events(a.id, "work.pr_pushed")).toHaveLength(1);

		const b = await readyItem("landed");
		await fake.setPlan(
			plan(b.head, {
				"pr list": {
					stdout: JSON.stringify([
						{
							number: 9,
							url: "https://github.com/acme/app/pull/9",
							state: "MERGED",
							headRefOid: b.head,
							headRefName: "team/landed",
							baseRefName: "main",
						},
					]),
				},
				"pr view": { stdout: prView(b.head, { number: 9, state: "MERGED" }) },
			}),
		);
		open(b.id);
		await settle();
		expect(await ghCalls("pr create")).toEqual([]);
		expect(item(b.id)?.state).toBe("merged");
		expect(events(b.id, "work.merged")[0]?.detail).toMatchObject({
			detectedBy: "pull_request",
			pr: 9,
			headMatches: true,
		});
		expect(events(b.id, "work.merged")[0]?.actorKind).toBe("system");
		expect(notes.at(-1)).toContain("It was merged on GitHub");
	});

	test("the branch moved after ready: nothing pushed; GitHub's branch ahead: rejected, never forced, 退回 offered", async () => {
		const a = await readyItem("moved");
		await github(a.head);
		await commitFile(a.worktree, "later.txt", "later\n", "after ready");
		open(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_WORK_ITEM_HEAD_MOVED" });
		expect(await git(["for-each-ref", "refs/heads/team/moved"], origin)).toBe("");

		const b = await readyItem("ahead");
		await git(["push", "-q", origin, `${await git(["rev-parse", "main"])}:refs/heads/team/ahead`]);
		const theirs = await commitOnOrigin("team/ahead", "theirs.txt", "theirs\n");
		open(b.id);
		await settle();
		expect(readMergeOutcome(b.id)).toMatchObject({ kind: "failed", code: "TEAM_PR_PUSH_REJECTED" });
		expect(await git(["rev-parse", "refs/heads/team/ahead"], origin)).toBe(theirs);
		expect(await ghCalls("pr create")).toEqual([]);
	});

	test("合并 PR: --match-head-commit with the method asked; a squash recorded with GitHub's commit; origin/<base> fetched, nothing local touched", async () => {
		const a = await readyItem("squash");
		// A queued item waits for it: a squash never puts the head itself into origin/main.
		const waiting = `gp-waiting-${generateId().slice(0, 6)}`;
		sqlite.run(
			`INSERT INTO team_work_items (id, team_id, project_id, title, state, base_ref, review_rounds, created_at, updated_at)
			VALUES (?, ?, ?, 'Waits', 'queued', 'main', 0, ?, ?)`,
			[waiting, LEAD, PROJECT, NOW, NOW],
		);
		sqlite.run(
			"INSERT INTO team_work_item_dependencies (item_id, depends_on_item_id, team_id, created_at) VALUES (?, ?, ?, ?)",
			[waiting, a.id, LEAD, NOW],
		);
		await github(a.head);
		open(a.id);
		await settle();
		// GitHub squashes it onto main.
		const squash = await commitOnOrigin("main", "squash.txt", "squash\n");
		await fake.setPlan(
			plan(a.head, {
				"pr view": [
					{ stdout: prView(a.head) },
					{
						stdout: prView(a.head, {
							state: "MERGED",
							mergeCommit: { oid: squash },
							mergedAt: NOW,
						}),
					},
				],
				"pr merge": { stdout: "" },
			}),
		);
		await fake.clearCalls();
		const localMain = await git(["rev-parse", "main"]);
		const status = await git(["status", "--porcelain"]);
		expect(mergePr(a.id, "squash")).toEqual({ itemId: a.id, job: "pr_merge", phase: "queued" });
		await settle();
		const [merge] = await ghCalls("pr merge");
		expect(merge?.args).toEqual([
			"pr",
			"merge",
			"7",
			"-R",
			"github.com/acme/app",
			"--squash",
			`--match-head-commit=${a.head}`,
		]);
		expect(item(a.id)?.state).toBe("merged");
		const merged = events(a.id, "work.merged")[0];
		expect(merged?.actorKind).toBe("person");
		expect(merged?.detail).toMatchObject({
			detectedBy: "pull_request",
			pr: 7,
			url: PR_URL,
			mergeCommit: squash,
			method: "squash",
			headMatches: true,
			head: a.head,
		});
		expect(await git(["rev-parse", "refs/remotes/origin/main"])).toBe(squash);
		expect(await git(["rev-parse", "main"])).toBe(localMain);
		expect(await git(["status", "--porcelain"])).toBe(status);
		const landedNote = notes.find((note) => note.includes("through pull request #7"));
		expect(landedNote).toContain("alice merged it from the team page");
		// Fetched, origin/main holds the squash: the queued item may start now.
		expect(events(waiting, "work.unblocked")).toHaveLength(1);
	});

	test("a base given as origin/<b>: the pull request targets <b>", async () => {
		const a = await readyItem("tracking");
		sqlite.run("UPDATE team_work_items SET base_ref = 'origin/main' WHERE id = ?", [a.id]);
		await github(a.head);
		open(a.id);
		await settle();
		const [create] = await ghCalls("pr create");
		expect(create?.args).toContain("--base=main");
		expect(events(a.id, "work.pr_opened")[0]?.detail).toMatchObject({ base: "main" });
	});

	test("each merge state refuses with its reason; nothing is merged", async () => {
		const a = await readyItem("states");
		await github(a.head);
		open(a.id);
		await settle();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, "TEAM_PR_BLOCKED"],
			[{ mergeStateStatus: "BEHIND" }, "TEAM_PR_BEHIND"],
			[{ mergeStateStatus: "UNKNOWN" }, "TEAM_PR_STATE_UNKNOWN"],
			[{ isDraft: true, mergeStateStatus: "DRAFT" }, "TEAM_PR_DRAFT"],
			[{ headRefOid: "f".repeat(40) }, "TEAM_PR_HEAD_STALE"],
			[{ state: "CLOSED" }, "TEAM_PR_CLOSED"],
		];
		for (const [over, code] of cases) {
			await fake.setPlan(plan(a.head, { "pr view": { stdout: prView(a.head, over) } }));
			mergePr(a.id);
			await settle();
			expect({ over, outcome: readMergeOutcome(a.id) }).toMatchObject({
				over,
				outcome: { kind: "failed", code },
			});
		}
		expect(await ghCalls("pr merge")).toEqual([]);
		expect(item(a.id)?.state).toBe("ready");
		// The method must be one the repository allows (rebase is not).
		expect(() => mergePr(a.id, "rebase")).toThrow(
			expect.objectContaining({ code: "TEAM_PR_METHOD_NOT_ALLOWED" }),
		);
	});

	test("DIRTY: the conflicting files from a local merge against origin/<base>, 退回 offered, the coordinator told once", async () => {
		const a = await readyItem("dirty", "shared.txt", "mine\n");
		await github(a.head);
		open(a.id);
		await settle();
		await commitOnOrigin("main", "shared.txt", "theirs\n");
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { mergeStateStatus: "DIRTY" }) } }),
		);
		mergePr(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({
			kind: "failed",
			code: "conflict",
			conflicts: ["shared.txt"],
		});
		expect(await ghCalls("pr merge")).toEqual([]);
		const told = notes.filter((note) => note.includes("conflicts with main"));
		expect(told).toHaveLength(1);
		expect(told[0]).toContain("shared.txt");
		// The background pass sees the same conflict: no second event, no second note.
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.merge_failed")).toHaveLength(1);
		expect(notes.filter((note) => note.includes("conflicts with main"))).toHaveLength(1);
		// The person's checkout and local main are untouched.
		expect(await git(["status", "--porcelain"])).toBe("");
		expect(await git(["show", "main:shared.txt"])).toBe("base");
	});

	test("a merge queue accepts it without merging: 已加入合并队列", async () => {
		const a = await readyItem("queue");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head) }, "pr merge": { stdout: "" } }),
		);
		mergePr(a.id, "merge");
		await settle();
		expect(item(a.id)?.state).toBe("ready");
		expect(events(a.id, "work.pr_queued")[0]?.detail).toMatchObject({
			pr: 7,
			method: "merge",
			head: a.head,
		});
		expect((await summary(a.id)).pr).toMatchObject({
			queued: true,
			canMergePr: false,
			mergeBlocker: "queued",
		});
	});

	test("merged by hand on GitHub: the background pass records it; transitions are recorded once", async () => {
		const a = await readyItem("hand");
		await github(a.head);
		open(a.id);
		await settle();
		const failing = JSON.stringify([
			{
				name: "test",
				bucket: "fail",
				state: "FAILURE",
				link: "https://ci.example/1",
				workflow: "CI",
			},
			{
				name: "lint",
				bucket: "pass",
				state: "SUCCESS",
				link: "https://ci.example/2",
				workflow: "CI",
			},
		]);
		await fake.setPlan(plan(a.head, { "pr checks": { stdout: failing, exit: 1 } }));
		await refreshPullRequest(a.id, { force: true });
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.pr_checks").map((event) => event.detail)).toEqual([
			expect.objectContaining({ pr: 7, checks: "failing", failed: 1, failures: ["CI / test"] }),
		]);
		expect(notes.filter((note) => note.includes("needs its worker"))).toHaveLength(1);
		expect((await summary(a.id)).pr?.checks).toMatchObject({
			state: "failing",
			fail: 1,
			pass: 1,
			failures: [{ name: "CI / test", link: "https://ci.example/1" }],
		});
		await fake.setPlan(
			plan(a.head, {
				"pr checks": { stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) },
			}),
		);
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.pr_checks")).toHaveLength(2);
		// Merged on GitHub by someone: the pass records it (the system's), any method.
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "MERGED" }) } }),
		);
		// The last read is still fresh (20 s): the pass reads nothing yet.
		expect(await runPrPollPass()).toBe(1);
		expect(item(a.id)?.state).toBe("ready");
		resetPrStatusForTests();
		expect(await runPrPollPass()).toBe(1);
		await settle();
		expect(item(a.id)?.state).toBe("merged");
		const merged = events(a.id, "work.merged")[0];
		expect(merged?.actorKind).toBe("system");
		expect(merged?.detail).toMatchObject({ detectedBy: "pull_request", pr: 7, method: null });
		expect(notes.at(-1)).toContain("It was merged on GitHub");
		expect(await runPrPollPass()).toBe(0);
	});

	test("the drawer's read: refreshing at once, done after; nothing again within 20 seconds", async () => {
		const a = await readyItem("drawer");
		await github(a.head);
		open(a.id);
		await settle();
		// Read right after opening: fresh.
		expect(requestPrRefresh({ teamId: LEAD, itemId: a.id })).toEqual({
			itemId: a.id,
			refreshing: false,
		});
		resetPrStatusForTests();
		expect(requestPrRefresh({ teamId: LEAD, itemId: a.id })).toEqual({
			itemId: a.id,
			refreshing: true,
		});
		expect((await summary(a.id)).pr?.refreshing).toBe(true);
		await settle();
		expect((await summary(a.id)).pr).toMatchObject({ refreshing: false, state: "OPEN" });
		// A read that finds nothing to do still ends.
		resetPrStatusForTests();
		setHostingSourceForTests(async () => "git@gitlab.example:acme/app.git");
		requestPrRefresh({ teamId: LEAD, itemId: a.id });
		await settle();
		expect(peekPrStatus(a.id, PR_7)?.refreshing).toBe(false);
	});

	test("closed on GitHub: recorded once; the next action is 「重新发起 PR」", async () => {
		const a = await readyItem("closed");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.pr_closed")).toHaveLength(1);
		expect((await summary(a.id)).pr).toMatchObject({ state: "CLOSED", mergeBlocker: "closed" });
	});

	test("origin's push URL changed after the hosting was read: nothing pushed, nothing run", async () => {
		const a = await readyItem("remote");
		await github(a.head);
		const ran = join(temporary, `ext-${generateId().slice(0, 6)}`);
		pushUrl = `ext::sh -c touch% ${ran}`;
		open(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_PR_REMOTE_CHANGED" });
		expect(existsSync(ran)).toBe(false);
		pushUrl = "https://github.com/someone-else/app.git";
		open(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_PR_REMOTE_CHANGED" });
		expect(await git(["for-each-ref", "refs/heads/team/"], origin)).toBe("");
		expect(await ghCalls("pr create")).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("review fixes (G)", () => {
	const summaryAs = async (itemId: string, manager: boolean) => {
		const row = item(itemId);
		if (!row) throw new Error("no item");
		return mergeSummaryOf({
			item: row,
			baseBranch: "main",
			teamActive: true,
			workerRunning: false,
			member: true,
			manager,
		});
	};

	test("1a: nothing is pushed to a repository no manager confirmed; a changed origin is refused", async () => {
		const a = await readyItem("pin");
		await github(a.head, {}, false);
		// Not confirmed yet: a manager is asked (the button opens the confirmation), others wait.
		expect(await summaryAs(a.id, true)).toMatchObject({
			canMerge: true,
			disabledReason: null,
			github: { target: "github.com/acme/app", pinned: null, canConfirm: true },
		});
		expect(await summaryAs(a.id, false)).toMatchObject({
			canMerge: false,
			disabledReason: "github_unconfirmed",
		});
		expect(() => open(a.id)).toThrow(
			expect.objectContaining({ code: "TEAM_PR_TARGET_UNCONFIRMED" }),
		);
		expect(() => mergePr(a.id)).toThrow(
			expect.objectContaining({ code: "TEAM_PR_TARGET_UNCONFIRMED" }),
		);
		// Confirmed, then origin is pointed elsewhere (an agent edits .git/config).
		setPinnedGithubTarget(PROJECT, ACME, USER);
		pushUrl = "https://github.com/attacker/app.git";
		setHostingSourceForTests(async () => pushUrl);
		await fake.setPlan(plan(a.head));
		await hostingOf(repo);
		await fake.clearCalls();
		expect(await summaryAs(a.id, true)).toMatchObject({
			disabledReason: "github_target_changed",
			github: { target: "github.com/attacker/app", pinned: "github.com/acme/app" },
		});
		expect(() => open(a.id)).toThrow(expect.objectContaining({ code: "TEAM_PR_REMOTE_CHANGED" }));
		// Changed between the request and the push: the job refuses too.
		pushUrl = GITHUB_URL;
		setHostingSourceForTests(async () => pushUrl);
		await hostingOf(repo);
		open(a.id);
		pushUrl = "https://github.com/attacker/app.git";
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_PR_REMOTE_CHANGED" });
		expect(await git(["for-each-ref", "refs/heads/team/"], origin)).toBe("");
		expect((await fake.calls()).filter((call) => call.args[0] === "pr")).toEqual([]);
	});

	test("2: a pull request merged at an older head never marks a re-readied item merged", async () => {
		const a = await readyItem("stale");
		await github(a.head);
		open(a.id);
		await settle();
		// Returned and marked ready again with new work, never pushed (the reviewer's scenario).
		const h2 = await commitFile(a.worktree, "more.txt", "more\n", "fix after review");
		db.update(teamWorkItems)
			.set({ headSha: h2, updatedAt: "2026-11-25T01:00:00.000Z" })
			.where(eq(teamWorkItems.id, a.id))
			.run();
		// GitHub merged the pull request at the OLD head; GitHub cannot place h2 at all.
		await fake.setPlan(
			plan(a.head, {
				"pr view": {
					stdout: prView(a.head, { state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }),
				},
				"api --hostname=github.com": { exit: 1, stderr: "HTTP 404: Not Found" },
			}),
		);
		await refreshPullRequest(a.id, { force: true });
		await settle();
		expect(item(a.id)?.state).toBe("ready");
		expect(events(a.id, "work.merged")).toEqual([]);
		expect(events(a.id, "work.pr_closed")[0]?.detail).toMatchObject({
			pr: 7,
			merged: true,
			reason: "older_head",
			head: a.head,
		});
		const [compare] = (await fake.calls()).filter((call) => call.args[0] === "api");
		expect(compare?.args).toEqual([
			"api",
			"--hostname=github.com",
			"--method=GET",
			`repos/acme/app/compare/${h2}...${a.head}?per_page=1`,
			"--jq=.status",
		]);
		// 「合并 PR」 does not take it either (a merge found before the click is checked the same).
		mergePr(a.id);
		await settle();
		expect(item(a.id)?.state).toBe("ready");
		// The card offers 重新发起 PR; it opens a new pull request for the new head.
		expect((await summary(a.id)).pr).toMatchObject({ number: 7, state: "CLOSED" });
		await fake.setPlan(
			plan(h2, {
				"pr list": {
					stdout: JSON.stringify([
						{
							number: 7,
							url: PR_URL,
							state: "MERGED",
							headRefOid: a.head,
							headRefName: "team/stale",
							baseRefName: "main",
						},
					]),
				},
				"pr create": { stdout: "https://github.com/acme/app/pull/8\n" },
				"pr view": { stdout: prView(h2, { number: 8, url: "https://github.com/acme/app/pull/8" }) },
			}),
		);
		open(a.id);
		await settle();
		expect(events(a.id, "work.pr_opened").at(-1)?.detail).toMatchObject({ pr: 8, head: h2 });
		expect((await summary(a.id)).pr).toMatchObject({ number: 8, state: "OPEN", headMatches: true });
		expect(await git(["rev-parse", "refs/heads/team/stale"], origin)).toBe(h2);
	});

	test("2b: merged at a head the ready head is inside: merged, headMatches false", async () => {
		const a = await readyItem("ahead2");
		await github(a.head);
		open(a.id);
		await settle();
		const later = "b".repeat(40);
		await fake.setPlan(
			plan(a.head, {
				"pr view": { stdout: prView(a.head, { state: "MERGED", headRefOid: later }) },
				"api --hostname=github.com": { stdout: "ahead\n" },
			}),
		);
		await refreshPullRequest(a.id, { force: true });
		await settle();
		expect(item(a.id)?.state).toBe("merged");
		expect(events(a.id, "work.merged")[0]?.detail).toMatchObject({
			detectedBy: "pull_request",
			headMatches: false,
		});
	});

	test("3: a pull request retargeted to another base is never taken as this item's merge", async () => {
		const a = await readyItem("retarget");
		await github(a.head);
		open(a.id);
		await settle();
		// Open but retargeted: 「合并 PR」 refuses, the pass takes it as closed.
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { baseRefName: "develop" }) } }),
		);
		mergePr(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_PR_BASE_MISMATCH" });
		expect(await ghCalls("pr merge")).toEqual([]);
		// Merged into develop: not this item's merge.
		await fake.setPlan(
			plan(a.head, {
				"pr view": { stdout: prView(a.head, { state: "MERGED", baseRefName: "develop" }) },
			}),
		);
		await refreshPullRequest(a.id, { force: true });
		await settle();
		expect(item(a.id)?.state).toBe("ready");
		expect(events(a.id, "work.pr_closed")[0]?.detail).toMatchObject({
			merged: true,
			reason: "other_base",
			base: "develop",
		});
	});

	test("4: a recorded conflict is not fetched and merged again on every pass", async () => {
		const a = await readyItem("dirty2", "shared.txt", "mine\n");
		await github(a.head);
		open(a.id);
		await settle();
		await commitOnOrigin("main", "shared.txt", "theirs\n");
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { mergeStateStatus: "DIRTY" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.merge_failed")).toHaveLength(1);
		const runs = conflictRunsForTests();
		const lookups = conflictLookupsForTests();
		const fetched = await git(["rev-parse", "refs/remotes/origin/main"]);
		for (let pass = 0; pass < 3; pass++) await refreshPullRequest(a.id, { force: true });
		// No fetch from origin and no merge-tree for a conflict already recorded.
		expect(conflictLookupsForTests()).toBe(lookups);
		expect(conflictRunsForTests()).toBe(runs);
		expect(events(a.id, "work.merge_failed")).toHaveLength(1);
		// A member's click lists them again, from the cache (same head, same base).
		mergePr(a.id);
		await settle();
		expect(events(a.id, "work.merge_failed")).toHaveLength(2);
		expect(conflictRunsForTests()).toBe(runs);
		expect(await git(["rev-parse", "refs/remotes/origin/main"])).toBe(fetched);
	});

	test("5: stopping the pass kills a hung gh read; the wait is short", async () => {
		const a = await readyItem("hung");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(plan(a.head, { "pr view": { sleepMs: 20_000, stdout: prView(a.head) } }));
		const stop = startTeamPrPoller();
		const read = refreshPullRequest(a.id, { force: true });
		await Bun.sleep(300);
		const started = Date.now();
		await stop();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await read).toBeNull();
		resetPullRequestWorkForTests();
	});

	test("nit: the read slots hand over without a gap for a newcomer", async () => {
		for (let delay = 0; delay < 6; delay++) {
			let running = 0;
			let most = 0;
			const gate = () => {
				let open!: () => void;
				const promise = new Promise<void>((resolve) => {
					open = resolve;
				});
				return { promise, open };
			};
			const run = (hold: Promise<void>) =>
				withReadSlotForTests(async () => {
					running++;
					most = Math.max(most, running);
					await hold;
					running--;
				});
			const [a, b, c, d] = [gate(), gate(), gate(), gate()];
			const all = [run(a.promise), run(b.promise), run(c.promise)];
			await Bun.sleep(1);
			a.open();
			let chain: Promise<unknown> = Promise.resolve();
			for (let i = 0; i < delay; i++) chain = chain.then(() => undefined);
			await chain.then(() => all.push(run(d.promise)));
			await Bun.sleep(1);
			expect({ delay, most }).toEqual({ delay, most: 2 });
			b.open();
			c.open();
			d.open();
			await Promise.all(all);
		}
	});

	test("nits: a merge found before the click is the system's; refresh refuses an archived team", async () => {
		const a = await readyItem("found");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "MERGED" }) } }),
		);
		mergePr(a.id);
		await settle();
		expect(events(a.id, "work.merged")[0]?.actorKind).toBe("system");
		const b = await readyItem("archived");
		sqlite.run("UPDATE project_teams SET status = 'archived' WHERE narrator_id = ?", [LEAD]);
		expect(() => requestPrRefresh({ teamId: LEAD, itemId: b.id })).toThrow(
			expect.objectContaining({ code: "TEAM_ARCHIVED" }),
		);
	});
});

describe.skipIf(process.platform === "win32")("review fixes, second round (Devin 3, 4)", () => {
	const views = async () => (await ghCalls("pr view")).length;

	test("3: reopened on GitHub, the pass records it opened again and it recovers", async () => {
		const a = await readyItem("reopen");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		expect((await summary(a.id)).pr).toMatchObject({ state: "CLOSED", mergeBlocker: "closed" });
		// Reopened on GitHub. Read a moment ago: the pass leaves it for now.
		await fake.setPlan(plan(a.head));
		await fake.clearCalls();
		await runPrPollPass();
		await settle();
		expect(await views()).toBe(0);
		// A while later (the read forgotten): the pass reads it again and it recovers.
		resetPrStatusForTests();
		await runPrPollPass();
		await settle();
		expect(await views()).toBe(1);
		expect(events(a.id, "work.pr_opened").map((event) => event.detail)).toEqual([
			expect.objectContaining({ pr: 7, created: true }),
			expect.objectContaining({ pr: 7, reopened: true, repository: "github.com/acme/app" }),
		]);
		expect((await summary(a.id)).pr).toMatchObject({
			state: "OPEN",
			canMergePr: true,
			mergeBlocker: null,
		});
		// Closed once more: recorded again (the newest event wins).
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.pr_closed")).toHaveLength(2);
		expect((await summary(a.id)).pr).toMatchObject({ state: "CLOSED" });
	});

	test("3: retargeted back to the item's base, it recovers; 「合并 PR」 works again", async () => {
		const a = await readyItem("back");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { baseRefName: "develop" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.pr_closed")[0]?.detail).toMatchObject({ reason: "other_base" });
		expect((await summary(a.id)).pr).toMatchObject({ state: "CLOSED" });
		await fake.setPlan(plan(a.head));
		await refreshPullRequest(a.id, { force: true });
		expect((await summary(a.id)).pr).toMatchObject({ state: "OPEN", canMergePr: true });
		mergePr(a.id, "squash");
		await settle();
		expect(await ghCalls("pr merge")).toHaveLength(1);
	});

	test("3: 「重新发起 PR」 finding the same pull request open records it opened again", async () => {
		const a = await readyItem("again");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		expect((await summary(a.id)).pr).toMatchObject({ state: "CLOSED" });
		// Reopened by hand; 「重新发起 PR」 finds #7 open again.
		const listed = JSON.stringify([
			{
				number: 7,
				url: PR_URL,
				state: "OPEN",
				headRefOid: a.head,
				headRefName: "team/again",
				baseRefName: "main",
				isCrossRepository: false,
			},
		]);
		await fake.setPlan(plan(a.head, { "pr list": { stdout: listed } }));
		await fake.clearCalls();
		open(a.id);
		await settle();
		expect(await ghCalls("pr create")).toEqual([]);
		expect(events(a.id, "work.pr_opened").at(-1)?.detail).toMatchObject({
			pr: 7,
			created: false,
			reopened: true,
		});
		expect((await summary(a.id)).pr).toMatchObject({ state: "OPEN", canMergePr: true });
	});

	test("3: queued, closed, reopened at the same head: no longer queued; 「合并 PR」 again (Devin)", async () => {
		const a = await readyItem("requeue");
		await github(a.head);
		open(a.id);
		await settle();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head) }, "pr merge": { stdout: "" } }),
		);
		mergePr(a.id, "merge");
		await settle();
		expect((await summary(a.id)).pr).toMatchObject({ queued: true, mergeBlocker: "queued" });
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		await fake.setPlan(plan(a.head));
		await refreshPullRequest(a.id, { force: true });
		expect((await summary(a.id)).pr).toMatchObject({
			state: "OPEN",
			queued: false,
			canMergePr: true,
			mergeBlocker: null,
		});
		// GitHub's own auto-merge still counts.
		await fake.setPlan(
			plan(a.head, {
				"pr view": { stdout: prView(a.head, { autoMergeRequest: { mergeMethod: "MERGE" } }) },
			}),
		);
		await refreshPullRequest(a.id, { force: true });
		expect((await summary(a.id)).pr).toMatchObject({ queued: true });
	});

	test("4: a legacy event's repository comes from its URL's host with the port", () => {
		const ref = { host: "ghe.test:8443", owner: "Acme", repo: "App", number: 7 };
		expect(aboutPullRequest({ pr: 7, url: "https://ghe.test:8443/acme/app/pull/7" }, ref)).toBe(
			true,
		);
		expect(aboutPullRequest({ pr: 7, url: "https://ghe.test/acme/app/pull/7" }, ref)).toBe(false);
		expect(aboutPullRequest({ pr: 8, url: "https://ghe.test:8443/acme/app/pull/8" }, ref)).toBe(
			false,
		);
	});

	test("4: a conflict recorded for the same number in another repository is not this one's", async () => {
		const a = await readyItem("dirty3", "shared.txt", "mine\n");
		await github(a.head);
		open(a.id);
		await settle();
		await commitOnOrigin("main", "shared.txt", "theirs\n");
		const conflict = (detail: Record<string, unknown>) =>
			db
				.insert(teamWorkEvents)
				.values({
					id: generateId(),
					teamId: LEAD,
					workItemId: a.id,
					kind: "work.merge_failed",
					actorKind: "system",
					actorId: null,
					detailJson: { code: "conflict", job: "pr_merge", pr: 7, head: a.head, ...detail },
					createdAt: new Date().toISOString(),
				})
				.run();
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { mergeStateStatus: "DIRTY" }) } }),
		);
		// A legacy event (no repository) of this very pull request: its URL says which; known.
		conflict({ url: PR_URL });
		const notesBefore = notes.length;
		await refreshPullRequest(a.id, { force: true });
		expect(events(a.id, "work.merge_failed")).toHaveLength(1);
		expect(notes).toHaveLength(notesBefore);
		// #7 of another repository at the same head: this one's conflict is recorded and told.
		conflict({ url: "https://github.com/acme/app2/pull/7", repository: "github.com/acme/app2" });
		await refreshPullRequest(a.id, { force: true });
		const recorded = events(a.id, "work.merge_failed");
		expect(recorded).toHaveLength(3);
		expect(recorded.at(-1)?.detail).toMatchObject({
			code: "conflict",
			pr: 7,
			repository: "github.com/acme/app",
			head: a.head,
		});
		expect(notes.length).toBeGreaterThan(notesBefore);
	});

	test("4: a pull request of the repository origin pointed to before is not the item's", async () => {
		const a = await readyItem("moved");
		await github(a.head);
		open(a.id);
		await settle();
		// Closed in the old repository, and its state read.
		await fake.setPlan(
			plan(a.head, { "pr view": { stdout: prView(a.head, { state: "CLOSED" }) } }),
		);
		await refreshPullRequest(a.id, { force: true });
		// A manager confirms another repository origin points to now.
		const APP2 = { host: "github.com", owner: "acme", repo: "app2" };
		pushUrl = "https://github.com/acme/app2.git";
		setHostingSourceForTests(async () => pushUrl);
		await fake.setPlan(plan(a.head));
		await hostingOf(repo);
		setPinnedGithubTarget(PROJECT, APP2, USER);
		await fake.clearCalls();
		// No pull request there yet: 「发起 PR」 is offered, 「合并 PR」 is not.
		const moved = await summary(a.id);
		expect(moved).toMatchObject({ canMerge: true, disabledReason: null, pr: null });
		mergePr(a.id);
		await settle();
		expect(readMergeOutcome(a.id)).toMatchObject({ code: "TEAM_PR_NONE" });
		expect(await ghCalls("pr merge")).toEqual([]);
		expect(() => requestPrRefresh({ teamId: LEAD, itemId: a.id })).toThrow(
			expect.objectContaining({ code: "TEAM_PR_NONE" }),
		);
		// #7 in the new repository inherits nothing of the old #7: not its read, not its closing.
		db.insert(teamWorkEvents)
			.values({
				id: generateId(),
				teamId: LEAD,
				workItemId: a.id,
				kind: "work.pr_opened",
				actorKind: "person",
				actorId: USER,
				detailJson: {
					pr: 7,
					url: "https://github.com/acme/app2/pull/7",
					repository: "github.com/acme/app2",
					base: "main",
					head: a.head,
					created: true,
				},
				createdAt: new Date().toISOString(),
			})
			.run();
		expect((await summary(a.id)).pr).toMatchObject({
			number: 7,
			repository: "github.com/acme/app2",
			state: null,
			mergeBlocker: "checking",
		});
		expect(peekPrStatus(a.id, { ...APP2, number: 7 })).toBeNull();
		expect(peekPrStatus(a.id, PR_7)?.status?.state).toBe("CLOSED");
	});
});

describe("the pull request body (review 6)", () => {
	test("an agent's title or verdict cannot leave its code span: links, images, autolinks, HTML stay inert", () => {
		const payload =
			"x`` [click me](//evil.example/phish) ![t](//evil.example/p.png) <!-- hidden --> www.evil.example ``";
		const body = pullRequestBody({
			locale: "en",
			itemId: "i1",
			title: payload,
			branch: "team/x",
			base: "main",
			by: "alice`` <b>x</b> ``",
			diffStat: null,
			rounds: [
				{
					kind: "review",
					round: 1,
					verdict: `clear${payload}`,
					findings: 0,
					reviewer: payload,
					text: "Closes #12 @octocat https://x",
				},
			],
		});
		const tree = fromMarkdown(body, {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()],
		});
		const live: string[] = [];
		const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
			if (
				["link", "image", "html", "linkReference", "imageReference", "definition"].includes(
					node.type,
				)
			)
				live.push(node.type);
			if (node.type === "text" && node.value?.includes("evil")) live.push(`text:${node.value}`);
			for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
		};
		walk(tree as never);
		expect(live).toEqual([]);
		expect(inlineCode("a``b")).toBe("```a``b```");
		expect(inlineCode("`x`")).toBe("`` `x` ``");
		expect(inlineCode("")).toBe("`-`");
	});
});

describe("the pull request body", () => {
	test("mentions, references and closing keywords from anyone's text are neutralised; at most 16 KB", () => {
		const nasty =
			"Closes #12, fixes acme/app#3, resolves GH-4 and https://github.com/acme/app/issues/5 — thanks @octocat ```\n@team/admins";
		const body = pullRequestBody({
			locale: "en",
			itemId: "item1",
			title: "Fix #9 for @boss",
			branch: "team/x",
			base: "main",
			by: "alice@corp",
			diffStat: { added: 3, removed: 1, files: 2, binaryFiles: 0, truncated: false },
			rounds: [
				{
					kind: "review",
					round: 1,
					verdict: "blocker",
					findings: 1,
					reviewer: "@rev",
					text: nasty,
				},
				{
					kind: "returned",
					round: 2,
					verdict: "blocker",
					findings: null,
					reviewer: null,
					text: nasty,
				},
			],
		});
		expect(body).not.toMatch(/@\w/);
		expect(body).not.toMatch(/#\d/);
		expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[^\n]{0,3}(#|https?:\/\/)/i);
		expect(body).not.toContain("GH-4");
		expect(body).not.toContain("https://github.com/acme/app/issues/5");
		expect(body).toContain("Opened by NarraFork user");
		expect(body).toContain("**Size:** +3 −1 in 2 file(s)");
		// The text's own backticks never close its fence.
		expect(body).toContain("````text");
		expect(pullRequestTitle("Fix #9 for @boss")).toBe(neutralizeForGithub("Fix #9 for @boss"));
		expect(pullRequestTitle("Fix #9 for @boss")).not.toMatch(/[@#]/);
		const zh = pullRequestBody({
			locale: "zh-CN",
			itemId: "item1",
			title: "t",
			branch: "team/x",
			base: "main",
			by: "alice",
			diffStat: null,
			rounds: [],
		});
		expect(zh).toContain("由 NarraFork 用户 `alice` 发起。");
		const long = "x".repeat(1_900);
		const capped = pullRequestBody({
			locale: "en",
			itemId: "item1",
			title: "t",
			branch: "team/x",
			base: "main",
			by: "alice",
			diffStat: null,
			rounds: Array.from({ length: 40 }, (_, index) => ({
				kind: "review" as const,
				round: index + 1,
				verdict: "clear",
				findings: 0,
				reviewer: "r",
				text: `${index} ${long}`,
			})),
		});
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(PR_BODY_MAX_BYTES);
		expect(capped).toContain("Earlier rounds are left out.");
		// The newest rounds are the ones kept.
		expect(capped).toContain("Review round 40");
		expect(capped).not.toContain("Review round 1:");
	});
});
