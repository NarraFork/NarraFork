/**
 * The current-tasks view's `context_update` rows say what CHANGED (任务树可读性 PR B).
 *
 * A row used to store only the list as it is now, so the transcript's line could say no more than
 * "Current tasks updated". Each row now also stores a state table of the open tasks (at most 60
 * addresses), and the next row of the same epoch is compared with it: the tasks finished,
 * started, cancelled, added, waiting or delegated in between are named (five at most, the rest
 * counted). The baseline is what the session was last shown (its previous row, or the epoch's
 * prefix baseline), never the view's read cache.
 *
 * Pinned here, through the real path (`taskSource.contextParts` → `buildEffectiveSystemPrompt` →
 * `reconcileEpoch`): each kind of change; the first row of an epoch (after session start, a
 * compact, a model switch) is compared with the summary its marker stored beside the prefix
 * baseline; an epoch or a row written before tables existed is not a baseline; the last task finishing names it; more
 * than 60 open tasks never report a task as gone on absence alone; a change of order alone names
 * no change; the model's text is the view's text, byte for byte, with or without the changes.
 *
 * ISOLATION: the isolated database of `tests/preload.ts`; every case makes its own session.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EpochRecord } from "@server/lib/agent/tool-loading";
import type { DbMessage } from "@shared/agent-protocol/types";
import type { OutlineTasksViewDisplay } from "@shared/outline-task-notice";
import { contextUpdateOf, renderContextUpdate } from "@shared/prefix-context";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import {
	baselineContextDisplays,
	previousContextDisplay,
	refineContextDisplay,
} from "../../context-display-refiners";
import { buildEffectiveSystemPrompt } from "../../narrator-prompt";
import { narratorService } from "../../narrator-service";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import { type OutlineOp, writeOutline } from "../../outline/write";
import { invalidateTaskBackend, taskSourceForNarrator } from "../index";
import { outlineTasksView, refineTasksViewDisplay, resetOutlineViewCache } from "../outline-views";

const NOW = "2026-11-10T00:00:00.000Z";
const KEY = "outline.tasks";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineViewCache();
	settings.anthropicProviders = [
		{
			id: "changes-p",
			name: "Changes",
			prefix: "changes-p",
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "default",
			officialApi: false,
		},
	];
});
afterEach(() => resetOutlineViewCache());

async function session(): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		title: "Root",
		model: "default",
		permissionMode: "default",
		status: "idle",
		cwd: "/tmp",
		taskBackend: "outline",
		ownerUserId: null,
		autoContinuationOverride: "off",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagentOf(root: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		title: "Helper",
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

interface Seeded {
	spaceId: string;
	pageId: string;
	/** The tasks by title. */
	task: Record<string, { blockId: string; address: string }>;
}

/** To-do tasks on a page of the session's space, written by the session. */
async function seed(root: string, titles: readonly string[]): Promise<Seeded> {
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
	const [page, ...tasks] = r.results as Array<{ blockId: string; address: string }>;
	return {
		spaceId: space.id,
		pageId: (page as { blockId: string }).blockId,
		task: Object.fromEntries(titles.map((title, i) => [title, tasks[i] as never])),
	};
}

async function write(s: Seeded, who: string, ops: OutlineOp[]): Promise<void> {
	await writeOutline({ spaceId: s.spaceId, ops, ...as(who) });
}

const setTask = (s: Seeded, title: string, status: "todo" | "doing" | "done" | "cancelled") =>
	({
		op: "setTask",
		block: { id: (s.task[title] as { blockId: string }).blockId },
		task: { status },
	}) as OutlineOp;

/** The prompt a request of the session is prepared with: its views as context parts. */
async function promptOf(id: string) {
	resetOutlineViewCache();
	return await buildEffectiveSystemPrompt({
		basePrompt: null,
		cwd: "/tmp",
		locale: "en",
		taskSection: "outline",
		runtimeHints: "runtime",
		contextParts: await (await taskSourceForNarrator(id)).contextParts("en"),
	});
}

/** One provider request's prefix reconciliation, with the session's views as context parts. */
async function request(id: string, model = "default") {
	return await requestWith(id, await promptOf(id), model);
}

