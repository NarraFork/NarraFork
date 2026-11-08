/**
 * Overlap hints (outline P2 PR 10b, design §2.6): the in-memory index keyed by (project,
 * repository-relative path), the one line a Write or Edit result ends with when another root
 * session's task in progress changed the same file, once an hour per (file, task); never inside
 * one session's tree, never for Bash, never for a task no longer in progress; names as the session
 * may read them; the bounds and eviction.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions,
 * project and repository directories, and starts from an empty index.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../../db";
import { narrators, projects, users } from "../../../db/schema";
import { localBackend } from "../../../lib/agent/execution/local-backend";
import { withOverlapHint } from "../../../lib/agent/tools/track-file-change";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { invalidateTaskBackend } from "../../task-source";
import {
	noteOutlineFileChange,
	OUTLINE_OVERLAP_LIMITS,
	type OutlineFileChange,
	outlineOverlapStats,
	readOutlineFileOverlaps,
	recordOutlineTouch,
	resetOutlineOverlapForTests,
} from "../overlap";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { writeOutline } from "../write";

const NOW = "2026-11-08T00:00:00.000Z";
const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const dirs: string[] = [];

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	invalidateSessionReadScopes();
	resetOutlineOverlapForTests();
});

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function person(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `ov${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function project(owner: string): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `ov-${id}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function session(
	owner: string,
	projectId: string | null,
	options: { title?: string; backend?: "spec" | "outline" } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: options.title ?? "Session",
		ownerUserId: owner,
		taskBackend: options.backend ?? "outline",
		visibility: "private",
		contextProjectId: projectId,
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagentOf(root: string, owner: string, projectId: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		title: "Helper",
		ownerUserId: owner,
		parentNarratorId: root,
		aclRootNarratorId: root,
		taskBackend: "outline",
		contextProjectId: projectId,
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A task in progress, started by the session (so it holds the claim). */
async function startTask(spaceId: string, narratorId: string, owner: string, title: string) {
	const written = await writeOutline({
		spaceId,
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: owner,
		ops: [
			{ op: "insert", tempId: "page", parent: null, content: `Page of ${title}` },
			{
				op: "insert",
				tempId: "task",
				parent: { tempId: "page" },
				content: title,
				task: { status: "doing" },
			},
		],
	});
	const task = written.results[1];
	if (!task) throw new Error("seed failed");
	return task;
}

