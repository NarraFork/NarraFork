/**
 * attribution-actors.test.ts — attribution must name its writers.
 *
 * A worktree is shared: subagents, standalone narrators and narrators bound to other
 * chapters all write to it. The Git panel used to resolve ids against the CHAPTER's
 * primary narrator list, so every one of those writers rendered as "Unknown" — the common
 * case in this repository, not an edge case.
 *
 * Covers the pure labelling rules here and the query path through the workspace
 * modification view, which is the consumer that feeds the panel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narrators } from "../db/schema";
import { generateId } from "../lib/id";
import { buildAttributionActors, type NarratorActorRow } from "./attribution-actors";
import { recordAttribution } from "./file-attribution-service";
import { normalizeWorkspacePath } from "./git-workspace";
import { getWorkspaceModificationView } from "./workspace-modification-view";

// ── pure labelling rules ─────────────────────────────────────────────────────

function row(overrides: Partial<NarratorActorRow> = {}): NarratorActorRow {
	return {
		id: "n1",
		title: "Primary session",
		variant: "primary",
		subagentType: null,
		parentNarratorId: null,
		...overrides,
	};
}

describe("buildAttributionActors", () => {
	test("resolves a primary narrator with no subagent type", () => {
		const actors = buildAttributionActors(["n1"], [row()]);
		expect(actors.get("n1")).toEqual({
			narratorId: "n1",
			title: "Primary session",
			subagentType: null,
			parentTitle: null,
			exists: true,
		});
	});

	test("derives the subagent type from variant, the authoritative field", () => {
		// `subagentType` is a denormalized copy and is null on older rows, so trusting it
		// alone is what made subagents unlabelable.
		const actors = buildAttributionActors(
			["s1"],
			[row({ id: "s1", variant: "subagent:general", subagentType: null })],
		);
		expect(actors.get("s1")?.subagentType).toBe("general");
	});

	test("falls back to subagentType when variant is a bare 'subagent'", () => {
		const actors = buildAttributionActors(
			["s1"],
			[row({ id: "s1", variant: "subagent", subagentType: "explore" })],
		);
		expect(actors.get("s1")?.subagentType).toBe("explore");
	});

	test("attaches the parent's title when the parent row is present", () => {
		const actors = buildAttributionActors(
			["s1"],
			[
				row({
					id: "s1",
					title: "Trace edges",
					variant: "subagent:explore",
					parentNarratorId: "p1",
				}),
				row({ id: "p1", title: "Graph rewrite" }),
			],
		);
		expect(actors.get("s1")?.parentTitle).toBe("Graph rewrite");
	});

	test("keeps an unknown id as a non-existent actor instead of dropping it", () => {
		// Dropping it would make a file look untouched by a session that really wrote to
		// it; "deleted session" is a truthful answer, silence is not.
		const actors = buildAttributionActors(["gone"], []);
		expect(actors.get("gone")).toEqual({
			narratorId: "gone",
			title: null,
			subagentType: null,
			parentTitle: null,
			exists: false,
		});
	});

	test("a missing parent row leaves parentTitle null without failing", () => {
		const actors = buildAttributionActors(
			["s1"],
			[row({ id: "s1", variant: "subagent:general", parentNarratorId: "vanished" })],
		);
		expect(actors.get("s1")?.exists).toBe(true);
		expect(actors.get("s1")?.parentTitle).toBeNull();
	});
});

// ── query path, through the view that feeds the Git panel ────────────────────

const createdNarrators: string[] = [];
const workspaces: string[] = [];

function makeWorkspace(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	workspaces.push(dir);
	return dir;
}

async function createNarrator(params: {
	title: string | null;
	cwd: string;
	variant?: string;
	subagentType?: string | null;
	parentNarratorId?: string | null;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: params.title,
		cwd: params.cwd,
		variant: params.variant ?? "primary",
		subagentType: params.subagentType ?? null,
		parentNarratorId: params.parentNarratorId ?? null,
		createdAt: now,
		updatedAt: now,
	});
	createdNarrators.push(id);
	return id;
}

/** Timestamps are millisecond ISO strings; separate rows so ordering is deterministic. */
function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 2));
}

