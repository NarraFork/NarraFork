/**
 * Permissions of the team surface (P3).
 *
 * - `Team` cleanup removes a worktree: it always asks a person — hard deny in read-only, dontAsk,
 *   plan and review modes, denied outright for an external (OAuth) session before any danger
 *   reflection, and the final start gate accepts only a person's recorded decision.
 * - Other `Team` actions are the team's own bookkeeping: allowed outside read-only and review.
 * - Delegating into a team work item's own worktree, and file writes inside one, need no person;
 *   any other directory still does, exactly as before.
 *
 * The decision table is checked directly; plan mode, OAuth, the bypass reflection skip and the
 * final gate through the real `handlePermission` pipeline.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getFileTestDb } from "../../../tests/setup";
import { narrators, narratorToolCalls } from "../../db/schema";
import { generateId } from "../../lib/id";
import type { RuntimePermissionConstraint } from "../narrator-permission";

const { db, sqlite, dispose } = getFileTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realNarratorService = { ...(await import("../narrator-service")) };
mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: { ...realNarratorService.narratorService, updateStatus: async () => {} },
}));
const { localBackend } = await import("../../lib/agent/execution/local-backend");
const { handlePermission, recheckFinalToolExecutionPermission, resolvePermissionDecision } =
	await import("../narrator-permission");
const { narratorPersistence: persistence } = await import("../narrator-persistence");

const NOW = "2026-11-17T00:00:00.000Z";
let cwd: string;
let worktree: string;
let elsewhere: string;
const now = () => new Date().toISOString();

const OAUTH: RuntimePermissionConstraint = {
	permissionMode: "bypassPermissions",
	allowKnowledgeWrite: false,
	deviceAccess: { host: "readWrite", global: "readWrite", selfRegistered: "readWrite" },
	oauthClientId: "fixture-client",
	grantId: "fixture-grant",
};

/** A coordinator `n` whose team has one live work item with its worktree under `cwd`. */
async function team(
	permissionMode: "default" | "bypassPermissions" | "dontAsk",
	traits: string[] = [],
) {
	await db.insert(narrators).values({
		id: "n",
		cwd,
		permissionMode,
		traits: ["team", ...traits],
		dangerReflectionOverride: "standard",
		createdAt: now(),
		updatedAt: now(),
	});
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES ('p', 'p', ?, ?, ?)",
		[cwd, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES ('n', 'p', 'main', ?, ?)`,
		[NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO narrator_worktree_resources (id, device_id, repository_key, worktree_path, state, create_request_id)
		VALUES ('wt', 'local', 'repo', ?, 'ready', 'req')`,
		[worktree],
	);
	sqlite.run(
		`INSERT INTO team_work_items (id, team_id, project_id, title, state, branch_name, worktree_resource_id, created_at, updated_at)
		VALUES ('item', 'n', 'p', 'Item', 'cancelled', 'team/item', 'wt', ?, ?)`,
		[NOW, NOW],
	);
}
const liveItem = () => sqlite.run("UPDATE team_work_items SET state = 'in_progress'");

async function persistedCall(toolName: string, input: Record<string, unknown>) {
	const toolUseId = `call-${generateId()}`;
	const message = await persistence.persistAssistantMessage("n", {
		uuid: generateId(),
		session_id: "fixture",
		message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] },
	});
	const call = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.messageId, message.id),
	});
	if (!call) throw new Error("Missing persisted tool call");
	return {
		toolUseId,
		callId: call.id,
		binding: await persistence.getToolCallBinding("n", message.id, toolUseId, call.id),
	};
}
async function decide(
	toolName: string,
	input: Record<string, unknown>,
	constraint?: RuntimePermissionConstraint,
	reviewReadOnlyBash = false,
) {
	const call = await persistedCall(toolName, input);
	return handlePermission(
		"n",
		new AbortController().signal,
		toolName,
		input,
		call.toolUseId,
		cwd,
		"en",
		undefined,
		{
			toolCallBinding: call.binding,
			...(typeof input.file_path === "string"
				? {
						executionBackend: localBackend,
						executionTarget: {
							deviceId: "local",
							backendKind: "local" as const,
							cwd,
							pathFlavor: localBackend.paths.flavor,
							resolvedFilePath: input.file_path,
							runtimeGeneration: localBackend.runtimeGeneration ?? 0,
							selectionSource: "local_default" as const,
						},
					}
				: {}),
		},
		undefined,
		constraint,
		reviewReadOnlyBash,
	);
}
/** A decision that would wait for a person shows as "pending" instead of hanging the test. */
async function settle(promise: Promise<{ behavior: string }>) {
	const pending = new Promise<"pending">((done) => setTimeout(() => done("pending"), 1500));
	const result = await Promise.race([promise, pending]);
	return result === "pending" ? result : result.behavior;
}

