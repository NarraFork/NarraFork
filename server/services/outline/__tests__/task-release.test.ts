/**
 * What a session's claims become when a run of it ends (outline P2 PR 10c-2, D54; `release.ts`,
 * `handoff.ts`), against the real store and write path:
 *
 *   - which tasks are kept, kept for an hour, or given back at once (the table in `release.ts`),
 *     and that tasks above one another are decided together;
 *   - the handoff: one per claim generation, under the topmost task, in the owner's language,
 *     with the session's notes, the steps done, a directory inside the project only, and the
 *     session's last reply only for a session the project can read;
 *   - the claim: released, its generation kept, the next claim one more;
 *   - retries, a run that started meanwhile, a restart before the hour is over (the expiry job);
 *   - a session with no claims costs one read; a store where sessions do not run does nothing new.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own project.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, projects, userPreferences, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import {
	handoffBlockId,
	handoffOps,
	isHandoffBlockId,
	OUTLINE_HANDOFF_ACTOR,
	OUTLINE_HANDOFF_LIMITS,
} from "../handoff";
import { keepOutlineTaskLeases, outlineLeaseKeepersOf } from "../lease-keeper";
import {
	OUTLINE_TASK_GRACE_LEASE_MS,
	OUTLINE_TASK_IDLE_LEASE_MS,
	OUTLINE_TASK_LEASE,
} from "../model";
import { loadBodies, readSubtree } from "../read";
import { settleOutlineTaskClaimsAtRunEnd } from "../release";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import type { OutlineStore } from "../store/port";
import { sqliteOutlineStore as store } from "../store/sqlite-store";
import {
	expireOutlineTaskLeases,
	OUTLINE_LEASE_ACTOR,
	resetOutlineLeaseExpiryBackoffForTests,
} from "../tasks";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-11T08:12:00.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) + ms);
const enabled = settings.outline.enabled;

beforeEach(() => {
	settings.outline.enabled = true;
});
afterEach(() => {
	settings.outline.enabled = enabled;
});

async function person(language?: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `u${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	if (language)
		await db
			.insert(userPreferences)
			.values({ id: generateId(), userId: id, language, createdAt: NOW, updatedAt: NOW } as never);
	return id;
}

async function project(owner: string, gitPath = "/srv/project") {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `P ${id.slice(0, 6)}`,
		gitPath,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { id, space: await ensureProjectSpace(id) };
}

async function session(
	owner: string,
	projectId: string,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "Refresh work",
		ownerUserId: owner,
		contextProjectId: projectId,
		visibility: "project",
		taskBackend: "outline",
		cwd: "/srv/project",
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

const subagentOf = (root: string, owner: string, projectId: string) =>
	session(owner, projectId, { type: "subagent", aclRootNarratorId: root, title: "helper" });

async function human(spaceId: string, userId: string, ops: OutlineOp[]) {
	return await writeOutline(
		{ spaceId, ops, actor: { kind: "human", id: userId }, responsibleUserId: userId },
		{ store },
	);
}

async function agent(spaceId: string, narratorId: string, ops: OutlineOp[], when = at(1000)) {
	return await writeOutline(
		{
			spaceId,
			ops,
			actor: { kind: "agent", id: narratorId },
			narratorId,
			responsibleUserId: null,
		},
		{ store, now: () => when },
	);
}

/** A task page with tasks under it (`steps` under the first), all to do. */
async function tasks(spaceId: string, userId: string, titles: string[], steps: string[] = []) {
	const written = await human(spaceId, userId, [
		{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
		...titles.map(
			(content, index): OutlineOp => ({
				op: "insert",
				tempId: `t${index}`,
				parent: { tempId: "p" },
				content,
				task: { status: "todo" },
			}),
		),
		...steps.map(
			(content): OutlineOp => ({
				op: "insert",
				parent: { tempId: "t0" },
				content,
				task: { status: "todo" },
			}),
		),
	]);
	const ids = written.results.slice(1).map((r) => (r as { blockId: string }).blockId);
	return { tasks: ids.slice(0, titles.length), steps: ids.slice(titles.length) };
}

const start = (spaceId: string, narratorId: string, ids: string[]) =>
	agent(
		spaceId,
		narratorId,
		ids.map((id): OutlineOp => ({ op: "setTask", block: { id }, task: { status: "doing" } })),
		at(0),
	);

async function stateOf(taskId: string) {
	const block = await store.getBlock(taskId);
	const [claim] = await store.getTaskClaims([taskId]);
	return {
		status: block?.taskJson?.status,
		assignee: block?.taskJson?.assignee ?? null,
		holder: claim?.holderNarratorId ?? null,
		lastHolder: claim?.lastHolderNarratorId ?? null,
		epoch: claim?.epoch ?? 0,
		expiresAt: claim?.expiresAt ?? null,
	};
}

async function handoffsUnder(taskId: string) {
	const subtree = await readSubtree(taskId, { store });
	const blocks = (subtree?.root.children ?? []).filter((child) => isHandoffBlockId(child.id));
	if (subtree)
		await loadBodies(subtree.state, [...blocks, ...blocks.flatMap((b) => b.children)], { store });
	return blocks.map((block) => ({
		id: block.id,
		text: block.content ?? "",
		lines: block.children.map((line) => line.content ?? ""),
	}));
}

const settle = (
	narratorId: string,
	natural: boolean,
	options: Parameters<typeof settleOutlineTaskClaimsAtRunEnd>[2] & { reply?: string } = {},
) =>
	settleOutlineTaskClaimsAtRunEnd(
		narratorId,
		{ natural, reply: options.reply ?? null },
		{ store, now: at(60_000), ...options },
	);

const leaseEnd = (ms: number) => at(60_000 + ms).toISOString();

describe("which tasks a run's end gives back", () => {
	test("a system run that ended by itself: the unfinished project task goes back to do at once, with a handoff; the session's own task stays", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const own = await ensureSessionSpace(s);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const mine = await tasks(own.id, alice, ["My own plan"]);
		await start(p.space.id, s, team.tasks);
		await start(own.id, s, mine.tasks);

		expect(await settle(s, true)).toEqual({ kept: 1, grace: 0, released: 1 });

		const [task] = team.tasks as [string];
		expect(await stateOf(task)).toMatchObject({
			status: "todo",
			holder: null,
			lastHolder: s,
			epoch: 1,
			expiresAt: null,
		});
		expect(await stateOf(mine.tasks[0] as string)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: leaseEnd(OUTLINE_TASK_IDLE_LEASE_MS),
		});
		// One atomic system commit of the named actor, for the session's owner.
		const block = await store.getBlock(task);
		const [commit] = await store.getCommitsBySeqs(p.space.id, [block?.versionSeq as number]);
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: OUTLINE_HANDOFF_ACTOR,
			responsibleUserId: alice,
		});
		expect(commit?.summary).toContain("back to do with a handoff");
		const [handoff, ...more] = await handoffsUnder(task);
		expect(more).toHaveLength(0);
		expect(handoff?.id).toBe(handoffBlockId(task, 1));
		// Nothing recorded and nothing done: the head line alone says so.
		expect(handoff?.text).toBe(
			`Handoff (generation 1 · session \`${s}\` "Refresh work" · 2026-11-11 08:13 UTC): no progress recorded; back to do`,
		);
		expect(handoff?.lines).toEqual([]);
	});

	test("a person's run, a stopped run, a failed run (not natural): kept for an hour, then the expiry job gives it back with the same block", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, s, team.tasks);

		expect(await settle(s, false)).toEqual({ kept: 0, grace: 1, released: 0 });
		expect(await stateOf(task)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: leaseEnd(OUTLINE_TASK_GRACE_LEASE_MS),
		});
		expect(await handoffsUnder(task)).toHaveLength(0);

		// Before the hour is over nothing happens; a process restart changes nothing (the lease is
		// in the database, and the job reads it).
		const early = await expireOutlineTaskLeases({
			store,
			now: at(60_000 + OUTLINE_TASK_GRACE_LEASE_MS - 1),
		});
		expect(early.reopened).toBe(0);
		const late = await expireOutlineTaskLeases({
			store,
			now: at(60_000 + OUTLINE_TASK_GRACE_LEASE_MS),
		});
		expect(late.reopened).toBe(1);
		expect(await stateOf(task)).toMatchObject({ status: "todo", holder: null, epoch: 1 });
		const [handoff, ...more] = await handoffsUnder(task);
		expect(more).toHaveLength(0);
		expect(handoff?.id).toBe(handoffBlockId(task, 1));
		expect(handoff?.text).toContain("the session's lease ran out; back to do");
		const block = await store.getBlock(task);
		const [commit] = await store.getCommitsBySeqs(p.space.id, [block?.versionSeq as number]);
		expect(commit).toMatchObject({ actorKind: "system", actorId: OUTLINE_LEASE_ACTOR });
	});

	test("a task that waits for a prerequisite is left as it is, on the idle lease", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Blocked", "The prerequisite", "Free"]);
		const [blocked, prerequisite, free] = team.tasks as [string, string, string];
		const prerequisiteSid = (await store.getBlock(prerequisite))?.sid as string;
		await human(p.space.id, alice, [
			{
				op: "setTask",
				block: { id: blocked },
				task: { depends: [{ target: `${p.space.key}/${prerequisiteSid}`, label: null }] },
			},
		]);
		await start(p.space.id, s, [blocked, free]);

		expect(await settle(s, true)).toEqual({ kept: 1, grace: 0, released: 1 });
		expect(await stateOf(blocked)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: leaseEnd(OUTLINE_TASK_IDLE_LEASE_MS),
		});
		expect(await handoffsUnder(blocked)).toHaveLength(0);
		expect(await stateOf(free)).toMatchObject({ status: "todo", holder: null });
	});

	test("a task a subagent of the session is doing something under is left as it is", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const sub = await subagentOf(s, alice, p.id);
		const team = await tasks(p.space.id, alice, ["Ship it", "Unrelated"], ["Delegated step"]);
		const [ship, unrelated] = team.tasks as [string, string];
		await start(p.space.id, s, [ship, unrelated]);
		await start(p.space.id, sub, team.steps);

		expect(await settle(s, true)).toEqual({ kept: 1, grace: 0, released: 1 });
		expect(await stateOf(ship)).toMatchObject({ status: "doing", holder: s });
		expect(await stateOf(team.steps[0] as string)).toMatchObject({ status: "doing", holder: sub });
		expect(await stateOf(unrelated)).toMatchObject({ status: "todo", holder: null });
	});

	test("a subagent's run ends while its root is idle: its claims pass to the root, and the tree they are in is kept for an hour, not a day", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const sub = await subagentOf(s, alice, p.id);
		const own = await ensureSessionSpace(s);
		const team = await tasks(p.space.id, alice, ["Ship it"], ["Delegated step"]);
		const mine = await tasks(own.id, alice, ["My own plan"]);
		const [ship] = team.tasks as [string];
		const [step] = team.steps as [string];
		await start(p.space.id, s, [ship]);
		await start(own.id, s, mine.tasks);
		await start(p.space.id, sub, [step]);
		// The root's own run ended earlier: everything it holds is on the idle lease.
		await settle(s, false, { now: at(30_000) });
		expect((await stateOf(ship)).expiresAt).toBe(
			at(30_000 + OUTLINE_TASK_IDLE_LEASE_MS).toISOString(),
		);

		const result = await settle(sub, true);
		expect(result.grace).toBe(2);
		for (const id of [ship, step])
			expect(await stateOf(id)).toMatchObject({
				status: "doing",
				holder: s,
				expiresAt: leaseEnd(OUTLINE_TASK_GRACE_LEASE_MS),
			});
		// What is not of that tree keeps its lease.
		expect((await stateOf(mine.tasks[0] as string)).expiresAt).toBe(
			at(30_000 + OUTLINE_TASK_IDLE_LEASE_MS).toISOString(),
		);
		// While the root runs, nothing is shortened: its keeper renews what it now holds.
		const other = await subagentOf(s, alice, p.id);
		const more = await tasks(p.space.id, alice, ["Another"]);
		await start(p.space.id, other, more.tasks);
		await settle(other, true, { isRunning: (id) => id === s });
		expect((await stateOf(more.tasks[0] as string)).expiresAt).toBe(
			leaseEnd(OUTLINE_TASK_IDLE_LEASE_MS),
		);
	});
});

