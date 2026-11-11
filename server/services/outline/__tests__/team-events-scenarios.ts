/**
 * Team events on their store (outline P2 PR 10a, design v2 §D): scenarios that run on SQLite
 * (`team-events.test.ts`) and on PostgreSQL (`tests/server/services/outline/
 * pg-outline-team-events.test.ts`), with the outline store and access executor of that database
 * injected. They cover what a commit is read as: who is told of which event (assigned to it, a
 * prerequisite ended, a task it created ended), who is not, when a row wakes and when it only
 * records, how several events of one commit become one row, and the limits. Writing the row and
 * waking go through the session runtime, which runs on SQLite only, and are tested in the test
 * file (with the PostgreSQL branch of the delivery).
 */
import { expect } from "bun:test";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineTaskFinishedMessageId } from "../task-finished";
import {
	OUTLINE_TEAM_EVENT_LIMITS,
	OUTLINE_TEAM_SOURCE,
	type OutlineTeamMessage,
	outlineTeamMessageId,
	readOutlineTeamMessages,
} from "../team-events";
import { type OutlineOp, type OutlineOpResult, writeOutline } from "../write";

export interface TeamEventsContext {
	/** A person; their username starts with `name`. */
	person(name: string): Promise<{ id: string; username: string }>;
	project(owner: string): Promise<string>;
	/** A root outline session of `owner` in `projectId`. */
	session(
		owner: string,
		projectId: string | null,
		options: {
			title: string;
			handle?: string;
			backend?: "spec" | "outline";
			archived?: boolean;
		},
	): Promise<string>;
	subagent(root: string, owner: string, projectId: string | null): Promise<string>;
}

export interface TeamEventsScenario {
	name: string;
	run(ctx: TeamEventsContext): Promise<void>;
}

type Who = { kind: "agent" | "human"; id: string; owner: string };
const agent = (id: string, owner: string): Who => ({ kind: "agent", id, owner });
const human = (id: string): Who => ({ kind: "human", id, owner: id });

interface Written {
	results: OutlineOpResult[];
	event: {
		spaceId: string;
		commitId: string;
		seq: number;
		actorKind: "agent" | "human";
		actorId: string;
	};
}

async function write(spaceId: string, who: Who, ops: OutlineOp[]): Promise<Written> {
	const result = await writeOutline({
		spaceId,
		ops,
		actor: { kind: who.kind, id: who.id },
		responsibleUserId: who.owner,
		...(who.kind === "agent" ? { narratorId: who.id } : {}),
	});
	if (!result.commit) throw new Error("nothing committed");
	return {
		results: result.results,
		event: {
			spaceId,
			commitId: result.commit.id,
			seq: result.commit.seq,
			actorKind: who.kind,
			actorId: who.id,
		},
	};
}

/** Tasks under a new page of the space, in order. */
async function tasks(
	spaceId: string,
	who: Who,
	items: ReadonlyArray<{
		title: string;
		status?: "todo" | "doing";
		assignee?: string;
		depends?: string[];
		alias?: string;
	}>,
): Promise<{ written: Written; tasks: OutlineOpResult[] }> {
	const written = await write(spaceId, who, [
		{ op: "insert", tempId: "page", parent: null, content: "Work" },
		...items.map(
			(item): OutlineOp => ({
				op: "insert",
				parent: { tempId: "page" },
				content: item.title,
				...(item.alias ? { alias: item.alias } : {}),
				task: {
					status: item.status ?? "todo",
					...(item.assignee ? { assignee: item.assignee } : {}),
					...(item.depends
						? { depends: item.depends.map((target) => ({ target, label: null })) }
						: {}),
				},
			}),
		),
	]);
	return { written, tasks: written.results.slice(1) };
}

const setTask = (id: string, task: Record<string, unknown>): OutlineOp => ({
	op: "setTask",
	block: { id },
	task: task as never,
});

const read = (written: Written): Promise<OutlineTeamMessage[]> =>
	readOutlineTeamMessages(written.event);

/** A project with its space, its owner, and sessions of it. */
async function team(ctx: TeamEventsContext, titles: readonly string[]) {
	const owner = await ctx.person("lead");
	const projectId = await ctx.project(owner.id);
	const space = await ensureProjectSpace(projectId);
	const sessions: string[] = [];
	for (const title of titles) sessions.push(await ctx.session(owner.id, projectId, { title }));
	return { owner, projectId, space, sessions };
}