afterEach(async () => {
	for (const workspacePath of workspaces.splice(0)) {
		await db
			.delete(fileAttributions)
			.where(eq(fileAttributions.workspacePath, normalizeWorkspacePath(workspacePath)));
		rmSync(workspacePath, { recursive: true, force: true });
	}
	// Children first: parentNarratorId is a self-FK.
	for (const narratorId of createdNarrators.splice(0).reverse()) {
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
});

describe("actor resolution in the modification view", () => {
	test("labels a subagent writer, the case that used to render as unknown", async () => {
		const ws = makeWorkspace("nf-actor-subagent-");
		const parent = await createNarrator({ title: "Graph rewrite", cwd: ws });
		const sub = await createNarrator({
			title: "Trace edges",
			cwd: ws,
			variant: "subagent:explore",
			parentNarratorId: parent,
		});

		await recordAttribution({
			workspacePath: ws,
			filePath: "src/a.ts",
			narratorId: sub,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "src/a.ts");

		expect(group?.lastActor).toEqual({
			narratorId: sub,
			title: "Trace edges",
			subagentType: "explore",
			// Resolved even though the parent never wrote a file itself.
			parentTitle: "Graph rewrite",
			exists: true,
		});
	});

	test("covers every writer of a shared file, newest first", async () => {
		const ws = makeWorkspace("nf-actor-shared-");
		const first = await createNarrator({ title: "First", cwd: ws });
		const second = await createNarrator({
			title: "Second",
			cwd: ws,
			variant: "subagent:general",
		});

		await recordAttribution({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: first,
			action: "write",
		});
		await tick();
		await recordAttribution({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: second,
			action: "edit",
		});

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "shared.ts");

		expect(group?.lastActor.title).toBe("Second");
		expect(group?.actors.map((a) => a.title)).toEqual(["Second", "First"]);
	});

	test("an external-only file has no narrator to resolve", async () => {
		const ws = makeWorkspace("nf-actor-external-");
		await recordAttribution({
			workspacePath: ws,
			filePath: "touched.ts",
			narratorId: null,
			action: "external",
		});

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "touched.ts");

		expect(group?.hasExternalChange).toBe(true);
		expect(group?.lastActor.narratorId).toBeNull();
		// External is not a deleted session; conflating them loses a real distinction.
		expect(group?.hasDeletedActor).toBe(false);
	});

	test("a deleted session's change is flagged as deleted, not as unknown", async () => {
		// `narrator_id` is ON DELETE SET NULL, so deleting the session leaves a row with
		// no id and a non-external action. That must not read as "no idea who did this".
		const ws = makeWorkspace("nf-actor-deleted-");
		const gone = await createNarrator({ title: "Doomed", cwd: ws });
		await recordAttribution({
			workspacePath: ws,
			filePath: "orphan.ts",
			narratorId: gone,
			action: "write",
		});
		await db.delete(narrators).where(eq(narrators.id, gone));

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "orphan.ts");

		expect(group?.hasDeletedActor).toBe(true);
		expect(group?.hasExternalChange).toBe(false);
	});

	test("a surviving writer keeps its label alongside a deleted co-writer", async () => {
		const ws = makeWorkspace("nf-actor-mixed-");
		const gone = await createNarrator({ title: "Doomed", cwd: ws });
		const alive = await createNarrator({ title: "Survivor", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: gone,
			action: "write",
		});
		await tick();
		await recordAttribution({
			workspacePath: ws,
			filePath: "shared.ts",
			narratorId: alive,
			action: "edit",
		});
		await db.delete(narrators).where(eq(narrators.id, gone));

		const view = await getWorkspaceModificationView(ws);
		const group = view.byFile.find((g) => g.filePath === "shared.ts");

		// The latest writer still exists, so the badge stays informative while the
		// deleted co-writer is accounted for separately.
		expect(group?.lastActor.title).toBe("Survivor");
		expect(group?.hasDeletedActor).toBe(true);
	});
});

