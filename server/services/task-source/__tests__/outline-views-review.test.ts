/**
 * Regressions from PR 4's first review (outline P2): each case is seeded from the reviewer's probe
 * of the same letter and asserts the corrected behavior.
 *
 *   B1  turning the outline off after the import keeps the person's rules (spec fence reader);
 *   S1  a failed view read keeps what the model was shown (never "removed");
 *   S2  the person's page is budgeted first, the plugin SOP gets the rest, within 4000 chars;
 *   S3  a checkbox on the behavior page is never a task of the session; forks drop checkboxes;
 *   S4  leftover fence text is shown page or no page; a large fence imports, resumably;
 *   S6  the compact's recorded decisions are the agent's own, never the behavior page;
 *   N1  reading the views creates no spec namespace;
 *   N2  a plugin SOP written during the import is kept, and the rewrite is the system's;
 *   N3  a cut fork copy says so on the fork's page;
 *   N5  the turn-end note is decided and written only where the run goes idle;
 *   N7  the compact context reads about what it renders;
 *   N8  no "keep the address of every open task" without tasks.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ContextPart, contextUpdateOf } from "@shared/prefix-context";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, specNamespaces } from "../../../db/schema";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { withRuntimePolicyTrait } from "../../../lib/runtime-policy-trait";
import { settings } from "../../../lib/settings";
import { compileDelegationCeiling } from "../../custom-subagent-service";
import { buildEffectiveSystemPrompt } from "../../narrator-prompt";
import { narratorService } from "../../narrator-service";
import * as runner from "../../outline/edit-text-runner";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import * as outlineWrite from "../../outline/write";
import { writeOutline } from "../../outline/write";
import { readSpecFile, writeSpecFile } from "../../spec-vfs-service";
import { taskSourceForNarrator } from "../index";
import { createOutlineTaskSource } from "../outline";
import {
	copyOutlineBehaviorPage,
	findBehaviorPage,
	importOutlineBehaviorFence,
	resetOutlineBehaviorImport,
} from "../outline-behavior";
import { OUTLINE_VIEW_LIMITS, resetOutlineViewCache } from "../outline-views";
import { seedLegacyPluginSop } from "./legacy-plugin-sop";
import { seedBehaviorPage, seedOutlineTasks } from "./outline-task-source-scenarios";

const NOW = "2026-11-02T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
	resetOutlineBehaviorImport();
});
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	settings.outline.enabled = true;
	resetOutlineViewCache();
});

async function session(backend: "spec" | "outline" = "outline"): Promise<string> {
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
		taskBackend: backend,
		ownerUserId: null,
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

/** Write a session's old fence as before PR 4 (the switch off: a spec write). */
async function oldFence(narratorId: string, text: string): Promise<void> {
	settings.outline.enabled = false;
	try {
		await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
	} finally {
		settings.outline.enabled = true;
	}
}

async function parts(narratorId: string): Promise<ContextPart[]> {
	return await (await taskSourceForNarrator(narratorId)).contextParts("en");
}
const part = (list: ContextPart[], key: string) =>
	list.find((p) => p.key === key && !p.unreadable)?.text ?? null;

/** A person adds one block under `parent` (a task when `task` is given). */
async function personAdds(
	narratorId: string,
	parent: string,
	content: string,
	task?: { status: "todo" | "doing" },
): Promise<string> {
	const space = await ensureSessionSpace(narratorId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", parent: { id: parent }, content, ...(task ? { task } : {}) }],
		actor: { kind: "human", id: "pat" },
		responsibleUserId: null,
	});
	return written.results[0]?.blockId as string;
}

/** Contents of the live children of a block, in order. */
async function children(narratorId: string, parentId: string): Promise<string[]> {
	const space = await ensureSessionSpace(narratorId);
	return (await outlineStore.listChildren(space.id, parentId, 1000)).map((b) => b.content);
}

