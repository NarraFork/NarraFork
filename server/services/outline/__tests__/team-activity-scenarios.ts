/**
 * Team activity on its store (outline P2 PR 10b, design §2.5): scenarios that run on SQLite
 * (`team-activity.test.ts`) and on PostgreSQL (`tests/server/services/outline/
 * pg-outline-team-activity.test.ts`), with the outline store and access executor of that
 * database injected. They cover what a look reads and says: the scope (related trees, the project
 * task page, files), what is left out (the session's own and its subagents' commits, a person's
 * change to a task it holds, tidying, unrelated trees, session spaces), names, the 4 KiB / 20 line
 * budget, the window and the cursor. Writing the row (cadence, delivery, the prompt) goes through
 * the session runtime, which runs on SQLite only, and is tested in the test file.
 */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackend } from "../../../lib/agent/execution/local-backend";
import { noteOutlineFileChange, resetOutlineOverlapForTests } from "../overlap";
import { ensureProjectSpace } from "../spaces";
import {
	OUTLINE_TEAM_ACTIVITY_LIMITS,
	readOutlineTeamActivity,
	resetOutlineTeamActivityForTests,
} from "../team-activity";
import { type OutlineOp, type OutlineOpResult, writeOutline } from "../write";

export interface TeamActivityContext {
	/** A person; their username starts with `name`. */
	person(name: string): Promise<{ id: string; username: string }>;
	project(owner: string): Promise<string>;
	/** A root outline session of `owner` in `projectId`, made at `createdAt`. */
	session(
		owner: string,
		projectId: string | null,
		options: { title: string; createdAt: string; backend?: "spec" | "outline" },
	): Promise<string>;
	subagent(root: string, owner: string, projectId: string): Promise<string>;
	/** A finished run of the session that ended at `endedAt`. */
	finishedRun(narratorId: string, endedAt: string): Promise<void>;
}

export interface TeamActivityScenario {
	name: string;
	run(ctx: TeamActivityContext): Promise<void>;
}

/** Times of a scenario: a base, and the look an hour after it. */
function clock() {
	const base = Date.parse("2026-11-08T08:00:00.000Z");
	let tick = 0;
	return {
		base,
		iso: (offsetMs: number) => new Date(base + offsetMs).toISOString(),
		/** Commits in the window: strictly increasing times from the base on. */
		next: () => new Date(base + ++tick * 1000),
		look: base + 60 * 60_000,
	};
}

type Who = { kind: "agent" | "human"; id: string; owner: string };
const agent = (id: string, owner: string): Who => ({ kind: "agent", id, owner });
const human = (id: string): Who => ({ kind: "human", id, owner: id });

async function write(
	spaceId: string,
	who: Who,
	ops: OutlineOp[],
	at: Date,
): Promise<OutlineOpResult[]> {
	const written = await writeOutline(
		{
			spaceId,
			ops,
			actor: { kind: who.kind, id: who.id },
			...(who.kind === "agent" ? { narratorId: who.id } : {}),
			responsibleUserId: who.owner,
		},
		{ now: () => at },
	);
	return written.results.map((r) => {
		if (!r) throw new Error("write failed");
		return r;
	});
}

const link = (r: OutlineOpResult, title: string) => `[[${r.address}|${title}]]`;

/**
 * A project with sessions A (the one looking), B and C of one person, a page with A's tree
 * (`auth 模块稳定` > `改刷新逻辑`, `补测试`; A holds `补测试`) and the project task page with a task
 * nobody started, all written well before the window.
 */
