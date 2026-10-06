import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HUMAN_ATTENTION_DETAIL_MAX_BYTES, type HumanAttentionPage } from "@shared/human-attention";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { PermissionResult } from "../../lib/agent";
import { AppError } from "../../lib/errors";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorRoutes } = await import("../narrators");
const { pendingPermissions } = await import("../../services/narrator-session-state");

const OWNER = "attention-route-owner";
const VIEWER = "attention-route-viewer";
const ROOT = "attention-route-parent";
const CHILD = "attention-route-child";
const NOW = "2026-09-07T00:00:00.000Z";
const decisions: PermissionResult[] = [];

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "content-type": "application/json" },
			}),
	);
	app.route("/narrators", narratorRoutes);
	return app;
}

beforeEach(async () => {
	await db.insert(users).values([
		{ id: OWNER, username: OWNER, passwordHash: "test", createdAt: NOW },
		{ id: VIEWER, username: VIEWER, passwordHash: "test", createdAt: NOW },
	]);
	await db.insert(narrators).values({
		id: ROOT,
		title: "Idle parent",
		ownerUserId: OWNER,
		visibility: "private",
		writeAudience: "owner",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(narrators).values({
		id: CHILD,
		title: "Background child",
		type: "subagent",
		variant: "subagent:general",
		traits: ["background"],
		parentNarratorId: ROOT,
		aclRootNarratorId: ROOT,
		ownerUserId: OWNER,
		status: "waiting",
		createdAt: NOW,
		updatedAt: NOW,
	});
});

afterEach(() => {
	for (const [id, pending] of pendingPermissions) {
		if (pending.narratorId === CHILD) pendingPermissions.delete(id);
	}
	decisions.length = 0;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

async function seedTool(
	id: string,
	toolName: string,
	status: "pending" | "success",
	input: Record<string, unknown>,
) {
	await db.insert(narratorMessages).values({
		id: `message-${id}`,
		narratorId: CHILD,
		role: "assistant",
		contentJson: [],
		parentToolUseId: "spawn-child",
		createdAt: NOW,
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId: CHILD,
		messageId: `message-${id}`,
		toolUseId: `tool-${id}`,
		toolName,
		status,
		inputJson: input,
		permissionStartedAt: status === "pending" ? NOW : null,
		createdAt: NOW,
	});
}

async function seedPermission(input: Record<string, unknown> = { command: "git status" }) {
	const id = "attention-permission";
	await seedTool(id, "Bash", "pending", input);
	pendingPermissions.set(id, {
		narratorId: CHILD,
		broadcastTargetId: ROOT,
		parentToolUseId: "spawn-child",
		toolName: "Bash",
		toolUseId: `tool-${id}`,
		input,
		cwd: "/work",
		locale: "en",
		signal: new AbortController().signal,
		resolve: (result) => decisions.push(result),
		cleanup: () => {
			pendingPermissions.delete(id);
		},
	});
	return id;
}

async function seedQuestion() {
	const question = {
		question: "direction",
		header: "Which option?",
		options: [{ label: "A" }, { label: "B" }],
	};
	await seedTool("attention-question-call", "AskUserQuestion", "success", {
		questions: [question],
		async: true,
	});
	await db.insert(narratorQuestions).values({
		id: "attention-question",
		narratorId: CHILD,
		toolCallId: "attention-question-call",
		toolUseId: "tool-attention-question-call",
		questionsJson: [question],
		status: "open",
		createdAt: NOW,
	});
}

async function readPage(userId = OWNER, query = "") {
	const response = await appAs(userId).request(`/narrators/human-attention${query}`);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return (await response.json()) as HumanAttentionPage;
}

describe("HumanAttention routes", () => {
	test("lists a background child's real decisions without a recent tab or busy parent", async () => {
		await seedPermission();
		await seedQuestion();
		const page = await readPage();
		expect(page.items.map((item) => item.kind).sort()).toEqual(["async_question", "permission"]);
		for (const item of page.items) {
			expect(item.narratorId).toBe(CHILD);
			expect(item.parentNarratorId).toBe(ROOT);
			expect(item.canAct).toBe(true);
			expect(item).not.toHaveProperty("inputJson");
			expect(item).not.toHaveProperty("questions");
		}
		const item = page.items.find((candidate) => candidate.kind === "permission");
		expect(item).toBeDefined();
		if (!item) throw new Error("Permission item missing from inbox");
		const detailResponse = await appAs(OWNER).request(
			`/narrators/human-attention/${encodeURIComponent(item.id)}`,
		);
		expect(detailResponse.status).toBe(200);
		expect(detailResponse.headers.get("cache-control")).toBe("no-store");
		expect(await detailResponse.json()).toMatchObject({
			permission: { inputJson: { command: "git status" } },
		});
	});

	test("keeps private child rows out of another user's list and detail", async () => {
		await seedPermission();
		const item = (await readPage()).items[0];
		expect((await readPage(VIEWER)).items).toEqual([]);
		const denied = await appAs(VIEWER).request(
			`/narrators/human-attention/${encodeURIComponent(item.id)}`,
		);
		expect(denied.status).toBe(404);
	});

	test("uses the existing guarded decision route and removes resolved details", async () => {
		await seedPermission();
		const item = (await readPage()).items[0];
		const approved = await appAs(OWNER).request(
			`/narrators/permissions/${item.requestId}/approve`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(approved.status).toBe(200);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].behavior).toBe("allow");
		expect((await readPage()).items).toEqual([]);
		expect(
			(await appAs(OWNER).request(`/narrators/human-attention/${encodeURIComponent(item.id)}`))
				.status,
		).toBe(404);
		expect(
			(
				await db.query.narrators.findFirst({
					where: eq(narrators.id, ROOT),
					columns: { status: true },
				})
			)?.status,
		).toBe("idle");
	});

	test("read visibility never grants the ability to approve", async () => {
		await seedPermission();
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, ROOT));
		const item = (await readPage(VIEWER)).items[0];
		expect(item.canAct).toBe(false);
		const denied = await appAs(VIEWER).request(`/narrators/permissions/${item.requestId}/approve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect([403, 404]).toContain(denied.status);
		expect(decisions).toHaveLength(0);
		expect(pendingPermissions.has(item.requestId)).toBe(true);
	});

	test("does not return a partially reviewable oversized approval payload", async () => {
		await seedPermission({ command: "x".repeat(HUMAN_ATTENTION_DETAIL_MAX_BYTES + 1) });
		const item = (await readPage()).items[0];
		const response = await appAs(OWNER).request(
			`/narrators/human-attention/${encodeURIComponent(item.id)}`,
		);
		expect(response.status).toBe(200);
		const detail = await response.json();
		expect(detail.tooLarge).toBe(true);
		expect(detail.permission).toBeUndefined();
	});

	test("rejects unbounded list requests before querying", async () => {
		const response = await appAs(OWNER).request("/narrators/human-attention?limit=100000");
		expect(response.status).toBe(400);
	});
});