describe("B1: the outline switched off after the import", () => {
	test("the session runs as spec and its fence carries the page's rules ahead of the SOP", async () => {
		const id = await session();
		await oldFence(id, "Never force-push the main branch.");
		await seedLegacyPluginSop(id, "Report to the lead.");
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("force-push");

		settings.outline.enabled = false;
		const source = await taskSourceForNarrator(id);
		expect(source.backend).toBe("spec");
		const fence = await source.behaviorFence();
		expect(fence?.kind).toBe("prose");
		const text = fence?.kind === "prose" ? fence.text : "";
		expect(text).toContain("Never force-push the main branch.");
		expect(text).toContain("Report to the lead.");
		expect(text.indexOf("force-push")).toBeLessThan(text.indexOf("Report to the lead."));
		// A subagent of it reads its session's page too (D31), as under the outline.
		const sub = await subagent(id);
		const subFence = await (await taskSourceForNarrator(sub)).behaviorFence();
		expect(subFence?.kind === "prose" ? subFence.text : "").toContain("Never force-push");
	});

	test("a spec session's fence reads exactly as before, switch on or off", async () => {
		const id = await session("spec");
		await writeSpecFile(id, "spec://behavior_fence", "Never force-push.", { actor: "user" });
		for (const enabled of [true, false]) {
			settings.outline.enabled = enabled;
			expect(await (await taskSourceForNarrator(id)).behaviorFence()).toEqual({
				kind: "prose",
				text: "Never force-push.",
			});
		}
	});
});

describe("S1: a view read that fails", () => {
	test("after an invalidation, the last view is kept (probe B)", async () => {
		let now = 1_000_000;
		resetOutlineViewCache(() => now);
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push the main branch.");
		const first = part(await parts(id), "outline.behavior");
		expect(first).toContain("Never force-push");
		await personAdds(id, pageId, "Ask before deleting files.");
		// Every read of this request fails (both views read the alias).
		const spy = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("transient: database is locked")),
		);
		restores.push(() => spy.mockRestore());
		expect(part(await parts(id), "outline.behavior")).toBe(first);
		spy.mockRestore();
		// The next read after the failure backoff (round 2, N-R2-8) succeeds and shows the new rule.
		now += OUTLINE_VIEW_LIMITS.failureBackoffMs;
		expect(part(await parts(id), "outline.behavior")).toContain("Ask before deleting files.");
	});

	test("never read in this process, or the session unresolved: marked unreadable, not left out", async () => {
		const id = await session();
		await seedBehaviorPage(id, "Never force-push.");
		const spy = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("transient")),
		);
		restores.push(() => spy.mockRestore());
		const failed = await parts(id);
		expect(failed.find((p) => p.key === "outline.behavior")).toEqual({
			key: "outline.behavior",
			text: "",
			unreadable: true,
		});
		spy.mockRestore();
		const { invalidateTaskBackend } = await import("../backend");
		invalidateTaskBackend(id);
		const backend = await import("../backend");
		const real = backend.readTaskSession;
		const failSession = spyOn(backend, "readTaskSession").mockImplementation(async (n) => {
			if (n === id) throw new Error("transient");
			return real(n);
		});
		restores.push(() => failSession.mockRestore());
		// The outline source itself (the factory would fall back to spec without a session).
		const unresolved = await createOutlineTaskSource(id).contextParts("en");
		expect(unresolved.map((p) => [p.key, p.unreadable])).toEqual([
			["outline.tasks", true],
			["outline.behavior", true],
		]);
	});

	test("through the request prefix: no removal and no update for a failed read (probe I)", async () => {
		settings.anthropicProviders = [
			{
				id: "review-p",
				name: "Review",
				prefix: "review-p",
				apiKey: "isolated-no-network",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-5-5",
				officialApi: false,
			},
		];
		const { reconcileEpoch, loadContextUpdate } = await import("../../narrator-epochs");
		let now = 1_000_000;
		resetOutlineViewCache(() => now);
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push the main branch.");
		const request = async () => {
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
				provider: "review-p",
				registryRevision: "r",
				prompt: { contract: built.contract, parts: built.parts, keepParts: built.keepParts },
				noticeText: (kind, name) => `${kind}: ${name}`,
				resolveTarget: (model, p) => ({ fingerprint: `${p}:${model}`, cacheTtlMs: 1 }),
			});
		};
		const behaviorUpdates = async () => {
			const seen: string[] = [];
			for (const row of await narratorService.getModelHistorySinceLastCompact(id)) {
				for (const block of Array.isArray(row.contentJson) ? row.contentJson : []) {
					const update = contextUpdateOf(block);
					if (!update) continue;
					for (const change of (await loadContextUpdate(update)).changes) {
						if (change.key === "outline.behavior")
							seen.push(change.value === null ? "REMOVED" : "SET");
					}
				}
			}
			return seen;
		};
		await request();
		// A person adds a rule (the cached view goes stale), and the next read fails once.
		await personAdds(id, pageId, "Ask first.");
		const once = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("transient")),
		);
		restores.push(() => once.mockRestore());
		await request();
		once.mockRestore();
		expect(await behaviorUpdates()).toEqual([]);
		// Read again once the failure backoff (round 2, N-R2-8) is over.
		now += OUTLINE_VIEW_LIMITS.failureBackoffMs;
		await request();
		expect(await behaviorUpdates()).toEqual(["SET"]);

		// After a restart (nothing cached) a failing read keeps the previous value too.
		resetOutlineViewCache();
		await personAdds(id, pageId, "Ask twice.");
		const always = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("transient")),
		);
		restores.push(() => always.mockRestore());
		await request();
		expect(await behaviorUpdates()).toEqual(["SET"]);
	});
});

