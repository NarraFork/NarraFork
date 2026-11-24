/**
 * The knowledge check of `work.ready` (`team-knowledge.ts`), against the migrated test database
 * and real git repositories: a branch that changes code a node anchors must update the node in
 * the same branch, and a source file it adds must be anchored; a repository without
 * `knowledge/index.md` is not checked; a check that cannot run refuses instead of passing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkItems } from "../../../db/schema";
import { teamTool } from "../../../lib/agent/tools/team";
import type { ToolContext } from "../../../lib/agent/types";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { safeSpawn } from "../../../lib/spawn";
import { setKnowledgeCheckLimitsForTests } from "../team-knowledge";
import {
	createWorkItem,
	markReady,
	recordReview,
	setWorkItemPortsForTests,
	type WorkActor,
	type WorkItemWorktreePorts,
	worktreePathOf,
} from "../work-items";

const LEAD = "pk-lead";
const PROJECT = "pk-project";
const USER = "pk-user";
const agent: WorkActor = { kind: "agent", id: LEAD };
const principal = { userId: USER, isAdmin: false };
const NOW = "2026-11-24T00:00:00.000Z";

let temporary: string;
let source: string;

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, "-c", "user.name=T", "-c", "user.email=t@e.test", ...args],
		timeout: 10_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

async function write(cwd: string, file: string, text: string) {
	await mkdir(dirname(join(cwd, file)), { recursive: true });
	await writeFile(join(cwd, file), text);
}

async function commit(cwd: string, files: Record<string, string>, message: string) {
	for (const [file, text] of Object.entries(files)) await write(cwd, file, text);
	await git(["add", "-A"], cwd);
	await git(["commit", "-qm", message], cwd);
}

function node(id: string, anchors: string[], verifiedAt = "base"): string {
	const list = anchors.length > 0 ? `\n${anchors.map((a) => `  - ${a}`).join("\n")}` : " []";
	return `---\nid: ${id}\ntitle: ${id}\nsummary: ${id}\nanchors:${list}\nstatus: draft\nverified_at: ${verifiedAt}\n---\n# ${id}\n`;
}

const TREE = {
	"knowledge/README.md": "# guide, not a node\n",
	"knowledge/index.md": node("root", []),
	"knowledge/api.md": node("api", ["server/api.ts", "shared/types/"]),
	"knowledge/ui.md": node("ui", ["frontend/**/*.tsx"]),
};

const ports: WorkItemWorktreePorts = {
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
	planRemoval: async () => {
		throw new Error("not used");
	},
	removeWorktree: async () => {
		throw new Error("not used");
	},
	principalOf: async (userId) => ({ userId, isAdmin: false }),
};

async function item(title = "Change") {
	const created = await createWorkItem({
		coordinatorId: LEAD,
		title,
		actor: agent,
		principal,
		signal: new AbortController().signal,
	});
	return { id: created.id, path: worktreePathOf(created) ?? "" };
}

async function ready(itemId: string) {
	await recordReview({
		coordinatorId: LEAD,
		itemId,
		verdict: "clear",
		findings: 0,
		reviewer: null,
		actor: agent,
	});
	return markReady({ coordinatorId: LEAD, itemId, actor: agent });
}

async function refusal(itemId: string): Promise<AppError> {
	const error = await ready(itemId).then(
		() => null,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(AppError);
	return error as AppError;
}

const stateOf = (id: string) =>
	db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get()?.state;

beforeAll(() => setWorkItemPortsForTests(ports));
afterAll(() => {
	setWorkItemPortsForTests(null);
	setKnowledgeCheckLimitsForTests(null);
});

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-knowledge-"));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"]);
	await commit(
		source,
		{
			".gitignore": ".worktrees/\n",
			"server/api.ts": "export const api = 1;\n",
			"shared/types/a.ts": "export type A = 1;\n",
			"frontend/page.tsx": "export const Page = 1;\n",
		},
		"initial",
	);
	await mkdir(join(source, ".worktrees"));
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', 'user', ?)",
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
});

afterEach(async () => {
	setKnowledgeCheckLimitsForTests(null);
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'pk-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	await rm(temporary, { recursive: true, force: true });
});