async function requestWith(
	id: string,
	built: Awaited<ReturnType<typeof promptOf>>,
	model = "default",
) {
	const { reconcileEpoch } = await import("../../narrator-epochs");
	const result = await reconcileEpoch({
		narratorId: id,
		messages: [],
		managed: new Set<string>(),
		current: [],
		candidates: [],
		model,
		provider: "changes-p",
		registryRevision: "r",
		prompt: {
			contract: built.contract,
			parts: built.parts,
			keepParts: built.keepParts,
			displays: built.displays,
		},
		noticeText: (kind, name) => `${kind}: ${name}`,
		resolveTarget: (m, p) => ({ fingerprint: `${p}:${m}`, cacheTtlMs: 1 }),
	});
	return { ...result, narratorId: id };
}

/** The session's epoch markers, as stored. */
async function markers(id: string): Promise<EpochRecord[]> {
	const out: EpochRecord[] = [];
	for (const row of await narratorService.getModelHistorySinceLastCompact(id)) {
		const block = Array.isArray(row.contentJson) ? row.contentJson[0] : undefined;
		if ((block as { type?: string } | undefined)?.type !== "epoch") continue;
		out.push((block as unknown as { epoch: EpochRecord }).epoch);
	}
	return out;
}

/** The session's `context_update` rows: their stored block and the view's summary. */
async function updates(id: string) {
	const rows: Array<{ block: Record<string, unknown>; view: OutlineTasksViewDisplay | null }> = [];
	for (const row of await narratorService.getModelHistorySinceLastCompact(id)) {
		for (const block of Array.isArray(row.contentJson) ? row.contentJson : []) {
			if (!contextUpdateOf(block)) continue;
			const display = (block as { display?: Record<string, unknown> }).display;
			rows.push({ block: block as never, view: (display?.[KEY] ?? null) as never });
		}
	}
	return rows;
}

/** The view's summary on the session's latest row. */
async function latest(id: string): Promise<OutlineTasksViewDisplay | null> {
	const rows = await updates(id);
	return rows[rows.length - 1]?.view ?? null;
}

const named = (view: OutlineTasksViewDisplay | null) =>
	(view?.changes ?? []).map((c) => `${c.kind}:${c.title}${c.from ? `<${c.from}` : ""}`);