async function project(ctx: TeamActivityContext) {
	const t = clock();
	const alice = await ctx.person("alice");
	const projectId = await ctx.project(alice.id);
	const space = await ensureProjectSpace(projectId);
	const made = t.iso(-3 * 60 * 60_000);
	const a = await ctx.session(alice.id, projectId, { title: "主线", createdAt: made });
	const b = await ctx.session(alice.id, projectId, { title: "B", createdAt: made });
	const c = await ctx.session(alice.id, projectId, { title: "C", createdAt: made });
	const before = new Date(t.base - 90 * 60_000);
	const [, root, refresh, tests] = await write(
		space.id,
		agent(a, alice.id),
		[
			{ op: "insert", tempId: "page", parent: null, content: "Auth" },
			{
				op: "insert",
				tempId: "root",
				parent: { tempId: "page" },
				content: "auth 模块稳定",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "root" },
				content: "改刷新逻辑",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "root" }, content: "补测试", task: { status: "doing" } },
		],
		before,
	);
	const [, upgrade] = await write(
		space.id,
		human(alice.id),
		[
			{ op: "insert", tempId: "tasks", parent: null, content: "任务", alias: "tasks" },
			{ op: "insert", parent: { tempId: "tasks" }, content: "升级依赖", task: { status: "todo" } },
		],
		new Date(before.getTime() + 1000),
	);
	const [, elsewhere] = await write(
		space.id,
		human(alice.id),
		[
			{ op: "insert", tempId: "other", parent: null, content: "Other work" },
			{
				op: "insert",
				parent: { tempId: "other" },
				content: "无关的任务",
				task: { status: "todo" },
			},
		],
		new Date(before.getTime() + 2000),
	);
	if (!root || !refresh || !tests || !upgrade || !elsewhere) throw new Error("seed failed");
	return { t, alice, projectId, space, a, b, c, root, refresh, tests, upgrade, elsewhere };
}

