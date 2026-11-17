/**
 * `Agent({ isolation: "worktree", title })` for a team coordinator (P3): it creates a work item
 * (branch + worktree), starts the subagent there as a `worker`, and records it as the item's
 * worker before its run starts. A workdir that is a queued item's worktree attaches the new
 * subagent to it. Other sessions cannot use isolation; an Agent call that fails after the item
 * was made leaves no untouched worktree behind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../../../db";
import { narratorWorktreeResources, teamWorkItems } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { safeSpawn } from "../../../../lib/spawn";
import type { ToolContext } from "../../types";

const runCalls: Array<Record<string, unknown>> = [];
let failRun = false;
let agentTool: typeof import("../task").agentTool;
let realNarratorSubagent: typeof import("@server/services/narrator-subagent");
let items: typeof import("@server/services/teams/work-items");

const LEAD = "p3a-lead";
const NOW = "2026-11-17T00:00:00.000Z";
let temporary: string;
let source: string;

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		timeout: 10_000,
		maxOutputBytes: 64 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

beforeAll(async () => {
	realNarratorSubagent = await import("@server/services/narrator-subagent");
	mock.module("@server/services/narrator-subagent", () => ({
		...realNarratorSubagent,
		runSubagent: mock(async (input: Record<string, unknown>) => {
			runCalls.push(input);
			if (failRun) throw new Error("model pool refused");
			const id = `p3a-worker-${runCalls.length}`;
			sqlite.run(
				`INSERT INTO narrators (id, type, title, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
				VALUES (?, 'subagent', ?, ?, ?, ?, ?)`,
				[id, id, LEAD, LEAD, NOW, NOW],
			);
			(input.onCreated as ((id: string) => void) | undefined)?.(id);
			return `<background_task_id>${id}</background_task_id>`;
		}),
	}));
	({ agentTool } = await import("../task"));
	items = await import("@server/services/teams/work-items");
});

afterAll(() => {
	items.setWorkItemPortsForTests(null);
	mock.module("@server/services/narrator-subagent", () => realNarratorSubagent);
	mock.restore();
});

beforeEach(async () => {
	runCalls.length = 0;
	failRun = false;
	temporary = await mkdtemp(join(tmpdir(), "nf-agent-team-"));
	source = join(temporary, "repo");
	await mkdir(join(source, ".worktrees"), { recursive: true });
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(source, "a.txt"), "a\n");
	await git(["add", "."]);
	await git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-qm", "init"]);
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('p3a-user', 'p3a-user', 'x', 'user', ?)",
		[NOW],
	);
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES ('p3a-p', 'p', ?, ?, ?)",
		[source, NOW, NOW],
	);
	for (const [id, traits] of [
		[LEAD, '["team"]'],
		["p3a-other", "[]"],
	])
		sqlite.run(
			`INSERT INTO narrators (id, type, title, traits, cwd, created_at, updated_at)
			VALUES (?, 'primary', ?, ?, ?, ?, ?)`,
			[id, id, traits, source, NOW, NOW],
		);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES (?, 'p3a-p', 'main', ?, ?)`,
		[LEAD, NOW, NOW],
	);
	items.setWorkItemPortsForTests({
		async createWorktree({ requestId, branchName, baseRef }) {
			const path = join(source, ".worktrees", requestId);
			await git(["worktree", "add", "-q", "-b", branchName, "--", path, baseRef]);
			db.insert(narratorWorktreeResources)
				.values({
					id: generateId(),
					ownerNarratorId: LEAD,
					deviceId: "local",
					repositoryKey: "repo",
					worktreePath: path,
					state: "ready",
					createRequestId: requestId,
				})
				.run();
			return { path };
		},
		planRemoval: async ({ path }) =>
			({
				status: "ready",
				expectedRevision: 1,
				worktree: { path, head: null, dirtyFileCount: 0, unreachableCommits: 0 },
				blockers: [],
				confirmations: [],
			}) as never,
		removeWorktree: async ({ path }) => {
			await git(["worktree", "remove", "--", path]);
			db.delete(narratorWorktreeResources)
				.where(eq(narratorWorktreeResources.worktreePath, path))
				.run();
			return {
				outcome: "removed",
				worktree: null,
				effects: {} as never,
				relocatedTo: null,
			};
		},
		isNarratorRunning: () => false,
		principalOf: async (userId) => ({ userId, isAdmin: false }),
		gitIdentity: async () => null,
	});
});

afterEach(async () => {
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'p3a-%'");
	sqlite.run("DELETE FROM projects WHERE id = 'p3a-p'");
	sqlite.run("DELETE FROM users WHERE id = 'p3a-user'");
	await rm(temporary, { recursive: true, force: true });
});

function ctx(narratorId = LEAD): ToolContext {
	return {
		narratorId,
		cwd: source,
		signal: new AbortController().signal,
		locale: "en",
		userId: "p3a-user",
		currentToolUseId: `use-${generateId()}`,
		toolCallBinding: { toolCallId: `row-${generateId()}`, attempt: 1 },
		updateExecutionLease: {
			kind: "resumable",
			setNarratorId: () => {},
			transfer: () => true,
			release: () => {},
		},
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

const only = () => {
	const rows = db.select().from(teamWorkItems).all();
	expect(rows).toHaveLength(1);
	return rows[0] as typeof teamWorkItems.$inferSelect;
};

describe("Agent with a team work item", () => {
	test('isolation "worktree" creates the item and starts a worker in its worktree', async () => {
		const result = await agentTool.execute(
			{ isolation: "worktree", title: "Try the parser", prompt: "do it", run_in_background: true },
			ctx(),
		);
		expect(result.isError).toBeFalsy();
		const item = only();
		const path = items.worktreePathOf(item);
		expect(item).toMatchObject({
			kind: "isolated",
			state: "in_progress",
			workerNarratorId: "p3a-worker-1",
		});
		expect(runCalls[0]).toMatchObject({
			cwd: path,
			subagentType: "worker",
			title: "Try the parser",
		});
		expect(result.output).toContain(`Team work item ${item.id}`);
		expect(path && existsSync(path)).toBe(true);
	});

	test("a workdir that is a queued item's worktree attaches the subagent to it", async () => {
		const queued = await items.createWorkItem({
			coordinatorId: LEAD,
			title: "Later",
			actor: { kind: "agent", id: LEAD },
			principal: { userId: "p3a-user", isAdmin: false },
			signal: new AbortController().signal,
		});
		const path = items.worktreePathOf(queued) ?? "";
		await agentTool.execute({ workdir: path, prompt: "go", subagent_type: "worker" }, ctx());
		expect(runCalls[0]?.cwd).toBe(path);
		expect(only()).toMatchObject({ state: "in_progress", workerNarratorId: "p3a-worker-1" });
	});

	test("refused for other sessions and with a workdir; a failed start leaves nothing behind", async () => {
		const other = await agentTool.execute(
			{ isolation: "worktree", title: "x", prompt: "p" },
			ctx("p3a-other"),
		);
		expect(other.isError).toBe(true);
		expect(other.output).toContain("team coordinators");
		const both = await agentTool.execute(
			{ isolation: "worktree", title: "x", prompt: "p", workdir: source },
			ctx(),
		);
		expect(both.isError).toBe(true);
		expect(runCalls).toHaveLength(0);
		expect(db.select().from(teamWorkItems).all()).toHaveLength(0);

		failRun = true;
		const failed = await agentTool.execute(
			{ isolation: "worktree", title: "Doomed", prompt: "p" },
			ctx(),
		);
		expect(failed.isError).toBe(true);
		const item = only();
		expect(item.state).toBe("cancelled");
		expect(item.worktreeResourceId).toBeNull();
		expect(existsSync(join(source, ".worktrees", `team-${item.id}`))).toBe(false);
	});
});

describe("Team tool", () => {
	test("coordinators only; a blocker review points back to the worker with Send", async () => {
		const { teamTool } = await import("../team");
		const refused = await teamTool.execute({ action: "work.list" }, ctx("p3a-other"));
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("TEAM_COORDINATOR_REQUIRED");
		const invalid = await teamTool.execute({ action: "work.nope" }, ctx());
		expect(invalid.output).toContain("INVALID_ARGUMENT");

		await agentTool.execute({ isolation: "worktree", title: "Fix it", prompt: "p" }, ctx());
		const item = only();
		const review = JSON.parse(
			(
				await teamTool.execute(
					{ action: "work.review", item: item.id, verdict: "blocker", findings: 3 },
					ctx(),
				)
			).output,
		);
		expect(review.item).toMatchObject({ state: "in_progress", reviewRounds: 1 });
		expect(review.nextAction).toContain('Send({ id: "');
		const missing = await teamTool.execute({ action: "work.ready" }, ctx());
		expect(missing.output).toContain("work.ready requires item");
		const listed = JSON.parse((await teamTool.execute({ action: "work.list" }, ctx())).output);
		expect(listed.items.map((row: { id: string }) => row.id)).toEqual([item.id]);
	});
});
