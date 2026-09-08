import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	fileAttributions,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { generateId } from "../lib/id";
import { recordAttribution, recordAttributions } from "./file-attribution-service";
import { normalizeWorkspacePath } from "./git-workspace";
import {
	findImpreciseChanges,
	getWorkspaceModificationView,
	type ModificationEvent,
	type WorkspaceModificationView,
} from "./workspace-modification-view";

/**
 * The timeline of a default-projection view.
 *
 * `timeline` is optional on the type because `projection: "byFile"` omits it. Every caller
 * below uses the default projection, so a missing timeline is a bug in the code under test
 * rather than a case to tolerate — failing here says so, instead of every assertion growing
 * an `?.` that would quietly pass on `undefined`.
 */
function timelineOf(view: WorkspaceModificationView): ModificationEvent[] {
	if (!view.timeline) throw new Error("expected the default projection to include a timeline");
	return view.timeline;
}

const createdNarrators: string[] = [];
const createdUsers: string[] = [];
const workspaces: string[] = [];

async function createUser(name: string): Promise<{ id: string; username: string }> {
	const id = generateId();
	const username = `${name}-${id}`;
	await db
		.insert(users)
		.values({ id, username, passwordHash: "test-only", createdAt: new Date().toISOString() });
	createdUsers.push(id);
	return { id, username };
}

function makeWorkspace(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	workspaces.push(dir);
	return dir;
}

async function createNarrator(title: string, cwd: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, title, cwd, createdAt: now, updatedAt: now });
	createdNarrators.push(id);
	return id;
}

/** Record one attribution, optionally with a tool call carrying a tree boundary. */
async function record(params: {
	workspacePath: string;
	filePath: string;
	narratorId: string | null;
	userId?: string;
	subagentType?: string;
	action: "write" | "edit" | "bash" | "external" | "human";
	toolName?: string | null;
	treeHashAfter?: string;
}): Promise<void> {
	let toolUseId: string | undefined;
	if (params.narratorId && params.treeHashAfter) {
		toolUseId = generateId();
		const messageId = generateId();
		const now = new Date().toISOString();
		// narrator_tool_calls.messageId is a real FK, so the owning message must exist.
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: params.narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: params.narratorId,
			messageId,
			toolUseId,
			toolName: params.toolName ?? "Write",
			status: "success",
			treeHashAfter: params.treeHashAfter,
			createdAt: now,
		});
	}
	await recordAttribution({
		deviceId: "local",
		workspacePath: params.workspacePath,
		filePath: params.filePath,
		narratorId: params.narratorId,
		userId: params.userId,
		subagentType: params.subagentType,
		action: params.action,
		toolName: params.toolName ?? null,
		toolUseId: toolUseId ?? null,
	});
	// Timestamps are ISO strings at millisecond resolution; separate the rows so the
	// newest-first ordering is deterministic.
	await new Promise((r) => setTimeout(r, 2));
}