export const OUTLINE_TEAM_EVENTS_SCENARIOS: TeamEventsScenario[] = [
	{
		name: "assigned by id by another session: one row that wakes, in its words and on its card",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Planner", "Worker"]);
			const [planner, worker] = sessions as [string, string];
			const seeded = await tasks(space.id, agent(planner, owner.id), [
				{ title: "Fix the refresh race" },
			]);
			const task = seeded.tasks[0] as OutlineOpResult;
			// Creating it unassigned concerns nobody.
			expect(await read(seeded.written)).toEqual([]);
			const assigned = await write(space.id, agent(planner, owner.id), [
				setTask(task.blockId, { assignee: `agent:${worker}` }),
			]);
			const [message, ...rest] = await read(assigned);
			expect(rest).toEqual([]);
			expect(message).toMatchObject({
				narratorId: worker,
				messageId: outlineTeamMessageId(assigned.event, worker),
				source: OUTLINE_TEAM_SOURCE,
				locale: "en",
				wake: true,
				taskIds: [task.blockId],
				assigned: [task.blockId],
			});
			expect(message?.content).toBe(
				`System notice (not the user speaking): tasks in the outline that concern this session changed.\n\nAssigned to this session by session "Planner" (not started; set one in progress when you take it up):\n- \`${task.address}\` Fix the refresh race\n\nRead the tasks with OutlineRead before acting on them: what they are now decides.`,
			);
			expect(message?.body).toEqual({
				kind: "outlineTasks",
				variant: "team",
				items: [
					{
						address: task.address,
						title: "Fix the refresh race",
						by: "Planner",
						changes: [{ kind: "assignedHere" }],
					},
				],
			});
			// The same commit read again makes the same row (a retry, the re-push after a start).
			expect((await read(assigned))[0]?.messageId).toBe(message?.messageId);
		},
	},
	{
		name: "assigned by handle, and created with the assignee",
		async run(ctx) {
			const owner = await ctx.person("lead");
			const projectId = await ctx.project(owner.id);
			const space = await ensureProjectSpace(projectId);
			const planner = await ctx.session(owner.id, projectId, { title: "Planner" });
			const handle = `Rev${Math.random().toString(36).slice(2, 8)}`;
			const named = await ctx.session(owner.id, projectId, { title: "Reviewer", handle });
			// A different case of the handle names the same session.
			const seeded = await tasks(space.id, agent(planner, owner.id), [
				{ title: "Review the patch", assignee: `agent:${handle.toUpperCase()}` },
			]);
			const [message, ...rest] = await read(seeded.written);
			expect(rest).toEqual([]);
			expect(message).toMatchObject({ narratorId: named, wake: true, source: OUTLINE_TEAM_SOURCE });
			expect(message?.assigned).toEqual([(seeded.tasks[0] as OutlineOpResult).blockId]);
		},
	},
	{
		name: "assigned: nobody is told of a name no session has, a subagent, itself, an unchanged assignee, an archived or a Dynamic Spec session, or the pool",
		async run(ctx) {
			const owner = await ctx.person("lead");
			const projectId = await ctx.project(owner.id);
			const space = await ensureProjectSpace(projectId);
			const planner = await ctx.session(owner.id, projectId, { title: "Planner" });
			const worker = await ctx.session(owner.id, projectId, { title: "Worker" });
			const helper = await ctx.subagent(worker, owner.id, projectId);
			const gone = await ctx.session(owner.id, projectId, { title: "Gone", archived: true });
			const spec = await ctx.session(owner.id, projectId, { title: "Spec", backend: "spec" });
			const by = agent(planner, owner.id);
			for (const assignee of [
				"agent:w-auth",
				`agent:${helper}`,
				`agent:${planner}`,
				`agent:${gone}`,
				`agent:${spec}`,
				"human:someone",
			]) {
				const seeded = await tasks(space.id, by, [{ title: `For ${assignee}`, assignee }]);
				expect(await read(seeded.written)).toEqual([]);
			}
			// The planner's subagent assigning to the planner's session: its own session.
			const sub = await ctx.subagent(planner, owner.id, projectId);
			const own = await tasks(space.id, agent(sub, owner.id), [
				{ title: "Back to my root", assignee: `agent:${planner}` },
			]);
			expect(await read(own.written)).toEqual([]);
			// The assignee stays: a status change, a claimable mark or new text assigns nothing.
			const kept = await tasks(space.id, by, [{ title: "Kept", assignee: `agent:${worker}` }]);
			const task = kept.tasks[0] as OutlineOpResult;
			expect(await read(kept.written)).toHaveLength(1);
			const started = await write(space.id, by, [setTask(task.blockId, { claimable: true })]);
			expect(await read(started)).toEqual([]);
			// A task put in the pool (claimable, nobody named) wakes nobody: D54.
			const pool = await tasks(space.id, by, [{ title: "Anyone" }]);
			const pooled = await write(space.id, by, [
				setTask((pool.tasks[0] as OutlineOpResult).blockId, { claimable: true }),
			]);
			expect(await read(pooled)).toEqual([]);
			// A finished task handed on tells nobody.
			const done = await write(space.id, by, [setTask(task.blockId, { status: "done" })]);
			expect((await read(done)).filter((m) => m.assigned?.length)).toEqual([]);
		},
	},
	{
		name: "a person assigns: the row is written for the next turn and wakes nobody",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Worker"]);
			const [worker] = sessions as [string];
			const seeded = await tasks(space.id, human(owner.id), [
				{ title: "Check the logs", assignee: `agent:${worker}` },
			]);
			const [message, ...rest] = await read(seeded.written);
			expect(rest).toEqual([]);
			expect(message).toMatchObject({
				narratorId: worker,
				wake: false,
				source: OUTLINE_TEAM_SOURCE,
			});
			// Named by username, in no language, on the card and in the text.
			expect(message?.content).toContain(`Assigned to this session by ${owner.username} (`);
			expect(message?.body).toMatchObject({ items: [{ by: owner.username }] });
		},
	},
	{
		name: "a prerequisite ended: the session whose task waited is told and woken once it waits for nothing",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Planner", "Worker", "Doer"]);
			const [planner, worker, doer] = sessions as [string, string, string];
			const seeded = await tasks(space.id, agent(doer, owner.id), [
				{ title: "Ship the API", status: "doing" },
				{ title: "Write the schema", status: "doing" },
			]);
			const [api, schema] = seeded.tasks as [OutlineOpResult, OutlineOpResult];
			// The planner's own tasks, in its session space, wait on them.
			const own = await ensureSessionSpace(planner);
			const waiting = await tasks(own.id, agent(planner, owner.id), [
				{ title: "Announce the API", depends: [api.address] },
				{ title: "Write the client", depends: [api.address, schema.address] },
			]);
			const [announce, client] = waiting.tasks as [OutlineOpResult, OutlineOpResult];
			const done = await write(space.id, agent(doer, owner.id), [
				setTask(api.blockId, { status: "done" }),
			]);
			const messages = await read(done);
			// The planner's tasks; and the planner did not create the prerequisite (the doer did).
			expect(messages.map((m) => m.narratorId)).toEqual([planner]);
			const [message] = messages;
			expect(message).toMatchObject({ source: OUTLINE_TEAM_SOURCE, wake: true });
			expect(message?.content).toBe(
				`System notice (not the user speaking): tasks in the outline that concern this session changed.\n\nPrerequisites of this session's tasks were ended by session "Doer":\n- \`${announce.address}\` Announce the API: its prerequisite \`${api.address}\` Ship the API was ticked done; it no longer waits\n- \`${client.address}\` Write the client: its prerequisite \`${api.address}\` Ship the API was ticked done; it still waits for something else\n\nRead the tasks with OutlineRead before acting on them: what they are now decides.`,
			);
			expect(message?.body).toEqual({
				kind: "outlineTasks",
				variant: "team",
				items: [
					{
						address: announce.address,
						title: "Announce the API",
						by: "Doer",
						changes: [{ kind: "unblocked", by: "done" }],
					},
					{
						address: client.address,
						title: "Write the client",
						by: "Doer",
						waiting: true,
						changes: [{ kind: "unblocked", by: "done", still: true }],
					},
				],
			});
			// The last prerequisite cancelled: only the task that still waited is told of it.
			const cancelled = await write(space.id, agent(doer, owner.id), [
				setTask(schema.blockId, { status: "cancelled" }),
			]);
			const [second, ...rest] = await read(cancelled);
			expect(rest).toEqual([]);
			expect(second).toMatchObject({ narratorId: planner, wake: true });
			expect(second?.content).toContain(
				`- \`${client.address}\` Write the client: its prerequisite \`${schema.address}\` Write the schema was cancelled; check whether this task is still needed; it no longer waits`,
			);
			expect(second?.content).not.toContain("Announce the API");
			// The worker has nothing to do with any of it.
			expect([...messages, second].some((m) => m?.narratorId === worker)).toBe(false);
		},
	},
	{
		name: "a prerequisite ended while the task still waits, or by a person: recorded, nobody woken",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Planner", "Doer"]);
			const [planner, doer] = sessions as [string, string];
			const seeded = await tasks(space.id, agent(doer, owner.id), [
				{ title: "First", status: "doing" },
				{ title: "Second", status: "doing" },
				{ title: "Third", status: "doing" },
			]);
			const [first, second, third] = seeded.tasks as [
				OutlineOpResult,
				OutlineOpResult,
				OutlineOpResult,
			];
			const own = await ensureSessionSpace(planner);
			const waiting = await tasks(own.id, agent(planner, owner.id), [
				{ title: "After both", depends: [first.address, second.address] },
				{ title: "After the third", depends: [third.address] },
			]);
			expect(waiting.tasks).toHaveLength(2);
			const one = await write(space.id, agent(doer, owner.id), [
				setTask(first.blockId, { status: "done" }),
			]);
			expect(await read(one)).toMatchObject([{ narratorId: planner, wake: false }]);
			// A person ends a prerequisite: the task no longer waits, and still nobody is woken.
			const byPerson = await write(space.id, human(owner.id), [
				setTask(third.blockId, { status: "done" }),
			]);
			const [message] = await read(byPerson);
			expect(message).toMatchObject({ narratorId: planner, wake: false });
			expect(message?.content).toContain("it no longer waits");
			expect(message?.content).toContain(`ended by ${owner.username}:`);
		},
	},
	{
		name: "a prerequisite ended: who does the dependent task (its holder, its session space, its assignee), and when nobody does",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Doer", "Holder", "Named", "Other"]);
			const [doer, holder, named] = sessions as [string, string, string, string];
			const seeded = await tasks(space.id, agent(doer, owner.id), [
				{ title: "The base", status: "doing", alias: "base-task" },
			]);
			const base = seeded.tasks[0] as OutlineOpResult;
			const aliasAddress = `${base.address.split("/")[0]}/base-task`;
			// In the project space: one a session holds, one assigned by name, one nobody does, one
			// a person is assigned, one written with the alias.
			const dependents = await tasks(space.id, agent(holder, owner.id), [
				{ title: "Held", status: "doing", depends: [base.address] },
				{ title: "Named", assignee: `agent:${named}`, depends: [base.address] },
				{ title: "Nobody's", depends: [base.address] },
				{ title: "A person's", assignee: "human:pat", depends: [base.address] },
				{ title: "By alias", status: "doing", depends: [aliasAddress] },
				{ title: "By bare alias", status: "doing", depends: ["base-task"] },
			]);
			expect(dependents.tasks).toHaveLength(6);
			// In a session's own space, one its person is doing themselves: theirs, not the session's.
			const namedSpace = await ensureSessionSpace(named);
			await tasks(namedSpace.id, human(owner.id), [
				{ title: "The person does this one", status: "doing", depends: [base.address] },
			]);
			const done = await write(space.id, agent(doer, owner.id), [
				setTask(base.blockId, { status: "done" }),
			]);
			const messages = await read(done);
			expect(messages.map((m) => m.narratorId).sort()).toEqual([holder, named].sort());
			const held = messages.find((m) => m.narratorId === holder);
			expect(held?.content).toContain("Held:");
			expect(held?.content).toContain("By alias:");
			expect(held?.content).toContain("By bare alias:");
			expect(held?.content).not.toContain("Nobody's");
			expect(held?.content).not.toContain("A person's");
			expect(messages.find((m) => m.narratorId === named)?.content).toContain("Named:");
			expect(messages.find((m) => m.narratorId === named)?.content).not.toContain(
				"The person does this one",
			);
			// The session that ends its own prerequisite is told nothing.
			const own = await tasks(space.id, agent(doer, owner.id), [
				{ title: "Mine first", status: "doing" },
			]);
			const mine = own.tasks[0] as OutlineOpResult;
			await tasks(space.id, agent(doer, owner.id), [
				{ title: "Mine after", status: "doing", depends: [mine.address] },
			]);
			const finished = await write(space.id, agent(doer, owner.id), [
				setTask(mine.blockId, { status: "done" }),
			]);
			expect(await read(finished)).toEqual([]);
		},
	},
	{
		name: "a prerequisite ended: a session named on a task in a space it may not read is told nothing",
		async run(ctx) {
			// A private project of one person; a session of someone else, elsewhere.
			const insiderOwner = await ctx.person("pat");
			const outsiderOwner = await ctx.person("uma");
			const secret = await ctx.project(insiderOwner.id);
			const elsewhere = await ctx.project(outsiderOwner.id);
			const space = await ensureProjectSpace(secret);
			const outsider = await ctx.session(outsiderOwner.id, elsewhere, { title: "Outsider" });
			const insider = await ctx.session(insiderOwner.id, secret, { title: "Insider" });
			const seeded = await tasks(space.id, human(insiderOwner.id), [{ title: "Base" }]);
			const base = seeded.tasks[0] as OutlineOpResult;
			// The person types the outsider's id on a task that waits for Base (the editor
			// checks no assignee).
			const named = await tasks(space.id, human(insiderOwner.id), [
				{
					title: "Secret plan title",
					assignee: `agent:${outsider}`,
					depends: [base.address],
				},
			]);
			// Not told of the assignment, and not of the prerequisite ending: neither row may
			// carry the task's title to a session that cannot read it.
			expect(await read(named.written)).toEqual([]);
			const done = await write(space.id, agent(insider, insiderOwner.id), [
				setTask(base.blockId, { status: "done" }),
			]);
			expect((await read(done)).filter((m) => m.narratorId === outsider)).toEqual([]);
		},
	},
	{
		name: "a task that came to depend on an ended task afterwards is not told of the old commit",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Planner", "Doer"]);
			const [planner, doer] = sessions as [string, string];
			const seeded = await tasks(space.id, agent(doer, owner.id), [
				{ title: "Done early", status: "doing" },
			]);
			const early = seeded.tasks[0] as OutlineOpResult;
			const done = await write(space.id, agent(doer, owner.id), [
				setTask(early.blockId, { status: "done" }),
			]);
			expect(await read(done)).toEqual([]);
			// Later: tasks of the planner name the ended task as a prerequisite, in the same space
			// and in its own.
			await tasks(space.id, agent(planner, owner.id), [
				{ title: "Written later here", status: "doing", depends: [early.address] },
			]);
			const own = await ensureSessionSpace(planner);
			await tasks(own.id, agent(planner, owner.id), [
				{ title: "Written later in its own space", depends: [early.address] },
			]);
			// The old commit read again (the re-push after a start) still concerns nobody.
			expect(await read(done)).toEqual([]);
		},
	},
	{
		name: "one commit that concerns a session in three ways is one row; another session it only finished tasks of is told as before",
		async run(ctx) {
			const { owner, space, sessions } = await team(ctx, ["Planner", "Doer", "Creator"]);
			const [planner, doer, creator] = sessions as [string, string, string];
			// The planner created two tasks the doer works on; the creator one more.
			const created = await tasks(space.id, agent(planner, owner.id), [
				{ title: "Build it" },
				{ title: "Test it" },
			]);
			const [build, test] = created.tasks as [OutlineOpResult, OutlineOpResult];
			const other = await tasks(space.id, agent(creator, owner.id), [{ title: "Document it" }]);
			const document = other.tasks[0] as OutlineOpResult;
			const own = await ensureSessionSpace(planner);
			const waiting = await tasks(own.id, agent(planner, owner.id), [
				{ title: "Release it", depends: [build.address] },
			]);
			const release = waiting.tasks[0] as OutlineOpResult;
			// One commit of the doer: finishes Build (a prerequisite, and a task the planner
			// created), hands Test to the planner, finishes Document (the creator's).
			const commit = await write(space.id, agent(doer, owner.id), [
				setTask(build.blockId, { status: "done" }),
				setTask(test.blockId, { assignee: `agent:${planner}` }),
				setTask(document.blockId, { status: "cancelled" }),
			]);
			const messages = await read(commit);
			expect(messages.map((m) => m.narratorId).sort()).toEqual([planner, creator].sort());
			const merged = messages.find((m) => m.narratorId === planner);
			expect(merged).toMatchObject({
				source: OUTLINE_TEAM_SOURCE,
				messageId: outlineTeamMessageId(commit.event, planner),
				wake: true,
				assigned: [test.blockId],
			});
			expect(new Set(merged?.taskIds)).toEqual(
				new Set([test.blockId, release.blockId, build.blockId]),
			);
			expect(merged?.content).toBe(
				`System notice (not the user speaking): tasks in the outline that concern this session changed.\n\nAssigned to this session by session "Doer" (not started; set one in progress when you take it up):\n- \`${test.address}\` Test it\n\nPrerequisites of this session's tasks were ended by session "Doer":\n- \`${release.address}\` Release it: its prerequisite \`${build.address}\` Build it was ticked done; it no longer waits\n\nTasks this session created were ended by session "Doer" (the results and any reports are under each task; reopen one that does not meet what you wanted):\n- \`${build.address}\` Build it: ticked done\n\nRead the tasks with OutlineRead before acting on them: what they are now decides.`,
			);
			expect(merged?.body).toEqual({
				kind: "outlineTasks",
				variant: "team",
				items: [
					{
						address: test.address,
						title: "Test it",
						by: "Doer",
						changes: [{ kind: "assignedHere" }],
					},
					{
						address: release.address,
						title: "Release it",
						by: "Doer",
						changes: [{ kind: "unblocked", by: "done" }],
					},
					{
						address: build.address,
						title: "Build it",
						by: "Doer",
						changes: [{ kind: "status", from: "todo", to: "done" }, { kind: "created" }],
					},
				],
			});
			// The creator: only a task it created ended. Told exactly as PR 9b told it.
			const plain = messages.find((m) => m.narratorId === creator);
			expect(plain?.source).toBeUndefined();
			expect(plain?.messageId).toBe(
				outlineTaskFinishedMessageId(commit.event, creator, [document.blockId]),
			);
			expect(plain?.body).toMatchObject({ variant: "finished" });
		},
	},
	{
		name: `limits: at most ${OUTLINE_TEAM_EVENT_LIMITS.sessionsPerCommit} sessions told and ${OUTLINE_TEAM_EVENT_LIMITS.listedPerCommit} tasks named per commit; the rest counted`,
		async run(ctx) {
			const owner = await ctx.person("lead");
			const projectId = await ctx.project(owner.id);
			const space = await ensureProjectSpace(projectId);
			const planner = await ctx.session(owner.id, projectId, { title: "Planner" });
			const many: string[] = [];
			for (let i = 0; i < OUTLINE_TEAM_EVENT_LIMITS.sessionsPerCommit + 1; i++)
				many.push(await ctx.session(owner.id, projectId, { title: `W${i}` }));
			const spread = await tasks(
				space.id,
				agent(planner, owner.id),
				many.map((id, i) => ({ title: `Task ${i}`, assignee: `agent:${id}` })),
			);
			const told = await read(spread.written);
			expect(told).toHaveLength(OUTLINE_TEAM_EVENT_LIMITS.sessionsPerCommit);
			expect(new Set(told.map((m) => m.narratorId)).size).toBe(told.length);
			// Every session told has its task named.
			for (const message of told) expect(message.content).toContain("- `");

			const worker = many[0] as string;
			const count = OUTLINE_TEAM_EVENT_LIMITS.listedPerCommit + 5;
			const pile = await tasks(
				space.id,
				agent(planner, owner.id),
				Array.from({ length: count }, (_, i) => ({
					title: `Pile ${i}`,
					assignee: `agent:${worker}`,
				})),
			);
			const [message, ...rest] = await read(pile.written);
			expect(rest).toEqual([]);
			expect(message?.taskIds).toHaveLength(count);
			expect(message?.assigned).toHaveLength(count);
			expect((message?.content.match(/^- `/gm) ?? []).length).toBe(
				OUTLINE_TEAM_EVENT_LIMITS.listedPerCommit,
			);
			expect(message?.content).toContain(
				"5 more changes of the same commit concern this session (not listed).",
			);
			expect(message?.body).toMatchObject({ more: 5 });
		},
	},
];