describe("S2: the page first, the plugin SOP with what is left (probe C)", () => {
	test("a long SOP does not push the person's rules out, and the view stays within 4000", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule 1: never force-push the main branch.");
		for (let n = 2; n <= 5; n++) await personAdds(id, pageId, `Rule ${n}: ${"keep it ".repeat(6)}`);
		await seedLegacyPluginSop(id, `Team SOP. ${"report to the lead ".repeat(260)}`);
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		for (const n of [1, 2, 3, 4, 5]) expect(view).toContain(`Rule ${n}:`);
		expect(view).not.toContain("not all shown");
		// The SOP follows, cut to what is left.
		expect(view).toContain("Plugin SOP:\nTeam SOP.");
		expect(view.endsWith("…")).toBe(true);
	});

	test("a page filling the budget leaves no room for the SOP, and nothing overruns", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule zero.");
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: Array.from({ length: 150 }, (_, n) => ({
				op: "insert" as const,
				parent: { id: pageId },
				content: `Rule ${n}: ${"always keep this constraint ".repeat(3)}`,
			})),
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		await seedLegacyPluginSop(id, "Report back.");
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(view).toContain("not all shown");
		expect(view).toContain("Rule zero.");
	});
});

describe("S3: a checkbox on the behavior page is not a task of the session (probe A)", () => {
	test("not open, not in the tasks view, never started by continuation", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push.");
		await personAdds(id, pageId, "Run the tests before every commit", { status: "todo" });
		await personAdds(id, pageId, "Keep the changelog updated", { status: "doing" });
		const source = await taskSourceForNarrator(id);
		expect((await source.openTasks()).tasks).toEqual([]);
		expect(await source.currentTask()).toBeNull();
		expect(await source.nextTask()).toBeNull();
		expect(part(await parts(id), "outline.tasks")).toBeNull();
		expect(await source.prepareContinuation({ promoteTodo: true })).toEqual({
			openTask: null,
			protectedOpenCount: 0,
		});
		// The person's checkbox stays on the page as written, and the view shows it as a rule.
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).toContain("- [ ] Run the tests before every commit");
		// The session's own tasks elsewhere are still its tasks.
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "todo" }]);
		expect((await source.openTasks()).tasks.map((t) => t.text)).toEqual(["Write the parser"]);
	});

	test("a fork copies the page without checkboxes (probe A2)", async () => {
		const parent = await session();
		const pageId = await seedBehaviorPage(parent, "Never force-push.");
		await personAdds(parent, pageId, "Keep the changelog updated", { status: "doing" });
		const child = await session();
		expect(await copyOutlineBehaviorPage(parent, child)).toBe(true);
		const childSpace = await ensureSessionSpace(child);
		const page = await findBehaviorPage(childSpace.id);
		const copied = await outlineStore.listChildren(childSpace.id, page?.id ?? "", 10);
		expect(copied.map((b) => [b.content, b.taskJson])).toEqual([
			["Never force-push.", null],
			["Keep the changelog updated", null],
		]);
		expect((await (await taskSourceForNarrator(child)).openTasks()).tasks).toEqual([]);
	});
});