// ── path and per-file boundary filtering ────────────────────────────────────

describe("uncommitted-scope filtering", () => {
	test("restricts to the requested paths", async () => {
		const ws = makeWorkspace("nf-scope-paths-");
		const narratorId = await createNarrator({ title: "Writer", cwd: ws });
		for (const filePath of ["wanted.ts", "ignored.ts"]) {
			await recordAttribution({ workspacePath: ws, filePath, narratorId, action: "write" });
			await tick();
		}

		const view = await getWorkspaceModificationView(ws, { filePaths: ["wanted.ts"] });

		expect(view.byFile.map((g) => g.filePath)).toEqual(["wanted.ts"]);
	});

	test("an empty path list returns nothing instead of the whole workspace", async () => {
		// The degenerate case must not silently widen to "everything", which is how a
		// scoped query turns back into the unscoped one it was meant to replace.
		const ws = makeWorkspace("nf-scope-empty-");
		const narratorId = await createNarrator({ title: "Writer", cwd: ws });
		await recordAttribution({
			workspacePath: ws,
			filePath: "a.ts",
			narratorId,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, { filePaths: [] });

		expect(view.byFile).toEqual([]);
		expect(view.timeline).toEqual([]);
	});

	test("drops changes older than each file's own boundary", async () => {
		const ws = makeWorkspace("nf-scope-boundary-");
		const old = await createNarrator({ title: "Old", cwd: ws });
		const recent = await createNarrator({ title: "Recent", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "a.ts",
			narratorId: old,
			action: "write",
		});
		await tick();
		const boundary = new Date().toISOString();
		await tick();
		await recordAttribution({
			workspacePath: ws,
			filePath: "a.ts",
			narratorId: recent,
			action: "edit",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["a.ts"],
			sinceByPath: new Map([["a.ts", boundary]]),
		});
		const group = view.byFile.find((g) => g.filePath === "a.ts");

		// Only the post-boundary writer survives: this is what stops a badge from
		// crediting a file's entire history to the current uncommitted change.
		expect(group?.actors.map((a) => a.title)).toEqual(["Recent"]);
		expect(group?.changeCount).toBe(1);
	});

	test("per-file boundaries are independent", async () => {
		// The bug this guards: one repository-wide boundary. In this repository 90 of 127
		// changed files were last committed before HEAD, so a shared boundary silently
		// discarded their real contributors.
		const ws = makeWorkspace("nf-scope-per-file-");
		const narratorId = await createNarrator({ title: "Writer", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "early.ts",
			narratorId,
			action: "write",
		});
		await tick();
		const cutoff = new Date().toISOString();
		await tick();
		await recordAttribution({
			workspacePath: ws,
			filePath: "late.ts",
			narratorId,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["early.ts", "late.ts"],
			// `early.ts` is bounded past its only change; `late.ts` is unbounded.
			sinceByPath: new Map([["early.ts", cutoff]]),
		});

		expect(view.byFile.map((g) => g.filePath)).toEqual(["late.ts"]);
	});

	test("a path with no boundary keeps all of its changes", async () => {
		// An untracked file has never been committed, so everything recorded for it
		// belongs to the current change.
		const ws = makeWorkspace("nf-scope-unbounded-");
		const narratorId = await createNarrator({ title: "Writer", cwd: ws });
		await recordAttribution({
			workspacePath: ws,
			filePath: "fresh.ts",
			narratorId,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["fresh.ts"],
			sinceByPath: new Map([["other.ts", new Date().toISOString()]]),
		});

		expect(view.byFile.map((g) => g.filePath)).toEqual(["fresh.ts"]);
	});

	test("a renamed file keeps the attribution recorded under its old path", async () => {
		// Attribution rows carry the path that existed when the write happened. Without
		// aliasing, a renamed file's whole history is orphaned: the old path is not in the
		// current diff so nothing renders it, and the new path has no rows of its own — which
		// is the "Unknown" badge this module exists to remove, in another shape.
		const ws = makeWorkspace("nf-actor-rename-");
		const writer = await createNarrator({ title: "Renamer", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "src/old.ts",
			narratorId: writer,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, {
			// Both names are queried; only the current one is displayed.
			filePaths: ["src/new.ts", "src/old.ts"],
			pathAliases: new Map([["src/old.ts", "src/new.ts"]]),
		});

		expect(view.byFile.map((g) => g.filePath)).toEqual(["src/new.ts"]);
		expect(view.byFile[0]?.lastActor.title).toBe("Renamer");
	});

	test("pre- and post-rename writes merge into one group", async () => {
		const ws = makeWorkspace("nf-actor-rename-merge-");
		const before = await createNarrator({ title: "Before", cwd: ws });
		const after = await createNarrator({ title: "After", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "old.ts",
			narratorId: before,
			action: "write",
		});
		await tick();
		await recordAttribution({
			workspacePath: ws,
			filePath: "new.ts",
			narratorId: after,
			action: "edit",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["new.ts", "old.ts"],
			pathAliases: new Map([["old.ts", "new.ts"]]),
		});

		const group = view.byFile.find((g) => g.filePath === "new.ts");
		expect(group?.changeCount).toBe(2);
		// Newest first, and both writers are credited — the rename is not a history reset.
		expect(group?.actors.map((a) => a.title)).toEqual(["After", "Before"]);
	});

	test("an alias is judged against the CURRENT path's boundary", async () => {
		// The old path's own boundary is the wrong window: git resolved the boundary for the
		// file as it exists now, and an entry left over from a different file that once had
		// that name would filter real contributors out.
		const ws = makeWorkspace("nf-actor-rename-boundary-");
		const writer = await createNarrator({ title: "Renamer", cwd: ws });

		await recordAttribution({
			workspacePath: ws,
			filePath: "old.ts",
			narratorId: writer,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["new.ts", "old.ts"],
			pathAliases: new Map([["old.ts", "new.ts"]]),
			// A boundary on the OLD name must be ignored; only `new.ts` bounds this file.
			sinceByPath: new Map([["old.ts", new Date(Date.now() + 60_000).toISOString()]]),
		});

		expect(view.byFile.map((g) => g.filePath)).toEqual(["new.ts"]);
	});

	test("the timeline keeps the path as recorded, so the rename stays visible", async () => {
		const ws = makeWorkspace("nf-actor-rename-timeline-");
		const writer = await createNarrator({ title: "Renamer", cwd: ws });
		await recordAttribution({
			workspacePath: ws,
			filePath: "old.ts",
			narratorId: writer,
			action: "write",
		});

		const view = await getWorkspaceModificationView(ws, {
			filePaths: ["new.ts", "old.ts"],
			pathAliases: new Map([["old.ts", "new.ts"]]),
		});

		// `byFile` answers "who touched this file" and folds the rename; the timeline answers
		// "what happened" and must not rewrite history.
		expect(view.timeline?.map((e) => e.filePath)).toEqual(["old.ts"]);
		expect(view.byFile.map((g) => g.filePath)).toEqual(["new.ts"]);
	});

	test("bash changes stay marked imprecise through the scoped path", async () => {
		// 22% of attributions in this repository are `bash`, whose write set is not
		// provably its own. The badge must be able to say so.
		const ws = makeWorkspace("nf-scope-bash-");
		const narratorId = await createNarrator({ title: "Shell user", cwd: ws });
		await recordAttribution({
			workspacePath: ws,
			filePath: "built.js",
			narratorId,
			action: "bash",
			toolName: "Bash",
		});

		const view = await getWorkspaceModificationView(ws, { filePaths: ["built.js"] });
		const group = view.byFile.find((g) => g.filePath === "built.js");

		expect(group?.hasImpreciseAttribution).toBe(true);
		expect(group?.lastActor.title).toBe("Shell user");
	});
});
