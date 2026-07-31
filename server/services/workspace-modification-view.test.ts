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
import { findImpreciseChanges, getWorkspaceModificationView } from "./workspace-modification-view";

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
		expect(view.timeline.map((e) => e.actor.narratorTitle)).toContain("Alice");
		expect(view.timeline.map((e) => e.actor.narratorTitle)).toContain("Bob");
	});

	test("orders the timeline newest first", async () => {
		const ws = makeWorkspace("nf-view-order-");
		const narratorId = await createNarrator("Solo", ws);
		await record({ workspacePath: ws, filePath: "first.ts", narratorId, action: "write" });
		await record({ workspacePath: ws, filePath: "second.ts", narratorId, action: "write" });

		const view = await getWorkspaceModificationView(ws);
		expect(view.timeline.map((e) => e.filePath)).toEqual(["second.ts", "first.ts"]);
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
		const precision = new Map(view.timeline.map((e) => [e.filePath, e.preciseAttribution]));
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
		const withBoundary = view.timeline.find((e) => e.filePath === "a.ts");
		const without = view.timeline.find((e) => e.filePath === "b.ts");
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
			expect(Object.keys(view.timeline[0])).not.toContain(key);
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
		expect(onlyAlice.timeline.map((e) => e.filePath)).toEqual(["a.ts"]);

		const onlyExternal = await getWorkspaceModificationView(ws, { narratorId: "external" });
		expect(onlyExternal.timeline.map((e) => e.filePath)).toEqual(["x.ts"]);
	});

	test("keeps separate workspaces isolated", async () => {
		const first = makeWorkspace("nf-view-iso-a-");
		const second = makeWorkspace("nf-view-iso-b-");
		const narratorId = await createNarrator("Solo", first);
		await record({ workspacePath: first, filePath: "a.ts", narratorId, action: "write" });
		await record({ workspacePath: second, filePath: "b.ts", narratorId, action: "write" });

		expect((await getWorkspaceModificationView(first)).timeline.map((e) => e.filePath)).toEqual([
			"a.ts",
		]);
		expect((await getWorkspaceModificationView(second)).timeline.map((e) => e.filePath)).toEqual([
			"b.ts",
		]);
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