describe("S4: fence text that is not on the page yet", () => {
	test("a failed import while a page exists still shows the fence text (probe J)", async () => {
		const id = await session();
		await seedBehaviorPage(id, "A rule the person wrote in the outline.");
		await oldFence(id, "- Old fence rule 0\n- Old fence rule 1");
		const fail = spyOn(outlineWrite, "writeOutline").mockImplementation(() =>
			Promise.reject(new Error("transient")),
		);
		restores.push(() => fail.mockRestore());
		expect(await importOutlineBehaviorFence(id, "en")).toBe("failed");
		fail.mockRestore();
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).toContain("A rule the person wrote in the outline.");
		expect(view).toContain("From this session's old behavior fence");
		expect(view).toContain("Old fence rule 0");
	});

	test("a fence of 230 items imports in several commits, resumes where it stopped, never twice", async () => {
		const id = await session();
		await oldFence(id, Array.from({ length: 230 }, (_, n) => `- Old fence rule ${n}`).join("\n"));
		await seedLegacyPluginSop(id, "Report back.");
		// The second commit fails: the first stays, the fence is untouched, the view shows both.
		const real = outlineWrite.writeOutline;
		let calls = 0;
		const flaky = spyOn(outlineWrite, "writeOutline").mockImplementation(async (...args) => {
			calls++;
			if (calls === 2) throw new Error("transient");
			return await real(...args);
		});
		restores.push(() => flaky.mockRestore());
		expect(await importOutlineBehaviorFence(id, "en")).toBe("failed");
		flaky.mockRestore();
		const space = await ensureSessionSpace(id);
		const page = await findBehaviorPage(space.id);
		const partial = await children(id, page?.id ?? "");
		expect(partial.length).toBeGreaterThan(0);
		expect(partial.length).toBeLessThan(230);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toContain(
			"Old fence rule 229",
		);

		// A later run (a restart) writes the rest and nothing twice.
		resetOutlineBehaviorImport(id);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		const all = await children(id, page?.id ?? "");
		expect(all).toEqual(Array.from({ length: 230 }, (_, n) => `Old fence rule ${n}`));
		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).not.toContain("Old fence rule");
		expect(fence).toContain("Report back.");
		expect(part(await parts(id), "outline.behavior")).not.toContain("old behavior fence");
	});
});

describe("S6: recorded decisions are what the session wrote, never the behavior page (probe E)", () => {
	test("a fork's copied page and the import are not the fork's decisions", async () => {
		const parent = await session();
		await seedBehaviorPage(parent, "Never force-push the main branch.");
		const child = await session();
		expect(await copyOutlineBehaviorPage(parent, child)).toBe(true);
		const context = (await (await taskSourceForNarrator(child)).compactContext("en")) ?? "";
		expect(context).not.toContain("Never force-push");
		expect(context).not.toContain("Recorded decisions");

		const imported = await session();
		await oldFence(imported, "Ask before deleting files.");
		expect(await importOutlineBehaviorFence(imported, "en")).toBe("imported");
		const after = (await (await taskSourceForNarrator(imported)).compactContext("en")) ?? "";
		expect(after).not.toContain("Ask before deleting files.");
	});

	test("a rule the agent itself wrote on the page under the grant is not a decision either", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push.");
		const space = await ensureSessionSpace(id);
		await writeOutline(
			{
				spaceId: space.id,
				ops: [{ op: "insert", parent: { id: pageId }, content: "Ask before deleting files." }],
				actor: { kind: "agent", id },
				narratorId: id,
				responsibleUserId: null,
			},
			{ agentBehaviorGrant: () => true },
		);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: "Decision: use SQLite" }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: null,
		});
		const context = (await (await taskSourceForNarrator(id)).compactContext("en")) ?? "";
		expect(context).toContain("Decision: use SQLite");
		expect(context).not.toContain("Ask before deleting files.");
	});
});

describe("N1: reading the views creates no spec namespace (probe F)", () => {
	test("neither for a subagent nor for its root, nor at run start", async () => {
		const root = await session();
		await seedBehaviorPage(root, "Never force-push.");
		const sub = await subagent(root);
		const namespaces = async (narratorId: string) =>
			(await db.select().from(specNamespaces).where(eq(specNamespaces.narratorId, narratorId)))
				.length;
		await parts(sub);
		await parts(root);
		expect(await importOutlineBehaviorFence(root, "en")).toBe("nothing");
		expect(await namespaces(sub)).toBe(0);
		expect(await namespaces(root)).toBe(0);
	});
});

