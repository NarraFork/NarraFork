import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HUMAN_ATTENTION_DETAIL_MAX_BYTES } from "@shared/human-attention";
import { eq } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	aclGrants,
	chapters,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../../db/schema";
import type { PendingDangerReflection, PendingPermission } from "../narrator-session-state";

// tests/preload isolates even the restored module. All fixture data below is in-memory.
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { listHumanAttentionForPrincipal: list, getHumanAttentionForPrincipal: detail } =
	await import("../human-attention-service");
const { pendingPermissions, pendingDangerReflections, pendingDangerConfirmations } = await import(
	"../narrator-session-state"
);
const {
	createTaskReflectionDecision,
	cleanupTaskReflection,
	getTaskReflectionAwaitingUser,
	takeOverTaskReflection,
	confirmTaskReflection,
} = await import("../../lib/agent/tools/task-reflection");
const { createExitPlanReflectionDecision, cleanupExitPlanReflection, takeOverExitPlanReflection } =
	await import("../../lib/agent/tools/exit-plan-reflection");
const { awaitAsyncQuestion, isAsyncQuestionAwaited, setQuestionServiceSeam } = await import(
	"../narrator-question-service"
);
const { NotFoundError } = await import("../../lib/errors");
const now = "2026-09-07T00:00:00.000Z";
const owner = { userId: "owner", isAdmin: false };
const reader = { userId: "reader", isAdmin: false };
const outsider = { userId: "outsider", isAdmin: false };
let sequence = 0;
const tasks = new Set<string>();
const plans = new Set<string>();
const controllers: AbortController[] = [];

async function narrator(id: string, values: Partial<typeof narrators.$inferInsert> = {}) {
	await db.insert(narrators).values({
		id,
		ownerUserId: owner.userId,
		visibility: "private",
		writeAudience: "owner",
		title: `Title ${id}`,
		createdAt: now,
		updatedAt: now,
		...values,
	});
	await db.insert(narratorMessages).values({
		id: `message-${id}`,
		narratorId: id,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	return id;
}

async function call(
	narratorId: string,
	values: Partial<typeof narratorToolCalls.$inferInsert> = {},
) {
	const id = `call-${++sequence}`;
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId: `message-${narratorId}`,
		toolUseId: `tool-${id}`,
		toolName: "Bash",
		status: "pending",
		createdAt: now,
		...values,
	});
	const row = db
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, values.id ?? id))
		.get();
	if (!row) throw new Error("Missing tool fixture");
	return row;
}

async function permission(
	narratorId: string,
	opts: {
		id?: string;
		toolName?: string;
		input?: Record<string, unknown>;
		live?: Partial<PendingPermission>;
	} = {},
) {
	const row = await call(narratorId, {
		...(opts.id ? { id: opts.id } : {}),
		toolName: opts.toolName ?? "Bash",
		inputJson: { oldPersistedInput: true },
	});
	const controller = new AbortController();
	controllers.push(controller);
	const pending: PendingPermission = {
		input: opts.input ?? { command: "pwd" },
		narratorId,
		toolUseId: row.toolUseId,
		toolName: row.toolName,
		cwd: "/test",
		locale: "en",
		signal: controller.signal,
		broadcastTargetId: narratorId,
		resolve: () => {},
		cleanup: () => pendingPermissions.delete(row.id),
		...opts.live,
	};
	pendingPermissions.set(row.id, pending);
	return { row, pending, controller };
}

async function question(
	narratorId: string,
	id = `question-${++sequence}`,
	questions: unknown = [
		{ header: "Secret question body", question: "key", options: [{ label: "yes" }] },
	],
) {
	const row = await call(narratorId, { toolName: "AskUserQuestion", status: "success" });
	await db.insert(narratorQuestions).values({
		id,
		narratorId,
		toolCallId: row.id,
		toolUseId: row.toolUseId,
		questionsJson: questions,
		createdAt: now,
	});
	return id;
}