describe("work.ready knowledge check", () => {
	test("a repository without knowledge/index.md is not checked", async () => {
		// A knowledge/ directory without the root node is not a tree.
		await commit(source, { "knowledge/api.md": node("api", ["server/api.ts"]) }, "no root");
		const work = await item();
		await commit(
			work.path,
			{ "server/api.ts": "export const api = 2;\n", "server/new.ts": "export {};\n" },
			"change",
		);
		const result = await ready(work.id);
		expect(result.item.state).toBe("ready");
	});

	test("anchored code changed without its node is refused, listing the node", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(
			work.path,
			{
				"server/api.ts": "export const api = 2;\n",
				"shared/types/a.ts": "export type A = 2;\n",
				"frontend/page.tsx": "export const Page = 2;\n",
			},
			"change",
		);
		const error = await refusal(work.id);
		expect(error.statusCode).toBe(409);
		expect(error.code).toBe("TEAM_WORK_ITEM_KNOWLEDGE_STALE");
		expect(error.message).toContain("knowledge/api.md");
		expect(error.message).toContain("work.ready again");
		expect(error.details).toEqual({
			head: await git(["rev-parse", "HEAD"], work.path),
			mergeBase: await git(["rev-parse", "main"]),
			nodes: [
				{ file: "knowledge/api.md", files: ["server/api.ts", "shared/types/a.ts"], moreFiles: 0 },
				{ file: "knowledge/ui.md", files: ["frontend/page.tsx"], moreFiles: 0 },
			],
			moreNodes: 0,
			uncovered: [],
			moreUncovered: 0,
		});
		expect(stateOf(work.id)).toBe("in_review");

		// The Team tool hands the coordinator the same list.
		const output = JSON.parse(
			(
				await teamTool.execute({ action: "work.ready", item: work.id }, {
					narratorId: LEAD,
				} as ToolContext)
			).output,
		);
		expect(output.error.code).toBe("TEAM_WORK_ITEM_KNOWLEDGE_STALE");
		expect(output.details.nodes.map((n: { file: string }) => n.file)).toEqual([
			"knowledge/api.md",
			"knowledge/ui.md",
		]);
	});

	test("updating the node in the branch passes, even when only verified_at moved", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(work.path, { "server/api.ts": "export const api = 2;\n" }, "change");
		expect((await refusal(work.id)).code).toBe("TEAM_WORK_ITEM_KNOWLEDGE_STALE");
		await commit(
			work.path,
			{ "knowledge/api.md": node("api", ["server/api.ts", "shared/types/"], "abc123") },
			"verify the node",
		);
		const result = await ready(work.id);
		expect(result.item.state).toBe("ready");
	});

	test("an added source file no node anchors is refused; tests and non-source are not", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(
			work.path,
			{
				"server/orphan.ts": "export {};\n",
				"server/__tests__/orphan.test.ts": "export {};\n",
				"scripts/tool.ts": "export {};\n",
				"frontend/new.tsx": "export {};\n", // anchored by the ui node's glob…
				"knowledge/ui.md": node("ui", ["frontend/**/*.tsx"], "abc123"), // …which is updated
			},
			"add files",
		);
		const error = await refusal(work.id);
		expect(error.code).toBe("TEAM_WORK_ITEM_KNOWLEDGE_STALE");
		expect(error.details).toMatchObject({ nodes: [], uncovered: ["server/orphan.ts"] });
		expect(error.message).toContain("server/orphan.ts");

		await commit(
			work.path,
			{ "knowledge/api.md": node("api", ["server/api.ts", "server/orphan.ts", "shared/types/"]) },
			"anchor it",
		);
		expect((await ready(work.id)).item.state).toBe("ready");
	});

	test("a rename hits the node of the old path and needs the new path anchored", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await git(["mv", "server/api.ts", "server/routes.ts"], work.path);
		await git(["commit", "-qm", "rename"], work.path);
		const error = await refusal(work.id);
		expect(error.details).toMatchObject({
			nodes: [{ file: "knowledge/api.md", files: ["server/api.ts"] }],
			uncovered: ["server/routes.ts"],
		});
		await commit(
			work.path,
			{ "knowledge/api.md": node("api", ["server/routes.ts", "shared/types/"]) },
			"follow the rename",
		);
		expect((await ready(work.id)).item.state).toBe("ready");
	});

	test("long lists are capped with a count of the rest", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		const files: Record<string, string> = {};
		for (let index = 0; index < 25; index++)
			files[`server/added-${String(index).padStart(2, "0")}.ts`] = "export {};\n";
		for (let index = 0; index < 12; index++)
			files[`shared/types/t-${String(index).padStart(2, "0")}.ts`] = "export {};\n";
		await commit(work.path, files, "many");
		const details = (await refusal(work.id)).details as {
			nodes: Array<{ files: string[]; moreFiles: number }>;
			uncovered: string[];
			moreUncovered: number;
		};
		expect(details.uncovered).toHaveLength(20);
		expect(details.moreUncovered).toBe(5);
		expect(details.nodes[0]?.files).toHaveLength(10);
		expect(details.nodes[0]?.moreFiles).toBe(2);
	});

	test("a base that does not resolve fails closed", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(work.path, { "knowledge/api.md": node("api", ["server/api.ts"]) }, "edit");
		sqlite.run("UPDATE team_work_items SET base_ref = 'no-such-branch' WHERE id = ?", [work.id]);
		const error = await refusal(work.id);
		expect(error.statusCode).toBe(409);
		expect(error.code).toBe("TEAM_KNOWLEDGE_CHECK_UNAVAILABLE");
		expect(error.message).toContain("no-such-branch");
		expect(stateOf(work.id)).toBe("in_review");
	});

	test("a tree over the read caps fails closed instead of passing", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(work.path, { "knowledge/api.md": node("api", ["server/api.ts"]) }, "edit");
		setKnowledgeCheckLimitsForTests({ maxNodeBytes: 64 });
		const bytes = await refusal(work.id);
		expect(bytes.code).toBe("TEAM_KNOWLEDGE_CHECK_UNAVAILABLE");
		expect(bytes.message).toContain("bytes of node files");
		setKnowledgeCheckLimitsForTests({ maxNodeFiles: 2 });
		const count = await refusal(work.id);
		expect(count.code).toBe("TEAM_KNOWLEDGE_CHECK_UNAVAILABLE");
		expect(count.message).toContain("node files");
		setKnowledgeCheckLimitsForTests({ maxMatchTests: 0 });
		expect((await refusal(work.id)).code).toBe("TEAM_KNOWLEDGE_CHECK_UNAVAILABLE");
		expect(stateOf(work.id)).toBe("in_review");
		setKnowledgeCheckLimitsForTests(null);
		expect((await ready(work.id)).item.state).toBe("ready");
	});

	test("uncommitted changes are refused as DIRTY before the knowledge check", async () => {
		await commit(source, TREE, "tree");
		const work = await item();
		await commit(work.path, { "server/api.ts": "export const api = 2;\n" }, "change");
		await write(work.path, "server/api.ts", "export const api = 3;\n");
		expect((await refusal(work.id)).code).toBe("TEAM_WORK_ITEM_DIRTY");
	});
});
