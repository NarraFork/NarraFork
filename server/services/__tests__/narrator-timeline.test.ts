/**
 * narrator-timeline.test.ts — row→interval mapping and the per-turn lane builder.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	apiRequests,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorTurns,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	getTurnTimeline,
	listTimelineTurns,
	MAX_ROWS_PER_SOURCE,
	modelIntervals,
	SUMMARY_SOURCE_MAX_BYTES,
	toolIntervals,
} = await import("../narrator-timeline");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function toolRow(over: Partial<Parameters<typeof toolIntervals>[0]> = {}) {
	return {
		id: "t1",
		toolName: "Bash",
		status: "success",
		createdAt: iso(0),
		streamStartedAt: iso(0),
		streamCompletedAt: iso(100),
		permissionStartedAt: iso(100),
		permissionDecidedAt: iso(110),
		permissionDecidedBy: "auto",
		executionStartedAt: iso(110),
		completedAt: iso(1110),
		durationMs: 1000,
		isBackground: false,
		...over,
	};
}

describe("toolIntervals", () => {
	test("auto-approved call is tool execution only", () => {
		expect(toolIntervals(toolRow(), T0)).toEqual([
			{ category: "tool", startMs: T0 + 110, endMs: T0 + 1110, itemId: "t1" },
		]);
	});

	test("user permission is a permission wait", () => {
		const intervals = toolIntervals(
			toolRow({
				permissionDecidedBy: "user",
				permissionDecidedAt: iso(5000),
				executionStartedAt: iso(5000),
				completedAt: iso(6000),
			}),
			T0,
		);
		expect(intervals[0]).toEqual({
			category: "permission_wait",
			startMs: T0 + 100,
			endMs: T0 + 5000,
			itemId: "t1",
		});
	});

	test("AskUserQuestion waits for a reply; a reflection decision is a review", () => {
		const ask = toolIntervals(
			toolRow({
				toolName: "AskUserQuestion",
				permissionDecidedBy: "user",
				permissionDecidedAt: iso(9000),
			}),
			T0,
		);
		expect(ask[0].category).toBe("user_reply_wait");
		const plan = toolIntervals(
			toolRow({
				toolName: "ExitPlanMode",
				permissionDecidedBy: "reflection",
				permissionDecidedAt: iso(900),
			}),
			T0,
		);
		expect(plan[0].category).toBe("review");
	});

	test("pending permission and running call extend to now", () => {
		const pending = toolIntervals(
			toolRow({
				status: "pending",
				permissionDecidedAt: null,
				permissionDecidedBy: null,
				executionStartedAt: null,
				completedAt: null,
			}),
			T0 + 3000,
		);
		expect(pending).toEqual([
			{ category: "permission_wait", startMs: T0 + 100, endMs: T0 + 3000, itemId: "t1" },
		]);
		const running = toolIntervals(toolRow({ status: "running", completedAt: null }), T0 + 4000);
		expect(running[0]).toEqual({
			category: "tool",
			startMs: T0 + 110,
			endMs: T0 + 4000,
			itemId: "t1",
		});
	});

	test("Agent and Await wait on subagents; background calls are skipped", () => {
		expect(toolIntervals(toolRow({ toolName: "Agent" }), T0)[0].category).toBe("subagent_wait");
		expect(toolIntervals(toolRow({ toolName: "Await" }), T0)[0].category).toBe("subagent_wait");
		expect(toolIntervals(toolRow({ isBackground: true }), T0)).toEqual([]);
	});
});

describe("modelIntervals", () => {
	test("splits a request into first-token wait and output", () => {
		expect(
			modelIntervals({
				id: "r",
				kind: "narrator",
				createdAt: iso(10_000),
				durationMs: 4000,
				ttftMs: 1000,
			}),
		).toEqual([
			{ category: "model_wait", startMs: T0 + 6000, endMs: T0 + 7000, itemId: "r" },
			{ category: "model_output", startMs: T0 + 7000, endMs: T0 + 10_000, itemId: "r" },
		]);
	});

	test("compaction is one block; missing duration yields nothing", () => {
		expect(
			modelIntervals({
				id: "c",
				kind: "compact",
				createdAt: iso(5000),
				durationMs: 5000,
				ttftMs: 10,
			}),
		).toEqual([{ category: "compact", startMs: T0, endMs: T0 + 5000, itemId: "c" }]);
		expect(
			modelIntervals({
				id: "x",
				kind: "narrator",
				createdAt: iso(5000),
				durationMs: null,
				ttftMs: null,
			}),
		).toEqual([]);
	});
});

describe("getTurnTimeline", () => {
	const PARENT = "tl-parent";
	const CHILD = "tl-child";

	async function seedNarrator(id: string, over: Partial<typeof narrators.$inferInsert> = {}) {
		await db.insert(narrators).values({
			id,
			title: id,
			status: "idle",
			createdAt: iso(0),
			updatedAt: iso(0),
			...over,
		});
	}

	async function seedMessage(
		id: string,
		narratorId: string,
		role: "user" | "assistant",
		at: number,
	) {
		await db.insert(narratorMessages).values({
			id,
			narratorId,
			role,
			contentJson: [],
			contentText: role === "user" ? "please build the timeline feature" : null,
			origin: role === "user" ? "user" : null,
			createdAt: iso(at),
		});
	}

	async function seedTool(
		id: string,
		narratorId: string,
		messageId: string,
		toolName: string,
		start: number,
		end: number,
		over: Partial<typeof narratorToolCalls.$inferInsert> = {},
	) {
		await db.insert(narratorToolCalls).values({
			id,
			narratorId,
			messageId,
			toolUseId: `${id}-use`,
			toolName,
			status: "success",
			inputJson: { description: `run ${id}` },
			streamStartedAt: iso(start),
			permissionStartedAt: iso(start),
			permissionDecidedAt: iso(start),
			permissionDecidedBy: "auto",
			executionStartedAt: iso(start),
			completedAt: iso(end),
			durationMs: end - start,
			createdAt: iso(start),
			...over,
		});
	}

	beforeEach(async () => {
		cleanDb(sqlite);
		await seedNarrator(PARENT);
		await seedMessage("m-user", PARENT, "user", 0);
		await seedMessage("m-a1", PARENT, "assistant", 2000);
		await db.insert(narratorTurns).values({
			id: "turn-1",
			narratorId: PARENT,
			status: "completed",
			triggerMessageId: "m-user",
			startedAt: iso(0),
			endedAt: iso(20_000),
		});
		await db.insert(apiRequests).values({
			id: "req-1",
			narratorId: PARENT,
			kind: "narrator",
			durationMs: 2000,
			ttftMs: 500,
			createdAt: iso(2000),
		});
		await seedTool("tool-bash", PARENT, "m-a1", "Bash", 2100, 3000);
		await seedTool("tool-agent", PARENT, "m-a1", "Agent", 3000, 15_000);
		await seedNarrator(CHILD, {
			type: "subagent",
			subagentType: "explore",
			parentNarratorId: PARENT,
			originToolCallId: "tool-agent",
			createdAt: iso(3100),
		});
		await seedMessage("c-user", CHILD, "user", 3100);
		await seedTool("child-read", CHILD, "c-user", "Read", 4000, 5000);
	});

	afterEach(() => cleanDb(sqlite));

	test("lists turns newest first with an excerpt", async () => {
		const result = await listTimelineTurns(PARENT);
		expect(result.hasMore).toBe(false);
		expect(result.turns).toHaveLength(1);
		expect(result.turns[0]).toMatchObject({
			id: "turn-1",
			index: 1,
			status: "completed",
			triggerExcerpt: "please build the timeline feature",
			derived: false,
		});
	});

	test("builds a continuous primary lane and a child lane branching from the Agent call", async () => {
		const timeline = await getTurnTimeline(PARENT, "turn-1", T0 + 60_000);
		expect(timeline).not.toBeNull();
		if (!timeline) return;
		expect(timeline.lanes.map((lane) => lane.narratorId)).toEqual([PARENT, CHILD]);
		const [primary, child] = timeline.lanes;

		expect(primary.segments[0].startMs).toBe(T0);
		for (let i = 1; i < primary.segments.length; i++) {
			expect(primary.segments[i].startMs).toBe(primary.segments[i - 1].endMs);
		}
		expect(primary.segments[primary.segments.length - 1].endMs).toBe(T0 + 20_000);
		const categories = primary.segments.map((segment) => segment.category);
		expect(categories).toContain("model_wait");
		expect(categories).toContain("model_output");
		expect(categories).toContain("tool");
		expect(categories).toContain("subagent_wait");
		expect(categories).toContain("overhead");

		expect(child.depth).toBe(1);
		expect(child.type).toBe("subagent");
		expect(child.subagentType).toBe("explore");
		expect(child.spawnItemId).toBe("tool-agent");
		expect(child.spawnAtMs).toBe(T0 + 3000);
		expect(child.startMs).toBe(T0 + 3100);
		expect(child.endMs).toBe(T0 + 15_000);
		expect(child.segments.some((segment) => segment.category === "tool")).toBe(true);

		const agent = timeline.items["tool-agent"];
		expect(agent?.kind).toBe("tool");
		if (agent?.kind === "tool") expect(agent.childNarratorId).toBe(CHILD);
		const bash = timeline.items["tool-bash"];
		if (bash?.kind === "tool") expect(bash.summary).toBe("run tool-bash");
	});

	test("pads the primary lane when a child outlives the turn", async () => {
		await db
			.update(narratorToolCalls)
			.set({ completedAt: iso(30_000), isBackground: true })
			.where((await import("drizzle-orm")).eq(narratorToolCalls.id, "tool-agent"));
		const timeline = await getTurnTimeline(PARENT, "turn-1", T0 + 60_000);
		const primary = timeline?.lanes[0];
		const child = timeline?.lanes[1];
		expect(child?.endMs).toBe(T0 + 5000);
		expect(primary?.endMs).toBe(T0 + 20_000);
	});

	test("falls back to user-message turns without narrator_turns rows", async () => {
		sqlite.exec("DELETE FROM narrator_turns");
		const turns = await listTimelineTurns(PARENT);
		expect(turns.turns[0]).toMatchObject({ id: "msg:m-user", derived: true, index: 1 });
		const timeline = await getTurnTimeline(PARENT, "msg:m-user", T0 + 60_000);
		expect(timeline?.turn?.id).toBe("msg:m-user");
		expect(timeline?.lanes[0].startMs).toBe(T0);
		expect(timeline?.lanes.length).toBe(2);
	});

	test("derived turns report a further page when exactly one more input exists", async () => {
		sqlite.exec("DELETE FROM narrator_turns");
		await seedMessage("m-user-2", PARENT, "user", 30_000);
		await seedMessage("m-user-3", PARENT, "user", 40_000);
		const first = await listTimelineTurns(PARENT, { limit: 2 });
		expect(first.turns.map((turn) => turn.id)).toEqual(["msg:m-user-3", "msg:m-user-2"]);
		expect(first.turns.map((turn) => turn.index)).toEqual([3, 2]);
		expect(first.turns[1].endedAt).toBe(iso(40_000));
		expect(first.hasMore).toBe(true);
		const second = await listTimelineTurns(PARENT, { limit: 2, before: first.turns[1].startedAt });
		expect(second.turns.map((turn) => [turn.id, turn.index])).toEqual([["msg:m-user", 1]]);
		expect(second.hasMore).toBe(false);
	});

	test("large inputs are not parsed; file tools fall back to the resolved path", async () => {
		const content = "x".repeat(SUMMARY_SOURCE_MAX_BYTES + 1);
		await seedTool("tool-write", PARENT, "m-a1", "Write", 15_500, 16_000, {
			inputJson: { file_path: "/repo/src/big.ts", content },
			resolvedFilePath: "/repo/src/resolved.ts",
		});
		await seedTool("tool-bash-big", PARENT, "m-a1", "Bash", 16_000, 16_500, {
			inputJson: { description: "huge heredoc", command: content },
		});
		const { eq } = await import("drizzle-orm");
		await db
			.update(narratorToolCalls)
			.set({ inputJson: { description: "explore", prompt: content } })
			.where(eq(narratorToolCalls.id, "tool-agent"));
		const timeline = await getTurnTimeline(PARENT, "turn-1", T0 + 60_000);
		const write = timeline?.items["tool-write"];
		const bash = timeline?.items["tool-bash-big"];
		const agent = timeline?.items["tool-agent"];
		expect(write?.kind === "tool" && write.summary).toBe("resolved.ts");
		expect(bash?.kind === "tool" && bash.summary).toBeNull();
		expect(agent?.kind === "tool" && agent.summary).toBe(CHILD);
		const small = timeline?.items["tool-bash"];
		expect(small?.kind === "tool" && small.summary).toBe("run tool-bash");
	});

	test("a foreground child resumed in a later turn keeps its lane within the spawn call", async () => {
		await seedTool("child-later", CHILD, "c-user", "Read", 500_000, 501_000);
		const timeline = await getTurnTimeline(PARENT, "turn-1", T0 + 600_000);
		expect(timeline?.lanes[1].endMs).toBe(T0 + 15_000);
		expect(timeline?.items["child-later"]).toBeUndefined();
		expect(timeline?.endMs).toBe(T0 + 20_000);
	});

	test("a lane past its row budget is flagged and stays bounded", async () => {
		sqlite.run("BEGIN");
		for (let i = 0; i <= MAX_ROWS_PER_SOURCE; i++) {
			await seedTool(`bulk-${i}`, PARENT, "m-a1", "Read", 3000 + i, 3000 + i + 1);
		}
		sqlite.run("COMMIT");
		const timeline = await getTurnTimeline(PARENT, "turn-1", T0 + 60_000);
		const [primary, child] = timeline?.lanes ?? [];
		expect(primary.truncated).toBe(true);
		// Rows are read in (created_at, id) order: 2 seeded + 2001 bulk calls, 2000 read.
		expect(primary.coveredUntilMs).toBe(T0 + 3000 + MAX_ROWS_PER_SOURCE - 2);
		expect(primary.endMs).toBe(T0 + 20_000);
		expect(primary.segments[primary.segments.length - 1].endMs).toBe(primary.coveredUntilMs ?? 0);
		expect(child.truncated).toBe(false);
		expect(child.coveredUntilMs).toBeNull();
		// Details ship only for what the (coarsened) segments reference.
		const referenced = new Set(primary.segments.flatMap((segment) => segment.itemIds));
		const shipped = Object.keys(timeline?.items ?? {}).filter((id) => id.startsWith("bulk-"));
		expect(shipped.every((id) => referenced.has(id))).toBe(true);
		expect(shipped.length).toBeLessThan(MAX_ROWS_PER_SOURCE);
	});

	test("concurrent requests for the same turn share one build", async () => {
		const a = getTurnTimeline(PARENT, "turn-1");
		const b = getTurnTimeline(PARENT, "turn-1");
		expect(a).toBe(b);
		expect(getTurnTimeline(PARENT)).not.toBe(a);
		expect((await a)?.lanes.length).toBe(2);
		expect(getTurnTimeline(PARENT, "turn-1")).not.toBe(a);
	});

	test("unknown narrator or turn", async () => {
		expect(await getTurnTimeline("missing")).toBeNull();
		expect(await getTurnTimeline(PARENT, "nope")).toBeNull();
	});
});