export const OUTLINE_TEAM_ACTIVITY_SCENARIOS: TeamActivityScenario[] = [
	{
		name: "what others did around the session's trees and on the task page, and nothing else",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			const { t, space } = p;
			// B ticks a task of A's tree done.
			await write(
				space.id,
				agent(p.b, p.alice.id),
				[{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "done" } }],
				t.next(),
			);
			// A person writes two notes under it (one commit).
			await write(
				space.id,
				human(p.alice.id),
				[
					{ op: "insert", parent: { id: p.refresh.blockId }, content: "看过日志了" },
					{ op: "insert", parent: { id: p.refresh.blockId }, content: "重现步骤在下面" },
				],
				t.next(),
			);
			// C adds a claimable task to the task page and starts the waiting one.
			const [added] = await write(
				space.id,
				agent(p.c, p.alice.id),
				[
					{
						op: "insert",
						parent: { id: (await pageOf(p.upgrade)).id },
						content: "迁移配置",
						task: { status: "todo", claimable: true },
					},
				],
				t.next(),
			);
			await write(
				space.id,
				agent(p.c, p.alice.id),
				[{ op: "setTask", block: { id: p.upgrade.blockId }, task: { status: "doing" } }],
				t.next(),
			);
			// Left out: A's own commit, its subagent's, a person's change to the task A holds
			// (PR 5 told it), tidying (a move, a reworded note), another tree off the task page.
			const helper = await ctx.subagent(p.a, p.alice.id, p.projectId);
			await write(
				space.id,
				agent(p.a, p.alice.id),
				[{ op: "insert", parent: { id: p.root.blockId }, content: "自己的笔记" }],
				t.next(),
			);
			await write(
				space.id,
				agent(helper, p.alice.id),
				[{ op: "insert", parent: { id: p.root.blockId }, content: "子代理的笔记" }],
				t.next(),
			);
			await write(
				space.id,
				human(p.alice.id),
				[{ op: "setTask", block: { id: p.tests.blockId }, task: { assignee: "human:bob" } }],
				t.next(),
			);
			await write(
				space.id,
				human(p.alice.id),
				[
					{
						op: "move",
						block: { id: p.tests.blockId },
						parent: { id: p.root.blockId },
						position: { first: true },
					},
				],
				t.next(),
			);
			await write(
				space.id,
				agent(p.b, p.alice.id),
				[{ op: "setTask", block: { id: p.elsewhere.blockId }, task: { status: "done" } }],
				t.next(),
			);

			const zh = await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: t.look });
			expect(zh?.content).toBe(
				[
					"团队动态（上一轮之后别人做的；系统整理，不是用户发言）",
					`- ${link(p.root, "auth 模块稳定")} 下：会话「B」把 ${link(p.refresh, "改刷新逻辑")} 勾成完成`,
					`- ${link(p.root, "auth 模块稳定")} 下：${p.alice.username} 加了 2 条笔记`,
					`- 项目任务页：会话「C」加了任务 [[${added?.address}|迁移配置]]（可领取）`,
					`- 项目任务页：会话「C」开始做 ${link(p.upgrade, "升级依赖")}`,
				].join("\n"),
			);
			// The reader's card: the same changes, who made them in no language.
			expect(zh?.body).toEqual({
				kind: "outlineTasks",
				variant: "activity",
				items: [
					{
						address: p.refresh.address,
						title: "改刷新逻辑",
						by: "B",
						changes: [{ kind: "status", from: "todo", to: "done" }],
					},
					{
						address: p.root.address,
						title: "auth 模块稳定",
						by: p.alice.username,
						changes: [{ kind: "notes", n: 2 }],
					},
					{
						address: added?.address,
						title: "迁移配置",
						by: "C",
						changes: [{ kind: "added" }, { kind: "claimable" }],
					},
					{
						address: p.upgrade.address,
						title: "升级依赖",
						by: "C",
						changes: [{ kind: "status", from: "todo", to: "doing" }],
					},
				],
			});
			// The cursor moved: nothing new, nothing to say.
			expect(await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: t.look + 1000 })).toBe(
				null,
			);
			// The same window read again from scratch says the same bytes (deterministic), in English
			// too.
			resetOutlineTeamActivityForTests();
			const en = await readOutlineTeamActivity(p.a, { locale: "en", now: t.look });
			expect(en?.content).toBe(
				[
					"Team activity since your last turn (what others did; compiled by the system, not the user)",
					`- Under ${link(p.root, "auth 模块稳定")}: session "B" ticked ${link(p.refresh, "改刷新逻辑")} done`,
					`- Under ${link(p.root, "auth 模块稳定")}: ${p.alice.username} added 2 notes`,
					`- Project task page: session "C" added the task [[${added?.address}|迁移配置]] (claimable)`,
					`- Project task page: session "C" started ${link(p.upgrade, "升级依赖")}`,
				].join("\n"),
			);
			resetOutlineTeamActivityForTests();
			expect((await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: t.look }))?.content).toBe(
				zh?.content,
			);
		},
	},
	{
		name: "a session it may not name is another session; the next look says only what is new",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			const stranger = await ctx.person("mallory");
			const theirs = await ctx.session(stranger.id, p.projectId, {
				title: "秘密",
				createdAt: p.t.iso(-3 * 60 * 60_000),
			});
			await write(
				p.space.id,
				agent(theirs, stranger.id),
				[{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "cancelled" } }],
				p.t.next(),
			);
			const first = await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: p.t.look });
			expect(first?.content.split("\n").slice(1)).toEqual([
				`- ${link(p.root, "auth 模块稳定")} 下：另一个会话取消了 ${link(p.refresh, "改刷新逻辑")}`,
			]);
			expect(first?.content).not.toContain("秘密");
			expect(first?.body).toMatchObject({ items: [{ title: "改刷新逻辑" }] });
			expect((first?.body as { items: Array<{ by?: string }> }).items[0]?.by).toBeUndefined();
			// Later: B hands the root over to C and reopens the cancelled task.
			await write(
				p.space.id,
				agent(p.b, p.alice.id),
				[
					{ op: "setTask", block: { id: p.root.blockId }, task: { assignee: `agent:${p.c}` } },
					{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "todo" } },
				],
				p.t.next(),
			);
			const second = await readOutlineTeamActivity(p.a, {
				locale: "zh-CN",
				now: p.t.look + 60_000,
			});
			// One commit: its blocks come in id order, so the lines are compared as a set.
			expect(second?.content.split("\n").slice(1).sort()).toEqual(
				[
					`- ${link(p.root, "auth 模块稳定")} 下：会话「B」把它转交给 会话「C」`,
					`- ${link(p.root, "auth 模块稳定")} 下：会话「B」重开了 ${link(p.refresh, "改刷新逻辑")}`,
				].sort(),
			);
		},
	},
	{
		name: "the window starts at the end of the last run, at most two hours back",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			// Before the last run ended: not news.
			await write(
				p.space.id,
				agent(p.b, p.alice.id),
				[{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "done" } }],
				new Date(p.t.base + 1000),
			);
			await ctx.finishedRun(p.a, p.t.iso(10 * 60_000));
			await write(
				p.space.id,
				agent(p.c, p.alice.id),
				[{ op: "insert", parent: { id: p.root.blockId }, content: "C 的笔记" }],
				new Date(p.t.base + 20 * 60_000),
			);
			const look = await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look });
			expect(look?.content.split("\n").slice(1)).toEqual([
				`- Under ${link(p.root, "auth 模块稳定")}: session "C" added 1 note`,
			]);
			// A session that never ran looks back two hours at most: the seed (90 minutes before the
			// base, two and a half hours before the look) is not in it, and neither is anything else.
			resetOutlineTeamActivityForTests();
			const fresh = await project(ctx);
			expect(
				await readOutlineTeamActivity(fresh.a, { locale: "en", now: fresh.t.look }),
			).toBeNull();
		},
	},
	{
		name: "the budget: at most 4 KiB and 20 lines, five a tree, the rest counted with where to read on",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			const long = "很长的标题".repeat(20);
			const trees: OutlineOpResult[][] = [];
			for (let i = 0; i < 6; i++) {
				const [, rootTask, ...children] = await write(
					p.space.id,
					agent(p.a, p.alice.id),
					[
						{ op: "insert", tempId: "page", parent: null, content: `Page ${i}` },
						{
							op: "insert",
							tempId: "root",
							parent: { tempId: "page" },
							content: `树 ${i}`,
							task: { status: "doing" },
						},
						...Array.from(
							{ length: 6 },
							(_, j): OutlineOp => ({
								op: "insert",
								parent: { tempId: "root" },
								content: `${long} ${i}.${j}`,
								task: { status: "todo" },
							}),
						),
					],
					new Date(p.t.base - 60 * 60_000 + i * 1000),
				);
				trees.push([rootTask as OutlineOpResult, ...children]);
			}
			await write(
				p.space.id,
				agent(p.b, p.alice.id),
				trees.flatMap((tree) =>
					tree.slice(1).map(
						(child): OutlineOp => ({
							op: "setTask",
							block: { id: child.blockId },
							task: { status: "done" },
						}),
					),
				),
				p.t.next(),
			);
			const look = await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: p.t.look });
			const content = look?.content ?? "";
			const lines = content.split("\n");
			expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(
				OUTLINE_TEAM_ACTIVITY_LIMITS.bytes,
			);
			expect(lines.length - 2).toBeLessThanOrEqual(OUTLINE_TEAM_ACTIVITY_LIMITS.lines);
			// Titles cut at 80 characters.
			expect(content).not.toContain(long);
			expect(content).toContain(`${long.slice(0, 79)}…`);
			// Every change is listed or counted: 36 tasks done, a tree at most five lines.
			const listed = lines.filter((line) => line.startsWith("- ")).length;
			const counted = Number(/还有 (\d+) 处变化没有列出/.exec(lines.at(-1) ?? "")?.[1] ?? 0);
			expect(listed + counted).toBe(36);
			expect(look?.listed).toBe(listed);
			expect(lines.at(-1)).toContain("用 OutlineRead 读 [[");
			expect(lines.at(-1)).toContain("|任务]]");
			for (const tree of trees)
				expect(
					lines.filter((line) => line.includes(`[[${tree[0]?.address}|`)).length,
				).toBeLessThanOrEqual(OUTLINE_TEAM_ACTIVITY_LIMITS.linesPerTree);
		},
	},
	{
		name: "files the session changed that another session's task in progress changed since",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			resetOutlineOverlapForTests();
			const p = await project(ctx);
			const [, theirs] = await write(
				p.space.id,
				agent(p.b, p.alice.id),
				[
					{ op: "insert", tempId: "page", parent: null, content: "B 的页" },
					{
						op: "insert",
						parent: { tempId: "page" },
						content: "T12 改登录页",
						task: { status: "doing" },
					},
				],
				new Date(p.t.base - 60 * 60_000),
			);
			const repo = mkdtempSync(join(tmpdir(), "nf-team-activity-"));
			mkdirSync(join(repo, ".git"));
			const touch = (narratorId: string, at: number) =>
				noteOutlineFileChange({
					narratorId,
					projectId: p.projectId,
					cwd: repo,
					filePaths: [join(repo, "auth/refresh.ts")],
					backend: localBackend,
					locale: "zh-CN",
					hint: false,
					now: at,
				});
			await touch(p.a, p.t.base);
			await touch(p.b, p.t.base + 5000);
			const look = await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: p.t.look });
			expect(look?.content.split("\n").slice(1)).toEqual([
				`- 文件：会话「B」的 [[${theirs?.address}|T12 改登录页]] 也在改你改过的 \`auth/refresh.ts\``,
			]);
			expect(look?.body).toMatchObject({
				items: [
					{
						title: "T12 改登录页",
						by: "B",
						changes: [{ kind: "overlap", path: "auth/refresh.ts" }],
					},
				],
			});
			// Told from the last look on: not again.
			expect(
				await readOutlineTeamActivity(p.a, { locale: "zh-CN", now: p.t.look + 1000 }),
			).toBeNull();
		},
	},
	{
		name: "big commits early in the window: what comes after them is still told, in this look or the next",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			/** A person pastes a page of notes: one commit of 181 blocks, on a page of its own. */
			const paste = async (k: number) =>
				await write(
					p.space.id,
					human(p.alice.id),
					[
						{ op: "insert", tempId: "p", parent: null, content: `Notes ${k}` },
						...Array.from(
							{ length: 180 },
							(_, i): OutlineOp => ({
								op: "insert",
								parent: { tempId: "p" },
								content: `line ${k}-${i}`,
							}),
						),
					],
					p.t.next(),
				);
			const tick = async (status: "done" | "todo") =>
				await write(
					p.space.id,
					agent(p.b, p.alice.id),
					[{ op: "setTask", block: { id: p.refresh.blockId }, task: { status } }],
					p.t.next(),
				);
			// Two of them, then B ticks A's task: the look reads on past them.
			await paste(0);
			await paste(1);
			await tick("done");
			const first = await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look });
			expect(first?.content.split("\n").slice(1)).toEqual([
				`- Under ${link(p.root, "auth 模块稳定")}: session "B" ticked ${link(p.refresh, "改刷新逻辑")} done`,
			]);
			// Five more, then B reopens it: this look runs out of reads first and says nothing yet;
			// the next one goes on where it stopped, and tells it. Nothing is counted as left out.
			for (let k = 2; k < 7; k++) await paste(k);
			await tick("todo");
			expect(
				await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look + 60_000 }),
			).toBeNull();
			const next = await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look + 120_000 });
			expect(next?.content.split("\n").slice(1)).toEqual([
				`- Under ${link(p.root, "auth 模块稳定")}: session "B" reopened ${link(p.refresh, "改刷新逻辑")}`,
			]);
			expect(
				await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look + 180_000 }),
			).toBeNull();
		},
	},
	{
		name: "a person's commit made for the session is the person's, and told",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			// A person ticks a task of A's tree in a commit made for A (as locking a plan for it is).
			await writeOutline(
				{
					spaceId: p.space.id,
					ops: [{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "done" } }],
					actor: { kind: "human", id: p.alice.id },
					narratorId: p.a,
					responsibleUserId: p.alice.id,
				},
				{ now: () => p.t.next() },
			);
			const look = await readOutlineTeamActivity(p.a, { locale: "en", now: p.t.look });
			expect(look?.content.split("\n").slice(1)).toEqual([
				`- Under ${link(p.root, "auth 模块稳定")}: ${p.alice.username} ticked ${link(p.refresh, "改刷新逻辑")} done`,
			]);
		},
	},
	{
		name: "nothing for a spec session, a subagent, or a session without anything around it",
		async run(ctx) {
			resetOutlineTeamActivityForTests();
			const p = await project(ctx);
			const spec = await ctx.session(p.alice.id, p.projectId, {
				title: "spec",
				createdAt: p.t.iso(-3 * 60 * 60_000),
				backend: "spec",
			});
			const helper = await ctx.subagent(p.a, p.alice.id, p.projectId);
			await write(
				p.space.id,
				agent(p.b, p.alice.id),
				[{ op: "setTask", block: { id: p.refresh.blockId }, task: { status: "done" } }],
				p.t.next(),
			);
			expect(await readOutlineTeamActivity(spec, { locale: "en", now: p.t.look })).toBeNull();
			expect(await readOutlineTeamActivity(helper, { locale: "en", now: p.t.look })).toBeNull();
			// C relates to nothing B did (its tree is A's, not on the task page).
			expect(await readOutlineTeamActivity(p.c, { locale: "en", now: p.t.look })).toBeNull();
		},
	},
];

/** The page a written block is on. */
async function pageOf(block: OutlineOpResult): Promise<{ id: string }> {
	const { outlineStore } = await import("../store");
	const [meta] = await outlineStore.getBlockMetasByIds([block.blockId]);
	if (!meta) throw new Error("no block");
	return { id: meta.pageId };
}
