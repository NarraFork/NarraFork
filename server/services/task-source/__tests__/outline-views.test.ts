/**
 * The built-in views of an outline session (outline P2, PR 4): the current-tasks view and the
 * behavior view, their cache, how they reach the request prefix (first turn, only on change,
 * after a compact), the behavior page (the import of an old fence, the agent's one-shot grant,
 * fork copies), the compact context, the turn-end note, and that spec sessions are unchanged.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is switched on before each case (the preload restores settings after it).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { contextUpdateOf, type PromptPart } from "@shared/prefix-context";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineCommits, users } from "../../../db/schema";
import {
	grantBehaviorFenceEdit,
	hasBehaviorFenceEditGrant,
} from "../../../lib/agent/tools/behavior-fence-grant";
import { outlineEditTool } from "../../../lib/agent/tools/outline";
import type { ToolContext } from "../../../lib/agent/types";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { withRuntimePolicyTrait } from "../../../lib/runtime-policy-trait";
import { settings } from "../../../lib/settings";
import { startNarratorRun } from "../../agent-runtime/run";
import { compileDelegationCeiling } from "../../custom-subagent-service";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../../narrator-executor";
import * as executor from "../../narrator-executor";
import { buildEffectiveSystemPrompt } from "../../narrator-prompt";
import { narratorService } from "../../narrator-service";
import {
	maybeDeliverOutlineTurnEndNote,
	prepareOutlineRun,
	setSpecBehaviorFenceForPlugin,
} from "../../narrator-session";
import type { ActiveNarrator } from "../../narrator-session-state";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import { writeOutline } from "../../outline/write";
import { readSpecFile, writeSpecFile } from "../../spec-vfs-service";
import { taskSourceForNarrator } from "../index";
import {
	copyOutlineBehaviorPage,
	findBehaviorPage,
	importOutlineBehaviorFence,
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
	resetOutlineBehaviorImport,
} from "../outline-behavior";
import { OUTLINE_VIEW_LIMITS, resetOutlineViewCache } from "../outline-views";
import { seedBehaviorPage, seedOutlineTasks, taskState } from "./outline-task-source-scenarios";

const NOW = "2026-11-02T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
	resetOutlineBehaviorImport();
});

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	resetOutlineViewCache();
});

async function user(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `outline-views-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(
	options: { backend?: "spec" | "outline"; owner?: string | null } = {},
): Promise<string> {
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
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner ?? null,
		autoContinuationOverride: "off",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagent(rootId: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		variant: "subagent:general",
		subagentType: "general",
		parentNarratorId: rootId,
		aclRootNarratorId: rootId,
		traits: withRuntimePolicyTrait(
			["standalone"],
			await compileDelegationCeiling("general", { outlineSession: true }),
		),
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** Write a session's old fence as it was written before PR 4 (the switch off: a spec write). */
async function oldFence(narratorId: string, text: string): Promise<void> {
	settings.outline.enabled = false;
	try {
		await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
	} finally {
		settings.outline.enabled = true;
	}
}

async function parts(narratorId: string, locale: "en" | "zh-CN" = "en"): Promise<PromptPart[]> {
	return await (await taskSourceForNarrator(narratorId)).contextParts(locale);
}

const part = (list: PromptPart[], key: string) => list.find((p) => p.key === key)?.text ?? null;

async function addressOf(blockId: string): Promise<string> {
	const [block] = await outlineStore.getBlocks([blockId]);
	const space = block ? await outlineStore.getSpace(block.spaceId) : null;
	return `${space?.key}/${block?.sid}`;
}

