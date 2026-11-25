/**
 * Base branch configuration (W): what counts as GitHub from origin's push URL, the cached hosting,
 * where a team's new work items start (the team's setting, else the project's default, else
 * `origin/<base>` on GitHub and the local base otherwise), and that `work.create` and `work.sync`
 * follow it — fetching origin into the remote-tracking ref only, never the local base.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkEvents, teamWorkItems } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { safeSpawn } from "../../../lib/spawn";
import { teamSettingsSchema } from "../../../lib/validators/project-teams";
import { teamProjectSettingsSchema, updateProjectSchema } from "../../../lib/validators/projects";
import {
	defaultWorkStart,
	hostingOf,
	hostingOfUrl,
	parseRemoteUrl,
	peekHosting,
	setHostingSourceForTests,
} from "../team-hosting";
import { resetOverlapStateForTests, runChangedPathsPass } from "../team-overlap";
import { updateTeam } from "../team-service";
import {
	compareRefFor,
	fetchOnce,
	itemStartedFrom,
	peekWorkStartDefault,
	projectWorkStartOf,
	resolveWorkStart,
} from "../team-work-start";
import { readWorkStats, resetWorkStatCacheForTests } from "../team-work-view";
import {
	assertDependenciesReachStart,
	reconcileUnblocks,
	setUnblockDeliveryForTests,
} from "../work-item-dependencies";
import {
	attachWorker,
	createWorkItem,
	markMergedByAncestry,
	setWorkItemPortsForTests,
	syncWorkItem,
	worktreePathOf,
} from "../work-items";

describe("origin's hosting", () => {
	test("push URLs: scp, ssh, https with userinfo; owner/repo exactly", () => {
		const table: [string, ReturnType<typeof parseRemoteUrl>][] = [
			["git@github.com:acme/app.git", { host: "github.com", owner: "acme", repo: "app" }],
			["github.com:acme/app", { host: "github.com", owner: "acme", repo: "app" }],
			["ssh://git@GitHub.com/acme/app.git/", { host: "github.com", owner: "acme", repo: "app" }],
			[
				"ssh://git@ssh.github.com:443/acme/app.git",
				{ host: "ssh.github.com", owner: "acme", repo: "app" },
			],
			[
				"https://user:token@github.com/acme/app.git",
				{ host: "github.com", owner: "acme", repo: "app" },
			],
			[
				"https://gitlab.example.com/acme/app",
				{ host: "gitlab.example.com", owner: "acme", repo: "app" },
			],
			["https://github.com/acme/app/extra", null],
			["https://github.com/acme", null],
			["/srv/git/app.git", null],
			["file:///srv/git/app.git", null],
			["C:\\repos\\app", null],
			["", null],
		];
		for (const [url, expected] of table) expect(parseRemoteUrl(url)).toEqual(expected);
		expect(hostingOfUrl("git@github.com:acme/app.git")).toEqual({
			kind: "github",
			host: "github.com",
			owner: "acme",
			repo: "app",
		});
		expect(hostingOfUrl("ssh://git@ssh.github.com:443/acme/app.git").kind).toBe("github");
		// GitHub Enterprise counts as GitHub only once the PR flow's gh probe says so.
		expect(hostingOfUrl("git@github.acme.corp:acme/app.git")).toEqual({
			kind: "other",
			host: "github.acme.corp",
		});
		expect(hostingOfUrl("/srv/git/app.git")).toEqual({ kind: "other", host: null });
		expect(hostingOfUrl(null)).toEqual({ kind: "none" });
		expect(defaultWorkStart({ kind: "github", host: "github.com", owner: "a", repo: "b" })).toBe(
			"remote",
		);
		expect(defaultWorkStart({ kind: "other", host: null })).toBe("local");
		expect(defaultWorkStart({ kind: "none" })).toBe("local");
	});

	test("the cache: one read at a time, kept 5 minutes (60 seconds after a failure)", async () => {
		let now = 1_000_000;
		let reads = 0;
		let fail = false;
		setHostingSourceForTests(
			async () => {
				reads++;
				await Bun.sleep(5);
				if (fail) throw new Error("git failed");
				return "git@github.com:acme/app.git";
			},
			() => now,
		);
		try {
			expect(peekHosting("/repo")).toBeNull();
			expect(peekHosting("/repo")).toBeNull();
			const read = await hostingOf("/repo");
			expect(read.kind).toBe("github");
			expect(reads).toBe(1);
			expect(peekHosting("/repo")?.kind).toBe("github");
			now += 4 * 60_000;
			expect(peekHosting("/repo")?.kind).toBe("github");
			expect(reads).toBe(1);
			now += 2 * 60_000;
			fail = true;
			// Stale: still answered while read again; a failed read is unknown, never "not GitHub".
			expect(peekHosting("/repo")?.kind).toBe("github");
			await Bun.sleep(20);
			expect(reads).toBe(2);
			expect(peekHosting("/repo")).toEqual({ kind: "unknown" });
			fail = false;
			now += 61_000;
			expect((await hostingOf("/repo")).kind).toBe("github");
			expect(reads).toBe(3);
		} finally {
			setHostingSourceForTests(null);
		}
	});

	test("the settings accept a work start and refuse anything else", () => {
		expect(teamSettingsSchema.safeParse({ workStart: "remote" }).success).toBe(true);
		expect(teamSettingsSchema.safeParse({ workStart: "local" }).success).toBe(true);
		expect(teamSettingsSchema.safeParse({ workStart: "origin" }).success).toBe(false);
		expect(teamProjectSettingsSchema.safeParse({ workStart: "local" }).success).toBe(true);
		expect(teamProjectSettingsSchema.safeParse({ workStart: "x" }).success).toBe(false);
		expect(projectWorkStartOf('{"teams":{"workStart":"remote"}}')).toBe("remote");
		expect(projectWorkStartOf({ teams: { workStart: "nope" } })).toBeNull();
		expect(projectWorkStartOf("not json")).toBeNull();
		// The project's default branch follows the rules of a team's base branch.
		for (const [name, ok] of [
			["main", true],
			["release/2026", true],
			["-upload-pack=evil", false],
			["topic.lock", false],
			["trailing/", false],
		] as const)
			expect({ name, ok: updateProjectSchema.safeParse({ defaultBranch: name }).success }).toEqual({
				name,
				ok,
			});
	});
});

// ── Work items start from the configured base ───────────────────────────────

const LEAD = "ws-lead";
const PROJECT = "ws-project";
const USER = "ws-user";
const NOW = "2026-11-25T00:00:00.000Z";
const principal = { userId: USER, isAdmin: false };
const agent = { kind: "agent" as const, id: LEAD };

let temporary: string;
let repo: string;
let origin: string;
let upstream: string;
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

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

function setTeamSettings(settings: Record<string, unknown>) {
	sqlite.run("UPDATE project_teams SET settings_json = ? WHERE narrator_id = ?", [
		JSON.stringify(settings),
		LEAD,
	]);
}

function setProjectSettings(settings: Record<string, unknown> | null) {
	sqlite.run("UPDATE projects SET chapter_settings = ? WHERE id = ?", [
		settings ? JSON.stringify(settings) : null,
		PROJECT,
	]);
}

const create = (title: string, dependsOn?: string[]) =>
	createWorkItem({
		coordinatorId: LEAD,
		title,
		...(dependsOn ? { dependsOn } : {}),
		actor: agent,
		principal,
		signal: new AbortController().signal,
	});

function createdDetail(itemId: string) {
	return db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.all()
		.map((row) => row.detail)
		.find((detail) => detail && "startFrom" in detail);
}

describe("origin fetches", () => {
	test("concurrent fetches of one repository and base share one run", async () => {
		let runs = 0;
		const slow = async () => {
			runs++;
			await Bun.sleep(30);
			return { ok: true as const };
		};
		const results = await Promise.all([
			fetchOnce("/repo", "main", slow),
			fetchOnce("/repo", "main", slow),
			fetchOnce("/repo", "develop", slow),
		]);
		expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
		expect(runs).toBe(2);
		await fetchOnce("/repo", "main", slow);
		expect(runs).toBe(3);
	});
});

describe("where work starts", () => {
	beforeAll(async () => {
		temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-team-start-")));
		const config = join(temporary, "gitconfig");
		await writeFile(
			config,
			"[user]\n\tname = T\n\temail = t@e.test\n[commit]\n\tgpgsign = false\n",
		);
		process.env.GIT_CONFIG_GLOBAL = config;
	});

	afterAll(async () => {
		setWorkItemPortsForTests(null);
		setHostingSourceForTests(null);
		if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
		await rm(temporary, { recursive: true, force: true });
	});

	beforeEach(async () => {
		setHostingSourceForTests(async () => null);
		const root = await mkdtemp(join(temporary, "case-"));
		repo = join(root, "repo");
		origin = join(root, "origin.git");
		await mkdir(repo);
		await git(["init", "-q", "-b", "main"]);
		await writeFile(join(repo, ".gitignore"), ".worktrees/\n");
		await git(["add", ".gitignore"]);
		await commitFile(repo, "a.txt", "a\n", "initial");
		await mkdir(join(repo, ".worktrees"));
		await git(["init", "-q", "--bare", "-b", "main", origin], root);
		await git(["remote", "add", "origin", origin]);
		await git(["push", "-q", "origin", "main"]);
		// Someone else pushed to origin: origin/main is ahead of the local main.
		const other = join(root, "other");
		await git(["clone", "-q", origin, other], root);
		upstream = await commitFile(other, "b.txt", "b\n", "upstream work");
		await git(["push", "-q", "origin", "main"], other);
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, 'u', 'x', 'user', ?)",
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
		setWorkItemPortsForTests({
			async createWorktree({ requestId, branchName, baseRef }) {
				const path = join(repo, ".worktrees", requestId);
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
			planRemoval: async () => {
				throw new Error("not used");
			},
			removeWorktree: async () => {
				throw new Error("not used");
			},
			principalOf: async (userId) => ({ userId, isAdmin: false }),
		});
	});

	afterEach(() => {
		for (const table of [
			"team_work_events",
			"team_work_items",
			"project_teams",
			"narrator_worktree_resources",
		])
			sqlite.run(`DELETE FROM ${table}`);
		sqlite.run("DELETE FROM narrators WHERE id LIKE 'ws-%'");
		sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
		sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	});

	test("the team's setting wins over the project's default, which wins over the hosting", async () => {
		const local = await git(["rev-parse", "main"]);
		expect(await resolveWorkStart({ projectId: PROJECT, settings: {} })).toBe("local");
		expect(peekWorkStartDefault(PROJECT)).toBe("local");
		setHostingSourceForTests(async () => "git@github.com:acme/app.git");
		expect(peekWorkStartDefault(PROJECT)).toBeNull();
		expect(await resolveWorkStart({ projectId: PROJECT, settings: {} })).toBe("remote");
		expect(peekWorkStartDefault(PROJECT)).toBe("remote");
		setProjectSettings({ teams: { workStart: "local" } });
		expect(await resolveWorkStart({ projectId: PROJECT, settings: {} })).toBe("local");
		expect(peekWorkStartDefault(PROJECT)).toBe("local");
		expect(await resolveWorkStart({ projectId: PROJECT, settings: { workStart: "remote" } })).toBe(
			"remote",
		);

		// GitHub, nothing configured on the project: new work starts from origin/main.
		setProjectSettings(null);
		const item = await create("From origin");
		const path = worktreePathOf(item) ?? "";
		expect(await git(["rev-parse", "HEAD"], path)).toBe(upstream);
		expect(item.baseRef).toBe("main");
		expect(createdDetail(item.id)).toMatchObject({ startFrom: "origin/main", baseRef: "main" });
		// Fetched into the remote-tracking ref only: the local main and its checkout stay.
		expect(await git(["rev-parse", "main"])).toBe(local);
		expect(await git(["rev-parse", "refs/remotes/origin/main"])).toBe(upstream);
		expect(await git(["status", "--porcelain"])).toBe("");
		// No upstream tracking set on the item's branch.
		await expect(git(["config", `branch.${item.branchName}.merge`])).rejects.toThrow();
	});

	test("local: new work starts from the local base, never fetching", async () => {
		const local = await git(["rev-parse", "main"]);
		setTeamSettings({ workStart: "local" });
		const item = await create("From local");
		expect(await git(["rev-parse", "HEAD"], worktreePathOf(item) ?? "")).toBe(local);
		expect(createdDetail(item.id)).toMatchObject({ startFrom: "main" });
		await expect(git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])).resolves.toBe(
			local,
		);
	});

	test("new work never starts from a base whose files a replacement ref rewrites (Devin 4)", async () => {
		setTeamSettings({ workStart: "local" });
		const local = await git(["rev-parse", "main"]);
		const blob = await git(["rev-parse", "main:a.txt"]);
		const fake = join(repo, ".git", "fake-blob");
		await writeFile(fake, "fake\n");
		await git(["replace", blob, await git(["hash-object", "-w", "--", fake])]);
		const before = await git(["worktree", "list", "--porcelain"]);
		await expect(create("On replaced files")).rejects.toMatchObject({
			code: "TEAM_GIT_REPLACED_HISTORY",
		});
		// Nothing was made: no worktree, no item.
		expect(await git(["worktree", "list", "--porcelain"])).toBe(before);
		expect(db.select().from(teamWorkItems).all()).toHaveLength(0);
		// Without the replacement it starts as usual.
		await git(["replace", "-d", blob]);
		const item = await create("On real files");
		expect(await git(["rev-parse", "HEAD"], worktreePathOf(item) ?? "")).toBe(local);
	});

	test("an unreachable origin starts from the remote-tracking ref as it is, or refuses", async () => {
		setTeamSettings({ workStart: "remote" });
		await git(["remote", "set-url", "origin", join(temporary, "missing.git")]);
		const known = await git(["rev-parse", "refs/remotes/origin/main"]);
		const item = await create("Offline");
		expect(await git(["rev-parse", "HEAD"], worktreePathOf(item) ?? "")).toBe(known);
		expect(createdDetail(item.id)).toMatchObject({ startFrom: "origin/main", fetched: false });
		await git(["update-ref", "-d", "refs/remotes/origin/main"]);
		await expect(create("Nothing to start from")).rejects.toMatchObject({
			code: "TEAM_WORK_START_UNAVAILABLE",
		});
	});

	test("work.sync brings in origin/<base> when the team starts from origin", async () => {
		setTeamSettings({ workStart: "local" });
		const item = await create("Sync me");
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
			VALUES ('ws-worker', 'subagent', 'w', 'idle', ?, ?, ?, ?)`,
			[LEAD, LEAD, NOW, NOW],
		);
		attachWorker(LEAD, item.id, "ws-worker", agent);
		const local = await syncWorkItem({ coordinatorId: LEAD, itemId: item.id, actor: agent });
		expect(local.outcome).toBe("up_to_date");
		setTeamSettings({ workStart: "remote" });
		const remote = await syncWorkItem({ coordinatorId: LEAD, itemId: item.id, actor: agent });
		expect(remote).toMatchObject({ outcome: "handed_off", baseSha: upstream });
		if (remote.outcome !== "handed_off") return;
		expect(remote.instruction).toContain(`the base origin/main (commit ${upstream})`);
		expect(remote.instruction).toContain(`git merge --no-ff ${upstream}`);
	});

	test("an item started from origin counts only its own commits, and lands when origin has it (review 5)", async () => {
		setTeamSettings({ workStart: "remote" });
		const local = await git(["rev-parse", "main"]);
		const item = await create("Own commits only");
		const path = worktreePathOf(item) ?? "";
		expect(itemStartedFrom(item.id)).toBe("origin/main");
		const own = await commitFile(path, "own.txt", "own\n", "the item's own work");
		const resolve = (ref: string) =>
			git(["rev-parse", "--verify", "--quiet", ref]).catch(() => null);
		expect(await compareRefFor(item.id, "main", resolve)).toBe("refs/remotes/origin/main");
		// The local main is still behind origin: it must not count b.txt as the item's.
		expect(await git(["rev-parse", "main"])).toBe(local);
		resetWorkStatCacheForTests();
		const stats = await readWorkStats(LEAD, { userId: USER, isAdmin: true }, PROJECT, [item.id]);
		expect(stats.stats[item.id]).toMatchObject({ files: 1, added: 1, removed: 0 });
		resetOverlapStateForTests();
		await runChangedPathsPass({ sweep: true });
		const stored = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get();
		expect(stored?.changedPathsJson).toEqual(["own.txt"]);
		// Ready, then merged on origin (and fetched): ancestry finds it there, local main behind.
		sqlite.run("UPDATE team_work_items SET state = 'ready', head_sha = ? WHERE id = ?", [
			own,
			item.id,
		]);
		db.insert(teamWorkEvents)
			.values({
				id: generateId(),
				teamId: LEAD,
				workItemId: item.id,
				kind: "work.ready",
				actorKind: "agent",
				actorId: LEAD,
				detailJson: { head: own, changedPathCount: 1 },
				createdAt: new Date().toISOString(),
			})
			.run();
		await git(["push", "-q", "origin", `${own}:refs/heads/main`]);
		await git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
		resetOverlapStateForTests();
		await runChangedPathsPass({ sweep: true });
		const merged = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get();
		expect(merged?.state).toBe("merged");
		expect(await git(["rev-parse", "main"])).toBe(local);
		// An item started locally is compared with the local base.
		setTeamSettings({ workStart: "local" });
		const localItem = await create("Local start");
		expect(await compareRefFor(localItem.id, "main", resolve)).toBe("main");
	});

	test("a settings change merges into what is stored: another key changed meanwhile is kept", async () => {
		const admin = { userId: USER, isAdmin: true };
		// Two people, each from a dialog that read the settings before the other saved.
		await updateTeam(LEAD, admin, { settings: { coordinatorLimits: { editLines: 5 } } });
		const after = await updateTeam(LEAD, admin, { settings: { workStart: "remote" } });
		expect(after.settings).toEqual({ coordinatorLimits: { editLines: 5 }, workStart: "remote" });
		const removed = await updateTeam(LEAD, admin, { settings: { workStart: null } });
		expect(removed.settings).toEqual({ coordinatorLimits: { editLines: 5 } });
	});

	/** Mark an item merged by ancestry at `head` (its head recorded at ready). */
	async function mergedAt(itemId: string, head: string) {
		sqlite.run("UPDATE team_work_items SET state = 'ready', head_sha = ? WHERE id = ?", [
			head,
			itemId,
		]);
		const row = db.select().from(teamWorkItems).where(eq(teamWorkItems.id, itemId)).get();
		expect(
			markMergedByAncestry({
				itemId,
				head,
				base: head,
				expectedHeadSha: head,
				expectedUpdatedAt: row?.updatedAt ?? "",
			}),
		).toBe(true);
		// The unblock is confirmed (git) after the merge transaction.
		await Bun.sleep(300);
	}
	const unblocks = (itemId: string) =>
		db
			.select({ kind: teamWorkEvents.kind })
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.workItemId, itemId))
			.all()
			.filter((event) => event.kind === "work.unblocked").length;

	beforeEach(() => setUnblockDeliveryForTests(async () => true));
	afterEach(() => setUnblockDeliveryForTests(null));

	test("a dependency merged only into the local base does not unblock an origin start (Devin 5)", async () => {
		setTeamSettings({ workStart: "remote" });
		const schema = await create("Schema");
		const api = await create("API", [schema.id]);
		const head = await commitFile(worktreePathOf(schema) ?? "", "schema.txt", "s\n", "schema");
		// Landed in the local main only (fast-forwarded there); origin/main does not have it.
		await git(["merge", "-q", "--ff-only", head]);
		await mergedAt(schema.id, head);
		expect(unblocks(api.id)).toBe(0);
		await expect(assertDependenciesReachStart(api.id)).rejects.toMatchObject({
			code: "TEAM_WORK_ITEM_BLOCKED",
			message: expect.stringContaining("not into origin/main"),
		});
		// Once origin has it (pushed and fetched), it may start.
		await git(["push", "-q", "origin", "main"]);
		await git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
		await assertDependenciesReachStart(api.id);
	});

	test("a dependency merged only on origin does not unblock a local start (Devin 5)", async () => {
		setTeamSettings({ workStart: "local" });
		const schema = await create("Schema");
		const api = await create("API", [schema.id]);
		const head = await commitFile(worktreePathOf(schema) ?? "", "schema.txt", "s\n", "schema");
		await git(["push", "-q", "origin", `${head}:refs/heads/main`, "--force"]);
		await git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
		await mergedAt(schema.id, head);
		expect(unblocks(api.id)).toBe(0);
		await expect(assertDependenciesReachStart(api.id)).rejects.toMatchObject({
			message: expect.stringContaining("not into main"),
		});
		await git(["merge", "-q", "--ff-only", head]);
		await assertDependenciesReachStart(api.id);
	});

	test("a replacement ref or a shallow file cannot make a dependency look inside the start (Devin 4)", async () => {
		setTeamSettings({ workStart: "local" });
		const schema = await create("Schema");
		const api = await create("API", [schema.id]);
		const head = await commitFile(worktreePathOf(schema) ?? "", "schema.txt", "s\n", "schema");
		// main's commit replaced by a copy that lists the dependency's head as a parent.
		const main = await git(["rev-parse", "main"]);
		const body = await git(["cat-file", "commit", main]);
		const fake = join(repo, ".git", "fake-commit");
		await writeFile(fake, `${body.replace(/^(tree [0-9a-f]+)$/m, `$1\nparent ${head}`)}\n`);
		await git(["replace", main, await git(["hash-object", "-t", "commit", "-w", "--", fake])]);
		await git(["merge-base", "--is-ancestor", head, "main"]);
		await mergedAt(schema.id, head);
		expect(unblocks(api.id)).toBe(0);
		await expect(assertDependenciesReachStart(api.id)).rejects.toMatchObject({
			code: "TEAM_WORK_ITEM_BLOCKED",
			message: expect.stringContaining("not into main"),
		});
		// Really inside, but behind a shallow boundary: not answered, so still not started.
		await git(["replace", "-d", main]);
		await git(["merge", "-q", "--ff-only", head]);
		await writeFile(join(repo, ".git", "shallow"), `${main}\n`);
		await expect(assertDependenciesReachStart(api.id)).rejects.toMatchObject({
			code: "TEAM_WORK_ITEM_BLOCKED",
		});
		await rm(join(repo, ".git", "shallow"));
		await assertDependenciesReachStart(api.id);
	});

	test("a dependency inside the start ref unblocks once (Devin 5)", async () => {
		setTeamSettings({ workStart: "local" });
		const schema = await create("Schema");
		const api = await create("API", [schema.id]);
		const head = await commitFile(worktreePathOf(schema) ?? "", "schema.txt", "s\n", "schema");
		await git(["merge", "-q", "--ff-only", head]);
		await mergedAt(schema.id, head);
		expect(unblocks(api.id)).toBe(1);
	});

	test("a team whose base is origin/main: never origin/origin/main (Devin 9)", async () => {
		sqlite.run("UPDATE project_teams SET base_branch = 'origin/main' WHERE narrator_id = ?", [
			LEAD,
		]);
		const before = await git(["rev-parse", "refs/remotes/origin/main"]);
		// Local start: the tracking ref as it is, not fetched.
		setTeamSettings({ workStart: "local" });
		const local = await create("Local from tracking");
		expect(await git(["rev-parse", "HEAD"], worktreePathOf(local) ?? "")).toBe(before);
		expect(createdDetail(local.id)).toMatchObject({ startFrom: "origin/main" });
		// Remote start: origin's main fetched into refs/remotes/origin/main.
		setTeamSettings({ workStart: "remote" });
		const remote = await create("Remote from tracking");
		expect(await git(["rev-parse", "HEAD"], worktreePathOf(remote) ?? "")).toBe(upstream);
		expect(createdDetail(remote.id)).toMatchObject({ startFrom: "origin/main" });
		await expect(
			git(["rev-parse", "--verify", "refs/remotes/origin/origin/main"]),
		).rejects.toThrow();
		// Sync names origin/main and its commit.
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
			VALUES ('ws-tracking-worker', 'subagent', 'w', 'idle', ?, ?, ?, ?)`,
			[LEAD, LEAD, NOW, NOW],
		);
		attachWorker(LEAD, local.id, "ws-tracking-worker", agent);
		const sync = await syncWorkItem({ coordinatorId: LEAD, itemId: local.id, actor: agent });
		expect(sync).toMatchObject({ outcome: "handed_off", baseSha: upstream });
		if (sync.outcome === "handed_off") {
			expect(sync.instruction).toContain(`the base origin/main (commit ${upstream})`);
			expect(sync.instruction).not.toContain("origin/origin");
		}
	});

	test("a dependency reaching origin later unblocks once, after the fetch that brings it (Devin)", async () => {
		const notes: string[] = [];
		setUnblockDeliveryForTests(async ({ itemId }) => {
			notes.push(itemId);
			return true;
		});
		setTeamSettings({ workStart: "remote" });
		const schema = await create("Schema");
		const api = await create("API", [schema.id]);
		const head = await commitFile(worktreePathOf(schema) ?? "", "schema.txt", "s\n", "schema");
		await git(["merge", "-q", "--ff-only", head]);
		await mergedAt(schema.id, head);
		expect(unblocks(api.id)).toBe(0);
		expect(notes).toEqual([]);
		// Origin gets it; the next work-start fetch brings it into refs/remotes/origin/main.
		await git(["push", "-q", "origin", "main"]);
		await create("Something else");
		await Bun.sleep(400);
		expect(unblocks(api.id)).toBe(1);
		expect(notes).toEqual([api.id]);
		// Looked at again (the periodic sweep): nothing more.
		expect(await reconcileUnblocks({ projectId: PROJECT })).toBe(0);
		expect(unblocks(api.id)).toBe(1);
		expect(notes).toEqual([api.id]);
	});
});
