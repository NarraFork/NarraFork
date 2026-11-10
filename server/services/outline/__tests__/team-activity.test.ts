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
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { readTestMessageContent } from "../../../../tests/setup";
import { db, sqlite as testSqlite } from "../../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorTurns,
	projects,
	users,
} from "../../../db/schema";
import { localBackend } from "../../../lib/agent/execution/local-backend";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { invalidateTaskBackend, taskSourceForNarrator } from "../../task-source";
import { noteOutlineFileChange, resetOutlineOverlapForTests } from "../overlap";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
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
	resetOutlineOverlapForTests();
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
			.select({ role: narratorMessages.role, id: narratorMessages.id })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(eq(narratorMessageRefs.narratorId, s.a));
		expect(row?.role).toBe("sys");
		// The body lives in block rows (content is no longer kept on the message): read as tests do.
		const block = readTestMessageContent(testSqlite, row?.id ?? "").find(
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
			.select({ id: narratorMessages.id })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(eq(narratorMessageRefs.narratorId, s.a));
		const activity = rows.flatMap((r) =>
			readTestMessageContent(testSqlite, r.id).filter(
				(b) => b.type === "system_injection" && b.source === OUTLINE_TEAM_ACTIVITY_SOURCE,
			),
		);
		expect(activity).toHaveLength(1);
		const text = String(activity[0]?.modelText ?? "");
		expect(text).toContain("Team activity since your last turn");
		// The named context parts (what the system prompt carries) do not change with the team's
		// activity, and do not carry it.
		const partsAfter = JSON.stringify(await (await taskSourceForNarrator(s.a)).contextParts("en"));
		expect(partsAfter).toBe(partsBefore);
		expect(partsAfter).not.toContain("Team activity");
		expect(partsAfter).not.toContain('session "B"');
	});

	test("files alone: a project without an outline space yet, another session's task in its own space", async () => {
		const owner = await sqlite.person("fay");
		const projectId = await sqlite.project(owner.id);
		const made = new Date(Date.now() - 60 * 60_000).toISOString();
		const a = await sqlite.session(owner.id, projectId, { title: "A", createdAt: made });
		const b = await sqlite.session(owner.id, projectId, { title: "B", createdAt: made });
		const theirs = await ensureSessionSpace(b);
		const written = await writeOutline({
			spaceId: theirs.id,
			actor: { kind: "agent", id: b },
			narratorId: b,
			responsibleUserId: owner.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "B's page" },
				{ op: "insert", parent: { tempId: "p" }, content: "B's work", task: { status: "doing" } },
			],
		});
		const task = written.results[1];
		const repo = mkdtempSync(join(tmpdir(), "nf-team-files-"));
		mkdirSync(join(repo, ".git"));
		const touch = (narratorId: string) =>
			noteOutlineFileChange({
				narratorId,
				projectId,
				cwd: repo,
				filePaths: [join(repo, "src/shared.ts")],
				backend: localBackend,
				locale: "en",
				hint: false,
			});
		await touch(a);
		await touch(b);
		const rows = capture();
		await writeOutlineTeamActivity(a, "en", "start");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.row.content.split("\n").slice(1)).toEqual([
			`- Files: [[${task?.address}|B's work]] of session "B" is also changing \`src/shared.ts\`, which you changed`,
		]);
	});

	test("a window with more commits than a look reads says once, without a number, that earlier ones were not read", async () => {
		const s = await changed();
		// 52 more commits by B (it reopens and ticks in turn): the newest 50 are read.
		for (let i = 0; i < 52; i++) await s.tick(i % 2 === 0 ? "todo" : "done", s.base + 1000 + i);
		const rows = capture();
		await writeOutlineTeamActivity(s.a, "en", "start", { now: s.base + 60_000 });
		expect(rows[0]?.row.content.split("\n").slice(1)).toEqual([
			expect.stringContaining('session "B"'),
			"(Some earlier changes in this window were not read.)",
		]);
		// A window read whole says no such thing.
		await s.tick("todo", s.base + 70_000);
		await writeOutlineTeamActivity(s.a, "zh-CN", "start", { now: s.base + 80_000 });
		expect(rows[1]?.row.content).not.toContain("没有读");
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