/** Append blocks under a page as a person, in commits of at most 150. */
async function personAdds(narratorId: string, pageId: string, contents: string[]): Promise<void> {
	const space = await ensureSessionSpace(narratorId);
	for (let i = 0; i < contents.length; i += 150) {
		await writeOutline({
			spaceId: space.id,
			ops: contents.slice(i, i + 150).map((content) => ({
				op: "insert" as const,
				parent: { id: pageId },
				content,
			})),
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The current-tasks view
// ─────────────────────────────────────────────────────────────────────────────

describe("the current-tasks view", () => {
	test("absent without open tasks; at most five in progress, titles clipped, within budget", async () => {
		const id = await session();
		expect(part(await parts(id), "outline.tasks")).toBeNull();
		const long = (n: number) => `Task ${n} ${"x".repeat(200)}`;
		await seedOutlineTasks(
			id,
			Array.from({ length: 12 }, (_, n) => ({ text: long(n), status: "doing" as const })),
		);
		const text = part(await parts(id), "outline.tasks") ?? "";
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.tasksChars);
		const lines = text.split("\n").filter((line) => line.startsWith("- [/]"));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.doing);
		for (const line of lines) {
			const title = line.replace(/^- \[\/\] `[^`]+` /, "");
			expect(title.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.titleChars);
			expect(title.endsWith("…")).toBe(true);
		}
		expect(text).toContain(`${12 - lines.length} more; read \`session/\` with OutlineRead.`);
		// Finishing everything removes the view.
		await seedOutlineTasks(id, [{ text: "All done", status: "done" }]);
		expect(part(await parts(id), "outline.tasks")).toBeNull();
	});

	test("deterministic: the same tasks read again (a lease renewed meanwhile) give the same text", async () => {
		const id = await session();
		await seedOutlineTasks(id, [
			{ text: "Write the parser", status: "doing" },
			{ text: "Write the printer", status: "todo" },
		]);
		const first = await parts(id);
		await outlineStore.renewTaskClaims(id, "2099-01-01T00:00:00.000Z");
		resetOutlineViewCache();
		expect(await parts(id)).toEqual(first);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The behavior view
// ─────────────────────────────────────────────────────────────────────────────

describe("the behavior view", () => {
	test("the page and the narrator's own plugin SOP; a subagent gets the root's page and its own SOP", async () => {
		const root = await session();
		const pageId = await seedBehaviorPage(root, "Never force-push the main branch.");
		const address = await addressOf(pageId);
		await setSpecBehaviorFenceForPlugin(root, "Report to the session lead.", "upsert");
		const sub = await subagent(root);
		await setSpecBehaviorFenceForPlugin(sub, "Report to the worker lead.", "upsert");

		const rootView = part(await parts(root), "outline.behavior") ?? "";
		expect(rootView).toBe(
			[
				"Behavior boundary (standing constraints the user set; always follow them)",
				`From this session's behavior page \`${address}\`:`,
				"- Behavior boundary",
				"  - Never force-push the main branch.",
				"Plugin SOP:",
				"Report to the session lead.",
			].join("\n"),
		);
		const subParts = await parts(sub);
		// A subagent has no tasks of its own (D27c): only the boundary.
		expect(subParts.map((p) => p.key)).toEqual(["outline.behavior"]);
		const subView = part(subParts, "outline.behavior") ?? "";
		expect(subView).toContain("Never force-push the main branch.");
		expect(subView).toContain(address);
		expect(subView).toContain("Report to the worker lead.");
		expect(subView).not.toContain("Report to the session lead.");

		const zh = part(await parts(root, "zh-CN"), "outline.behavior") ?? "";
		expect(zh).toContain("行为边界（用户设定的长期约束，务必遵守）");
		expect(zh).toContain(`来自本会话的行为边界页 \`${address}\``);
		expect(zh).toContain("插件 SOP：");
	});

	test("a page over the budget is cut within 4000 characters and names its address", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule zero.");
		await personAdds(
			id,
			pageId,
			Array.from({ length: 300 }, (_, n) => `Rule ${n}: ${"keep this constraint ".repeat(4)}`),
		);
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(view).toContain("Rule zero.");
		expect(view).toContain(
			`‹not all shown; read \`${await addressOf(pageId)}\` with OutlineRead for the whole page›`,
		);
	});

	test("fence text the import has not moved yet is shown from the old fence", async () => {
		const id = await session();
		await oldFence(id, "Always run the tests before committing.");
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).toContain(
			"From this session's old behavior fence (not moved to the behavior page yet):",
		);
		expect(view).toContain("Always run the tests before committing.");
		expect(await (await taskSourceForNarrator(id)).behaviorFence()).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The cache
// ─────────────────────────────────────────────────────────────────────────────

describe("the view cache", () => {
	function countReads() {
		const counts = { findSpace: 0, listOpenTasks: 0, findAliasOwners: 0 };
		for (const name of Object.keys(counts) as Array<keyof typeof counts>) {
			const real = outlineStore[name].bind(outlineStore) as (...args: unknown[]) => unknown;
			const spy = spyOn(outlineStore, name).mockImplementation(((...args: unknown[]) => {
				counts[name]++;
				return real(...args);
			}) as never);
			restores.push(() => spy.mockRestore());
		}
		return counts;
	}
	const total = (counts: Record<string, number>) =>
		Object.values(counts).reduce((sum, n) => sum + n, 0);

	test("a hit reads nothing; a commit in its space drops it; one elsewhere does not", async () => {
		const id = await session();
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		await seedBehaviorPage(id, "Never force-push.");
		const first = await parts(id);
		const counts = countReads();
		expect(await parts(id)).toEqual(first);
		expect(total(counts)).toBe(0);

		// Another session's commit: still a hit (the counts are the views' reads only).
		const other = await session();
		await seedOutlineTasks(other, [{ text: "Unrelated", status: "todo" }]);
		for (const name of Object.keys(counts) as Array<keyof typeof counts>) counts[name] = 0;
		expect(await parts(id)).toEqual(first);
		expect(total(counts)).toBe(0);

		// A person ticks the task in this session's space: read again, and changed.
		const { block } = await taskState(id, "Write the parser");
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: block.id }, task: { status: "done" } }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const after = await parts(id);
		expect(total(counts)).toBeGreaterThan(0);
		expect(part(after, "outline.tasks")).toBeNull();
		expect(part(after, "outline.behavior")).toBe(part(first, "outline.behavior"));
	});

	test("an entry lasts sixty seconds at most; a plugin's SOP change drops the behavior view", async () => {
		let now = 1_000_000;
		resetOutlineViewCache(() => now);
		const id = await session();
		await seedBehaviorPage(id, "Never force-push.");
		const first = await parts(id);
		const counts = countReads();
		now += OUTLINE_VIEW_LIMITS.maxAgeMs - 1;
		await parts(id);
		expect(total(counts)).toBe(0);
		now += 2;
		expect(await parts(id)).toEqual(first);
		expect(total(counts)).toBeGreaterThan(0);

		await setSpecBehaviorFenceForPlugin(id, "Report back.", "upsert");
		expect(part(await parts(id), "outline.behavior")).toContain("Plugin SOP:\nReport back.");
	});

	test("read while the session had no space: its first commit anywhere drops it", async () => {
		const id = await session();
		expect(await parts(id)).toEqual([]);
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		expect(part(await parts(id), "outline.tasks")).toContain("Write the parser");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The views in the request prefix (D27e): first turn, only on change, after a compact
// ─────────────────────────────────────────────────────────────────────────────

describe("the views in the request prefix", () => {
	const provider = "outline-views-tests";
	beforeEach(() => {
		settings.anthropicProviders = [
			{
				id: provider,
				name: "Outline views",
				prefix: provider,
				apiKey: "isolated-no-network",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-5-5",
				officialApi: false,
			},
		];
	});

	test("in the first baseline; one update per change, none without; in the baseline after a compact", async () => {
		const { reconcileEpoch, loadContextUpdate } = await import("../../narrator-epochs");
		const { narratorPersistence } = await import("../../narrator-persistence");
		const id = await session();
		await seedOutlineTasks(id, [
			{ text: "Write the parser", status: "doing" },
			{ text: "Write the printer", status: "todo" },
		]);
		const pageId = await seedBehaviorPage(id, "Never force-push the main branch.");
		const space = await ensureSessionSpace(id);

		const request = async (contract = "Fixed contract") => {
			const built = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd: "/tmp",
				locale: "en",
				taskSection: "outline",
				runtimeHints: "runtime",
				contextParts: await parts(id),
			});
			return await reconcileEpoch({
				narratorId: id,
				messages: [],
				managed: new Set<string>(),
				current: [],
				candidates: [],
				model: "claude-sonnet-5-5",
				provider,
				registryRevision: "r",
				prompt: { contract: `${contract}\n${built.contract}`, parts: built.parts },
				noticeText: (kind, name) => `${kind}: ${name}`,
				resolveTarget: (model, p) => ({ fingerprint: `${p}:${model}`, cacheTtlMs: 1 }),
			});
		};
		const updates = async () => {
			const rows = await narratorService.getModelHistorySinceLastCompact(id);
			const out: Array<{ epochId: string; keys: string[]; values: Record<string, string | null> }> =
				[];
			for (const row of rows) {
				for (const block of Array.isArray(row.contentJson) ? row.contentJson : []) {
					const update = contextUpdateOf(block);
					if (!update) continue;
					const loaded = await loadContextUpdate(update);
					const changes = loaded.changes.filter((c) => c.key.startsWith("outline."));
					if (changes.length === 0) continue;
					out.push({
						epochId: loaded.epochId,
						keys: changes.map((c) => c.key),
						values: Object.fromEntries(changes.map((c) => [c.key, c.value])),
					});
				}
			}
			return out;
		};

		// First turn: both views are in the baseline, after `runtime`.
		const first = await request();
		expect(first.opened).toBe(true);
		const baseline = first.systemPrompt ?? "";
		expect(baseline).toContain("## Context: outline.tasks");
		expect(baseline).toContain("Write the parser");
		expect(baseline).toContain("## Context: outline.behavior");
		expect(baseline).toContain("Never force-push the main branch.");
		expect(baseline.indexOf("## Context: runtime")).toBeLessThan(
			baseline.indexOf("## Context: outline.tasks"),
		);
		expect(baseline.indexOf("## Context: outline.tasks")).toBeLessThan(
			baseline.indexOf("## Context: outline.behavior"),
		);

		// Nothing changed: requests append nothing.
		await request();
		await request();
		expect(await updates()).toEqual([]);

		// The person adds a rule: exactly one update, for the behavior view only.
		await personAdds(id, pageId, ["Ask before deleting files."]);
		await request();
		await request();
		const afterRule = await updates();
		expect(afterRule).toHaveLength(1);
		expect(afterRule[0]?.keys).toEqual(["outline.behavior"]);
		expect(afterRule[0]?.values["outline.behavior"]).toContain("Ask before deleting files.");

		// The agent ticks its task done: one update for the tasks view.
		const { block } = await taskState(id, "Write the parser");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: block.id }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: null,
		});
		await request();
		const afterTick = await updates();
		expect(afterTick).toHaveLength(2);
		expect(afterTick[1]?.keys).toEqual(["outline.tasks"]);
		expect(afterTick[1]?.values["outline.tasks"]).not.toContain("Write the parser");

		// A compact: the new baseline carries the boundary again, unchanged or not, and its epoch
		// has no updates of its own.
		const compact = await narratorPersistence.persistCompactingMessage(id);
		await narratorPersistence.finalizeCompactingMessage(compact.id, id, "Summary of the work");
		const compacted = await request("Fixed contract\nSummary of the work");
		expect(compacted.epoch?.reason).toBe("compact");
		expect(compacted.systemPrompt).toContain("## Context: outline.behavior");
		expect(compacted.systemPrompt).toContain("Never force-push the main branch.");
		expect(compacted.systemPrompt).toContain("Ask before deleting files.");
		await request("Fixed contract\nSummary of the work");
		expect(await updates()).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The behavior page: the import, the agent's grant, forks
// ─────────────────────────────────────────────────────────────────────────────

describe("importing an old fence", () => {
	test("its text becomes the page in one import commit; the fence keeps only the plugin SOP", async () => {
		const owner = await user();
		const id = await session({ owner });
		await oldFence(id, "- Never force-push.\n- Ask before deleting files.");
		await setSpecBehaviorFenceForPlugin(id, "Report to the lead.", "upsert");
		expect(await importOutlineBehaviorFence(id, "zh-CN")).toBe("imported");

		const space = await ensureSessionSpace(id);
		const page = await findBehaviorPage(space.id);
		expect(page).not.toBeNull();
		const commits = await db
			.select()
			.from(outlineCommits)
			.where(eq(outlineCommits.spaceId, space.id));
		expect(commits).toHaveLength(1);
		expect(commits[0]).toMatchObject({
			kind: "import",
			actorKind: "system",
			actorId: OUTLINE_BEHAVIOR_IMPORT_ACTOR,
			narratorId: id,
			responsibleUserId: owner,
		});
		const children = await outlineStore.listChildren(space.id, page?.id ?? "", 10);
		expect(children.map((b) => b.content)).toEqual([
			"Never force-push.",
			"Ask before deleting files.",
		]);
		expect(children.every((b) => b.taskJson === null)).toBe(true);
		const [pageRow] = await outlineStore.getBlocks([page?.id ?? ""]);
		expect(pageRow?.content).toBe("行为边界");

		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).not.toContain("force-push");
		expect(fence).toContain("Report to the lead.");

		// Asked once: a second run imports nothing, and after a restart there is nothing left.
		expect(await importOutlineBehaviorFence(id, "en")).toBe("nothing");
		resetOutlineBehaviorImport(id);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("nothing");
		expect(
			await db.select().from(outlineCommits).where(eq(outlineCommits.spaceId, space.id)),
		).toHaveLength(1);
		// The view now shows the page and the SOP.
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).toContain("  - Never force-push.");
		expect(view).toContain("Plugin SOP:\nReport to the lead.");
		expect(view).not.toContain("old behavior fence");
	});

	test("an existing page gets the text appended; no fence text, no import; subagents and spec never", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Existing rule.");
		await oldFence(id, "Imported rule.");
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		const space = await ensureSessionSpace(id);
		expect((await outlineStore.listChildren(space.id, pageId, 10)).map((b) => b.content)).toEqual([
			"Existing rule.",
			"Imported rule.",
		]);

		const empty = await session();
		expect(await importOutlineBehaviorFence(empty, "en")).toBe("nothing");
		expect(await outlineStore.findSpace({ kind: "session", narratorId: empty })).toBeNull();

		const spec = await session({ backend: "spec" });
		await writeSpecFile(spec, "spec://behavior_fence", "Spec rule.", { actor: "user" });
		expect(await importOutlineBehaviorFence(spec, "en")).toBe("nothing");
		expect((await readSpecFile(spec, "spec://behavior_fence")).content).toBe("Spec rule.");

		const sub = await subagent(id);
		expect(await importOutlineBehaviorFence(sub, "en")).toBe("nothing");
	});

	test("a run of the session imports before its first prompt", async () => {
		const id = await session();
		await oldFence(id, "Never force-push.");
		const active = { narratorId: id, locale: "en" } as unknown as ActiveNarrator;
		await prepareOutlineRun(active);
		const space = await ensureSessionSpace(id);
		expect(await findBehaviorPage(space.id)).not.toBeNull();
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("");
	});
});

describe("the agent writing the behavior page", () => {
	async function agent() {
		const owner = await user();
		const id = await session({ owner });
		const ctx = {
			narratorId: id,
			cwd: "/tmp",
			signal: new AbortController().signal,
			locale: "en",
			userId: owner,
			requestPermission: async () => ({ behavior: "allow" }),
		} as unknown as ToolContext;
		const edit = (edits: unknown[]) => outlineEditTool.execute({ edits }, ctx);
		return { id, owner, edit };
	}

	test("refused without the user turn's grant; allowed once with it", async () => {
		const { id, edit } = await agent();
		const pageId = await seedBehaviorPage(id, "Never force-push.");
		const page = await addressOf(pageId);
		const add = () => edit([{ add: page, markdown: "- Ask before deleting files." }]);

		const refused = await add();
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("behavior page of this session");
		const space = await ensureSessionSpace(id);
		expect((await outlineStore.listChildren(space.id, pageId, 10)).map((b) => b.content)).toEqual([
			"Never force-push.",
		]);

		grantBehaviorFenceEdit(id);
		const allowed = await add();
		expect(allowed.isError).toBeFalsy();
		expect(hasBehaviorFenceEditGrant(id)).toBe(false);
		expect((await outlineStore.listChildren(space.id, pageId, 10)).map((b) => b.content)).toEqual([
			"Never force-push.",
			"Ask before deleting files.",
		]);

		// One-shot: the next write is refused again.
		const again = await edit([{ add: page, markdown: "- One more rule." }]);
		expect(again.isError).toBe(true);
	});

	test("creating the page, giving the alias and moving blocks onto it count; other pages do not", async () => {
		const { id, edit } = await agent();
		// Creating the page with the alias.
		const create = await edit([
			{ add: "session/", markdown: "- Behavior boundary\n  alias:: behavior\n  - Rule." },
		]);
		expect(create.isError).toBe(true);
		const space = await ensureSessionSpace(id);
		expect(await findBehaviorPage(space.id)).toBeNull();

		// An ordinary page of the session space is the agent's to write, grant or not, and does
		// not spend the grant.
		grantBehaviorFenceEdit(id);
		const notes = await edit([{ add: "session/", markdown: "- Notes\n  - A finding." }]);
		expect(notes.isError).toBeFalsy();
		expect(hasBehaviorFenceEditGrant(id)).toBe(true);
		const notesPage = (await outlineStore.listChildMetas(space.id, [null], 10))[0];
		const notesAddress = await addressOf(notesPage?.id ?? "");

		// Giving that page the alias needs the grant (spent here).
		const named = await edit([{ set: notesAddress, alias: "behavior" }]);
		expect(named.isError).toBeFalsy();
		expect((await findBehaviorPage(space.id))?.id).toBe(notesPage?.id);

		// Moving a block of its own onto the page needs it again.
		const other = await edit([{ add: "session/", markdown: "- Scratch\n  - Move me." }]);
		expect(other.isError).toBeFalsy();
		const scratch = (await outlineStore.listChildMetas(space.id, [null], 10)).find(
			(b) => b.id !== notesPage?.id,
		);
		const [moveMe] = await outlineStore.listChildMetas(space.id, [scratch?.id ?? null], 10);
		const moved = await edit([{ move: await addressOf(moveMe?.id ?? ""), to: notesAddress }]);
		expect(moved.isError).toBe(true);
		expect(moved.output).toContain("behavior page of this session");
	});

	test("people and system writes are not asked; another session's or space's alias is no page", async () => {
		const { id } = await agent();
		const pageId = await seedBehaviorPage(id, "Rule.");
		await personAdds(id, pageId, ["A person's rule."]);
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: { id: pageId }, content: "A system rule." }],
			actor: { kind: "system", id: "test" },
			narratorId: id,
			responsibleUserId: null,
		});
		expect((await outlineStore.listChildren(space.id, pageId, 10)).map((b) => b.content)).toEqual([
			"Rule.",
			"A person's rule.",
			"A system rule.",
		]);
	});
});

describe("forks copy the behavior page", () => {
	test("a fork of an outline session gets the page with its short ids; the rest is not copied", async () => {
		const owner = await user();
		const parent = await session({ owner });
		const pageId = await seedBehaviorPage(parent, "Never force-push.");
		await seedOutlineTasks(parent, [{ text: "Parent task", status: "todo" }]);
		const child = await narratorService.forkNarrator(parent, null, { userId: owner });
		const childSpace = await ensureSessionSpace(child.id);
		const page = await findBehaviorPage(childSpace.id);
		const [parentPage] = await outlineStore.getBlocks([pageId]);
		expect(page?.sid).toBe(parentPage?.sid);
		expect(
			(await outlineStore.listChildren(childSpace.id, page?.id ?? "", 10)).map((b) => b.content),
		).toEqual(["Never force-push."]);
		expect(await outlineStore.listChildMetas(childSpace.id, [null], 10)).toHaveLength(1);
		expect(part(await parts(child.id), "outline.behavior")).toContain("Never force-push.");
		expect(part(await parts(child.id), "outline.tasks")).toBeNull();
		// Copying again changes nothing.
		expect(await copyOutlineBehaviorPage(parent, child.id)).toBe(false);
	});

	test("a spec parent, or an outline parent without a page, copies nothing", async () => {
		const spec = await session({ backend: "spec" });
		const specChild = await session({ backend: "spec" });
		expect(await copyOutlineBehaviorPage(spec, specChild)).toBe(false);
		const bare = await session();
		const bareChild = await session();
		expect(await copyOutlineBehaviorPage(bare, bareChild)).toBe(false);
		expect(await outlineStore.findSpace({ kind: "session", narratorId: bareChild })).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Compact context (decision 2026-11-02 Q3: source C)
// ─────────────────────────────────────────────────────────────────────────────

describe("the compact context", () => {
	test("open tasks with addresses and waits, the notes recorded since the last compact, the request", async () => {
		const id = await session();
		await seedOutlineTasks(id, [
			{ text: "Write the parser", status: "doing" },
			{ text: "Waiting on access", status: "blocked" },
		]);
		const space = await ensureSessionSpace(id);
		const { block } = await taskState(id, "Write the parser");
		// The session records a decision under its task (a long one: its first line is clipped).
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					parent: { id: block.id },
					content: `Decision: use a Pratt parser ${"since precedence matters ".repeat(10)}`,
				},
			],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: null,
		});
		const source = await taskSourceForNarrator(id);
		const parser = await taskState(id, "Write the parser");
		const waiting = await taskState(id, "Waiting on access");
		const en = (await source.compactContext("en", { since: null })) ?? "";
		expect(en).toContain(`- [doing] \`${parser.address}\` Write the parser`);
		expect(en).toContain(`- [waiting] \`${waiting.address}\` Waiting on access ‹waiting on `);
		expect(en).toContain("Recorded decisions:");
		const note = en.split("\n").find((line) => line.includes("Decision: use a Pratt parser")) ?? "";
		expect(note).toMatch(/^- `[^`]+` Decision: use a Pratt parser since precedence/);
		expect(note.endsWith("…")).toBe(true);
		expect(note.replace(/^- `[^`]+` /, "").length).toBeLessThanOrEqual(160);
		// Tasks are not notes; the session's other non-task blocks are (its pages here).
		expect(en).not.toMatch(/- `[^`]+` Write the parser\n/);
		expect(en).toMatch(/- `[^`]+` Tasks\n/);
		expect(en).toContain('add a section "Key decisions"');
		expect(en.length).toBeLessThanOrEqual(6000);
		const zh = (await source.compactContext("zh-CN", { since: null })) ?? "";
		expect(zh).toContain("「关键决定」");
		expect(zh).toContain("已记录的决定");

		// Only what was written after the last compact counts.
		const later = new Date(Date.now() + 60_000).toISOString();
		expect(await source.compactContext("en", { since: later })).not.toContain("Recorded decisions");
		// Without `since` the source reads when the last compact was (none: everything).
		expect(await source.compactContext("en")).toContain("Pratt parser");
	});

	test("a session without tasks still asks for the key decisions; a subagent gets none", async () => {
		const id = await session();
		const text = await (await taskSourceForNarrator(id)).compactContext("en");
		expect(text).toContain("This session has no open tasks in the outline.");
		expect(text).toContain("Key decisions");
		const sub = await subagent(id);
		expect(await (await taskSourceForNarrator(sub)).compactContext("en")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The turn-end note (decision 2026-11-02 Q4)
// ─────────────────────────────────────────────────────────────────────────────

describe("the turn-end note", () => {
	async function notes(id: string) {
		const rows = await narratorService.getModelHistorySinceLastCompact(id);
		return rows.filter((row) =>
			(Array.isArray(row.contentJson) ? row.contentJson : []).some(
				(block) =>
					!!block &&
					typeof block === "object" &&
					(block as { source?: unknown }).source === "outline_task_turn_end",
			),
		);
	}
	async function run(id: string) {
		const active = {
			narratorId: id,
			locale: "en",
			_todoReminderCompletedToolCount: 7,
		} as unknown as ActiveNarrator;
		await prepareOutlineRun(active);
		return active;
	}

	test("left when a task is in progress, the turn made 30 tool calls and changed no task", async () => {
		const id = await session();
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		const { address } = await taskState(id, "Write the parser");
		const active = await run(id);
		active._todoReminderCompletedToolCount = 7 + 30;
		expect(await maybeDeliverOutlineTurnEndNote(active)).toBe(true);
		const rows = await notes(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.contentText).toBe(
			`System note: \`${address}\` Write the parser is still in progress; when it is done, tick it [x] with OutlineEdit.`,
		);
		expect(rows[0]?.contentText?.includes("\n")).toBe(false);
		// Once per run.
		expect(await maybeDeliverOutlineTurnEndNote(active)).toBe(false);
		expect(await notes(id)).toHaveLength(1);
	});

	test("not left with fewer than 30 tool calls, a task changed, or nothing in progress", async () => {
		const few = await session();
		await seedOutlineTasks(few, [{ text: "Write the parser", status: "doing" }]);
		const fewRun = await run(few);
		fewRun._todoReminderCompletedToolCount = 7 + 29;
		expect(await maybeDeliverOutlineTurnEndNote(fewRun)).toBe(false);

		const changed = await session();
		await seedOutlineTasks(changed, [
			{ text: "Write the parser", status: "doing" },
			{ text: "Write the printer", status: "todo" },
		]);
		const changedRun = await run(changed);
		const { block } = await taskState(changed, "Write the printer");
		const space = await ensureSessionSpace(changed);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: block.id }, content: "Write the pretty printer" }],
			actor: { kind: "agent", id: changed },
			narratorId: changed,
			responsibleUserId: null,
		});
		changedRun._todoReminderCompletedToolCount = 7 + 40;
		expect(await maybeDeliverOutlineTurnEndNote(changedRun)).toBe(false);

		const idle = await session();
		await seedOutlineTasks(idle, [{ text: "Write the parser", status: "todo" }]);
		const idleRun = await run(idle);
		idleRun._todoReminderCompletedToolCount = 7 + 40;
		expect(await maybeDeliverOutlineTurnEndNote(idleRun)).toBe(false);

		for (const id of [few, changed, idle]) expect(await notes(id)).toEqual([]);
	});

	test("spec sessions and subagents never get one", async () => {
		const spec = await session({ backend: "spec" });
		const specRun = await run(spec);
		expect(specRun._outlineTurnStart).toBeUndefined();
		specRun._todoReminderCompletedToolCount = 100;
		expect(await maybeDeliverOutlineTurnEndNote(specRun)).toBe(false);
		const root = await session();
		await seedOutlineTasks(root, [{ text: "Root work", status: "doing" }]);
		const subRun = await run(await subagent(root));
		expect(subRun._outlineTurnStart).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The cadence drain: retired for the outline, as it was for spec
// ─────────────────────────────────────────────────────────────────────────────

describe("the cadence drain", () => {
	async function drain(id: string) {
		const { drainInjectionsIntoHistory } = await import("../../narrator-session");
		const { tryClaimExecution } = await import("../../agent-runtime/ownership");
		const owner = tryClaimExecution(id, "run");
		try {
			const active = {
				narratorId: id,
				cwd: ".",
				locale: "en",
				_todoReminderCompletedToolCount: 15,
				_lastTasksReminderCompletedToolCount: 0,
				_tasksReminderInterval: 15,
				_fenceInterval: -1,
				_fenceAttach: true,
			} as unknown as ActiveNarrator;
			await drainInjectionsIntoHistory(active, "en");
		} finally {
			owner?.release();
		}
		const rows = await narratorService.getModelHistorySinceLastCompact(id);
		return rows.flatMap((row) =>
			(Array.isArray(row.contentJson) ? row.contentJson : []).flatMap((block) => {
				const source = (block as { source?: unknown } | null)?.source;
				return typeof source === "string" ? [source] : [];
			}),
		);
	}

	test("a due cadence writes no digest or fence row for an outline session, and reads nothing", async () => {
		const id = await session();
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		await seedBehaviorPage(id, "Never force-push.");
		await taskSourceForNarrator(id);
		const reads = { count: 0 };
		for (const name of [
			"findSpace",
			"listOpenTasks",
			"listClaimedTasks",
			"findAliasOwners",
		] as const) {
			const real = outlineStore[name].bind(outlineStore) as (...args: unknown[]) => unknown;
			const spy = spyOn(outlineStore, name).mockImplementation(((...args: unknown[]) => {
				reads.count++;
				return real(...args);
			}) as never);
			restores.push(() => spy.mockRestore());
		}
		expect(await drain(id)).toEqual([]);
		expect(reads.count).toBe(0);
	});

	test("a spec session's due cadence still writes its digest and its fence", async () => {
		const id = await session({ backend: "spec" });
		await writeSpecFile(id, "spec://behavior_fence", "Never force-push.", { actor: "user" });
		expect(await drain(id)).toEqual(["living_work_spec", "behavior_fence"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Spec sessions are unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("spec sessions are unchanged", () => {
	const options = {
		basePrompt: "BASE",
		cwd: "/tmp",
		contextSummary: "Earlier work.",
		planMode: true,
		planFilePath: ".narrafork/plans/p.md",
		workspaceContext: '{"cwd":"/tmp"}',
		skillsContext: "skills",
		modelsContext: "models",
		modeContext: "mode",
		runtimeHints: "runtime",
	};
	const digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

	test("the prompt is the same object with or without the spec source's parts, in both locales", async () => {
		const id = await session({ backend: "spec" });
		const source = await taskSourceForNarrator(id);
		expect(source.backend).toBe("spec");
		for (const locale of ["en", "zh-CN"] as const) {
			const specParts = await source.contextParts(locale);
			expect(specParts).toEqual([]);
			const without = await buildEffectiveSystemPrompt({ ...options, locale });
			const withParts = await buildEffectiveSystemPrompt({
				...options,
				locale,
				taskSection: "spec",
				contextParts: specParts,
			});
			expect(withParts).toEqual(without);
			expect(without.parts.map((p) => p.key)).not.toContain("outline.tasks");
		}
	});

	// The whole spec prompt for a fixed input, as PR 3 (`924aebac`) built it: computed there and
	// pinned here, so any byte of it changing fails.
	test("the full spec prompt is byte for byte what PR 3 built", async () => {
		const out: Record<string, string> = {};
		for (const locale of ["en", "zh-CN"] as const) {
			const built = await buildEffectiveSystemPrompt({ ...options, locale });
			out[locale] = digest({ prompt: built.prompt, contract: built.contract, parts: built.parts });
		}
		expect(out).toEqual(SPEC_PROMPT_DIGESTS);
	});

	test("a spec session's digest, fence and drain are read as before; its run prepares nothing", async () => {
		const id = await session({ backend: "spec" });
		await writeSpecFile(id, "spec://behavior_fence", "Never force-push.", { actor: "user" });
		const source = await taskSourceForNarrator(id);
		expect(await source.taskDigest()).toEqual({ kind: "tasks", variant: "emptyNever" });
		expect(await source.behaviorFence()).toEqual({ kind: "prose", text: "Never force-push." });
		expect(source.turnEndNote).toBeUndefined();
		const active = { narratorId: id, locale: "en" } as unknown as ActiveNarrator;
		const emitted: string[] = [];
		const listen = (event: { spaceId: string }) => {
			emitted.push(event.spaceId);
		};
		eventBus.on("outline:committed", listen);
		try {
			await prepareOutlineRun(active);
		} finally {
			eventBus.off("outline:committed", listen);
		}
		expect(active._outlineTurnStart).toBeUndefined();
		expect(emitted).toEqual([]);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("Never force-push.");
	});
});

/** See "the full spec prompt is byte for byte what PR 3 built". */
const SPEC_PROMPT_DIGESTS: Record<string, string> = {
	en: "85bd631b5545aa90",
	"zh-CN": "3f9b5c535127b3cb",
};

// ─────────────────────────────────────────────────────────────────────────────
// Through a real run (the model mocked): the import, the first prompt, the turn-end note
// ─────────────────────────────────────────────────────────────────────────────

describe("an outline session's run", () => {
	beforeEach(() => {
		settings.anthropicProviders = [
			{
				id: "outline-views-run",
				name: "Outline views run",
				prefix: "outlineviewsrun",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
			},
		];
	});

	async function outlineSession(mode: "off" | "always") {
		const owner = await user();
		const created = await narratorService.create({
			ownerUserId: owner,
			model: "outlineviewsrun:claude-sonnet-4",
			autoContinuationOverride: mode,
			startInPlanMode: false,
			cwd: "/",
		});
		expect(created.taskBackend).toBe("outline");
		const ctx = {
			narratorId: created.id,
			cwd: "/",
			signal: new AbortController().signal,
			locale: "en",
			userId: owner,
			requestPermission: async () => ({ behavior: "allow" }),
		} as unknown as ToolContext;
		return { id: created.id, owner, ctx };
	}

	async function runWith(
		id: string,
		owner: string,
		pass: (n: number, options: ExecuteLoopOptions) => Promise<void>,
	): Promise<number> {
		let passes = 0;
		const model = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			passes++;
			await pass(passes, options);
			return {
				finalText: `pass ${passes}`,
				hasError: false,
				shouldUpdateTitle: false,
				hadToolUses: true,
				completedNaturally: true,
			} satisfies ExecuteLoopResult;
		});
		restores.push(() => model.mockRestore());
		const run = await startNarratorRun({
			narratorId: id,
			text: "Work on it",
			locale: "en",
			principal: owner,
			foreground: true,
		});
		expect((await run.terminal).hasError).toBe(false);
		return passes;
	}

	/** Make the pass look like it ran `n` tool calls (what the loop reports as it completes them). */
	const ranTools = (options: ExecuteLoopOptions, n: number) =>
		options.config.onCompletedToolCount?.((options.config.initialCompletedToolCount ?? 0) + n);

	async function turnEndNotes(id: string) {
		const rows = await narratorService.getModelHistorySinceLastCompact(id);
		return rows.filter((row) =>
			(Array.isArray(row.contentJson) ? row.contentJson : []).some(
				(block) =>
					!!block &&
					typeof block === "object" &&
					(block as { source?: unknown }).source === "outline_task_turn_end",
			),
		);
	}

	test("imports the old fence before the first prompt, which carries the boundary and the tasks", async () => {
		const { id, owner } = await outlineSession("off");
		await oldFence(id, "Never force-push the main branch.");
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		const prompts: string[] = [];
		await runWith(id, owner, async (_n, options) => {
			prompts.push(options.config.systemPrompt ?? "");
		});
		expect(prompts[0]).toContain("## Context: outline.behavior");
		expect(prompts[0]).toContain("Never force-push the main branch.");
		expect(prompts[0]).not.toContain("old behavior fence");
		expect(prompts[0]).toContain("## Context: outline.tasks");
		expect(prompts[0]).toContain("Write the parser");
		const space = await ensureSessionSpace(id);
		expect(await findBehaviorPage(space.id)).not.toBeNull();
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("");
	});

	test("a long pass that leaves its task in progress untouched ends with one line, and no new turn", async () => {
		const { id, owner } = await outlineSession("off");
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		const { address } = await taskState(id, "Write the parser");
		const passes = await runWith(id, owner, async (_n, options) => {
			ranTools(options, 30);
		});
		expect(passes).toBe(1);
		const notes = await turnEndNotes(id);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.contentText).toContain(`\`${address}\` Write the parser is still in progress`);
	});

	test("no line when a continuation follows the long pass, nor once the task was ticked", async () => {
		const { id, owner, ctx } = await outlineSession("always");
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		const { address } = await taskState(id, "Write the parser");
		const passes = await runWith(id, owner, async (n, options) => {
			ranTools(options, 30);
			if (n === 2) {
				const done = await outlineEditTool.execute(
					{ edits: [{ set: address, checkbox: "x" }] },
					ctx,
				);
				expect(done.isError).toBeFalsy();
			}
		});
		// Pass 1 was continued (its task still in progress); pass 2 ticked it done.
		expect(passes).toBe(2);
		expect(await turnEndNotes(id)).toEqual([]);
	});
});
