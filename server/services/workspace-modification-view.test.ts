import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { generateId } from "../lib/id";
import { recordAttribution } from "./file-attribution-service";
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
const workspaces: string[] = [];

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
	action: "write" | "edit" | "bash" | "external";
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

	test("marks write/edit precise and bash/external imprecise", async () => {
		const ws = makeWorkspace("nf-view-precision-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "w.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "e.ts", narratorId, action: "edit" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "bash" });
		await record({ workspacePath: ws, filePath: "x.ts", narratorId: null, action: "external" });

		const view = await getWorkspaceModificationView(ws);
		const precision = new Map(timelineOf(view).map((e) => [e.filePath, e.preciseAttribution]));
		// Write/Edit hold the workspace write lock for their whole window.
		expect(precision.get("w.ts")).toBe(true);
		expect(precision.get("e.ts")).toBe(true);
		// Bash is only serialized for short targeted commands, which is not recorded
		// per row — so its scope is not provably its own.
		expect(precision.get("b.ts")).toBe(false);
		expect(precision.get("x.ts")).toBe(false);
	});

	test("exposes the tree boundary of a change when one was recorded", async () => {
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
		expect(withBoundary?.treeHashAfter).toBe("a".repeat(40));
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
	test("reports nothing when only the reverting narrator wrote precisely", async () => {
		const ws = makeWorkspace("nf-imprecise-clean-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "a.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "b.ts", narratorId, action: "edit" });

		const report = await findImpreciseChanges(ws, { excludeNarratorId: narratorId });
		expect(report.hasImprecise).toBe(false);
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