beforeEach(async () => {
	cleanDb(sqlite);
	cwd = await mkdtemp(join(tmpdir(), "nf-team-permission-"));
	worktree = join(cwd, ".worktrees", "item");
	elsewhere = join(cwd, ".worktrees", "other");
	await mkdir(worktree, { recursive: true });
	await mkdir(elsewhere, { recursive: true });
});
afterEach(async () => {
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
	dispose();
});

const cleanup = { action: "cleanup", item: "item" };

async function git(args: string[], at: string) {
	const { safeSpawn } = await import("../../lib/spawn");
	const result = await safeSpawn({ cmd: ["git", "-C", at, ...args], timeout: 10_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr);
}

describe("decision table", () => {
	const decision = (
		toolName: string,
		input: Record<string, unknown>,
		permMode: string,
		extra: Partial<Parameters<typeof resolvePermissionDecision>[0]> = {},
	) =>
		resolvePermissionDecision({
			toolName,
			input,
			permMode,
			cwd,
			teamWorktrees: [worktree],
			...extra,
		});

	test("cleanup always asks a person; hard deny where nobody can approve", () => {
		for (const mode of ["default", "acceptEdits", "bypassPermissions"])
			expect(decision("Team", cleanup, mode)).toBe("ask");
		for (const mode of ["readOnly", "dontAsk"]) {
			const meta: { blacklistReason?: string } = {};
			expect(decision("Team", cleanup, mode, { meta })).toBe("deny");
			expect(meta.blacklistReason).toContain("person's approval");
		}
		for (const relaxedPlan of [false, true]) {
			const meta: { blacklistReason?: string } = {};
			expect(
				decision("Team", cleanup, "bypassPermissions", { planMode: true, relaxedPlan, meta }),
			).toBe("deny");
			expect(meta.blacklistReason).toContain("Plan mode");
		}
		expect(decision("Team", cleanup, "bypassPermissions", { reviewReadOnlyBash: true })).toBe(
			"deny",
		);
	});

	test("other Team actions: bookkeeping allowed, writes denied in read-only and review", () => {
		for (const input of [
			{ action: "work.create", title: "x" },
			{ action: "work.review", item: "item", verdict: "clear" },
			{ action: "work.sync", item: "item" },
			{ action: "checkin", minutes: 50 },
			{ action: "decision", text: "x" },
			{ action: "brief", text: "rules" },
		]) {
			for (const mode of ["default", "acceptEdits", "dontAsk", "bypassPermissions"])
				expect(decision("Team", input, mode)).toBe("allow");
			expect(decision("Team", input, "readOnly")).toBe("deny");
			expect(decision("Team", input, "default", { reviewReadOnlyBash: true })).toBe("deny");
		}
		for (const input of [{ action: "work.list" }, { action: "brief" }]) {
			expect(decision("Team", input, "readOnly")).toBe("allow");
			expect(decision("Team", input, "default", { reviewReadOnlyBash: true })).toBe("allow");
		}
	});

	test("delegating into the team's worktree needs no approval; other directories still do", () => {
		const into = { subagent_type: "worker", prompt: "p", workdir: worktree };
		const below = { ...into, workdir: join(worktree, "src") };
		const other = { ...into, workdir: elsewhere };
		for (const mode of ["default", "acceptEdits", "dontAsk"]) {
			expect(decision("Agent", into, mode)).toBe("allow");
			expect(decision("Agent", below, mode)).toBe("allow");
		}
		expect(decision("Agent", other, "default")).toBe("ask");
		expect(decision("Agent", other, "acceptEdits")).toBe("ask");
		expect(decision("Agent", other, "dontAsk")).toBe("deny");
		// Without a recorded team worktree the same directory is "other".
		expect(decision("Agent", into, "default", { teamWorktrees: [] })).toBe("ask");
		// Read-only sessions do not gain a writer through it.
		expect(decision("Agent", into, "readOnly")).toBe("deny");
		// The default directory (the parent's) is allowed as before.
		expect(decision("Agent", { subagent_type: "worker", prompt: "p" }, "default")).toBe("allow");
	});

	test("file writes inside the team's worktree need no approval; outside they still ask", () => {
		const inside = { file_path: join(worktree, "a.ts"), content: "x" };
		const outside = { file_path: join(elsewhere, "a.ts"), content: "x" };
		expect(decision("Write", inside, "default")).toBe("allow");
		expect(decision("Edit", { ...inside, old_string: "a", new_string: "b" }, "default")).toBe(
			"allow",
		);
		expect(decision("Write", outside, "default")).toBe("ask");
		expect(decision("Write", inside, "readOnly")).toBe("deny");
		expect(decision("Write", inside, "default", { planMode: true })).toBe("deny");
	});

	test("git control files in the team's worktree are never auto-allowed", () => {
		for (const relative of [
			".husky/_/post-merge",
			".husky/pre-commit",
			".githooks/pre-commit",
			".gitattributes",
			".gitmodules",
			".gitignore",
			"sub/.gitattributes",
			".GitAttributes",
			".GIT/x",
			".Husky/_/h",
			".husky./x",
			".husky /x",
			".GitHooks./pre-commit",
			".lfsconfig",
			"sub/.gitattributes.",
		])
			expect(
				decision("Write", { file_path: join(worktree, relative), content: "x" }, "default"),
			).toBe("ask");
		// `.git` internals are denied outright by the protected-path rule.
		expect(
			decision("Write", { file_path: join(worktree, ".git", "config"), content: "x" }, "default"),
		).toBe("deny");
		// The configured hooks directory, compared case-insensitively and without trailing dots.
		for (const variant of [
			["Tools", "Hooks"],
			["tools.", "hooks "],
			["TOOLS", "hooks."],
		])
			expect(
				decision(
					"Write",
					{ file_path: join(worktree, ...variant, "post-merge"), content: "x" },
					"default",
					{ teamWorktreeGuards: [join(worktree, "tools", "hooks")] },
				),
			).toBe("ask");
		// A configured hooks directory anywhere in the worktree is guarded too.
		const hooks = join(worktree, "tools", "hooks");
		expect(
			decision("Write", { file_path: join(hooks, "pre-commit"), content: "x" }, "default", {
				teamWorktreeGuards: [hooks],
			}),
		).toBe("ask");
		expect(
			decision(
				"Write",
				{ file_path: join(worktree, "tools", "build.ts"), content: "x" },
				"default",
				{
					teamWorktreeGuards: [hooks],
				},
			),
		).toBe("allow");
	});

	test("a worker's allowance does not reach another worker's worktree", () => {
		// What `teamWorktreePathsForNarrator` gives worker A: its own item only.
		const workerA = { teamWorktrees: [worktree] };
		expect(
			decision("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "default", workerA),
		).toBe("ask");
		expect(
			decision(
				"Agent",
				{ subagent_type: "worker", prompt: "p", workdir: elsewhere },
				"default",
				workerA,
			),
		).toBe("ask");
	});

	test("Agent isolation creates a worktree: denied in read-only and review", () => {
		const input = { isolation: "worktree", title: "t", prompt: "p" };
		expect(decision("Agent", input, "default")).toBe("allow");
		expect(decision("Agent", { ...input, subagent_type: "explore" }, "readOnly")).toBe("deny");
		expect(decision("Agent", input, "default", { reviewReadOnlyBash: true })).toBe("deny");
	});
});

describe("through handlePermission", () => {
	for (const mode of ["bypassPermissions", "default"] as const) {
		test(`strict plan mode (${mode}) denies cleanup outright, never a prompt or a reflection`, async () => {
			await team(mode, ["plan"]);
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await decide("Team", cleanup);
				expect(result.behavior).toBe("deny");
				expect(JSON.stringify(result)).toContain("Plan mode: Team cleanup");
			}
		});
	}

	test("review mode and dontAsk deny cleanup outright", async () => {
		await team("dontAsk");
		expect((await decide("Team", cleanup)).behavior).toBe("deny");
		sqlite.run("UPDATE narrators SET permission_mode = 'default' WHERE id = 'n'");
		expect((await decide("Team", cleanup, undefined, true)).behavior).toBe("deny");
	});

	test("an external OAuth session in bypassPermissions cannot approve cleanup itself", async () => {
		await team("bypassPermissions");
		const result = await decide("Team", cleanup, OAUTH);
		expect(result.behavior).toBe("deny");
		expect(JSON.stringify(result)).toContain("person's approval");
	});

	test("bypassPermissions still waits for a person on cleanup", async () => {
		await team("bypassPermissions");
		expect(await settle(decide("Team", cleanup))).toBe("pending");
	});

	test("bypassPermissions: delegating into the team's worktree starts no danger reflection", async () => {
		await team("bypassPermissions");
		liveItem();
		const into = await decide("Agent", { subagent_type: "worker", prompt: "p", workdir: worktree });
		expect(into.behavior).toBe("allow");
		// An external session gets no team allowance.
		const oauth = await decide(
			"Agent",
			{ subagent_type: "worker", prompt: "p", workdir: worktree },
			{ ...OAUTH, permissionMode: "dontAsk" },
		);
		expect(oauth.behavior).toBe("deny");
	});

	test("default mode: a finished item's worktree is not the team's any more", async () => {
		await team("default");
		expect(
			await settle(decide("Agent", { subagent_type: "worker", prompt: "p", workdir: worktree })),
		).toBe("pending");
		liveItem();
		expect(
			(await decide("Agent", { subagent_type: "worker", prompt: "p", workdir: worktree })).behavior,
		).toBe("allow");
	});

	test("the repository's configured hooks directory is read and guarded", async () => {
		await git(["init", "-q", "-b", "main"], cwd);
		await git(["config", "core.hooksPath", "tools/hooks"], cwd);
		await team("default");
		liveItem();
		// Relative hooksPath resolves inside the worktree git runs in.
		expect(
			await settle(
				decide("Write", {
					file_path: join(worktree, "tools", "hooks", "post-merge"),
					content: "x",
				}),
			),
		).toBe("pending");
		expect(
			await settle(
				decide("Write", { file_path: join(worktree, ".husky", "_", "h"), content: "x" }),
			),
		).toBe("pending");
		expect(
			(await decide("Write", { file_path: join(worktree, "src", "a.ts"), content: "x" })).behavior,
		).toBe("allow");
	});

	test("a symlink or `..` out of the team's worktree is not inside it", async () => {
		await team("default");
		liveItem();
		const outside = await mkdtemp(join(tmpdir(), "nf-team-outside-"));
		try {
			await symlink(outside, join(worktree, "link"));
			expect(
				await settle(decide("Write", { file_path: join(worktree, "link", "x.txt"), content: "x" })),
			).toBe("pending");
			expect(
				await settle(
					decide("Write", { file_path: join(worktree, "..", "other", "x.txt"), content: "x" }),
				),
			).toBe("pending");
			expect(
				(await decide("Write", { file_path: join(worktree, "ok.txt"), content: "x" })).behavior,
			).toBe("allow");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("a worker's helper gets its worker's worktree, not the other items'", async () => {
		await team("default");
		liveItem();
		sqlite.run(
			`INSERT INTO narrator_worktree_resources (id, device_id, repository_key, worktree_path, state, create_request_id)
			VALUES ('wt2', 'local', 'repo', ?, 'ready', 'req2')`,
			[elsewhere],
		);
		for (const [id, parent] of [
			["worker-a", "n"],
			["worker-b", "n"],
			["helper-a", "worker-a"],
		])
			sqlite.run(
				`INSERT INTO narrators (id, type, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
				VALUES (?, 'subagent', ?, 'n', ?, ?)`,
				[id, parent, NOW, NOW],
			);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = 'worker-a'");
		sqlite.run(
			`INSERT INTO team_work_items (id, team_id, project_id, title, state, worker_narrator_id, worktree_resource_id, created_at, updated_at)
			VALUES ('item2', 'n', 'p', 'B', 'in_progress', 'worker-b', 'wt2', ?, ?)`,
			[NOW, NOW],
		);
		const { teamWorktreePathsForNarrator } = await import("../teams/team-membership");
		expect(teamWorktreePathsForNarrator("worker-a")).toEqual([worktree]);
		expect(teamWorktreePathsForNarrator("helper-a")).toEqual([worktree]);
		expect(teamWorktreePathsForNarrator("worker-b")).toEqual([elsewhere]);
		expect(teamWorktreePathsForNarrator("n").sort()).toEqual([worktree, elsewhere].sort());
	});

	test("the final start gate accepts a cleanup only on a person's recorded approval", async () => {
		await team("bypassPermissions");
		for (const decidedBy of ["reflection", "auto", "user"] as const) {
			const call = await persistedCall("Team", cleanup);
			await db
				.update(narratorToolCalls)
				.set({ status: "running", permissionDecidedBy: decidedBy, permissionDecidedAt: now() })
				.where(eq(narratorToolCalls.id, call.callId));
			const check = recheckFinalToolExecutionPermission({
				narratorId: "n",
				toolName: "Team",
				input: cleanup,
				toolUseId: call.toolUseId,
				binding: call.binding,
				cwd,
			});
			// Settle natively before expect to avoid Bun's reused-Worker .resolves stall.
			if (decidedBy === "user") expect(await check).toBeDefined();
			else await expect(check).rejects.toThrow("Team cleanup requires a person's approval");
		}
		// Other actions keep their automatic approval.
		const call = await persistedCall("Team", { action: "decision", text: "x" });
		await db
			.update(narratorToolCalls)
			.set({ status: "running", permissionDecidedBy: "auto", permissionDecidedAt: now() })
			.where(eq(narratorToolCalls.id, call.callId));
		expect(
			await recheckFinalToolExecutionPermission({
				narratorId: "n",
				toolName: "Team",
				input: { action: "decision", text: "x" },
				toolUseId: call.toolUseId,
				binding: call.binding,
				cwd,
			}),
		).toBeDefined();
	});
});
