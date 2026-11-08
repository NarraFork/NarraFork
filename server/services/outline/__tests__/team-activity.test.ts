/**
 * Team activity (outline P2 PR 10b, design §2.5) on SQLite: the store scenarios shared with
 * PostgreSQL (`team-activity-scenarios.ts`), then what goes through the session runtime, which
 * runs on SQLite only: the row (a `sys` injection, `outline_team_activity`, `schedule: none` at the
 * start of a run, `onNextTurn` at a tool boundary), the cadence (a run start always looks; a tool
 * boundary at most every ten minutes, reading nothing in between, writing only what is new), the
 * run start through `prepareOutlineRun`, and that none of it reaches the system prompt.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions and
 * project and starts from empty cursors.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorTurns,
	projects,
	users,
} from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { invalidateTaskBackend, taskSourceForNarrator } from "../../task-source";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineStore } from "../store/port";
import {
	OUTLINE_TEAM_ACTIVITY_LIMITS,
	OUTLINE_TEAM_ACTIVITY_SOURCE,
	type OutlineTeamActivityDelivery,
	resetOutlineTeamActivityForTests,
	setOutlineTeamActivityDelivery,
	writeOutlineTeamActivity,
} from "../team-activity";
import { writeOutline } from "../write";
import {
	OUTLINE_TEAM_ACTIVITY_SCENARIOS,
	type TeamActivityContext,
} from "./team-activity-scenarios";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	invalidateSessionReadScopes();
	resetOutlineTeamActivityForTests();
});

afterEach(() => {
	setOutlineTeamActivityDelivery(null);
});

const sqlite: TeamActivityContext = {
	async person(name) {
		const id = generateId();
		const username = `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
		await db.insert(users).values({
			id,
			username,
			passwordHash: "x",
			role: "user",
			createdAt: "2026-11-01T00:00:00.000Z",
		});
		return { id, username };
	},
	async project(owner) {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name: `team-${id}`,
			ownerUserId: owner,
			visibility: "private",
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
		});
		return id;
	},
	async session(owner, projectId, options) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title: options.title,
			ownerUserId: owner,
			taskBackend: options.backend ?? "outline",
			visibility: "private",
			contextProjectId: projectId,
			status: "idle",
			createdAt: options.createdAt,
			updatedAt: options.createdAt,
		});
		return id;
	},
	async subagent(root, owner, projectId) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			type: "subagent",
			title: "Helper",
			ownerUserId: owner,
			parentNarratorId: root,
			aclRootNarratorId: root,
			taskBackend: "outline",
			contextProjectId: projectId,
			status: "idle",
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
		});
		return id;
	},
	async finishedRun(narratorId, endedAt) {
		await db.insert(narratorTurns).values({
			id: generateId(),
			narratorId,
			status: "completed",
			startedAt: new Date(Date.parse(endedAt) - 60_000).toISOString(),
			endedAt,
		});
	},
};

describe("on SQLite", () => {
	for (const scenario of OUTLINE_TEAM_ACTIVITY_SCENARIOS)
		test(scenario.name, async () => {
			await scenario.run(sqlite);
		});
});

/** A session A whose tree another session B just changed, an hour before `look`. */
async function changed() {
	const owner = await sqlite.person("ann");
	const projectId = await sqlite.project(owner.id);
	const space = await ensureProjectSpace(projectId);
	const base = Date.now() - 30 * 60_000;
	const made = new Date(base - 3 * 60 * 60_000).toISOString();
	const a = await sqlite.session(owner.id, projectId, { title: "A", createdAt: made });
	const b = await sqlite.session(owner.id, projectId, { title: "B", createdAt: made });
	const seed = await writeOutline(
		{
			spaceId: space.id,
			actor: { kind: "agent", id: a },
			narratorId: a,
			responsibleUserId: owner.id,
			ops: [
				{ op: "insert", tempId: "page", parent: null, content: "Work" },
				{ op: "insert", parent: { tempId: "page" }, content: "Ship it", task: { status: "doing" } },
			],
		},
		{ now: () => new Date(base - 2.5 * 60 * 60_000) },
	);
	const task = seed.results[1];
	if (!task) throw new Error("seed");
	const tick = async (status: "done" | "todo", at: number) =>
		await writeOutline(
			{
				spaceId: space.id,
				actor: { kind: "agent", id: b },
				narratorId: b,
				responsibleUserId: owner.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status } }],
			},
			{ now: () => new Date(at) },
		);
	await tick("done", base);
	return { owner, space, a, b, task, tick, base };
}

/** Capture rows instead of writing them. */
function capture() {
	const rows: Array<{
		narratorId: string;
		row: Parameters<OutlineTeamActivityDelivery["deliver"]>[1];
	}> = [];
	setOutlineTeamActivityDelivery({
		async deliver(narratorId, row) {
			rows.push({ narratorId, row });
			return {
				messageId: `m${rows.length}`,
				turnText: row.schedule === "onNextTurn" ? row.content : null,
			};
		},
	});
	return rows;
}