describe("tasks above one another are decided together", () => {
	test("a task and its step go back in one commit, with one handoff under the task", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Ship it"], ["Write the test", "Change the code"]);
		const [ship] = team.tasks as [string];
		const [first, second] = team.steps as [string, string];
		await start(p.space.id, s, [ship, first]);

		expect(await settle(s, true)).toEqual({ kept: 0, grace: 0, released: 2 });
		expect(await stateOf(ship)).toMatchObject({ status: "todo", holder: null, epoch: 1 });
		expect(await stateOf(first)).toMatchObject({ status: "todo", holder: null, epoch: 1 });
		expect(await stateOf(second)).toMatchObject({ status: "todo", epoch: 0 });
		expect(await handoffsUnder(ship)).toHaveLength(1);
		expect(await handoffsUnder(first)).toHaveLength(0);
		const seqs = [
			(await store.getBlock(ship))?.versionSeq as number,
			(await store.getBlock(first))?.versionSeq as number,
		];
		expect(seqs[0]).toBe(seqs[1] as number);
	});

	test("a step that waits keeps the task above it too; a task that waits keeps its step", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(
			p.space.id,
			alice,
			["Ship it", "The prerequisite", "Parent waits"],
			["Step"],
		);
		const [ship, prerequisite, waiting] = team.tasks as [string, string, string];
		const [step] = team.steps as [string];
		const child = await human(p.space.id, alice, [
			{ op: "insert", parent: { id: waiting }, content: "Its step", task: { status: "todo" } },
		]);
		const waitingStep = (child.results[0] as { blockId: string }).blockId;
		const depends = [
			{ target: `${p.space.key}/${(await store.getBlock(prerequisite))?.sid}`, label: null },
		];
		await human(p.space.id, alice, [
			{ op: "setTask", block: { id: step }, task: { depends } },
			{ op: "setTask", block: { id: waiting }, task: { depends } },
		]);
		await start(p.space.id, s, [ship, step, waiting, waitingStep]);

		expect(await settle(s, true)).toEqual({ kept: 4, grace: 0, released: 0 });
		for (const id of [ship, step, waiting, waitingStep])
			expect(await stateOf(id)).toMatchObject({
				status: "doing",
				holder: s,
				expiresAt: leaseEnd(OUTLINE_TASK_IDLE_LEASE_MS),
			});
	});
});

