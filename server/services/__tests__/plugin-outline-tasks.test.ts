/**
 * Plugins' block commands on an outline session's tasks (outline P2 PR 12a; PR 12 design §2.10),
 * driven through the real public API (strict input, the core adapters, the session layer, the
 * outline write path): `tasks_read`, `task_add`, `task_set_status`, `behavior_rules_set`; who
 * they refuse (a Dynamic Spec session, a subagent); a task a person created is not the plugin's to
 * finish or cancel; a protected task a plugin asks for is created by a person and not locked
 * (D52); and the `outline:session_tasks_changed` event behind `narrafork.narrator.tasks.changed`.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * Nothing runs a model (`start` is `plugin-outline-task-start.test.ts`).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { narrators, userPreferences, users } from "../../db/schema";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { TEAM_SOP_CLOSE, TEAM_SOP_OPEN, TEAM_SOP_PLUGIN_ID } from "../behavior-fence-sop";
import { prepareOutlineRun } from "../narrator-session";
import type { ActiveNarrator } from "../narrator-session-state";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_TASK_IDLE_LEASE_MS } from "../outline/model";
import { addPersonTask, OUTLINE_TASKS_PAGE_ALIAS } from "../outline/person-tasks";
import {
	emitSessionTasksChanged,
	readSessionTasksChanged,
	settleOutlinePluginTaskEventsForTests,
	startOutlinePluginTaskEvents,
} from "../outline/plugin-task-events";
import {
	comparePaths,
	encodeTaskCursor,
	isAfterCursor,
	OUTLINE_PLUGIN_TASK_LIMITS,
} from "../outline/plugin-tasks";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import { defaultPluginEventMapper } from "../plugin-event-gateway";
import {
	type CapabilityBroker,
	type CommandResult,
	createCommandRequest,
	createCorePluginPublicApiAdapters,
	type HostCallContext,
	PluginPublicApi,
	type PluginPublicApiAuditEntry,
} from "../plugin-public-api";
import { readSpecFile, writeSpecFile } from "../spec-vfs-service";
import { invalidateTaskBackend } from "../task-source";
import { copyOutlineBehaviorPage, findBehaviorPage } from "../task-source/outline-behavior";
import { moveOutlineFenceSop, pluginRulesSid } from "../task-source/outline-plugin-rules";
import { outlineBehaviorView } from "../task-source/outline-views";

const NOW = "2026-11-08T00:00:00.000Z";
const PLUGIN = "com.example.lead";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
});

const audit: PluginPublicApiAuditEntry[] = [];
const broker: CapabilityBroker = { authorize: async () => ({ allowed: true }) };
const api = new PluginPublicApi({
	capabilityBroker: broker,
	adapters: createCorePluginPublicApiAdapters({
		db,
		pluginManager: {
			list: async () => [],
			getStatus: async () => undefined,
			enable: async () => {
				throw new Error("not used");
			},
			disable: async () => {
				throw new Error("not used");
			},
		},
	}),
	auditSink: { write: (entry) => void audit.push(entry) },
	cursorSecret: "plugin-outline-tasks-test-cursor-secret-32b",
});

let sequence = 0;
function context(pluginId = PLUGIN): HostCallContext {
	sequence++;
	return {
		requestId: `request-${sequence}`,
		correlationId: `correlation-${sequence}`,
		deadlineAt: new Date(Date.now() + 30_000).toISOString(),
		plugin: {
			pluginId,
			packageVersion: "1.0.0",
			runtimeId: "runtime-1",
			runtimeGeneration: 1,
			installationId: "installation-1",
		},
		invocation: { kind: "plugin_background", source: "event" },
		scope: {},
	} as HostCallContext;
}

async function command(
	name: string,
	input: Record<string, unknown>,
	pluginId = PLUGIN,
): Promise<CommandResult> {
	const ctx = context(pluginId);
	return await api.command(ctx, createCommandRequest(ctx, `narrafork.narrator.${name}`, input));
}

/** The command's data, failing the test when it did not succeed. */
async function ok<T = Record<string, unknown>>(
	name: string,
	input: Record<string, unknown>,
	pluginId = PLUGIN,
): Promise<T> {
	const result = await command(name, input, pluginId);
	if (result.status !== "succeeded")
		throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
	return result.data as T;
}