/** A store that counts its reads (the cadence reads nothing between looks). */
function counting(store: OutlineStore): { store: OutlineStore; reads: () => number } {
	let reads = 0;
	const wrapped = new Proxy(store, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				reads++;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { store: wrapped, reads: () => reads };
}

describe("the row and its cadence", () => {
	test("a run start writes a sys row read by this run's history; a tool boundary looks again only after ten minutes, and writes only what is new", async () => {
		const s = await changed();
		const rows = capture();
		const counted = counting(outlineStore);
		const now = s.base + 60_000;
		const start = await writeOutlineTeamActivity(s.a, "en", "start", { now, store: counted.store });
		expect(start).toEqual({ messageId: "m1", turnText: null });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.row).toMatchObject({
			source: OUTLINE_TEAM_ACTIVITY_SOURCE,
			role: "sys",
			schedule: "none",
			locale: "en",
		});
		expect(rows[0]?.row.content).toContain('session "B" ticked');
		// A tool boundary within ten minutes: no reads at all.
		const before = counted.reads();
		expect(
			await writeOutlineTeamActivity(s.a, "en", "boundary", {
				now: now + OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs - 1,
				store: counted.store,
			}),
		).toBeNull();
		expect(counted.reads()).toBe(before);
		// After ten minutes with nothing new: a look, no row.
		expect(
			await writeOutlineTeamActivity(s.a, "en", "boundary", {
				now: now + OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs,
				store: counted.store,
			}),
		).toBeNull();
		expect(counted.reads()).toBeGreaterThan(before);
		expect(rows).toHaveLength(1);
		// Something new, ten minutes after that look: handed to the running loop.
		await s.tick("todo", now + OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs + 1000);
		const mid = await writeOutlineTeamActivity(s.a, "en", "boundary", {
			now: now + 2 * OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs + 2000,
			store: counted.store,
		});
		expect(rows).toHaveLength(2);
		expect(rows[1]?.row.schedule).toBe("onNextTurn");
		expect(rows[1]?.row.content).toContain('session "B" reopened');
		expect(rows[1]?.row.content).not.toContain("ticked");
		expect(mid?.turnText).toBe(rows[1]?.row.content);
		// A run start always looks (nothing new: nothing written).
		expect(
			await writeOutlineTeamActivity(s.a, "en", "start", {
				now: now + 2 * OUTLINE_TEAM_ACTIVITY_LIMITS.cadenceMs + 3000,
				store: counted.store,
			}),
		).toBeNull();
		expect(rows).toHaveLength(2);
	});

	test("the real delivery: a persisted sys row with the reader's body; switched off, nothing", async () => {
		const s = await changed();
		settings.outline.enabled = false;
		expect(await writeOutlineTeamActivity(s.a, "zh-CN", "start", { now: s.base + 1 })).toBeNull();
		settings.outline.enabled = true;
		const written = await writeOutlineTeamActivity(s.a, "zh-CN", "start", { now: s.base + 2 });
		expect(written?.messageId).toBeTruthy();
		const [row] = await db
			.select({ role: narratorMessages.role, json: narratorMessages.contentJson })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(eq(narratorMessageRefs.narratorId, s.a));
		expect(row?.role).toBe("sys");
		const block = ((row?.json ?? []) as Array<Record<string, unknown>>).find(
			(b) => b.type === "system_injection",
		);
		expect(block?.source).toBe(OUTLINE_TEAM_ACTIVITY_SOURCE);
		expect(String(block?.modelText)).toStartWith(
			"团队动态（上一轮之后别人做的；系统整理，不是用户发言）\n",
		);
		expect(block?.body).toMatchObject({
			kind: "outlineTasks",
			variant: "activity",
			items: [
				{ title: "Ship it", by: "B", changes: [{ kind: "status", from: "doing", to: "done" }] },
			],
		});
	});

	test("a run start through prepareOutlineRun writes the row; the system prompt's parts stay byte-identical", async () => {
		const s = await changed();
		const { prepareOutlineRun } = await import("../../narrator-session");
		const source = await taskSourceForNarrator(s.a);
		const partsBefore = JSON.stringify(await source.contextParts("en"));
		const active = {
			narratorId: s.a,
			locale: "en",
			_todoReminderCompletedToolCount: 0,
		} as unknown as Parameters<typeof prepareOutlineRun>[0];
		await prepareOutlineRun(active);
		const rows = await db
			.select({ json: narratorMessages.contentJson, text: narratorMessages.contentText })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(eq(narratorMessageRefs.narratorId, s.a));
		const activity = rows.filter((r) =>
			((r.json ?? []) as Array<Record<string, unknown>>).some(
				(b) => b.type === "system_injection" && b.source === OUTLINE_TEAM_ACTIVITY_SOURCE,
			),
		);
		expect(activity).toHaveLength(1);
		const text = String(activity[0]?.text ?? "");
		expect(text).toContain("Team activity since your last turn");
		// The named context parts (what the system prompt carries) do not change with the team's
		// activity, and do not carry it.
		const partsAfter = JSON.stringify(await (await taskSourceForNarrator(s.a)).contextParts("en"));
		expect(partsAfter).toBe(partsBefore);
		expect(partsAfter).not.toContain("Team activity");
		expect(partsAfter).not.toContain('session "B"');
	});

	test("a spec session's run start and tool boundaries write nothing", async () => {
		const s = await changed();
		const spec = await sqlite.session(s.owner.id, null, {
			title: "spec",
			createdAt: new Date(s.base - 60_000).toISOString(),
			backend: "spec",
		});
		const rows = capture();
		expect(await writeOutlineTeamActivity(spec, "en", "start", { now: s.base + 1 })).toBeNull();
		expect(await writeOutlineTeamActivity(spec, "en", "boundary", { now: s.base + 2 })).toBeNull();
		expect(rows).toEqual([]);
	});
});
