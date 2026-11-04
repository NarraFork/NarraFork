/**
 * The reader's summary of the current-tasks view on its `context_update` rows (task notices,
 * PR-1): an update that changes `outline.tasks` stores, beside the model-facing update, the tasks
 * the view listed (titled, by address) and how many are open, so the transcript's line can name
 * the current task. The summary is never part of the change key and never reaches the model; a
 * view that goes away stores `null`; an update that changes no summarized part stores nothing.
 *
 * ISOLATION: the isolated database of `tests/preload.ts`; every case makes its own session.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { contextUpdateOf } from "@shared/prefix-context";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { buildEffectiveSystemPrompt } from "../../narrator-prompt";
import { narratorService } from "../../narrator-service";
import { taskSourceForNarrator } from "../index";
import { resetOutlineViewCache } from "../outline-views";
import { seedBehaviorPage, seedOutlineTasks, taskState } from "./outline-task-source-scenarios";

const NOW = "2026-11-04T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
	settings.anthropicProviders = [
		{
			id: "display-p",
			name: "Display",
			prefix: "display-p",
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-sonnet-5-5",
			officialApi: false,
		},
	];
});
afterEach(() => {
	resetOutlineViewCache();
});

async function session(): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
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

/** One provider request's prefix reconciliation, with the session's views as context parts. */
async function request(id: string) {
	const { reconcileEpoch } = await import("../../narrator-epochs");
	// A change lands as an outline commit; the cached view is dropped by its event, but the
	// reconciliation here runs right after, so read the views fresh.
	resetOutlineViewCache();
	const built = await buildEffectiveSystemPrompt({
		basePrompt: null,
		cwd: "/tmp",
		locale: "en",
		taskSection: "outline",
		runtimeHints: "runtime",
		contextParts: await (await taskSourceForNarrator(id)).contextParts("en"),
	});
	return await reconcileEpoch({
		narratorId: id,
		messages: [],
		managed: new Set<string>(),
		current: [],
		candidates: [],
		model: "claude-sonnet-5-5",
		provider: "display-p",
		registryRevision: "r",
		prompt: {
			contract: built.contract,
			parts: built.parts,
			keepParts: built.keepParts,
			displays: built.displays,
		},
		noticeText: (kind, name) => `${kind}: ${name}`,
		resolveTarget: (model, p) => ({ fingerprint: `${p}:${model}`, cacheTtlMs: 1 }),
	});
}

/** The session's `context_update` rows: their notice text and stored block. */
async function updates(id: string) {
	const rows: Array<{ text: string | null; block: Record<string, unknown> }> = [];
	for (const row of await narratorService.getModelHistorySinceLastCompact(id)) {
		for (const block of Array.isArray(row.contentJson) ? row.contentJson : []) {
			if (contextUpdateOf(block)) rows.push({ text: row.contentText, block: block as never });
		}
	}
	return rows;
}

describe("the view's summary names only what its text names", () => {
	test("tasks the text leaves out for its budget are counted, never named", async () => {
		const id = await session();
		const long = (n: number) => `Task ${n} ${"x".repeat(110)}`;
		await seedOutlineTasks(id, [
			...Array.from({ length: 5 }, (_, i) => ({ text: long(i), status: "doing" as const })),
			...Array.from({ length: 5 }, (_, i) => ({ text: long(10 + i), status: "blocked" as const })),
			{ text: "The next todo", status: "todo" as const },
		]);
		const [part] = await (await taskSourceForNarrator(id)).contextParts("en");
		const text = part?.text ?? "";
		const display = part?.display as {
			doing: Array<{ title: string }>;
			waiting: Array<{ title: string }>;
			next: Array<{ title: string }>;
			counts: { doing: number; waiting: number; todo: number };
		};
		// The budget cut the text short of some tasks...
		expect(text).toContain("more; read `session/` with OutlineRead.");
		const named = [...display.doing, ...display.waiting, ...display.next].map((t) => t.title);
		expect(named.length).toBeGreaterThan(0);
		expect(named.length).toBeLessThan(11);
		// ...and the summary names none of those, while still counting every open task.
		for (const title of named) expect(text).toContain(title);
		expect(display.next).toEqual([]);
		expect(display.counts).toEqual({ doing: 5, waiting: 5, todo: 1 });
	});
});

describe("context_update rows of the current-tasks view", () => {
	test("store the view's summary beside the update; the model's update is unchanged", async () => {
		const { loadContextUpdate } = await import("../../narrator-epochs");
		const id = await session();
		await seedOutlineTasks(id, [
			{ text: "Write the parser", status: "doing", protected: true },
			{ text: "Write the docs", status: "todo" },
		]);
		await request(id);
		// The first request is the baseline: no update row.
		expect(await updates(id)).toEqual([]);

		await seedOutlineTasks(id, [
			{ text: "Write the docs", status: "doing" },
			{ text: "Tag the build", status: "todo" },
			{ text: "Announce it", status: "todo" },
		]);
		const docs = await taskState(id, "Write the docs");
		const tag = await taskState(id, "Tag the build");
		await request(id);
		const [row] = await updates(id);
		expect(row?.text).toBe("Context updated: outline.tasks");
		expect(row?.block.display).toEqual({
			"outline.tasks": {
				doing: [{ address: docs.address, title: "Write the docs" }],
				waiting: [],
				next: [{ address: tag.address, title: "Tag the build" }],
				counts: { doing: 1, waiting: 0, todo: 2 },
			},
		});
		// What the model reads (the frozen update text and its changes) is the view's text alone:
		// the summary rides beside it like the row's snapshot reference, never inside it.
		const loaded = await loadContextUpdate(contextUpdateOf(row?.block) as never);
		const value = loaded.changes.find((change) => change.key === "outline.tasks")?.value ?? "";
		expect(value).toContain(`\`${docs.address}\` Write the docs`);
		expect(JSON.stringify(loaded.changes)).not.toContain("counts");
		expect(loaded.modelText ?? "").toContain("<context_update>");
		expect(loaded.modelText ?? "").not.toContain("counts");
	});

	test("a view that goes away stores null; a change of another part stores no summary", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push the main branch.");
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		await request(id);
		// Every task gone: the view is removed, and the row says so for the reader.
		await seedOutlineTasks(id, []);
		await request(id);
		const removed = await updates(id);
		expect(removed).toHaveLength(1);
		expect(removed[0]?.block.display).toEqual({ "outline.tasks": null });
		// Only the behavior boundary changes: an update without a summary, written as before.
		const { writeOutline } = await import("../../outline/write");
		const { ensureSessionSpace } = await import("../../outline/spaces");
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: { id: pageId }, content: "Ask first." }],
			actor: { kind: "system", id: "test" },
			responsibleUserId: null,
		} as never);
		await request(id);
		const all = await updates(id);
		expect(all).toHaveLength(2);
		expect(all[1]?.text).toBe("Context updated: outline.behavior");
		expect(all[1]?.block.display).toBeUndefined();
	});
});