describe("the handoff", () => {
	test("links the session's newest notes under the task, counts the steps, names a directory inside the project, in the owner's language", async () => {
		const alice = await person("zh-CN");
		const p = await project(alice);
		const s = await session(alice, p.id, {
			title: "改刷新逻辑",
			cwd: "/srv/project/.worktrees/fix-refresh",
		});
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"], ["One", "Two", "Three"]);
		const [task] = team.tasks as [string];
		// A note written before the session held the task is not its record of this work.
		await agent(
			p.space.id,
			s,
			[{ op: "insert", parent: { id: task }, content: "Old note" }],
			at(-5000),
		);
		await start(p.space.id, s, [task]);
		const notes = await agent(p.space.id, s, [
			{ op: "insert", parent: { id: task }, content: "Refresh takes two paths [not one]" },
			{ op: "insert", parent: { id: task }, content: "Next: the concurrency test" },
			{ op: "setTask", block: { id: team.steps[0] as string }, task: { status: "done" } },
			{ op: "setTask", block: { id: team.steps[1] as string }, task: { status: "cancelled" } },
		]);
		const sids = notes.results.slice(0, 2).map((r) => (r as { sid: string }).sid);

		// A reply is passed, but the session wrote notes: they are what the handoff shows.
		await settle(s, true, { reply: "I ran out of turns." });
		const [handoff] = await handoffsUnder(task);
		expect(handoff?.text).toBe(
			`交接（第 1 代 · 会话 \`${s}\` 「改刷新逻辑」 · 2026-11-11 08:13 UTC）：没做完，已放回待办`,
		);
		expect(handoff?.lines).toHaveLength(3);
		expect(handoff?.lines[0]).toContain("会话的记录：");
		expect(handoff?.lines[0]).toContain(
			`[[${p.space.key}/${sids[0]}|Refresh takes two paths (not one)]]`,
		);
		expect(handoff?.lines[0]).toContain(`[[${p.space.key}/${sids[1]}|Next: the concurrency test]]`);
		expect(handoff?.lines[0]).not.toContain("Old note");
		// Cancelled steps are not counted.
		expect(handoff?.lines[1]).toBe("步骤：2 个里完成 1 个");
		expect(handoff?.lines[2]).toBe("工作目录：`.worktrees/fix-refresh`");
		expect(handoff?.lines.join("\n")).not.toContain("I ran out of turns");
	});

	test("the session's last reply: only with no note, only for one task, and never from a private session", async () => {
		const alice = await person();
		const p = await project(alice);
		const reply =
			"Looked at   the token store;\nthe second path is `refreshLater`. [[secret/page]]";
		const cases = [
			{ visibility: "project" as const, tasks: 1, shown: true },
			{ visibility: "public" as const, tasks: 1, shown: true },
			{ visibility: "private" as const, tasks: 1, shown: false },
			{ visibility: "project" as const, tasks: 2, shown: false },
		];
		for (const c of cases) {
			const s = await session(alice, p.id, { visibility: c.visibility });
			const team = await tasks(p.space.id, alice, ["First", "Second"].slice(0, c.tasks));
			await start(p.space.id, s, team.tasks);
			await settle(s, true, { reply });
			const text = (await handoffsUnder(team.tasks[0] as string))
				.flatMap((h) => [h.text, ...h.lines])
				.join("\n");
			expect(text.includes("token store")).toBe(c.shown);
			if (c.shown) {
				// Plain text, on one line: nothing of it is outline syntax.
				expect(text).toContain(
					"The session's last reply (excerpt): Looked at the token store; the",
				);
				expect(text).not.toMatch(/(^|[^\\])\[\[secret\/page\]\]/);
				expect(text).toContain("not finished; back to do");
			}
		}
		// A person's turn gives nothing back at once, so nothing is quoted; the expiry job, an hour
		// later, has no reply to quote.
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Talked about"]);
		await start(p.space.id, s, team.tasks);
		await settle(s, false, { reply });
		await expireOutlineTaskLeases({ store, now: at(60_000 + OUTLINE_TASK_GRACE_LEASE_MS) });
		const later = await handoffsUnder(team.tasks[0] as string);
		expect(later).toHaveLength(1);
		expect(later.flatMap((h) => [h.text, ...h.lines]).join("\n")).not.toContain("token store");
	});

	test("a directory outside the project, or the project's own, is not written; a long reply is cut", () => {
		const base = {
			taskBlockId: "task",
			epoch: 2,
			narratorId: "nrt",
			title: 'A "title" with [[link]]',
			at: new Date(NOW),
			reason: "unfinished" as const,
			locale: "en" as const,
			notes: [],
			steps: { done: 0, total: 3 },
			directory: null,
			reply: "x".repeat(5000),
		};
		const ops = handoffOps(base);
		// The head, the steps (a reply makes it more than "no progress"), the reply.
		expect(ops).toHaveLength(3);
		expect(ops[0]).toMatchObject({
			op: "insert",
			id: handoffBlockId("task", 2),
			parent: { id: "task" },
		});
		const reply = (ops[2] as { content: string }).content;
		expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(
			OUTLINE_HANDOFF_LIMITS.replyBytes + 64,
		);
		// The title is text, never a link.
		expect((ops[0] as { content: string }).content).not.toMatch(/(^|[^\\])\[\[link\]\]/);
		expect(handoffBlockId("task", 2)).not.toBe(handoffBlockId("task", 3));
		expect(isHandoffBlockId(handoffBlockId("task", 2))).toBe(true);
		expect(isHandoffBlockId("dlrpAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
	});

	test("an assignment to the session by name goes with it; any other assignment stays", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Named", "Someone else's name"]);
		const [named, other] = team.tasks as [string, string];
		await human(p.space.id, alice, [
			{ op: "setTask", block: { id: named }, task: { assignee: `agent:${s}` } },
			{ op: "setTask", block: { id: other }, task: { assignee: "agent:reviewer" } },
		]);
		await start(p.space.id, s, [named, other]);
		await settle(s, true);
		expect(await stateOf(named)).toMatchObject({ status: "todo", assignee: null });
		expect(await stateOf(other)).toMatchObject({ status: "todo", assignee: "agent:reviewer" });
	});
});

describe("generations, retries and races", () => {
	test("the generation is kept on release; the next claim is the next generation, and its release writes its own handoff", async () => {
		const alice = await person();
		const p = await project(alice);
		const first = await session(alice, p.id);
		const second = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, first, [task]);
		await settle(first, true);
		expect(await stateOf(task)).toMatchObject({ epoch: 1, holder: null });
		// Settling again (a retry) finds nothing to give back and writes nothing.
		const seq = (await store.getBlock(task))?.versionSeq;
		expect(await settle(first, true)).toEqual({ kept: 0, grace: 0, released: 0 });
		expect((await store.getBlock(task))?.versionSeq).toBe(seq as number);
		expect(await handoffsUnder(task)).toHaveLength(1);

		await start(p.space.id, second, [task]);
		expect(await stateOf(task)).toMatchObject({ epoch: 2, holder: second });
		await settle(second, true);
		const handoffs = await handoffsUnder(task);
		expect(handoffs.map((h) => h.id)).toEqual([handoffBlockId(task, 1), handoffBlockId(task, 2)]);
		expect(await stateOf(task)).toMatchObject({ epoch: 2, holder: null, lastHolder: second });
	});

	test("a run of the session that started meanwhile keeps its tasks", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, s, [task]);
		// Known before anything is written.
		expect(await settle(s, true, { isRunning: () => true })).toMatchObject({ released: 0 });
		expect(await stateOf(task)).toMatchObject({ status: "doing", holder: s });
		// It renews between the lease being cut and the reopening: the reopening is refused for it.
		let cut = false;
		const racing: OutlineStore = {
			...store,
			async updateTaskClaims(writes) {
				const written = await store.updateTaskClaims(writes);
				cut = written;
				await store.renewTaskClaims(s, at(60_000 + OUTLINE_TASK_LEASE.leaseMs).toISOString());
				return written;
			},
		};
		expect(await settle(s, true, { store: racing })).toMatchObject({ released: 0 });
		expect(cut).toBe(true);
		expect(await stateOf(task)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: at(60_000 + OUTLINE_TASK_LEASE.leaseMs).toISOString(),
		});
		expect(await handoffsUnder(task)).toHaveLength(0);
	});

	test("a process that stops after the lease was cut: the expiry job gives the task back, once", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, s, [task]);
		const crashing: OutlineStore = {
			...store,
			async applyCommit() {
				throw new Error("the process stopped");
			},
		};
		await settle(s, true, { store: crashing }).catch(() => null);
		// The process is gone, and with it what it remembered of the failure.
		resetOutlineLeaseExpiryBackoffForTests();
		expect(await stateOf(task)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: at(60_000).toISOString(),
		});
		const first = await expireOutlineTaskLeases({ store, now: at(120_000) });
		const again = await expireOutlineTaskLeases({ store, now: at(180_000) });
		expect([first.reopened, again.reopened]).toEqual([1, 0]);
		expect(await stateOf(task)).toMatchObject({ status: "todo", holder: null, epoch: 1 });
		expect(await handoffsUnder(task)).toHaveLength(1);
	});
});