describe("what changed since the view the session saw before", () => {
	test("session start: the first row is compared with the view the prefix baseline held", async () => {
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race", "Write docs"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		await request(id);
		// The epoch's baseline holds the view: no row yet. Its marker keeps the view's summary
		// (the list and its state table) for the first row to be compared with.
		expect(await updates(id)).toEqual([]);
		const baseline = (await markers(id))[0]?.baselineDisplays?.[KEY] as OutlineTasksViewDisplay;
		expect(baseline.states).toEqual({
			doing: [s.task["Add tests"]?.address as string],
			todo: [s.task["Fix the race"]?.address, s.task["Write docs"]?.address] as string[],
		});
		expect(baseline.changes).toBeUndefined();

		await write(s, id, [setTask(s, "Add tests", "done"), setTask(s, "Fix the race", "doing")]);
		await request(id);
		const first = await latest(id);
		expect(named(first)).toEqual(["done:Add tests<doing", "started:Fix the race<todo"]);
		expect(first?.changed).toBe(2);
		expect(first?.changes?.[0]?.address).toBe(s.task["Add tests"]?.address as string);
		expect(first?.states).toEqual({
			doing: [s.task["Fix the race"]?.address as string],
			todo: [s.task["Write docs"]?.address as string],
		});

		// The next row is compared with that row, not with the baseline again.
		await write(s, id, [setTask(s, "Write docs", "doing")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["started:Write docs<todo"]);
	});

	test("session start with no task open: the first tasks are named as they appear", async () => {
		const id = await session();
		await request(id);
		// The baseline went without the view: a known, empty list.
		expect((await markers(id))[0]?.baselineDisplays).toEqual({ [KEY]: null });
		const s = await seed(id, ["Add tests", "Fix the race"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["started:Add tests", "added:Fix the race"]);
	});

	test("after a compact the first row is compared with the new baseline, not an older row", async () => {
		const { narratorPersistence } = await import("../../narrator-persistence");
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race", "Write docs"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Fix the race", "doing")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["started:Fix the race<todo"]);
		// Between that row and the compact a task finishes: the compact's baseline holds the list
		// without it, so the first row after the compact must not report it again.
		await write(s, id, [setTask(s, "Add tests", "done")]);
		const compact = await narratorPersistence.persistCompactingMessage(id);
		expect(
			await narratorPersistence.finalizeCompactingMessage(compact.id, id, "Summary so far"),
		).not.toBeNull();
		const opened = await request(id);
		expect(opened.epoch?.reason).toBe("compact");
		expect(await updates(id)).toEqual([]);
		await write(s, id, [setTask(s, "Write docs", "doing")]);
		await request(id);
		const rows = await updates(id);
		expect(rows).toHaveLength(1);
		expect(named(rows[0]?.view ?? null)).toEqual(["started:Write docs<todo"]);
	});

	test("after a model switch the first row is compared with the new baseline", async () => {
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race", "Write docs"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Fix the race", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Add tests", "done")]);
		const switched = await request(id, "other-model");
		expect(switched.epoch?.reason).toBe("target");
		expect((await markers(id)).map((m) => Object.keys(m.baselineDisplays ?? {}))).toEqual([
			[KEY],
			[KEY],
		]);
		// The switch itself wrote no row; the finished task is in neither the new baseline nor the
		// row after it.
		expect(await updates(id)).toHaveLength(1);
		await write(s, id, [setTask(s, "Write docs", "doing")]);
		await request(id, "other-model");
		expect(named(await latest(id))).toEqual(["started:Write docs<todo"]);
	});

	test("an epoch opened before baselines were stored: its first row lists, it does not compare", async () => {
		const { narratorPersistence } = await import("../../narrator-persistence");
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		// The marker as it was written before this field existed.
		const original = narratorPersistence.persistEpochMarker;
		const spy = spyOn(narratorPersistence, "persistEpochMarker").mockImplementation(
			(narratorId, { baselineDisplays: _dropped, ...record }) =>
				original.call(narratorPersistence, narratorId, record),
		);
		try {
			await request(id);
		} finally {
			spy.mockRestore();
		}
		expect((await markers(id))[0]).toBeDefined();
		expect((await markers(id))[0]?.baselineDisplays).toBeUndefined();
		await write(s, id, [setTask(s, "Fix the race", "doing")]);
		await request(id);
		const first = await latest(id);
		expect(first?.changes).toBeUndefined();
		expect(first?.changed).toBeUndefined();
		expect(first?.states?.doing).toHaveLength(2);
		// From its second row on it compares as any epoch does.
		await write(s, id, [setTask(s, "Add tests", "done")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["done:Add tests<doing"]);
	});

	test("a full fork: its first row lists its own tasks, never the parent's as having left", async () => {
		const id = await session();
		const s = await seed(id, ["Parent task", "Parent next"]);
		await write(s, id, [setTask(s, "Parent task", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Parent next", "doing")]);
		await request(id);
		const parentRows = await updates(id);
		expect(named(parentRows[0]?.view ?? null)).toEqual(["started:Parent next<todo"]);
		const fork = await narratorService.forkNarrator(id, null, { inheritMode: "full" });
		invalidateTaskBackend();
		// The fork has the parent's history (its marker and its row), and tasks of its own.
		expect(await updates(fork.id)).toHaveLength(1);
		const f = await seed(fork.id, ["Fork task"]);
		await write(f, fork.id, [setTask(f, "Fork task", "doing")]);
		await request(fork.id);
		const first = (await updates(fork.id)).at(-1)?.view ?? null;
		expect(first?.doing.map((t) => t.title)).toEqual(["Fork task"]);
		// Not compared with what the parent saw: nothing "no longer listed", nothing "started".
		expect(first?.changes).toBeUndefined();
		expect(first?.changed).toBeUndefined();
		// From its own first row on, the fork compares as any session does.
		await write(f, fork.id, [setTask(f, "Fork task", "done")]);
		await request(fork.id);
		expect(named((await updates(fork.id)).at(-1)?.view ?? null)).toEqual(["done:Fork task<doing"]);
		// The parent goes on comparing with its own rows.
		await write(s, id, [setTask(s, "Parent task", "done")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["done:Parent task<doing"]);
	});

	test("the baseline's summary is the marker's alone: the prefix and its hashes do not move", async () => {
		const { getPrefixText } = await import("../../narrator-prefix-snapshots");
		const { narratorPersistence } = await import("../../narrator-persistence");
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		const withBaseline = await request(id);
		const [marker] = await markers(id);
		resetOutlineViewCache();
		const text = (await outlineTasksView(id, "en")) as string;
		// The view's part of the prefix is the view's text, byte for byte.
		const part = marker?.prefix?.parts.find((p) => p.key === KEY);
		expect(await getPrefixText(part?.hash as string)).toBe(text);
		expect(withBaseline.systemPrompt).toContain(text);
		for (const word of ["baselineDisplays", "states", '"counts"']) {
			expect(withBaseline.systemPrompt).not.toContain(word);
		}
		// The same session opened without the field (as before this change): the same prefix
		// references and the same prompt, to the byte.
		const twin = await session();
		const original = narratorPersistence.persistEpochMarker;
		const spy = spyOn(narratorPersistence, "persistEpochMarker").mockImplementation(
			(narratorId, { baselineDisplays: _dropped, ...record }) =>
				original.call(narratorPersistence, narratorId, record),
		);
		let without: Awaited<ReturnType<typeof request>>;
		try {
			without = await requestWith(twin, await promptOf(id));
		} finally {
			spy.mockRestore();
		}
		const again = await requestWith(await session(), await promptOf(id));
		expect(without.systemPrompt).toBe(again.systemPrompt as string);
		const [bare] = await markers(twin);
		expect(bare?.baselineDisplays).toBeUndefined();
		const [full] = await markers(again.narratorId);
		expect(full?.baselineDisplays).toBeDefined();
		expect(full?.prefix).toEqual(bare?.prefix as never);
		const { baselineDisplays: _b, ...rest } = full as unknown as Record<string, unknown>;
		expect(rest).toEqual(bare as never);
	});

	test("cancelled, removed, added and put back are told apart", async () => {
		const id = await session();
		const s = await seed(id, ["Keep", "Drop", "Delete me", "Pause me", "Uncheck me"]);
		await write(s, id, [setTask(s, "Keep", "doing"), setTask(s, "Pause me", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Drop", "doing")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["started:Drop<todo"]);

		await write(s, id, [
			setTask(s, "Drop", "cancelled"),
			{ op: "delete", block: { id: s.task["Delete me"]?.blockId as string } },
			{ op: "setTask", block: { id: s.task["Uncheck me"]?.blockId as string }, task: null },
			setTask(s, "Pause me", "todo"),
			{ op: "insert", parent: { id: s.pageId }, content: "Brand new", task: { status: "todo" } },
		]);
		await request(id);
		const view = await latest(id);
		expect(named(view)).toEqual([
			"cancelled:Drop<doing",
			"added:Brand new",
			"requeued:Pause me<doing",
			"removed:Delete me<todo",
			"removed:Uncheck me<todo",
		]);
		expect(view?.changed).toBe(5);
	});

	test("waiting on a prerequisite, and no longer waiting", async () => {
		const id = await session();
		const s = await seed(id, ["First", "Second"]);
		await write(s, id, [setTask(s, "First", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Second", "doing")]);
		await request(id);
		const first = s.task.First as { blockId: string; address: string };
		await write(s, id, [
			{
				op: "setTask",
				block: { id: (s.task.Second as { blockId: string }).blockId },
				task: { depends: [{ target: first.address, label: null }] },
			} as OutlineOp,
		]);
		await request(id);
		expect(named(await latest(id))).toEqual(["waiting:Second<doing"]);
		// Its prerequisite finishes: one finished, the other free again.
		await write(s, id, [setTask(s, "First", "done")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["done:First<doing", "started:Second<waiting"]);
	});

	test("handed to a subagent, and handed back when its run ends", async () => {
		const id = await session();
		const helper = await subagentOf(id);
		const s = await seed(id, ["Own work", "Refresh race"]);
		await write(s, id, [setTask(s, "Own work", "doing")]);
		await request(id);
		await write(s, id, [{ op: "insert", parent: { id: s.pageId }, content: "A note" }]);
		await write(s, id, [
			{ op: "insert", parent: { id: s.pageId }, content: "Filler", task: { status: "todo" } },
		]);
		await request(id);
		await write(s, helper, [setTask(s, "Refresh race", "doing")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["delegated:Refresh race<todo"]);
		expect((await latest(id))?.states?.delegated).toEqual([
			s.task["Refresh race"]?.address as string,
		]);
		// The session takes it back (as when the subagent's run ends and its claim passes on).
		await write(s, id, [setTask(s, "Refresh race", "todo")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["returned:Refresh race<delegated"]);
	});

	test("the last task finishing names it instead of only saying the list is empty", async () => {
		const id = await session();
		const s = await seed(id, ["Only task"]);
		await write(s, id, [setTask(s, "Only task", "doing")]);
		await request(id);
		// As the epoch's first row too (compared with its baseline).
		const other = await session();
		const o = await seed(other, ["Solo"]);
		await request(other);
		await write(o, other, [setTask(o, "Solo", "done")]);
		await request(other);
		expect(named(await latest(other))).toEqual(["done:Solo<todo"]);
		expect((await latest(other))?.states).toEqual({});

		await write(s, id, [
			{ op: "insert", parent: { id: s.pageId }, content: "Next", task: { status: "todo" } },
		]);
		await request(id);
		await write(s, id, [setTask(s, "Only task", "done")]);
		await request(id);
		expect(named(await latest(id))).toEqual(["done:Only task<doing"]);
		const next = (await outlineStore.listChildMetas(s.spaceId, [s.pageId], 10)).find(
			(m) => m.taskJson?.status === "todo",
		);
		await write(s, id, [
			{ op: "setTask", block: { id: next?.id as string }, task: { status: "done" } },
		]);
		await request(id);
		const emptied = await latest(id);
		expect(emptied).toEqual({
			doing: [],
			waiting: [],
			next: [],
			counts: { doing: 0, waiting: 0, todo: 0 },
			states: {},
			changes: [{ address: expect.any(String), title: "Next", kind: "done", from: "todo" }],
			changed: 1,
		});
		// And the list filling again is compared with that empty list.
		await write(s, id, [
			{ op: "insert", parent: { id: s.pageId }, content: "Round two", task: { status: "doing" } },
		]);
		await request(id);
		expect(named(await latest(id))).toEqual(["started:Round two"]);
	});

	test("a new order or a new title alone: no state change is named", async () => {
		const id = await session();
		const s = await seed(id, ["Alpha", "Bravo", "Charlie"]);
		await write(s, id, [setTask(s, "Alpha", "doing"), setTask(s, "Bravo", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Charlie", "doing")]);
		await request(id);
		// Moved: the same tasks in another order. The view's text changes, the states do not.
		await write(s, id, [
			{
				op: "move",
				block: { id: s.task.Alpha?.blockId as string },
				parent: { id: s.pageId },
				position: { after: { id: s.task.Charlie?.blockId as string } },
			} as OutlineOp,
		]);
		await request(id);
		const moved = await latest(id);
		expect(moved?.changes).toEqual([]);
		expect(moved?.changed).toBe(0);
		expect(moved?.doing.map((t) => t.title)).toEqual(["Bravo", "Charlie", "Alpha"]);
		// Renamed: the same task under a new title, never a removal and an addition.
		await write(s, id, [
			{ op: "update", block: { id: s.task.Bravo?.blockId as string }, content: "Bravo, reworded" },
		]);
		await request(id);
		expect(named(await latest(id))).toEqual(["renamed:Bravo, reworded<doing"]);
	});

	test("more than sixty open tasks: the table is cut and absence alone is never a change", async () => {
		const id = await session();
		const helper = await subagentOf(id);
		const own = Array.from({ length: 52 }, (_, i) => `Own ${String(i).padStart(2, "0")}`);
		const handed = Array.from({ length: 12 }, (_, i) => `Handed ${String(i).padStart(2, "0")}`);
		const s = await seed(id, [...own, ...handed]);
		await write(s, id, [setTask(s, "Own 00", "doing")]);
		await write(
			s,
			helper,
			handed.map((title) => setTask(s, title, "doing")),
		);
		await request(id);
		await write(s, id, [setTask(s, "Own 01", "doing")]);
		await request(id);
		const first = await latest(id);
		const size = (view: OutlineTasksViewDisplay | null) =>
			Object.values(view?.states ?? {}).flat().length;
		expect(size(first)).toBeLessThanOrEqual(60);
		expect(first?.statesMore).toBe(true);
		// Work in progress and the delegated are in the table whole; the to-dos are what is cut.
		expect(first?.states?.doing).toHaveLength(2);
		expect(first?.states?.delegated).toHaveLength(12);

		// One to-do finished, one started, and two started that were past the cut: all four named.
		// The table has less room for to-dos now, so a to-do that is still open falls off its
		// end: its block is read (still open) and it is NOT reported as having left.
		const before = new Set(first?.states?.todo ?? []);
		await write(s, id, [
			setTask(s, "Own 02", "done"),
			setTask(s, "Own 03", "doing"),
			setTask(s, "Own 50", "doing"),
			setTask(s, "Own 51", "doing"),
		]);
		await request(id);
		const second = await latest(id);
		const after = new Set(second?.states?.todo ?? []);
		const fellOff = [...before].filter(
			(address) =>
				!after.has(address) &&
				address !== s.task["Own 02"]?.address &&
				address !== s.task["Own 03"]?.address,
		);
		expect(fellOff.length).toBeGreaterThanOrEqual(1);
		expect(named(second)).toEqual([
			"done:Own 02<todo",
			"started:Own 03<todo",
			"started:Own 50",
			"started:Own 51",
		]);
		expect(second?.changed).toBe(4);
		expect(size(second)).toBeLessThanOrEqual(60);
		expect(JSON.stringify(second).length).toBeLessThan(8192);
	});

	test("the model's text is the view's text, byte for byte, whatever the reader's row says", async () => {
		const { loadContextUpdate } = await import("../../narrator-epochs");
		const id = await session();
		const s = await seed(id, ["Add tests", "Fix the race"]);
		await write(s, id, [setTask(s, "Add tests", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Fix the race", "doing")]);
		await request(id);
		await write(s, id, [setTask(s, "Add tests", "done")]);
		await request(id);
		const rows = await updates(id);
		expect(rows).toHaveLength(2);
		expect(named(rows[1]?.view ?? null)).toEqual(["done:Add tests<doing"]);
		resetOutlineViewCache();
		const text = await outlineTasksView(id, "en");
		const loaded = await loadContextUpdate(contextUpdateOf(rows[1]?.block) as never);
		expect(loaded.changes).toEqual([{ key: KEY, value: text }]);
		// Nothing of the reader's summary is in what the model reads: not the table, not the
		// finished task (which only the reader's changes name).
		for (const word of ["states", "kind", "Add tests"]) {
			expect(loaded.modelText ?? "").not.toContain(word);
			expect(JSON.stringify(loaded.changes)).not.toContain(word);
		}
		expect(loaded.modelText).toBe(renderContextUpdate([{ key: KEY, value: text }]));
	});
});

describe("refineTasksViewDisplay", () => {
	const view = (extra: Partial<OutlineTasksViewDisplay> = {}): OutlineTasksViewDisplay => ({
		doing: [],
		waiting: [],
		next: [],
		counts: { doing: 0, waiting: 0, todo: 0 },
		...extra,
	});

	test("a previous row without a state table (written before them) is no baseline", async () => {
		const current = view({ states: { doing: ["s/a"] } });
		expect(await refineTasksViewDisplay({ previous: view(), current })).toBe(current);
		expect(await refineTasksViewDisplay({ previous: undefined, current })).toBe(current);
		expect(await refineTasksViewDisplay({ previous: "junk", current })).toBe(current);
		// Nor is a current value that is not a view touched.
		expect(await refineTasksViewDisplay({ previous: null, current: 7 })).toBe(7);
		// A view that goes away with nothing to compare with stays null.
		expect(await refineTasksViewDisplay({ previous: undefined, current: null })).toBeNull();
		expect(await refineTasksViewDisplay({ previous: null, current: null })).toBeNull();
	});

	test("a task whose space is gone is removed; a failed read is counted, not guessed", async () => {
		const previous = view({ states: { doing: ["no-such-space/abc"], todo: ["broken"] } });
		const refined = (await refineTasksViewDisplay({
			previous,
			current: view({ states: {} }),
		})) as OutlineTasksViewDisplay;
		// Neither has a title to name it by: both are counted.
		expect(refined.changes).toEqual([]);
		expect(refined.changed).toBe(2);
	});

	test("titles too long for the row: the changes give way, the list stays", async () => {
		const long = (n: number) => `${n} ${"长".repeat(118)}`;
		const tasks = (prefix: string, n: number) =>
			Array.from({ length: n }, (_, i) => ({ address: `s/${prefix}${i}`, title: long(i) }));
		const current = view({
			doing: tasks("d", 5),
			waiting: tasks("w", 5),
			next: tasks("t", 1),
			delegated: tasks("g", 5),
			states: {
				doing: tasks("d", 5).map((t) => t.address),
				delegated: tasks("g", 5).map((t) => t.address),
				waiting: tasks("w", 5).map((t) => t.address),
				todo: ["s/t0"],
			},
		});
		const refined = await refineTasksViewDisplay({ previous: view({ states: {} }), current });
		expect(refined).toBe(current);
	});
});

describe("the baseline is the session's previous row of the same epoch", () => {
	const row = (id: string, epochId: string, keys: string, display?: Record<string, unknown>) =>
		({
			id,
			role: "sys",
			contentText: `Context updated: ${keys}`,
			contentJson: [
				{ type: "text", text: `Context updated: ${keys}` },
				{ type: "context_update", epochId, changes: [], ...(display ? { display } : {}) },
			],
		}) as unknown as DbMessage;

	test("the latest row of the epoch that changed the part, whatever it stored", () => {
		const messages = [
			row("1", "e1", KEY, { [KEY]: { v: 1 } }),
			row("2", "e1", "outline.behavior"),
			{ id: "3", role: "user", contentText: "hi", contentJson: [{ type: "text", text: "hi" }] },
			row("4", "e1", `${KEY}, outline.behavior`, { [KEY]: { v: 2 } }),
			row("5", "e1", "outline.behavior"),
		] as DbMessage[];
		expect(previousContextDisplay(messages, "e1", KEY)).toEqual({ v: 2 });
		// A removal is a baseline too (an empty list).
		expect(
			previousContextDisplay([...messages, row("6", "e1", KEY, { [KEY]: null })], "e1", KEY),
		).toBeNull();
		// A later row that changed the part without storing a summary hides the older one: what the
		// session saw last is unknown, and an older list would name changes that are not.
		expect(previousContextDisplay([...messages, row("6", "e1", KEY)], "e1", KEY)).toBeUndefined();
		// Rows of another epoch (before a compact or a model switch) are not what this one saw.
		expect(previousContextDisplay(messages, "e2", KEY)).toBeUndefined();
		expect(previousContextDisplay(messages, undefined, KEY)).toBeUndefined();
		expect(previousContextDisplay([], "e1", KEY)).toBeUndefined();
		// No row of the epoch changed the part: what the epoch's baseline stored, when it did.
		expect(previousContextDisplay([], "e1", KEY, { [KEY]: { v: 0 } })).toEqual({ v: 0 });
		expect(previousContextDisplay([], "e1", KEY, { [KEY]: null })).toBeNull();
		expect(previousContextDisplay([], "e1", KEY, { other: 1 })).toBeUndefined();
		expect(previousContextDisplay(messages, "e2", KEY, { [KEY]: { v: 0 } })).toEqual({ v: 0 });
		// A fork inherits its parent's rows and marker: what the PARENT was shown is no baseline
		// for the fork, whether the row is shared (still the parent's) or copied (written by it).
		const owned = (owner: string, author: string | null) =>
			({
				...row("7", "e1", KEY, { [KEY]: { v: 7 } }),
				narratorId: owner,
				authorNarratorId: author,
			}) as DbMessage;
		expect(previousContextDisplay([owned("me", null)], "e1", KEY, undefined, "me")).toEqual({
			v: 7,
		});
		expect(previousContextDisplay([owned("me", "me")], "e1", KEY, undefined, "me")).toEqual({
			v: 7,
		});
		expect(
			previousContextDisplay([owned("parent", null)], "e1", KEY, undefined, "me"),
		).toBeUndefined();
		expect(
			previousContextDisplay([owned("me", "parent")], "e1", KEY, undefined, "me"),
		).toBeUndefined();
		// The parent's row is the latest: an older row of the fork's own does not stand in for it.
		expect(
			previousContextDisplay(
				[owned("me", null), { ...owned("parent", null), id: "8" }],
				"e1",
				KEY,
				undefined,
				"me",
			),
		).toBeUndefined();
		// The parent's marker: its baseline is the parent's too. A marker not in the history (the
		// one this request opened) is the session's own.
		const marker = (owner: string) =>
			({
				id: "e1",
				role: "system",
				narratorId: owner,
				contentText: null,
				contentJson: [{ type: "epoch" }],
			}) as unknown as DbMessage;
		expect(
			previousContextDisplay([marker("parent")], "e1", KEY, { [KEY]: { v: 0 } }, "me"),
		).toBeUndefined();
		expect(previousContextDisplay([marker("me")], "e1", KEY, { [KEY]: { v: 0 } }, "me")).toEqual({
			v: 0,
		});
		expect(previousContextDisplay([], "e1", KEY, { [KEY]: { v: 0 } }, "me")).toEqual({ v: 0 });
		// A row of the epoch always wins over its baseline, a row without a summary included.
		expect(previousContextDisplay(messages, "e1", KEY, { [KEY]: { v: 0 } })).toEqual({ v: 2 });
		expect(
			previousContextDisplay([...messages, row("6", "e1", KEY)], "e1", KEY, { [KEY]: { v: 0 } }),
		).toBeUndefined();
	});

	test("what a marker stores: the part's summary, null without the part, nothing if unread", () => {
		const view = { doing: [], states: {} };
		expect(
			baselineContextDisplays({
				parts: [{ key: KEY }, { key: "mode" }],
				displays: { [KEY]: view },
			}),
		).toEqual({ [KEY]: view });
		expect(baselineContextDisplays({ parts: [{ key: "mode" }] })).toEqual({ [KEY]: null });
		// Kept from before because it could not be read: what the session saw is not known.
		expect(baselineContextDisplays({ parts: [{ key: "mode" }], keepParts: [KEY] })).toBeUndefined();
		// In the prefix but without a summary: not known either.
		expect(baselineContextDisplays({ parts: [{ key: KEY }] })).toBeUndefined();
		// Too large to keep on a marker.
		expect(
			baselineContextDisplays({
				parts: [{ key: KEY }],
				displays: { [KEY]: { blob: "x".repeat(9000) } },
			}),
		).toBeUndefined();
	});

	test("a part without a refiner is stored as it is; a refiner that throws keeps the summary", async () => {
		const { registerContextDisplayRefiner } = await import("../../context-display-refiners");
		const display = { "test.part": { n: 1 }, "test.other": { n: 2 } };
		const base = { narratorId: "n", messages: [] as DbMessage[], epochId: "e1" };
		expect(await refineContextDisplay({ ...base, display })).toBe(display);
		registerContextDisplayRefiner("test.part", async ({ previous, current }) => ({
			previous,
			current,
		}));
		registerContextDisplayRefiner("test.other", async () => {
			throw new Error("boom");
		});
		expect(
			await refineContextDisplay({
				...base,
				display,
				messages: [row("1", "e1", "test.part", { "test.part": { n: 0 } })],
			}),
		).toEqual({
			"test.part": { previous: { n: 0 }, current: { n: 1 } },
			"test.other": { n: 2 },
		});
	});
});