beforeEach(async () => {
	mock.restore();
	for (const id of tasks) cleanupTaskReflection(id);
	for (const id of plans) cleanupExitPlanReflection(id);
	tasks.clear();
	plans.clear();
	for (const controller of controllers) controller.abort();
	controllers.length = 0;
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	pendingDangerConfirmations.clear();
	cleanDb(sqlite);
	sequence = 0;
	await db.insert(users).values(
		[owner, reader, outsider].map((user) => ({
			id: user.userId,
			username: user.userId,
			passwordHash: "test",
			createdAt: now,
		})),
	);
	setQuestionServiceSeam({
		isLoopRunning: () => false,
		broadcastToNarrator: () => {},
		emitAttention: () => {},
		emitAttentionResolved: () => {},
	});
});

afterAll(() => {
	for (const id of tasks) cleanupTaskReflection(id);
	for (const id of plans) cleanupExitPlanReflection(id);
	for (const controller of controllers) controller.abort();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	pendingDangerConfirmations.clear();
	setQuestionServiceSeam(null);
	mock.restore();
	mock.module("../../db", () => realDb);
	cleanDb(sqlite);
});

describe("human attention discovery", () => {
	test("background subagent belongs to its true owner even with an idle parent and no subscriptions", async () => {
		await narrator("parent", { status: "idle" });
		await narrator("child", {
			type: "subagent",
			parentNarratorId: "parent",
			aclRootNarratorId: "parent",
			ownerUserId: outsider.userId,
			isBackground: true,
			status: "idle",
		});
		const p = await permission("child", {
			live: { broadcastTargetId: "parent", parentToolUseId: "parent-tool" },
		});
		const page = await list(owner);
		expect(page.nextCursor).toBeNull();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({
			id: `permission:${p.row.id}`,
			narratorId: "child",
			parentNarratorId: "parent",
			rootNarratorId: "parent",
			canAct: true,
		});
		expect((await detail(owner, `permission:${p.row.id}`)).permission).toMatchObject({
			id: p.row.id,
			ownerNarratorId: "child",
			subagentNarratorId: "child",
			parentToolUseId: "parent-tool",
			inputJson: { command: "pwd" },
		});
		expect((await list(outsider)).items).toHaveLength(0);
		await expect(detail(outsider, `permission:${p.row.id}`)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("ordinary forks do not inherit grouping or parent ACL", async () => {
		await narrator("parent", { ownerUserId: outsider.userId });
		await narrator("fork", { parentNarratorId: "parent", aclRootNarratorId: "parent" });
		const id = await question("fork");
		expect((await list(owner)).items[0]).toMatchObject({
			id: `question:${id}`,
			parentNarratorId: null,
			rootNarratorId: null,
		});
		expect((await list(outsider)).items).toHaveLength(0);
	});

	test("read does not imply write, root changes take effect on every new request", async () => {
		await narrator("root", { visibility: "public" });
		await narrator("child", {
			type: "subagent",
			parentNarratorId: "root",
			aclRootNarratorId: "root",
		});
		const id = await question("child");
		expect((await list(reader)).items[0]?.canAct).toBe(false);
		expect((await detail(reader, `question:${id}`)).item.canAct).toBe(false);
		await db.insert(aclGrants).values({
			id: "grant-write",
			scopeType: "narrator",
			scopeId: "root",
			principalType: "user",
			principalId: reader.userId,
			capability: "write",
			createdAt: now,
		});
		expect((await list(reader)).items[0]?.canAct).toBe(true);
		await db.delete(aclGrants).where(eq(aclGrants.id, "grant-write"));
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, "root"));
		expect((await list(reader)).items).toHaveLength(0);
		await expect(detail(reader, `question:${id}`)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("project membership gates read and write separately, including standalone project context", async () => {
		await db.insert(projects).values({
			id: "p",
			name: "Project",
			gitPath: "/unused",
			ownerUserId: owner.userId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(chapters).values({
			id: "ch",
			projectId: "p",
			title: "Chapter",
			branch: "test",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		});
		await narrator("project-n", {
			chapterId: "ch",
			visibility: "project",
			writeAudience: "project",
		});
		await narrator("context-n", {
			contextProjectId: "p",
			visibility: "project",
			writeAudience: "project",
		});
		await narrator("private-n", { chapterId: "ch", visibility: "private" });
		await question("project-n");
		await question("context-n");
		await question("private-n");
		expect((await list(reader)).items).toHaveLength(0);
		await db.insert(aclGrants).values({
			id: "project-read",
			scopeType: "project",
			scopeId: "p",
			principalType: "user",
			principalId: reader.userId,
			capability: "read",
			createdAt: now,
		});
		const readPage = await list(reader);
		expect(readPage.items).toHaveLength(2);
		expect(readPage.items.every((item) => !item.canAct)).toBe(true);
		await db.update(aclGrants).set({ capability: "write" }).where(eq(aclGrants.id, "project-read"));
		expect((await list(reader)).items.every((item) => item.canAct)).toBe(true);
		await db.delete(aclGrants).where(eq(aclGrants.id, "project-read"));
		expect((await list(reader)).items).toHaveLength(0);
		expect((await list({ ...outsider, isAdmin: true })).items).toHaveLength(3);
	});

	test("only live, undecided requests appear; aborted, removed, and stale rows disappear", async () => {
		await narrator("n", { status: "waiting" });
		await call("n"); // Persisted pending alone is NOT a decision.
		const p = await permission("n");
		const id = await question("n");
		expect((await list(owner)).items).toHaveLength(2);
		await db
			.update(narratorToolCalls)
			.set({ status: "success" })
			.where(eq(narratorToolCalls.id, p.row.id));
		await db
			.update(narratorQuestions)
			.set({ status: "answered" })
			.where(eq(narratorQuestions.id, id));
		expect((await list(owner)).items).toHaveLength(0);
		await expect(detail(owner, `permission:${p.row.id}`)).rejects.toBeInstanceOf(NotFoundError);
		await expect(detail(owner, `question:${id}`)).rejects.toBeInstanceOf(NotFoundError);
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(eq(narratorToolCalls.id, p.row.id));
		p.controller.abort();
		expect((await list(owner)).items).toHaveLength(0);
		await expect(detail(owner, `permission:${p.row.id}`)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("task takeover uses synthetic decision id, hides automatic reflection and resolves through the existing registry", async () => {
		await narrator("n");
		const row = await call("n", { toolName: "Edit" });
		const requestId = "task_reflection_synthetic";
		tasks.add(requestId);
		const decision = createTaskReflectionDecision(requestId, {
			narratorId: "n",
			broadcastTargetId: "n",
			toolCallId: row.id,
			toolUseId: row.toolUseId,
			toolName: "Edit",
			inputJson: { file_path: "spec://tasks.json" },
			mutations: [{ text: "protected work" }],
		});
		expect(getTaskReflectionAwaitingUser(requestId)).toBeNull();
		expect((await list(owner)).items).toHaveLength(0);
		await takeOverTaskReflection(requestId);
		expect((await list(owner)).items[0]).toMatchObject({
			id: `permission:${requestId}`,
			requestId,
			toolCallId: row.id,
			kind: "reflection",
		});
		expect((await detail(owner, `permission:${requestId}`)).permission).toMatchObject({
			id: requestId,
			suggestions: [
				expect.objectContaining({ type: "task_reflection", status: "awaiting_user", requestId }),
			],
		});
		await expect(detail(owner, `permission:${row.id}`)).rejects.toBeInstanceOf(NotFoundError);
		await confirmTaskReflection(requestId, "User approved the protected work", undefined, "user");
		expect((await decision).action).toBe("confirm");
		expect((await list(owner)).items).toHaveLength(0);
	});

	test("danger confirmation cache and automatic danger/plan/Ask reflections are not human decisions", async () => {
		await narrator("n");
		const row = await call("n");
		const danger: PendingDangerReflection = {
			requestId: row.id,
			toolCallId: row.id,
			narratorId: "n",
			broadcastTargetId: "n",
			toolUseId: row.toolUseId,
			toolName: "Bash",
			input: { command: "rm ./x" },
			fingerprint: "f",
			danger: { severity: "high", summary: "Danger", consequences: [], saferAlternatives: [] },
			startedAt: Date.now(),
			resolve: () => {},
			cleanup: () => {},
		};
		pendingDangerReflections.set(row.id, danger);
		pendingDangerConfirmations.set("cache", {
			narratorId: "n",
			fingerprint: "cache",
			expiresAt: Date.now() + 1000,
			summary: "already allowed",
		});
		const plan = await call("n", { toolName: "ExitPlanMode" });
		plans.add("exit_plan_synthetic");
		createExitPlanReflectionDecision("exit_plan_synthetic", {
			narratorId: "n",
			broadcastTargetId: "n",
			toolCallId: plan.id,
			toolUseId: plan.toolUseId,
			toolName: plan.toolName,
			inputJson: { plan: "plan" },
		});
		await takeOverExitPlanReflection("exit_plan_synthetic");
		const ask = await permission("n", {
			toolName: "AskUserQuestion",
			live: { questionReflectionAbort: new AbortController() },
		});
		expect((await list(owner)).items).toHaveLength(0);
		await expect(detail(owner, "permission:exit_plan_synthetic")).rejects.toBeInstanceOf(
			NotFoundError,
		);
		danger.reflectionStoppedByUser = true;
		ask.pending.questionReflectionStoppedByUser = true;
		expect((await list(owner)).items.map((i) => i.kind).sort()).toEqual([
			"blocking_question",
			"reflection",
		]);
		const realPlan = await permission("n", {
			toolName: "ExitPlanMode",
			input: { plan: "real approvable plan" },
		});
		expect((await detail(owner, `permission:${realPlan.row.id}`)).item.kind).toBe("plan_approval");
	});
});

describe("bounded paging and detail", () => {
	test("more than 200 unreadable async rows cannot hide a readable question", async () => {
		await narrator("a-hidden", { ownerUserId: outsider.userId });
		await narrator("z-visible");
		for (let i = 0; i < 240; i++) await question("a-hidden", `hidden-${i}`);
		const id = await question("z-visible");
		const page = await list(owner, { limit: 1 });
		expect(page.items.map((item) => item.id)).toEqual([`question:${id}`]);
		expect(page.nextCursor).toBeNull();
	});

	test("live candidates are ACL filtered without truncating discovery at 200", async () => {
		await narrator("hidden", { ownerUserId: outsider.userId });
		await narrator("visible");
		for (let i = 0; i < 220; i++)
			await permission("hidden", { id: `a-${String(i).padStart(3, "0")}` });
		const visible = await permission("visible", { id: "z-visible" });
		expect((await list(owner, { limit: 1 })).items[0]?.id).toBe(`permission:${visible.row.id}`);
	});

	test("short/empty bounded live pages continue rather than lose visible data", async () => {
		await narrator("hidden", { ownerUserId: outsider.userId });
		await narrator("visible");
		for (let i = 0; i < 420; i++)
			await permission("hidden", { id: `a-${String(i).padStart(3, "0")}` });
		await permission("visible", { id: "z-visible" });
		const first = await list(owner);
		expect(first.items).toHaveLength(0);
		expect(first.nextCursor).not.toBeNull();
		const second = await list(owner, { cursor: first.nextCursor ?? undefined });
		expect(second.items.map((item) => item.id)).toEqual(["permission:z-visible"]);
		expect(second.nextCursor).toBeNull();
	});

	test("stable cursors cross live/async phases without duplicates, with live and awaited priority", async () => {
		await narrator("a");
		await narrator("b");
		await question("a", "a");
		await question("a", "b");
		const awaitedId = await question("b", "c");
		const p = await permission("b", { id: "urgent" });
		const abort = new AbortController();
		controllers.push(abort);
		const wait = awaitAsyncQuestion({
			questionId: awaitedId,
			narratorId: "b",
			timeoutMs: 0,
			signal: abort.signal,
		});
		for (let i = 0; i < 20 && !isAsyncQuestionAwaited(awaitedId); i++) await Promise.resolve();
		expect(isAsyncQuestionAwaited(awaitedId)).toBe(true);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 8; i++) {
			const page = await list(owner, { limit: 1, cursor });
			seen.push(...page.items.map((item) => item.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(seen).toEqual([`permission:${p.row.id}`, "question:c", "question:a", "question:b"]);
		abort.abort();
		await wait;
	});

	test("invalid IDs/cursors fail closed, limit is clamped, cancellation is honored", async () => {
		await expect(detail(owner, "tool:123")).rejects.toBeInstanceOf(NotFoundError);
		await expect(detail(owner, "permission:")).rejects.toBeInstanceOf(NotFoundError);
		await expect(list(owner, { cursor: "!bad" })).rejects.toThrow("Invalid human attention cursor");
		await expect(list(owner, { cursor: "x".repeat(1025) })).rejects.toThrow(
			"Invalid human attention cursor",
		);
		await narrator("n");
		for (let i = 0; i < 105; i++) await question("n");
		expect((await list(owner, { limit: 10_000 })).items).toHaveLength(100);
		expect((await list(owner, { limit: 0 })).items).toHaveLength(1);
		const controller = new AbortController();
		controller.abort();
		await expect(list(owner, { signal: controller.signal })).rejects.toThrow();
	});

	test("list rows never read input, plans or forms; titles and summaries are clamped", async () => {
		await narrator("n", { title: "t".repeat(5000) });
		const p = await permission("n", {
			toolName: "ExitPlanMode",
			input: { plan: "secret plan body" },
		});
		await db
			.update(narratorToolCalls)
			.set({ permissionDecisionReason: "r".repeat(5000) })
			.where(eq(narratorToolCalls.id, p.row.id));
		await question("n");
		const page = await list(owner);
		expect(
			page.items.every((i) => (i.narratorTitle?.length ?? 0) <= 160 && i.summary.length <= 240),
		).toBe(true);
		expect(JSON.stringify(page)).not.toContain("secret plan body");
		expect(JSON.stringify(page)).not.toContain("Secret question body");
		expect(JSON.stringify(page)).not.toContain("inputJson");
	});

	test("oversized live inputs are rejected before enumeration/serialization of their tail", async () => {
		await narrator("n");
		let getterRead = false;
		const input: Record<string, unknown> = {
			plan: "x".repeat(HUMAN_ATTENTION_DETAIL_MAX_BYTES + 1),
		};
		Object.defineProperty(input, "tail", {
			enumerable: true,
			get() {
				getterRead = true;
				throw new Error("must not inspect tail");
			},
		});
		const p = await permission("n", { toolName: "ExitPlanMode", input });
		const result = await detail(owner, `permission:${p.row.id}`);
		expect(result.tooLarge).toBe(true);
		expect(result.permission).toBeUndefined();
		expect(getterRead).toBe(false);
		expect((await list(owner)).items).toHaveLength(1);
	});

	test("byte/escape/node/depth limits reject entire payloads, not partial approvals", async () => {
		await narrator("n");
		for (const input of [
			{ value: "中".repeat(90_000) },
			{ value: "\u0000".repeat(45_000) },
			{ value: Array(40_000).fill(null) },
		]) {
			const p = await permission("n", { input });
			expect(await detail(owner, `permission:${p.row.id}`)).toMatchObject({ tooLarge: true });
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const p = await permission("n", { input: cyclic });
		expect((await detail(owner, `permission:${p.row.id}`)).permission).toBeUndefined();
	});

	test("oversized persisted questions/target JSON never reach JSON.parse", async () => {
		await narrator("n");
		const marker = "HUGE-BODY-NEVER-PARSED";
		const id = await question("n", undefined, [
			{ question: "key", header: marker + "x".repeat(HUMAN_ATTENTION_DETAIL_MAX_BYTES) },
		]);
		const p = await permission("n");
		await db
			.update(narratorToolCalls)
			.set({
				executionTargetsJson: {
					oversized: marker + "x".repeat(HUMAN_ATTENTION_DETAIL_MAX_BYTES),
				} as never,
			})
			.where(eq(narratorToolCalls.id, p.row.id));
		const original = JSON.parse;
		const parse = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			if (typeof text === "string" && text.includes(marker))
				throw new Error("oversized JSON crossed SQL boundary");
			return original(text, reviver);
		});
		try {
			expect(await detail(owner, `question:${id}`)).toMatchObject({ tooLarge: true });
			expect(await detail(owner, `permission:${p.row.id}`)).toMatchObject({ tooLarge: true });
		} finally {
			parse.mockRestore();
		}
	});

	test("safe detail preserves full form, live input and frozen remote target, within the byte budget", async () => {
		await narrator("n");
		const frozen = {
			deviceId: "remote-device",
			backendKind: "remote" as const,
			cwd: "C:\\project",
			pathFlavor: "windows" as const,
			runtimeGeneration: 41,
			canonicalPath: "C:\\project\\plan.md",
			lexicalPath: "C:\\project\\plan.md",
			selectionSource: "explicit" as const,
		};
		const p = await permission("n", {
			toolName: "ExitPlanMode",
			input: { plan: "完整计划" },
			live: { executionTarget: frozen },
		});
		const result = await detail(owner, `permission:${p.row.id}`);
		expect(result.permission?.executionTarget).toEqual(frozen);
		expect(result.permission?.executionCwd).toBe(frozen.cwd);
		expect(result.permission?.inputJson).toEqual({ plan: "完整计划" });
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
			HUMAN_ATTENTION_DETAIL_MAX_BYTES,
		);
		const id = await question("n");
		expect((await detail(owner, `question:${id}`)).question?.questions[0]?.header).toBe(
			"Secret question body",
		);
	});

	test("ACL write checks are cached once per owner within a request, never across requests", async () => {
		await narrator("n", { visibility: "public" });
		for (let i = 0; i < 12; i++) await permission("n");
		await question("n");
		const acl = await import("../narrator-acl");
		const check = spyOn(acl, "canWriteNarrator");
		try {
			expect((await list(reader)).items).toHaveLength(13);
			expect(check).toHaveBeenCalledTimes(1);
			await list(reader);
			expect(check).toHaveBeenCalledTimes(2);
		} finally {
			check.mockRestore();
		}
	});

	test("the exact serialized detail budget is accepted, the next byte is rejected", async () => {
		await narrator("n");
		const input = { value: "" };
		const p = await permission("n", { input });
		const initial = await detail(owner, `permission:${p.row.id}`);
		const metadataBytes = Buffer.byteLength(JSON.stringify(initial));
		input.value = "x".repeat(HUMAN_ATTENTION_DETAIL_MAX_BYTES - metadataBytes);
		const exact = await detail(owner, `permission:${p.row.id}`);
		expect(exact.tooLarge).toBeUndefined();
		expect(Buffer.byteLength(JSON.stringify(exact))).toBe(HUMAN_ATTENTION_DETAIL_MAX_BYTES);
		input.value += "x";
		const over = await detail(owner, `permission:${p.row.id}`);
		expect(over.tooLarge).toBe(true);
		expect(over.permission).toBeUndefined();
	});

	test("query plan seeks narrators then probes open-question index, never historical question bodies", async () => {
		await narrator("n");
		await question("n");
		const all = db.all.bind(db);
		const queries: { sql: string; params: unknown[] }[] = [];
		const dialect = new SQLiteSyncDialect();
		const capture = spyOn(db, "all").mockImplementation((query) => {
			if (typeof query !== "string") queries.push(dialect.sqlToQuery(query.getSQL()));
			return all(query);
		});
		try {
			await list(owner);
		} finally {
			capture.mockRestore();
		}
		const query = queries.find((q) => q.sql.includes("cross join"));
		if (!query) throw new Error("Missing cross-join query");
		expect(query.sql).not.toContain("questions_json");
		expect(query.sql).not.toContain("input_json");
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
			.all(...(query.params as never[]));
		const text = JSON.stringify(plan);
		expect(text).toContain("SEARCH narrators");
		expect(text).toContain("idx_narrator_questions_narrator_status (narrator_id=? AND status=?)");
		expect(text).not.toContain("SCAN narrator_questions");
	});
});