async function refused(name: string, input: Record<string, unknown>): Promise<string> {
	const result = await command(name, input);
	expect(result.status).not.toBe("succeeded");
	return result.error?.code ?? "";
}

async function person(language: "en" | "zh-CN" = "en"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `pot${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	await db
		.insert(userPreferences)
		.values({ id: generateId(), userId: id, language, createdAt: NOW, updatedAt: NOW });
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
		status: "idle",
		cwd: "/tmp",
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner === undefined ? await person() : options.owner,
		visibility: "private",
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
		variant: "subagent:general",
		parentNarratorId: root,
		aclRootNarratorId: root,
		taskBackend: "outline",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A person's commit in the session's space. */
async function human(narratorId: string, ops: OutlineOp[]) {
	const space = await ensureSessionSpace(narratorId);
	return await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: "pat" },
		responsibleUserId: null,
	});
}

async function block(id: string) {
	const row = await outlineStore.getBlock(id);
	if (!row) throw new Error(`no block ${id}`);
	return row;
}

describe("who the block commands answer", () => {
	test("a Dynamic Spec session and a subagent are refused (CONFLICT), a missing one is not found", async () => {
		const spec = await session({ backend: "spec" });
		const outline = await session();
		const sub = await subagentOf(outline);
		for (const id of [spec, sub]) {
			expect(await refused("tasks_read", { narratorId: id })).toBe("CONFLICT");
			expect(await refused("task_add", { narratorId: id, text: "x" })).toBe("CONFLICT");
			expect(
				await refused("task_set_status", { narratorId: id, blockId: "abcdefgh", status: "done" }),
			).toBe("CONFLICT");
			expect(
				await refused("behavior_rules_set", { narratorId: id, mode: "upsert", text: "x" }),
			).toBe("CONFLICT");
		}
		const missing = await command("tasks_read", { narratorId: "no-such-narrator" });
		expect(missing.error?.code).toBe("NOT_FOUND");
		// A session read as spec while the outline is switched off.
		settings.outline.enabled = false;
		expect(await refused("tasks_read", { narratorId: outline })).toBe("CONFLICT");
	});

	test("strict input: text and rules limits, unknown fields", async () => {
		const id = await session();
		expect(await refused("task_add", { narratorId: id, text: "x".repeat(1001) })).toBe(
			"INVALID_PARAMS",
		);
		expect(await refused("task_add", { narratorId: id, text: "x", owner: "me" })).toBe(
			"INVALID_PARAMS",
		);
		expect(
			await refused("behavior_rules_set", {
				narratorId: id,
				mode: "upsert",
				text: "x".repeat(2001),
			}),
		).toBe("INVALID_PARAMS");
		expect(await refused("tasks_read", { narratorId: id, limit: 101 })).toBe("INVALID_PARAMS");
	});
});

describe("tasks_read", () => {
	test("a session without a space reads empty", async () => {
		const id = await session();
		expect(await ok("tasks_read", { narratorId: id })).toEqual({
			backend: "outline",
			narratorId: id,
			spaceKey: null,
			seq: 0,
			tasks: [],
			nextCursor: null,
		});
	});

	test("the session space's tasks in document order, rules left out, with their fields", async () => {
		const id = await session();
		await ok("task_add", { narratorId: id, text: "First" });
		const written = await human(id, [
			{ op: "insert", tempId: "plan", parent: null, content: "Plan", task: { status: "doing" } },
			{ op: "insert", tempId: "notes", parent: { tempId: "plan" }, content: "Notes" },
			{
				op: "insert",
				tempId: "step",
				parent: { tempId: "notes" },
				content: "Step one",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "plan" },
				content: "Step two",
				task: { status: "done" },
			},
			{
				op: "insert",
				tempId: "rules",
				parent: null,
				content: "Rules",
				alias: OUTLINE_BEHAVIOR_ALIAS,
			},
			{ op: "insert", parent: { tempId: "rules" }, content: "A rule", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "Dropped", task: { status: "cancelled" } },
		]);
		const space = await ensureSessionSpace(id);
		const stepAddress = written.results[2]?.address as string;
		// Waits for "Step one" (not finished yet).
		await human(id, [
			{
				op: "insert",
				parent: null,
				content: "After step one",
				task: { status: "todo", depends: [{ target: stepAddress, label: null }] },
			},
		]);
		const read = await ok<{
			tasks: Array<Record<string, unknown>>;
			seq: number;
			spaceKey: string;
		}>("tasks_read", { narratorId: id });
		expect(read.spaceKey).toBe(space.key);
		expect(read.seq).toBe(((await outlineStore.getSpace(space.id))?.nextSeq ?? 1) - 1);
		expect(read.tasks.map((t) => [t.text, t.status, t.depth, t.waiting])).toEqual([
			["First", "todo", 1, false],
			["Plan", "doing", 0, false],
			["Step one", "todo", 2, false],
			["Step two", "done", 1, false],
			["Dropped", "cancelled", 0, false],
			["After step one", "todo", 0, true],
		]);
		const plan = read.tasks[1] as Record<string, unknown>;
		expect(plan).toMatchObject({
			blockId: written.results[0]?.blockId,
			address: written.results[0]?.address,
			humanCreated: false,
			parentBlockId: null,
		});
		expect(typeof plan.versionSeq).toBe("number");
		expect((read.tasks[2] as Record<string, unknown>).parentBlockId).toBe(
			written.results[1]?.blockId,
		);
	});

	test("pages: the cursor continues after the last task, even when it is gone", async () => {
		const id = await session();
		await human(id, [
			{ op: "insert", tempId: "a", parent: null, content: "A", task: { status: "todo" } },
			{ op: "insert", parent: { tempId: "a" }, content: "A1", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "B", task: { status: "todo" } },
			{ op: "insert", tempId: "c", parent: null, content: "C" },
			{ op: "insert", parent: { tempId: "c" }, content: "C1", task: { status: "done" } },
			{ op: "insert", parent: { tempId: "c" }, content: "C2", task: { status: "todo" } },
		]);
		const all = await ok<{ tasks: Array<{ text: string; blockId: string }> }>("tasks_read", {
			narratorId: id,
		});
		expect(all.tasks.map((t) => t.text)).toEqual(["A", "A1", "B", "C1", "C2"]);
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let round = 0; round < 10; round++) {
			const page: { tasks: Array<{ text: string }>; nextCursor: string | null } = await ok(
				"tasks_read",
				{ narratorId: id, limit: 2, ...(cursor ? { cursor } : {}) },
			);
			seen.push(...page.tasks.map((t) => t.text));
			cursor = page.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual(["A", "A1", "B", "C1", "C2"]);

		const first = await ok<{ tasks: Array<{ blockId: string }>; nextCursor: string }>(
			"tasks_read",
			{ narratorId: id, limit: 2 },
		);
		// "A1", the last task of the page, is deleted: the next page still starts after it.
		await human(id, [{ op: "delete", block: { id: first.tasks[1]?.blockId as string } }]);
		const next = await ok<{ tasks: Array<{ text: string }> }>("tasks_read", {
			narratorId: id,
			cursor: first.nextCursor,
		});
		expect(next.tasks.map((t) => t.text)).toEqual(["B", "C1", "C2"]);
		expect(await refused("tasks_read", { narratorId: id, cursor: "not-a-cursor" })).toBe(
			"INVALID_PARAMS",
		);
	});

	test("a read stops at its page budget and the cursor continues past the last page read", async () => {
		const id = await session();
		for (let i = 0; i < OUTLINE_PLUGIN_TASK_LIMITS.pagesPerRead + 5; i += 150) {
			await human(
				id,
				Array.from({ length: 150 }, (_, n) => ({
					op: "insert" as const,
					parent: null,
					content: `Notes ${i + n}`,
				})),
			);
		}
		await human(id, [
			{ op: "insert", parent: null, content: "Late task", task: { status: "todo" } },
		]);
		const first = await ok<{ tasks: unknown[]; nextCursor: string | null }>("tasks_read", {
			narratorId: id,
		});
		expect(first.tasks).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		const second = await ok<{ tasks: Array<{ text: string }>; nextCursor: string | null }>(
			"tasks_read",
			{ narratorId: id, cursor: first.nextCursor },
		);
		expect(second.tasks.map((t) => t.text)).toEqual(["Late task"]);
		expect(second.nextCursor).toBeNull();
	});

	test("positions compare in document order; a cursor past a page skips what is under it", () => {
		const page: [string, string] = ["a0", "page1"];
		const under = [page, ["a0", "x"] as [string, string]];
		expect(comparePaths([page], under)).toBeLessThan(0);
		expect(comparePaths(under, [["a1", "page0"]])).toBeLessThan(0);
		expect(isAfterCursor(under, { path: [page] })).toBe(true);
		expect(isAfterCursor(under, { path: [page], past: true })).toBe(false);
		expect(isAfterCursor([["a1", "p"]], { path: [page], past: true })).toBe(true);
		expect(encodeTaskCursor({ path: [page] })).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe("task_add", () => {
	test("on the task page (made in the owner's language), managed by the plugin, deduped", async () => {
		const owner = await person("zh-CN");
		const id = await session({ owner });
		const added = await ok<{ blockId: string; address: string; added: boolean; status: string }>(
			"task_add",
			{ narratorId: id, text: "Review PR 12" },
		);
		expect(added).toMatchObject({ added: true, status: "todo", started: false });
		const space = await ensureSessionSpace(id);
		const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		expect((await block(page?.id as string)).content).toBe("任务");
		const row = await block(added.blockId);
		expect(row.parentId).toBe(page?.id ?? null);
		expect(row.taskJson).toMatchObject({
			status: "todo",
			manager: { kind: "system", id: `plugin:${PLUGIN}` },
		});
		expect(row.taskJson?.humanCreated).toBeUndefined();
		expect(row.taskJson?.lock).toBeUndefined();
		const [commit] = await outlineStore.listCommits(space.id, { limit: 10 });
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: `plugin:${PLUGIN}`,
			narratorId: id,
			responsibleUserId: owner,
		});
		// The same text again: found, nothing written.
		const again = await ok<{ blockId: string; added: boolean }>("task_add", {
			narratorId: id,
			text: "  Review PR 12 ",
		});
		expect(again).toMatchObject({ blockId: added.blockId, added: false });
		expect(await outlineStore.listCommits(space.id, { limit: 10 })).toHaveLength(1);
	});

	test("protected: created by a person and not locked (D52)", async () => {
		const id = await session();
		const added = await ok<{ blockId: string }>("task_add", {
			narratorId: id,
			text: "Ship the release",
			protected: true,
		});
		const row = await block(added.blockId);
		expect(row.taskJson?.humanCreated).toBe(true);
		expect(row.taskJson?.lock).toBeUndefined();
	});

	test("under a block the plugin names; not on the behavior page; a missing parent is not found", async () => {
		const id = await session();
		const seeded = await human(id, [
			{ op: "insert", tempId: "plan", parent: null, content: "Plan", task: { status: "todo" } },
			{
				op: "insert",
				tempId: "rules",
				parent: null,
				content: "Rules",
				alias: OUTLINE_BEHAVIOR_ALIAS,
			},
		]);
		const plan = seeded.results[0]?.blockId as string;
		const added = await ok<{ blockId: string }>("task_add", {
			narratorId: id,
			text: "Step",
			parentBlockId: plan,
		});
		expect((await block(added.blockId)).parentId).toBe(plan);
		expect(
			await refused("task_add", {
				narratorId: id,
				text: "Rule",
				parentBlockId: seeded.results[1]?.blockId,
			}),
		).toBe("INVALID_PARAMS");
		expect(
			await refused("task_add", { narratorId: id, text: "x", parentBlockId: "missing0" }),
		).toBe("NOT_FOUND");
	});
});

describe("task_set_status", () => {
	test("start, finish; in progress for an idle session is on the idle lease", async () => {
		const id = await session();
		const added = await ok<{ blockId: string }>("task_add", { narratorId: id, text: "Do it" });
		const before = Date.now();
		const doing = await ok<{ status: string; versionSeq: number; changed: boolean }>(
			"task_set_status",
			{ narratorId: id, blockId: added.blockId, status: "doing" },
		);
		expect(doing).toMatchObject({ status: "doing", changed: true });
		const [claim] = await outlineStore.getTaskClaims([added.blockId]);
		expect(claim?.holderNarratorId).toBe(id);
		expect(Date.parse(claim?.expiresAt ?? "")).toBeGreaterThanOrEqual(
			before + OUTLINE_TASK_IDLE_LEASE_MS - 60_000,
		);
		// Stale base version.
		expect(
			await refused("task_set_status", {
				narratorId: id,
				blockId: added.blockId,
				status: "done",
				baseVersionSeq: doing.versionSeq - 1,
			}),
		).toBe("CONFLICT");
		const done = await ok<{ status: string; versionSeq: number }>("task_set_status", {
			narratorId: id,
			blockId: added.blockId,
			status: "done",
			baseVersionSeq: doing.versionSeq,
		});
		expect(done.status).toBe("done");
		expect((await block(added.blockId)).taskJson?.status).toBe("done");
		// Already done: nothing written.
		expect(
			await ok("task_set_status", { narratorId: id, blockId: added.blockId, status: "done" }),
		).toMatchObject({ changed: false });
	});

	test("a task a person created cannot be finished or cancelled by a plugin, whoever locked it", async () => {
		const owner = await person();
		const id = await session({ owner });
		const goal = await addPersonTask({ narratorId: id, userId: owner, text: "Goal", lock: true });
		const plugins = await ok<{ blockId: string }>("task_add", {
			narratorId: id,
			text: "Protected by the plugin",
			protected: true,
		});
		for (const blockId of [goal.blockId, plugins.blockId]) {
			for (const status of ["done", "cancelled"]) {
				const result = await command("task_set_status", { narratorId: id, blockId, status });
				expect(result.error?.code).toBe("CONFLICT");
				expect(result.error?.message).toContain("created by a person");
			}
			// Starting it is the plugin's to do.
			expect(
				await ok("task_set_status", { narratorId: id, blockId, status: "doing" }),
			).toMatchObject({ status: "doing" });
			expect((await block(blockId)).taskJson?.status).toBe("doing");
		}
	});

	test("not a task of the session: not found; someone else doing it: conflict", async () => {
		const id = await session();
		const other = await session();
		const seeded = await human(id, [
			{ op: "insert", tempId: "p", parent: null, content: "Plain" },
			{
				op: "insert",
				tempId: "rules",
				parent: null,
				content: "Rules",
				alias: OUTLINE_BEHAVIOR_ALIAS,
			},
			{ op: "insert", parent: { tempId: "rules" }, content: "Rule", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "Shared", task: { status: "todo" } },
		]);
		const elsewhere = await ok<{ blockId: string }>("task_add", {
			narratorId: other,
			text: "Theirs",
		});
		for (const blockId of [
			seeded.results[0]?.blockId,
			seeded.results[2]?.blockId,
			elsewhere.blockId,
		])
			expect(await refused("task_set_status", { narratorId: id, blockId, status: "done" })).toBe(
				"NOT_FOUND",
			);
		// Another session takes the task up (its agent's write, a running lease).
		const space = await ensureSessionSpace(id);
		const shared = seeded.results[3]?.blockId as string;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: shared }, task: { status: "doing" } }],
			actor: { kind: "agent", id: other },
			narratorId: other,
			responsibleUserId: null,
		});
		expect(
			await refused("task_set_status", { narratorId: id, blockId: shared, status: "done" }),
		).toBe("CONFLICT");
	});
});

describe("behavior_rules_set", () => {
	async function rules(narratorId: string, pluginId = PLUGIN) {
		const space = await ensureSessionSpace(narratorId);
		const [meta] = await outlineStore.getBlockMetas(space.id, { sids: [pluginRulesSid(pluginId)] });
		if (!meta) return null;
		const children = await outlineStore.listChildren(space.id, meta.id, 50);
		return {
			id: meta.id,
			deleted: meta.deleted,
			content: (await block(meta.id)).content,
			children: children.map((c) => [c.content, c.taskJson]),
			page: meta.pageId,
		};
	}

	test("one block per plugin on the behavior page: upsert replaces, a deleted one comes back, clear deletes", async () => {
		const id = await session();
		const first = await ok<{ blockId: string }>("behavior_rules_set", {
			narratorId: id,
			mode: "upsert",
			text: "Report to the lead.\n\n- [ ] after every task\n- see [[elsewhere]]",
		});
		const space = await ensureSessionSpace(id);
		const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]);
		let held = await rules(id);
		expect(held?.id).toBe(first.blockId);
		expect(held?.page).toBe(page?.id ?? "");
		expect(held?.content).toBe(`Rules from plugin ${PLUGIN}`);
		// Notes only: the checkbox and the link stay text.
		expect(held?.children.map(([, task]) => task)).toEqual([null]);
		expect(String(held?.children[0]?.[0])).toContain("Report to the lead.");
		expect(await outlineBehaviorView(id, "en")).toContain("Report to the lead.");

		await ok("behavior_rules_set", { narratorId: id, mode: "upsert", text: "Only this." });
		held = await rules(id);
		expect(held?.children.map(([content]) => content)).toEqual(["Only this."]);
		// The same rules again: nothing is written.
		const before = (await outlineStore.listCommits(space.id, { limit: 50 })).length;
		expect(
			await ok("behavior_rules_set", { narratorId: id, mode: "upsert", text: "Only this." }),
		).toEqual({ blockId: first.blockId });
		expect(await outlineStore.listCommits(space.id, { limit: 50 })).toHaveLength(before);

		// A person deletes it: the next update brings it back with the new rules.
		await human(id, [{ op: "delete", block: { id: first.blockId } }]);
		const back = await ok<{ blockId: string }>("behavior_rules_set", {
			narratorId: id,
			mode: "upsert",
			text: "Back again.",
		});
		expect(back.blockId).toBe(first.blockId);
		held = await rules(id);
		expect(held?.deleted).toBe(false);
		expect(held?.children.map(([content]) => content)).toEqual(["Back again."]);

		expect(await ok("behavior_rules_set", { narratorId: id, mode: "clear" })).toEqual({
			blockId: null,
		});
		expect((await rules(id))?.deleted).toBe(true);
		// Nothing to clear: nothing written.
		const commits = (await outlineStore.listCommits(space.id, { limit: 50 })).length;
		await ok("behavior_rules_set", { narratorId: id, mode: "clear" });
		expect(await outlineStore.listCommits(space.id, { limit: 50 })).toHaveLength(commits);
	});

	test("an SOP another plugin left in the old fence is kept in that plugin's block, and leaves the fence", async () => {
		const id = await session();
		settings.outline.enabled = false;
		await writeSpecFile(
			id,
			"spec://behavior_fence",
			`Own rule.\n\n${TEAM_SOP_OPEN}\nTeam SOP.\n${TEAM_SOP_CLOSE}`,
			{ actor: "user" },
		);
		settings.outline.enabled = true;
		await ok("behavior_rules_set", { narratorId: id, mode: "upsert", text: "Lead rules." });
		expect((await rules(id, TEAM_SOP_PLUGIN_ID))?.children.map(([c]) => c)).toEqual(["Team SOP."]);
		expect((await rules(id))?.children.map(([c]) => c)).toEqual(["Lead rules."]);
		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).toBe("Own rule.");
	});
});

describe("an SOP left in the old fence", () => {
	async function oldFence(narratorId: string, text: string) {
		settings.outline.enabled = false;
		try {
			await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
		} finally {
			settings.outline.enabled = true;
		}
	}

	test("moves to the marked plugin's block when the session starts a run, once", async () => {
		const id = await session();
		await oldFence(id, `- Own rule\n\n${TEAM_SOP_OPEN}\nTeam SOP.\n${TEAM_SOP_CLOSE}`);
		const active = { narratorId: id, locale: "en" } as unknown as ActiveNarrator;
		await prepareOutlineRun(active);
		const space = await ensureSessionSpace(id);
		const [held] = await outlineStore.getBlockMetas(space.id, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		expect(
			(await outlineStore.listChildren(space.id, held?.id as string, 10)).map((b) => b.content),
		).toEqual(["Team SOP."]);
		// PR 4's import took the own rule, this the SOP: the old fence holds nothing now.
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("");
		const view = await outlineBehaviorView(id, "en");
		expect(view?.match(/Team SOP\./g)).toHaveLength(1);
		expect(await moveOutlineFenceSop(id)).toBe("nothing");
		// A block the plugin has already: the fence's copy is stale and only leaves the fence.
		const other = await session();
		await ok(
			"behavior_rules_set",
			{ narratorId: other, mode: "upsert", text: "Current SOP." },
			TEAM_SOP_PLUGIN_ID,
		);
		await oldFence(other, `${TEAM_SOP_OPEN}\nStale SOP.\n${TEAM_SOP_CLOSE}`);
		expect(await moveOutlineFenceSop(other)).toBe("dropped");
		expect((await readSpecFile(other, "spec://behavior_fence")).content).toBe("");
		const otherSpace = await ensureSessionSpace(other);
		const [current] = await outlineStore.getBlockMetas(otherSpace.id, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		expect(
			(await outlineStore.listChildren(otherSpace.id, current?.id as string, 10)).map(
				(b) => b.content,
			),
		).toEqual(["Current SOP."]);
	});

	test("a subagent's own fence is left alone; a fork's copy of the block is updated, not doubled", async () => {
		const id = await session();
		const sub = await subagentOf(id);
		await oldFence(sub, `${TEAM_SOP_OPEN}\nWorker SOP.\n${TEAM_SOP_CLOSE}`);
		expect(await moveOutlineFenceSop(sub)).toBe("nothing");
		expect((await readSpecFile(sub, "spec://behavior_fence")).content).toContain("Worker SOP.");

		await ok("behavior_rules_set", { narratorId: id, mode: "upsert", text: "Parent rules." });
		const fork = await session();
		expect(await copyOutlineBehaviorPage(id, fork)).toBe(true);
		await ok("behavior_rules_set", { narratorId: fork, mode: "upsert", text: "Fork rules." });
		const space = await ensureSessionSpace(fork);
		const page = await findBehaviorPage(space.id);
		const blocks = await outlineStore.listChildren(space.id, page?.id as string, 10);
		expect(blocks.map((b) => b.content)).toEqual([`Rules from plugin ${PLUGIN}`]);
		expect(
			(await outlineStore.listChildren(space.id, blocks[0]?.id as string, 10)).map(
				(b) => b.content,
			),
		).toEqual(["Fork rules."]);
	});
});

describe("narrafork.narrator.tasks.changed", () => {
	test("a commit's task changes, off the behavior page, as one event; none for text or spec sessions", async () => {
		const id = await session();
		const seeded = await human(id, [
			{ op: "insert", tempId: "a", parent: null, content: "A", task: { status: "todo" } },
			{ op: "insert", tempId: "n", parent: null, content: "Note" },
			{
				op: "insert",
				tempId: "rules",
				parent: null,
				content: "Rules",
				alias: OUTLINE_BEHAVIOR_ALIAS,
			},
			{ op: "insert", parent: { tempId: "rules" }, content: "Rule", task: { status: "todo" } },
		]);
		const space = await ensureSessionSpace(id);
		const at = async () => ((await outlineStore.getSpace(space.id))?.nextSeq ?? 1) - 1;
		const a = seeded.results[0]?.blockId as string;
		expect(
			await readSessionTasksChanged({ spaceId: space.id, seq: await at(), actorKind: "human" }),
		).toEqual({
			narratorId: id,
			spaceKey: space.key,
			seq: await at(),
			actorKind: "human",
			changes: [{ blockId: a, status: "todo" }],
			truncated: false,
		});
		// Text of a plain block: nothing.
		await human(id, [
			{ op: "update", block: { id: seeded.results[1]?.blockId as string }, content: "Note 2" },
		]);
		expect(
			await readSessionTasksChanged({ spaceId: space.id, seq: await at(), actorKind: "human" }),
		).toBeNull();
		// No longer a task, then deleted.
		await human(id, [{ op: "setTask", block: { id: a }, task: null }]);
		expect(
			(await readSessionTasksChanged({ spaceId: space.id, seq: await at(), actorKind: "human" }))
				?.changes,
		).toEqual([{ blockId: a, status: "none" }]);
		await human(id, [{ op: "setTask", block: { id: a }, task: { status: "doing" } }]);
		await human(id, [{ op: "delete", block: { id: a } }]);
		expect(
			(await readSessionTasksChanged({ spaceId: space.id, seq: await at(), actorKind: "human" }))
				?.changes,
		).toEqual([{ blockId: a, status: "deleted" }]);

		// A spec session's space: nothing (its tasks are not there).
		const spec = await session({ backend: "spec" });
		const specSpace = await ensureSessionSpace(spec);
		await writeOutline({
			spaceId: specSpace.id,
			ops: [{ op: "insert", parent: null, content: "T", task: { status: "todo" } }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		expect(
			await emitSessionTasksChanged({ spaceId: specSpace.id, seq: 1, actorKind: "human" }),
		).toBe(false);
	});

	test("the listener emits it; the gateway publishes the new topic and, for the old commands, spec.changed", async () => {
		startOutlinePluginTaskEvents();
		const id = await session();
		const events: NarraForkEvent[] = [];
		const listener = (event: NarraForkEvent) => {
			if (event.type === "outline:session_tasks_changed" && event.narratorId === id)
				events.push(event);
		};
		eventBus.onAny(listener);
		try {
			const added = await ok<{ blockId: string }>("task_add", { narratorId: id, text: "Watch me" });
			await settleOutlinePluginTaskEventsForTests();
			expect(events).toHaveLength(1);
			const event = events[0] as Extract<NarraForkEvent, { type: "outline:session_tasks_changed" }>;
			expect(event.actorKind).toBe("system");
			expect(event.changes).toEqual([{ blockId: added.blockId, status: "todo" }]);
			const mapped = await defaultPluginEventMapper(event, {
				eventId: "evt_1",
				occurredAt: NOW,
			});
			expect(Array.isArray(mapped)).toBe(true);
			const [tasks, spec] = mapped as unknown as Array<{
				topic: string;
				eventId?: string;
				data: Record<string, unknown>;
			}>;
			const revisionId = `outline:${event.spaceKey}:${event.seq}`;
			expect(tasks?.topic).toBe("narrafork.narrator.tasks.changed");
			expect(tasks?.data).toEqual({
				narratorId: id,
				seq: event.seq,
				revisionId,
				updatedBy: "system",
				changes: [{ blockId: added.blockId, status: "todo" }],
				truncated: false,
			});
			expect(spec?.topic).toBe("narrafork.narrator.spec.changed");
			expect(spec?.eventId).not.toBe(tasks?.eventId);
			expect(spec?.data).toEqual({
				narratorId: id,
				path: "tasks.json",
				uri: "spec://tasks.json",
				revisionId,
				updatedBy: "system",
			});
		} finally {
			eventBus.offAny(listener);
		}
	});
});

describe("audit", () => {
	test("the block commands are not marked as converted spec commands", async () => {
		const id = await session();
		audit.length = 0;
		await ok("task_add", { narratorId: id, text: "Audited" });
		expect(audit.map((entry) => [entry.methodId, entry.compat])).toEqual([
			["narrafork.narrator.task_add", undefined],
		]);
	});
});
