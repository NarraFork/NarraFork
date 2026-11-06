/**
 * The "delegated" section of the current-tasks view (outline P2 PR 9b, PR 9 design §2.8): the
 * open tasks the session's subagents hold with a live lease, after its own work in progress,
 * each with the subagent doing it; at most ten lines, the rest counted; the view is there even
 * when everything open is delegated; a lapsed lease or a claim handed back is not listed; another
 * session's subagent is not this session's; the reader's summary carries the section; and a
 * subagent ending (its claim handed back, which is no commit) makes the cached view read again.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineTaskClaims } from "../../../db/schema";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import { type OutlineOp, writeOutline } from "../../outline/write";
import { invalidateTaskBackend, taskSourceForNarrator } from "../index";
import { OUTLINE_VIEW_LIMITS, outlineTasksView, resetOutlineViewCache } from "../outline-views";

const NOW = "2026-11-06T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineViewCache();
});
afterEach(() => resetOutlineViewCache());

async function session(title = "Root"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		title,
		status: "idle",
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagentOf(root: string, title: string | null = "Fix the race"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		title,
		parentNarratorId: root,
		aclRootNarratorId: root,
		taskBackend: "outline",
		status: "working",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

const as = (narratorId: string) => ({
	actor: { kind: "agent" as const, id: narratorId },
	narratorId,
	responsibleUserId: null,
});

/** Tasks on a page of the root's session space, written by the root. */
async function seed(root: string, titles: readonly string[]) {
	const space = await ensureSessionSpace(root);
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "page", parent: null, content: "Work" },
			...titles.map(
				(title): OutlineOp => ({
					op: "insert",
					parent: { tempId: "page" },
					content: title,
					task: { status: "todo" },
				}),
			),
		],
		...as(root),
	});
	return { space, tasks: r.results.slice(1) as Array<{ blockId: string; address: string }> };
}

/** `who` starts the tasks: their claims are `who`'s, on a running lease. */
async function start(spaceId: string, who: string, ids: readonly string[]) {
	await writeOutline({
		spaceId,
		ops: ids.map((id) => ({ op: "setTask", block: { id }, task: { status: "doing" } })),
		...as(who),
	});
}

const DELEGATED_HEADING =
	"Delegated to subagents (do not work on these yourself; each report comes back to you):";

describe("the delegated section", () => {
	test("after the session's own work in progress: each task with the subagent doing it", async () => {
		const root = await session();
		const helper = await subagentOf(root);
		const { space, tasks } = await seed(root, ["Own work", "Fix the refresh race", "Next one"]);
		const [own, delegated, next] = tasks;
		if (!own || !delegated || !next) throw new Error("seed");
		await start(space.id, root, [own.blockId]);
		await start(space.id, helper, [delegated.blockId]);
		const text = await outlineTasksView(root, "en");
		expect(text).toBe(
			[
				"Current tasks of this session in the outline (kept by the system, updated when they change):",
				"In progress:",
				`- [/] \`${own.address}\` Own work`,
				DELEGATED_HEADING,
				`- [/] \`${delegated.address}\` Fix the refresh race — subagent "Fix the race" (\`${helper}\`), running`,
				"Next:",
				`- [ ] \`${next.address}\` Next one`,
			].join("\n"),
		);
		// The reader's summary carries the section and its count.
		const [part] = await (await taskSourceForNarrator(root)).contextParts("en");
		expect(part?.display).toMatchObject({
			delegated: [{ address: delegated.address, title: "Fix the refresh race" }],
			counts: { doing: 1, todo: 1, waiting: 0, delegated: 1 },
		});
	});

	test("in Chinese; a subagent without a title is named by its id", async () => {
		const root = await session();
		const helper = await subagentOf(root, null);
		const { space, tasks } = await seed(root, ["改刷新逻辑"]);
		const [task] = tasks;
		if (!task) throw new Error("seed");
		await start(space.id, helper, [task.blockId]);
		expect(await outlineTasksView(root, "zh-CN")).toBe(
			[
				"本会话在大纲里的当前任务（由系统维护，有变化时更新）：",
				"已交给子代理（不要自己再做；报告会交回给你）：",
				`- [/] \`${task.address}\` 改刷新逻辑 — 子代理 \`${helper}\`，运行中`,
			].join("\n"),
		);
	});

	test("everything open is delegated: the view is there, with only that section", async () => {
		const root = await session();
		const helper = await subagentOf(root);
		const { space, tasks } = await seed(root, ["Only task"]);
		const [task] = tasks;
		if (!task) throw new Error("seed");
		expect(await outlineTasksView(root, "en")).toContain("Next:");
		await start(space.id, helper, [task.blockId]);
		resetOutlineViewCache();
		const text = await outlineTasksView(root, "en");
		expect(text).not.toBeNull();
		expect(text).toContain(DELEGATED_HEADING);
		expect(text).not.toContain("Next:");
	});

	test(`at most ${OUTLINE_VIEW_LIMITS.delegated} lines; the rest counted`, async () => {
		const root = await session();
		const helper = await subagentOf(root);
		const titles = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`);
		const { space, tasks } = await seed(root, titles);
		await start(
			space.id,
			helper,
			tasks.map((t) => t.blockId),
		);
		const text = (await outlineTasksView(root, "en")) ?? "";
		expect(text.split("\n").filter((line) => line.includes("— subagent"))).toHaveLength(10);
		expect(text).toContain("2 more; read `session/` with OutlineRead.");
		const [part] = await (await taskSourceForNarrator(root)).contextParts("en");
		const display = part?.display as { delegated: unknown[]; counts: { delegated: number } };
		expect(display.delegated).toHaveLength(10);
		expect(display.counts.delegated).toBe(12);
	});

	test("a lapsed lease, a claim handed back, and another session's subagent are not listed", async () => {
		const root = await session();
		const other = await session("Other");
		const helper = await subagentOf(root);
		const stranger = await subagentOf(other);
		const { space, tasks } = await seed(root, ["Lapsed", "Handed back", "Stranger's"]);
		const [lapsed, back, foreign] = tasks;
		if (!lapsed || !back || !foreign) throw new Error("seed");
		await start(space.id, helper, [lapsed.blockId, back.blockId]);
		await start(space.id, stranger, [foreign.blockId]);
		await db
			.update(outlineTaskClaims)
			.set({ expiresAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(outlineTaskClaims.taskBlockId, lapsed.blockId));
		const text = (await outlineTasksView(root, "en")) ?? "";
		expect(text).toContain(`\`${back.address}\` Handed back — subagent`);
		expect(text).not.toContain("Lapsed — subagent");
		expect(text).not.toContain("Stranger's — subagent");

		// The run ends: the claim passes to the session (no commit). The subagent's end makes the
		// cached view read again.
		expect(
			await outlineStore.handOverTaskClaims(helper, root, "2099-01-01T00:00:00.000Z"),
		).toBeGreaterThan(0);
		expect(await outlineTasksView(root, "en")).toBe(text);
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: helper,
			parentNarratorId: root,
			toolUseId: "tu-1",
		});
		const after = (await outlineTasksView(root, "en")) ?? "";
		expect(after).not.toContain(DELEGATED_HEADING);
		expect(after).toContain(`\`${back.address}\` Handed back`);
	});

	test("a subagent has no view of its own", async () => {
		const root = await session();
		const helper = await subagentOf(root);
		const { space, tasks } = await seed(root, ["Delegated"]);
		await start(space.id, helper, [tasks[0]?.blockId as string]);
		expect(await outlineTasksView(helper, "en")).toBeNull();
	});
});