describe("cost and where it does not apply", () => {
	function counting() {
		const calls: string[] = [];
		const proxy = new Proxy(store, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls.push(String(key));
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		}) as OutlineStore;
		return { calls, proxy };
	}

	test("a session that holds nothing: its session row and one read of its claims", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const { calls, proxy } = counting();
		expect(await settle(s, true, { store: proxy })).toEqual({ kept: 0, grace: 0, released: 0 });
		expect(calls).toEqual(["getNarratorRoots", "listClaimedTasks"]);
	});

	test("a session that holds only its own tasks: one statement puts them on the idle lease, as before", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const own = await ensureSessionSpace(s);
		const mine = await tasks(own.id, alice, ["My own plan"]);
		await start(own.id, s, mine.tasks);
		const { calls, proxy } = counting();
		expect(await settle(s, true, { store: proxy })).toEqual({ kept: 1, grace: 0, released: 0 });
		expect(calls).toEqual(["getNarratorRoots", "listClaimedTasks", "getSpace", "renewTaskClaims"]);
	});

	test("through the keeper: a stop without a word on how the run ended gives nothing back at once; with the outline off it reads nothing", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, s, [task]);
		const clock = () => Date.parse(NOW) + 60_000;
		const keeper = keepOutlineTaskLeases(s, { store, now: clock, intervalMs: 0 });
		await keeper.stop();
		expect(outlineLeaseKeepersOf(s)).toBe(0);
		expect(await stateOf(task)).toMatchObject({
			status: "doing",
			holder: s,
			expiresAt: leaseEnd(OUTLINE_TASK_GRACE_LEASE_MS),
		});
		// A person's message waiting to start the next run: not given back either.
		const waiting = keepOutlineTaskLeases(s, { store, now: clock, intervalMs: 0 });
		await waiting.stop({ natural: true, pendingInput: async () => true });
		expect(await stateOf(task)).toMatchObject({ status: "doing", holder: s });
		// A natural end, nothing waiting: given back.
		const natural = keepOutlineTaskLeases(s, { store, now: clock, intervalMs: 0 });
		await natural.stop({ natural: true, pendingInput: async () => false });
		expect(await stateOf(task)).toMatchObject({ status: "todo", holder: null });

		const { calls, proxy } = counting();
		const off = keepOutlineTaskLeases(s, { store: proxy, enabled: () => false, intervalMs: 0 });
		await off.stop({ natural: true });
		expect(calls).toEqual([]);
	});

	test("an archived session lets go of everything, as before: no handoff is written for it here", async () => {
		const alice = await person();
		const p = await project(alice);
		const s = await session(alice, p.id);
		const team = await tasks(p.space.id, alice, ["Fix the refresh logic"]);
		const [task] = team.tasks as [string];
		await start(p.space.id, s, [task]);
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, s));
		await settle(s, true);
		expect(await stateOf(task)).toMatchObject({ status: "todo", holder: null });
		expect(await handoffsUnder(task)).toHaveLength(0);
	});
});