/** A repository directory (`.git` a directory) or a linked worktree (`.git` a file). */
function repo(kind: "checkout" | "worktree" = "checkout"): string {
	const dir = mkdtempSync(join(tmpdir(), "nf-overlap-"));
	dirs.push(dir);
	if (kind === "checkout") mkdirSync(join(dir, ".git"));
	else writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

function change(
	narratorId: string,
	projectId: string | null,
	cwd: string,
	file: string,
	extra: Partial<OutlineFileChange> = {},
): OutlineFileChange {
	return {
		narratorId,
		projectId,
		cwd,
		filePaths: [join(cwd, file)],
		backend: localBackend,
		locale: "en",
		hint: true,
		now: T0,
		...extra,
	};
}

/** Two sessions of one person in one project, each holding a task in progress. */
async function team() {
	const owner = await person();
	const projectId = await project(owner);
	const space = await ensureProjectSpace(projectId);
	const a = await session(owner, projectId, { title: "Refresh work" });
	const b = await session(owner, projectId, { title: "Login page" });
	const taskA = await startTask(space.id, a, owner, "Fix the refresh race");
	const taskB = await startTask(space.id, b, owner, "Restyle the login page");
	return { owner, projectId, space, a, b, taskA, taskB };
}

describe("the hint", () => {
	test("another session's task in progress changed the same file: one line naming its task and session, once an hour per (file, task)", async () => {
		const t = await team();
		const dir = repo();
		expect(await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts"))).toBeNull();
		const hint = await noteOutlineFileChange(
			change(t.b, t.projectId, dir, "src/auth.ts", { now: T0 + 1000 }),
		);
		expect(hint).toBe(
			`Overlap: [[${t.taskA.address}|Fix the refresh race]] (session "Refresh work", in progress) also changed \`src/auth.ts\`. You may want to read its task before going on.`,
		);
		// Told: not again within the hour, again after it.
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/auth.ts", { now: T0 + 2000 })),
		).toBeNull();
		expect(
			await noteOutlineFileChange(
				change(t.b, t.projectId, dir, "src/auth.ts", {
					now: T0 + OUTLINE_OVERLAP_LIMITS.toldMs + 2000,
				}),
			),
		).toContain(t.taskA.address);
		// A's side: B's task changed the file after A did.
		expect(
			await noteOutlineFileChange(
				change(t.a, t.projectId, dir, "src/auth.ts", { now: T0 + 3000, locale: "zh-CN" }),
			),
		).toBe(
			`重叠提示：[[${t.taskB.address}|Restyle the login page]]（会话「Login page」，进行中）也改过 \`src/auth.ts\`。动手前可以先读它的任务。`,
		);
	});

	test("the same repository-relative path in two worktrees is one key; another path or project is not", async () => {
		const t = await team();
		const main = repo("checkout");
		const worktree = repo("worktree");
		await noteOutlineFileChange(change(t.a, t.projectId, main, "src/auth.ts"));
		// A subdirectory as the working directory: the path is still the repository's.
		mkdirSync(join(worktree, "src", "deep"), { recursive: true });
		const fromSubdir = await noteOutlineFileChange({
			...change(t.b, t.projectId, join(worktree, "src", "deep"), "../auth.ts"),
			now: T0 + 1,
		});
		expect(fromSubdir).toContain("`src/auth.ts`");
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, worktree, "src/other.ts")),
		).toBeNull();
		const elsewhere = await project(t.owner);
		expect(await noteOutlineFileChange(change(t.b, elsewhere, worktree, "src/auth.ts"))).toBeNull();
	});

	test("one session's tree: its subagent hears nothing of its root, nor the root of its subagent", async () => {
		const t = await team();
		const dir = repo();
		const helper = await subagentOf(t.a, t.owner, t.projectId);
		await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts"));
		expect(
			await noteOutlineFileChange(change(helper, t.projectId, dir, "src/auth.ts", { now: T0 + 1 })),
		).toBeNull();
		await noteOutlineFileChange(change(helper, t.projectId, dir, "src/sub.ts"));
		expect(
			await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/sub.ts", { now: T0 + 2 })),
		).toBeNull();
		// The subagent's write counts for its root: another session hears of the root's task.
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/sub.ts", { now: T0 + 3 })),
		).toContain(t.taskA.address);
	});

	test("nothing is named once the task left progress, nor for a session that held no task in progress", async () => {
		const t = await team();
		const dir = repo();
		await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts"));
		await writeOutline({
			spaceId: t.space.id,
			actor: { kind: "agent", id: t.a },
			narratorId: t.a,
			responsibleUserId: t.owner,
			ops: [{ op: "setTask", block: { id: t.taskA.blockId }, task: { status: "done" } }],
		});
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/auth.ts", { now: T0 + 1 })),
		).toBeNull();
		const idle = await session(t.owner, t.projectId, { title: "Idle" });
		await noteOutlineFileChange(change(idle, t.projectId, dir, "src/idle.ts"));
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/idle.ts", { now: T0 + 2 })),
		).toBeNull();
	});

	test("a session the writer may not name is 'another session'; a record older than a day no longer counts", async () => {
		const t = await team();
		const stranger = await person();
		const theirs = await session(stranger, t.projectId, { title: "Secret plans" });
		const taskC = await startTask(t.space.id, theirs, stranger, "Their task");
		const dir = repo();
		await noteOutlineFileChange(change(theirs, t.projectId, dir, "src/auth.ts"));
		const hint = await noteOutlineFileChange(
			change(t.b, t.projectId, dir, "src/auth.ts", { now: T0 + 1 }),
		);
		expect(hint).toContain(`[[${taskC.address}|Their task]] (another session, in progress)`);
		expect(hint).not.toContain("Secret plans");
		await noteOutlineFileChange(change(theirs, t.projectId, dir, "src/old.ts"));
		expect(
			await noteOutlineFileChange(
				change(t.b, t.projectId, dir, "src/old.ts", { now: T0 + OUTLINE_OVERLAP_LIMITS.ttlMs + 1 }),
			),
		).toBeNull();
	});

	test("Bash records without a hint; two others count as more", async () => {
		const t = await team();
		const third = await session(t.owner, t.projectId, { title: "Third" });
		await startTask(t.space.id, third, t.owner, "Third task");
		const dir = repo();
		expect(
			await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts", { hint: false })),
		).toBeNull();
		await noteOutlineFileChange(change(third, t.projectId, dir, "src/auth.ts", { now: T0 + 5 }));
		// Bash on a file others changed: still no hint (its result is not told).
		expect(
			await noteOutlineFileChange(
				change(t.b, t.projectId, dir, "src/auth.ts", { hint: false, now: T0 + 6 }),
			),
		).toBeNull();
		const hint = await noteOutlineFileChange(
			change(t.b, t.projectId, dir, "src/auth.ts", { now: T0 + 7 }),
		);
		expect(hint).toContain("Third task");
		expect(hint).toContain("(1 more)");
	});

	test("off, a spec session, a session without a project, a file outside the repository: nothing", async () => {
		const t = await team();
		const dir = repo();
		await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts"));
		const spec = await session(t.owner, t.projectId, { backend: "spec" });
		expect(await noteOutlineFileChange(change(spec, t.projectId, dir, "src/auth.ts"))).toBeNull();
		const loose = await session(t.owner, null);
		expect(await noteOutlineFileChange(change(loose, null, dir, "src/auth.ts"))).toBeNull();
		expect(
			await noteOutlineFileChange({
				...change(t.b, t.projectId, dir, "x"),
				filePaths: [join(tmpdir(), "outside.ts")],
			}),
		).toBeNull();
		settings.outline.enabled = false;
		expect(await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/auth.ts"))).toBeNull();
		settings.outline.enabled = true;
		expect(await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/auth.ts"))).toContain(
			t.taskA.address,
		);
	});

	test("the result gets the hint as its last line, an error result never", () => {
		expect(withOverlapHint({ output: "Edited a.ts" }, "Overlap: x")).toEqual({
			output: "Edited a.ts\n\nOverlap: x",
		});
		expect(withOverlapHint({ output: "Edited a.ts" }, null)).toEqual({ output: "Edited a.ts" });
		expect(withOverlapHint({ output: "Error", isError: true }, "Overlap: x")).toEqual({
			output: "Error",
			isError: true,
		});
	});
});