afterEach(async () => {
	for (const workspacePath of workspaces.splice(0)) {
		await db
			.delete(fileAttributions)
			.where(eq(fileAttributions.workspacePath, normalizeWorkspacePath(workspacePath)));
		rmSync(workspacePath, { recursive: true, force: true });
	}
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const id of createdUsers.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("unified workspace modification view", () => {
	test("aggregates every actor that touched the directory, not just one narrator", async () => {
		const ws = makeWorkspace("nf-view-actors-");
		const alice = await createNarrator("Alice", ws);
		const bob = await createNarrator("Bob", ws);

		await record({ workspacePath: ws, filePath: "src/a.ts", narratorId: alice, action: "write" });
		await record({ workspacePath: ws, filePath: "src/b.ts", narratorId: bob, action: "edit" });
		await record({ workspacePath: ws, filePath: "src/c.ts", narratorId: null, action: "external" });

		const view = await getWorkspaceModificationView(ws);

		expect(view.timeline).toHaveLength(3);
		// The whole point of the unified view: all three actors appear together.
		expect(view.actors.map((a) => a.narratorId).sort()).toEqual([alice, bob, null].sort());
		expect(timelineOf(view).map((e) => e.actor.title)).toContain("Alice");
		expect(timelineOf(view).map((e) => e.actor.title)).toContain("Bob");
	});

	test("orders the timeline newest first", async () => {
		const ws = makeWorkspace("nf-view-order-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "first.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "second.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);
		expect(timelineOf(view).map((e) => e.filePath)).toEqual(["second.ts", "first.ts"]);
	});

	test("groups by file with contributors and flags", async () => {
		const ws = makeWorkspace("nf-view-byfile-");
		const alice = await createNarrator("Alice", ws);
		const bob = await createNarrator("Bob", ws);

		await record({ workspacePath: ws, filePath: "shared.ts", narratorId: alice, action: "write" });
		await record({ workspacePath: ws, filePath: "shared.ts", narratorId: bob, action: "edit" });
		await record({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: null,
			action: "external",
		});

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "shared.ts");
		expect(group?.changeCount).toBe(3);
		expect(group?.actors).toHaveLength(3);
		expect(group?.hasExternalChange).toBe(true);
		// External changes are never precisely attributable.
		expect(group?.hasImpreciseAttribution).toBe(true);
	});

	test("never upgrades legacy write/edit observations to measured attribution", async () => {
		const ws = makeWorkspace("nf-view-precision-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "w.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "e.ts", narratorId, action: "edit" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "bash" });
		await record({ workspacePath: ws, filePath: "x.ts", narratorId: null, action: "external" });

		const view = await getWorkspaceModificationView(ws);
		const precision = new Map(timelineOf(view).map((e) => [e.filePath, e.preciseAttribution]));
		// A declared path or tree hash is not a settled, execution-confirmed v2 effect.
		expect(precision.get("w.ts")).toBe(false);
		expect(precision.get("e.ts")).toBe(false);
		expect(timelineOf(view).every((event) => event.evidence === "legacy")).toBe(true);
		expect(timelineOf(view).some((event) => event.attributionGrade === "measured")).toBe(false);
		expect(view.baselineStatus).toBe("unverified");
		expect(precision.get("b.ts")).toBe(false);
		expect(precision.get("x.ts")).toBe(false);
	});

	test("legacy toolUseId alone never binds a possibly reused tree boundary", async () => {
		const ws = makeWorkspace("nf-view-tree-");
		const narratorId = await createNarrator("Solo", ws);
		await record({
			workspacePath: ws,
			filePath: "a.ts",
			narratorId,
			action: "write",
			treeHashAfter: "a".repeat(40),
		});
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);
		const withBoundary = timelineOf(view).find((e) => e.filePath === "a.ts");
		const without = timelineOf(view).find((e) => e.filePath === "b.ts");
		expect(withBoundary?.treeHashAfter).toBeNull();
		expect(without?.treeHashAfter).toBeNull();
	});

	test("returns no file contents, only metadata", async () => {
		const ws = makeWorkspace("nf-view-nocontent-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);
		// A list endpoint must never carry file bodies regardless of file size.
		const contentBearingKeys = [
			"content",
			"currentContent",
			"revertedContent",
			"originalContent",
			"diff",
		];
		for (const key of contentBearingKeys) {
			expect(Object.keys(timelineOf(view)[0])).not.toContain(key);
			expect(Object.keys(view.byFile[0])).not.toContain(key);
		}
	});

	test("caps the window and reports that more exist", async () => {
		const ws = makeWorkspace("nf-view-limit-");
		const narratorId = await createNarrator("Solo", ws);
		for (let i = 0; i < 4; i++) {
			await record({ workspacePath: ws, filePath: `f${i}.ts`, narratorId, action: "write" });
		}

		const view = await getWorkspaceModificationView(ws, { limit: 2 });
		expect(view.timeline).toHaveLength(2);
		expect(view.hasMore).toBe(true);
	});

	test("filters to a single actor, and to external changes", async () => {
		const ws = makeWorkspace("nf-view-filter-");
		const alice = await createNarrator("Alice", ws);
		const bob = await createNarrator("Bob", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId: alice, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId: bob, action: "write" });
		await record({ workspacePath: ws, filePath: "x.ts", narratorId: null, action: "external" });

		const onlyAlice = await getWorkspaceModificationView(ws, { narratorId: alice });
		expect(onlyAlice.timeline?.map((e) => e.filePath)).toEqual(["a.ts"]);

		const onlyExternal = await getWorkspaceModificationView(ws, { narratorId: "external" });
		expect(onlyExternal.timeline?.map((e) => e.filePath)).toEqual(["x.ts"]);
	});

	test("keeps separate workspaces isolated", async () => {
		const first = makeWorkspace("nf-view-iso-a-");
		const second = makeWorkspace("nf-view-iso-b-");
		const narratorId = await createNarrator("Solo", first);
		await record({ workspacePath: first, filePath: "a.ts", narratorId, action: "write" });
		await record({ workspacePath: second, filePath: "b.ts", narratorId, action: "write" });

		expect((await getWorkspaceModificationView(first)).timeline?.map((e) => e.filePath)).toEqual([
			"a.ts",
		]);
		expect((await getWorkspaceModificationView(second)).timeline?.map((e) => e.filePath)).toEqual([
			"b.ts",
		]);
	});

	test("reports how many rows survived into the aggregation", async () => {
		// `hasMore` alone cannot tell "no attribution recorded" apart from "the window did
		// not reach it", because the boundary filter runs after the window is drawn.
		const ws = makeWorkspace("nf-view-windowcount-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);
		expect(view.windowCount).toBe(2);
	});

	test("a full window filtered to nothing is distinguishable from an empty one", async () => {
		// The contradiction this closes: `hasMore: true` alongside an empty `byFile`, which
		// a client had no way to interpret.
		const ws = makeWorkspace("nf-view-empty-window-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });
		const afterEverything = new Date(Date.now() + 60_000).toISOString();

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["a.ts"],
			sinceByPath: new Map([["a.ts", afterEverything]]),
		});

		expect(view.byFile).toEqual([]);
		// Zero rows took part, so "no badge" is the correct rendering, not a symptom of a
		// window that ran out.
		expect(view.windowCount).toBe(0);
	});
});