describe("N2: the import and the plugin's SOP channel (probe G)", () => {
	test("an SOP update landing during the import is kept; the rewrite is the system's", async () => {
		const id = await session();
		await oldFence(id, "Never force-push the main branch.");
		await seedLegacyPluginSop(id, "OLD SOP");
		const real = runner.processEditText;
		let once = false;
		const spy = spyOn(runner, "processEditText").mockImplementation((async (
			...args: Parameters<typeof real>
		) => {
			const out = await real(...args);
			if (!once) {
				once = true;
				// The pre-PR 12a channel (since then the plugin's command writes its block).
				await seedLegacyPluginSop(id, "NEW SOP");
			}
			return out;
		}) as typeof real);
		restores.push(() => spy.mockRestore());
		const updatedBy: string[] = [];
		const listen = (event: { narratorId: string; updatedBy: string }) => {
			if (event.narratorId === id) updatedBy.push(event.updatedBy);
		};
		eventBus.on("spec:changed", listen);
		try {
			expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		} finally {
			eventBus.off("spec:changed", listen);
		}
		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).toContain("NEW SOP");
		expect(fence).not.toContain("force-push");
		expect(updatedBy.at(-1)).toBe("system");
	});
});

describe("N3: a fork copy cut at the commit limit says so (probe L)", () => {
	test("the fork's page starts with a note naming the parent's page", async () => {
		const parent = await session();
		const pageId = await seedBehaviorPage(parent, "Rule zero.");
		const space = await ensureSessionSpace(parent);
		for (let i = 0; i < 260; i += 150) {
			await writeOutline({
				spaceId: space.id,
				ops: Array.from({ length: Math.min(150, 260 - i) }, (_, n) => ({
					op: "insert" as const,
					parent: { id: pageId },
					content: `Rule ${i + n + 1}`,
				})),
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
		}
		const [parentPage] = await outlineStore.getBlocks([pageId]);
		const child = await session();
		expect(await copyOutlineBehaviorPage(parent, child)).toBe(true);
		const childSpace = await ensureSessionSpace(child);
		const page = await findBehaviorPage(childSpace.id);
		const kids = await children(child, page?.id ?? "");
		expect(kids.length).toBeLessThanOrEqual(199);
		expect(kids[0]).toContain(`of the 262 blocks of this page were copied`);
		expect(kids[0]).toContain(`${space.key}/${parentPage?.sid}`);
		expect(part(await parts(child), "outline.behavior")).toContain("were copied when the session");
	});
});

describe("N5: the turn-end note is written where the run goes idle", () => {
	test("decided after the continuation, compact restart and hold; written after the drain", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../agent-runtime/orchestrator.ts"),
			"utf8",
		);
		const decide = source.indexOf("await decideOutlineTurnEndNote(active, {");
		expect(decide).toBeGreaterThan(0);
		expect(source.indexOf("await decideOutlineTurnEndNote(active, {", decide + 1)).toBe(-1);
		for (const before of [
			'const continuationPrompt = await continueForSpec("spec", runState.hadError);',
			"shouldResumeAfterCompact(",
			"const next = await holdAtBoundary();",
		]) {
			const at = source.lastIndexOf(before, decide);
			expect(at).toBeGreaterThan(0);
		}
		// The rest of this ordering (the drain and the arbitration back to back, the note written
		// after them) is the second round's N-R2-5, `outline-views-review-r2.test.ts`.
		const deliver = source.indexOf("await deliverOutlineTurnEndNote(active, turnEndNote)");
		expect(source.lastIndexOf("const bgCompletionAfterIdle = await", deliver)).toBeGreaterThan(
			decide,
		);
	});
});

describe("N7, N8: the compact context", () => {
	test("reads about what it renders", async () => {
		const id = await session();
		const space = await ensureSessionSpace(id);
		for (let n = 0; n < 60; n++) {
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "insert", parent: null, content: `Decision ${n}: ${"x".repeat(150)}` }],
				actor: { kind: "agent", id },
				narratorId: id,
				responsibleUserId: null,
			});
		}
		const real = outlineStore.getBlocks.bind(outlineStore);
		let asked = 0;
		const spy = spyOn(outlineStore, "getBlocks").mockImplementation(async (ids) => {
			asked += ids.length;
			return await real(ids);
		});
		restores.push(() => spy.mockRestore());
		const context = (await (await taskSourceForNarrator(id)).compactContext("en")) ?? "";
		const shown = context.split("\n").filter((line) => line.includes("Decision ")).length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(60);
		expect(asked).toBeLessThanOrEqual(shown + 10);
	});

	test("without open tasks it does not ask to keep their addresses", async () => {
		const id = await session();
		for (const locale of ["en", "zh-CN"] as const) {
			const text = (await (await taskSourceForNarrator(id)).compactContext(locale)) ?? "";
			expect(text).not.toContain("every open task above");
			expect(text).not.toContain("每个未完成任务的地址");
			expect(text).toMatch(/Key decisions|关键决定/);
		}
	});
});