describe("bounds", () => {
	test("a session keeps its latest files; the oldest go first and tell nobody", async () => {
		const t = await team();
		const dir = repo();
		for (let i = 0; i <= OUTLINE_OVERLAP_LIMITS.filesPerSession; i++)
			await noteOutlineFileChange(
				change(t.a, t.projectId, dir, `src/f${i}.ts`, { hint: false, now: T0 + i }),
			);
		expect(outlineOverlapStats().keys).toBe(OUTLINE_OVERLAP_LIMITS.filesPerSession);
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/f0.ts", { now: T0 + 1000 })),
		).toBeNull();
		expect(
			await noteOutlineFileChange(change(t.b, t.projectId, dir, "src/f1.ts", { now: T0 + 1001 })),
		).toContain(t.taskA.address);
	});

	test("the process keeps at most its key limit, least recently written first", () => {
		const n = OUTLINE_OVERLAP_LIMITS.keys + 5;
		for (let i = 0; i < n; i++)
			recordOutlineTouch(`s${i % OUTLINE_OVERLAP_LIMITS.sessions}`, `p\u0000k${i}`, ["t"], T0);
		expect(outlineOverlapStats().keys).toBe(OUTLINE_OVERLAP_LIMITS.keys);
		expect(outlineOverlapStats().sessions).toBeLessThanOrEqual(OUTLINE_OVERLAP_LIMITS.sessions);
	});
});

describe("for team activity", () => {
	test("files the session changed that another session's task in progress changed since a time", async () => {
		const t = await team();
		const dir = repo();
		await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/auth.ts", { hint: false }));
		await noteOutlineFileChange(change(t.a, t.projectId, dir, "src/mine.ts", { hint: false }));
		await noteOutlineFileChange(
			change(t.b, t.projectId, dir, "src/auth.ts", { hint: false, now: T0 + 10 }),
		);
		const overlaps = await readOutlineFileOverlaps(t.a, T0 + 1, { now: T0 + 20 });
		expect(overlaps).toEqual([
			{
				path: "src/auth.ts",
				other: t.b,
				taskId: t.taskB.blockId,
				spaceId: t.space.id,
				at: T0 + 10,
			},
		]);
		expect(await readOutlineFileOverlaps(t.a, T0 + 11, { now: T0 + 20 })).toEqual([]);
		// B's side: A changed the file before the time asked about.
		expect(await readOutlineFileOverlaps(t.b, T0 + 1, { now: T0 + 20 })).toEqual([]);
	});
});