describe("per-path windowing", () => {
	test("a hot file cannot crowd another file out of the rollup", async () => {
		// The bug: one global `ORDER BY changed_at DESC LIMIT n`. A busy file's recent
		// changes filled the whole window, so quieter files were absent from `byFile`
		// entirely and the panel rendered no badge for them at all.
		const ws = makeWorkspace("nf-view-perpath-");
		const busy = await createNarrator("Busy", ws);
		const quiet = await createNarrator("Quiet", ws);

		// The quiet file's only change is the OLDEST row in the workspace, so a global
		// window this small would never reach it.
		await record({ workspacePath: ws, filePath: "quiet.ts", narratorId: quiet, action: "write" });
		for (let i = 0; i < 20; i++) {
			await record({ workspacePath: ws, filePath: "busy.ts", narratorId: busy, action: "edit" });
		}

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["busy.ts", "quiet.ts"],
		});

		const paths = view.byFile.map((g) => g.filePath).sort();
		expect(paths).toEqual(["busy.ts", "quiet.ts"]);
		expect(view.byFile.find((g) => g.filePath === "quiet.ts")?.lastActor.title).toBe("Quiet");
		// The busy file is windowed per path, so its slice is bounded rather than unbounded.
		expect(view.byFile.find((g) => g.filePath === "busy.ts")?.changeCount).toBeLessThanOrEqual(10);
	});

	test("a saturated per-path slice reports hasMore", async () => {
		const ws = makeWorkspace("nf-view-perpath-more-");
		const narratorId = await createNarrator("Busy", ws);
		for (let i = 0; i < 12; i++) {
			await record({ workspacePath: ws, filePath: "busy.ts", narratorId, action: "edit" });
		}

		const view = await getWorkspaceModificationView(ws, { filePaths: ["busy.ts"] });

		expect(view.hasMore).toBe(true);
		expect(view.windowCount).toBe(10);
	});

	test("a file well inside its slice reports no more history", async () => {
		const ws = makeWorkspace("nf-view-perpath-done-");
		const narratorId = await createNarrator("Calm", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws, { filePaths: ["a.ts"] });

		expect(view.hasMore).toBe(false);
		expect(view.windowCount).toBe(1);
	});

	test("the newest actor is still the newest across a sharded query", async () => {
		// Per-path rows come back grouped by path, not in time order, so the aggregation
		// depends on an explicit re-sort. Without it the badge would name whichever writer
		// the shard happened to return last.
		const ws = makeWorkspace("nf-view-perpath-order-");
		const first = await createNarrator("First", ws);
		const second = await createNarrator("Second", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId: first, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId: first, action: "write" });
		await record({ workspacePath: ws, filePath: "a.ts", narratorId: second, action: "edit" });

		const view = await getWorkspaceModificationView(ws, { filePaths: ["a.ts", "b.ts"] });

		expect(view.byFile.find((g) => g.filePath === "a.ts")?.lastActor.title).toBe("Second");
		// `byFile` itself is newest-first, and `a.ts` was touched most recently.
		expect(view.byFile.map((g) => g.filePath)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("projections", () => {
	test("byFile omits the timeline, the half nobody renders", async () => {
		// The Git panel refetches every 30 s and reads only `byFile`; the timeline carries an
		// id, tool-use id, tree hash and full actor per change.
		const ws = makeWorkspace("nf-view-projection-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws, { projection: "byFile" });

		expect(view.timeline).toBeUndefined();
		expect(view.byFile).toHaveLength(1);
		expect(view.actors).toHaveLength(1);
	});

	test("no projection still returns the timeline, so older clients are unaffected", async () => {
		const ws = makeWorkspace("nf-view-projection-default-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);

		expect(view.timeline).toHaveLength(1);
	});

	test("an empty path list honours the projection too", async () => {
		const ws = makeWorkspace("nf-view-projection-empty-");

		const withTimeline = await getWorkspaceModificationView(ws, { filePaths: [] });
		const without = await getWorkspaceModificationView(ws, {
			filePaths: [],
			projection: "byFile",
		});

		expect(withTimeline.timeline).toEqual([]);
		expect(without.timeline).toBeUndefined();
	});
});

describe("imprecise change detection for revert warnings", () => {
	test("warns for legacy Write/Edit even when the reverting narrator is the only known actor", async () => {
		const ws = makeWorkspace("nf-imprecise-clean-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "edit" });

		const report = await findImpreciseChanges(ws, { excludeNarratorId: narratorId });
		expect(report.hasImprecise).toBe(true);
		expect(report.legacyCount).toBe(2);
		expect(report.warningScanComplete).toBe(true);
	});

	test("counts another narrator's changes in the window", async () => {
		const ws = makeWorkspace("nf-imprecise-other-");
		const alice = await createNarrator("Alice", ws);
		const bob = await createNarrator("Bob", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId: alice, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId: bob, action: "write" });

		// Alice reverting the workspace also discards Bob's write.
		const report = await findImpreciseChanges(ws, { excludeNarratorId: alice });
		expect(report.hasImprecise).toBe(true);
		expect(report.otherActorCount).toBe(1);
		expect(report.sampleFilePaths).toContain("b.ts");
	});

	test("counts external and unserialized shell changes", async () => {
		const ws = makeWorkspace("nf-imprecise-mixed-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "x.ts", narratorId: null, action: "external" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "bash" });

		const report = await findImpreciseChanges(ws, { excludeNarratorId: narratorId });
		expect(report.externalCount).toBe(1);
		expect(report.unserializedCount).toBe(1);
		expect(report.hasImprecise).toBe(true);
	});

	test("respects the time window", async () => {
		const ws = makeWorkspace("nf-imprecise-window-");
		await record({ workspacePath: ws, filePath: "old.ts", narratorId: null, action: "external" });
		const cutoff = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 5));
		await record({ workspacePath: ws, filePath: "new.ts", narratorId: null, action: "external" });

		// Only the change inside the reverted window is relevant.
		const report = await findImpreciseChanges(ws, { since: cutoff });
		expect(report.externalCount).toBe(1);
		expect(report.sampleFilePaths).toEqual(["new.ts"]);
	});
});

/** Seed bounded batches with deterministic UTC timestamps, without wall-clock sleeps. */
async function seedEvents(
	workspacePath: string,
	rows: Array<{
		filePath: string;
		action: "write" | "edit" | "external" | "human";
		narratorId?: string;
		userId?: string;
		changedAt: string;
	}>,
): Promise<void> {
	for (let offset = 0; offset < rows.length; offset += 100) {
		await db.insert(fileAttributions).values(
			rows.slice(offset, offset + 100).map((row) => ({
				id: generateId(),
				deviceId: "local",
				workspacePath: normalizeWorkspacePath(workspacePath),
				...row,
			})),
		);
	}
}

// All DB access uses tests/preload.ts's isolated NARRAFORK_HOME.
describe("M4 actor identity and honest observation coverage", () => {
	test("two human users resolve separately in both projections, including batch writes", async () => {
		const ws = makeWorkspace("nf-view-human-");
		const alice = await createUser("alice");
		const bob = await createUser("bob");
		await recordAttributions({ workspacePath: ws, action: "human", userId: alice.id }, [
			"shared.ts",
			"batch.ts",
		]);
		await seedEvents(ws, [
			{
				filePath: "shared.ts",
				action: "human",
				userId: bob.id,
				changedAt: "2099-01-01T00:00:00.000Z",
			},
		]);
		for (const options of [
			{},
			{ filePaths: ["shared.ts", "batch.ts"], projection: "byFile" as const },
		]) {
			const view = await getWorkspaceModificationView(ws, options);
			const group = view.byFile.find((entry) => entry.filePath === "shared.ts");
			expect(group?.lastAction).toBe("human");
			expect(group?.lastActor).toMatchObject({
				kind: "human",
				userId: bob.id,
				narratorId: null,
				title: bob.username,
				exists: true,
			});
			expect(group?.actors.map((actor) => actor.userId)).toEqual([bob.id, alice.id]);
			expect(view.byFile.find((entry) => entry.filePath === "batch.ts")?.lastActor.userId).toBe(
				alice.id,
			);
			expect(group?.hasDeletedActor).toBe(false);
			expect(group?.hasExternalChange).toBe(false);
			expect(group?.completeness.countsLowerBound).toBe(false);
		}
	});

	test("external then deleted subagent keeps the last event's kind, action and unknown identity", async () => {
		const ws = makeWorkspace("nf-view-deleted-order-");
		const gone = await createNarrator("Do not invent this name", ws);
		await db
			.update(narrators)
			.set({ variant: "subagent:review", subagentType: null })
			.where(eq(narrators.id, gone));
		await record({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: null,
			action: "external",
		});
		await record({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: gone,
			action: "edit",
		});
		await recordAttributions({ workspacePath: ws, narratorId: gone, action: "edit" }, ["batch.ts"]);
		await db.delete(narrators).where(eq(narrators.id, gone));
		const view = await getWorkspaceModificationView(ws, { filePaths: ["shared.ts"] });
		const group = view.byFile[0];
		expect(group?.lastAction).toBe("edit");
		expect(group?.lastActor).toMatchObject({
			kind: "subagent",
			subagentType: "review",
			narratorId: null,
			title: null,
			exists: false,
			deleted: null,
			identityKnown: false,
		});
		expect(group?.actors.map((actor) => actor.kind)).toEqual(["subagent", "external_unknown"]);
		expect(group?.hasExternalChange).toBe(true);
		// Null FK does not distinguish deletion from an originally absent legacy identity.
		expect(group?.hasDeletedActor).toBeNull();
		expect(timelineOf(view)[0]?.actor).toEqual(group?.lastActor);
		expect(group?.completeness.countsLowerBound).toBe(true);
		expect(JSON.stringify(view)).not.toContain("Do not invent this name");
		const batch = await getWorkspaceModificationView(ws, { filePaths: ["batch.ts"] });
		expect(batch.byFile[0]?.lastActor).toMatchObject({
			kind: "subagent",
			subagentType: "review",
			title: null,
		});
	});

	test("anonymized human rows stay human, and id-less tool actors do not become primaries", async () => {
		const ws = makeWorkspace("nf-view-deleted-unknown-");
		const user = await createUser("removed");
		await record({
			workspacePath: ws,
			filePath: "human.ts",
			narratorId: null,
			userId: user.id,
			action: "human",
		});
		// The legacy migration used NO ACTION despite the schema's SET NULL declaration.
		// Emulate the anonymized/FK-null read state explicitly; this is not a deletion test.
		await db
			.update(fileAttributions)
			.set({ userId: null })
			.where(eq(fileAttributions.userId, user.id));
		await db.delete(users).where(eq(users.id, user.id));
		await record({ workspacePath: ws, filePath: "tool.ts", narratorId: null, action: "write" });
		const view = await getWorkspaceModificationView(ws);
		expect(view.byFile.find((group) => group.filePath === "human.ts")?.lastActor).toMatchObject({
			kind: "human",
			userId: null,
			title: null,
			deleted: null,
			identityKnown: false,
		});
		expect(view.byFile.find((group) => group.filePath === "tool.ts")?.lastActor.kind).toBe(
			"narrator_unknown",
		);
		const report = await findImpreciseChanges(ws);
		expect(report).toMatchObject({
			hasImprecise: true,
			humanCount: 1,
			unknownCount: 2,
			legacyCount: 2,
		});
	});

	test("ten rows alone are complete; hidden participants and flags beyond ten remain unknown", async () => {
		const ws = makeWorkspace("nf-view-ten-");
		const busy = await createNarrator("Busy", ws);
		const hidden = await createNarrator("Older participant", ws);
		const recent = Array.from({ length: 10 }, (_, i) => ({
			filePath: "busy.ts",
			narratorId: busy,
			action: "edit" as const,
			changedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
		}));
		await seedEvents(ws, recent);
		const complete = await getWorkspaceModificationView(ws, { filePaths: ["busy.ts"] });
		expect(complete.hasMore).toBe(false);
		expect(complete.byFile[0]?.completeness).toMatchObject({
			fileHistoryComplete: true,
			contributorsTruncated: false,
			countsLowerBound: false,
			warningScanComplete: true,
		});
		await seedEvents(ws, [
			{
				filePath: "busy.ts",
				narratorId: hidden,
				action: "write",
				changedAt: "2026-01-01T01:00:00.000Z",
			},
			{ filePath: "busy.ts", action: "external", changedAt: "2026-01-01T00:00:00.000Z" },
			{
				filePath: "quiet.ts",
				narratorId: hidden,
				action: "write",
				changedAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const partial = await getWorkspaceModificationView(ws, { filePaths: ["busy.ts", "quiet.ts"] });
		const group = partial.byFile.find((entry) => entry.filePath === "busy.ts");
		expect(partial.hasMore).toBe(true);
		expect(group?.changeCount).toBe(10);
		expect(group?.actors.map((actor) => actor.narratorId)).toEqual([busy]);
		expect(group?.hasExternalChange).toBeNull();
		expect(group?.hasDeletedActor).toBeNull();
		expect(group?.completeness).toMatchObject({
			fileHistoryComplete: false,
			contributorsTruncated: true,
			countsLowerBound: true,
			warningScanComplete: false,
		});
		expect(
			partial.byFile.find((entry) => entry.filePath === "quiet.ts")?.completeness
				.fileHistoryComplete,
		).toBe(true);
	});

	test("a capped window stays incomplete after its per-path timestamp filter empties it", async () => {
		const ws = makeWorkspace("nf-view-filtered-cap-");
		await seedEvents(
			ws,
			Array.from({ length: 11 }, (_, i) => ({
				filePath: "a.ts",
				action: "external" as const,
				changedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			})),
		);
		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["a.ts"],
			sinceByPath: new Map([["a.ts", "2026-02-01T00:00:00.000Z"]]),
		});
		expect(view.byFile).toHaveLength(0);
		expect(view.windowCount).toBe(0);
		expect(view.hasMore).toBe(true);
		expect(view.completeness.fileHistoryComplete).toBe(false);
	});

	test("requested paths beyond the cap are disclosed, and duplicate paths do not duplicate rows", async () => {
		const ws = makeWorkspace("nf-view-path-cap-");
		await record({ workspacePath: ws, filePath: "a.ts", narratorId: null, action: "external" });
		const duplicate = await getWorkspaceModificationView(ws, { filePaths: ["a.ts", "a.ts"] });
		expect(duplicate.windowCount).toBe(1);
		const capped = await getWorkspaceModificationView(ws, {
			filePaths: Array.from({ length: 401 }, (_, i) => `f${i}.ts`),
		});
		expect(capped.hasMore).toBe(true);
		expect(capped.completeness.fileHistoryComplete).toBe(false);
	});

	test("more than 2000 events cannot hide older external, human and other-actor hazards as safe", async () => {
		const ws = makeWorkspace("nf-view-warning-cap-");
		const owner = await createNarrator("Owner", ws);
		const other = await createNarrator("Other", ws);
		const human = await createUser("human");
		await seedEvents(ws, [
			{ filePath: "external.ts", action: "external", changedAt: "2026-01-01T00:00:00.000Z" },
			{
				filePath: "human.ts",
				userId: human.id,
				action: "human",
				changedAt: "2026-01-01T00:00:01.000Z",
			},
			{
				filePath: "other.ts",
				narratorId: other,
				action: "write",
				changedAt: "2026-01-01T00:00:02.000Z",
			},
			...Array.from({ length: 2000 }, (_, i) => ({
				filePath: `recent-${i}.ts`,
				narratorId: owner,
				action: "edit" as const,
				changedAt: new Date(Date.UTC(2026, 0, 2) + i).toISOString(),
			})),
		]);
		const report = await findImpreciseChanges(ws, { excludeNarratorId: owner });
		expect(report).toMatchObject({
			hasImprecise: true,
			hasMore: true,
			windowCount: 2000,
			warningScanComplete: false,
			countsLowerBound: true,
			externalCount: 0,
			humanCount: 0,
			otherActorCount: 0,
			legacyCount: 2000,
		});
		expect(report.sampleFilePaths.length).toBeLessThanOrEqual(10);
		expect(report.completeness.warningScanComplete).toBe(false);
		const exactlyAtLimit = await findImpreciseChanges(ws, {
			excludeNarratorId: owner,
			since: "2026-01-02T00:00:00.000Z",
		});
		expect(exactlyAtLimit).toMatchObject({
			windowCount: 2000,
			hasMore: false,
			warningScanComplete: true,
			countsLowerBound: false,
			hasImprecise: true,
		});
	});

	test("an empty warning window is complete, rather than an inferred safe prefix", async () => {
		const ws = makeWorkspace("nf-view-warning-empty-");
		expect(await findImpreciseChanges(ws)).toMatchObject({
			hasImprecise: false,
			hasMore: false,
			windowCount: 0,
			warningScanComplete: true,
			countsLowerBound: false,
		});
	});

	test("since, until and per-path boundaries normalize equivalent offsets to UTC", async () => {
		const ws = makeWorkspace("nf-view-offset-");
		await seedEvents(ws, [
			{ filePath: "a.ts", action: "external", changedAt: "2026-01-01T00:00:00.000Z" },
			{ filePath: "b.ts", action: "external", changedAt: "2026-01-01T01:00:00.000Z" },
		]);
		const utc = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T00:00:00.000Z" };
		const offset = { since: "2026-01-01T08:00:00+08:00", until: "2025-12-31T19:00:00-05:00" };
		expect(await getWorkspaceModificationView(ws, offset)).toEqual(
			await getWorkspaceModificationView(ws, utc),
		);
		expect(
			await getWorkspaceModificationView(ws, { ...offset, filePaths: ["a.ts", "b.ts"] }),
		).toEqual(await getWorkspaceModificationView(ws, { ...utc, filePaths: ["a.ts", "b.ts"] }));
		expect(await findImpreciseChanges(ws, offset)).toEqual(await findImpreciseChanges(ws, utc));
		const utcBoundary = await getWorkspaceModificationView(ws, {
			filePaths: ["a.ts", "b.ts"],
			sinceByPath: new Map([
				["a.ts", utc.since],
				["b.ts", utc.since],
			]),
		});
		const offsetBoundary = await getWorkspaceModificationView(ws, {
			filePaths: ["a.ts", "b.ts"],
			sinceByPath: new Map([
				["a.ts", offset.since],
				["b.ts", offset.since],
			]),
		});
		expect(offsetBoundary).toEqual(utcBoundary);
		expect(offsetBoundary.byFile.map((group) => group.filePath)).toEqual(["b.ts"]);
	});
});
